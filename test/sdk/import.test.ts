/**
 * Gcr.importExport / importManualCopy and the writer lock: results as envelopes, idempotence, every refused input, and
 * proof that concurrent mutators on one handle never interleave.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { Gcr } from '../../src/sdk/gcr.js';
import { syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import { buildZip } from '../helpers/zip-builder.js';
import {
  FIXED_NOW,
  ID,
  assertCode,
  assertEnvelopeShape,
  assertRejectCode,
  chat,
  conversationsJson,
  emptyDb,
  expectGcr,
  fixedClock,
  importBuilders,
  importClaude,
  makeTempDir,
  rejected,
  removeDir,
  thrown,
  warningCodes,
  writeText,
} from './sdk.helpers.test.js';

const manualDoc = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    conversationId: syntheticUuid(0x41),
    title: 'GCR-SYNTHETIC-FIXTURE manual copy',
    messages: [
      { role: 'user', text: 'copied question about marmots' },
      { role: 'assistant', text: 'copied answer about marmots' },
    ],
    ...over,
  });

describe('importExport', () => {
  let t: Awaited<ReturnType<typeof emptyDb>>;
  before(async () => {
    t = await emptyDb();
  });
  after(async () => {
    await t.cleanup();
  });

  it('imports a conversations.json and returns the ImportReport inside an envelope with source, completeness and warnings', async () => {
    const env = await importBuilders(t.gcr, t.dir, [chat(ID.linear, 'first import', [['hello marmot', 'hi']]), chat(ID.branched, 'second', [['x', 'y']])], { sub: 'first' });
    assertEnvelopeShape(env);
    assert.equal(env.data.conversations.stored, 2);
    assert.equal(env.data.messages.structural, 2);
    assert.equal(env.data.alreadyImported, false);
    assert.equal(env.data.sourceLabel, 'conversations.json');
    assert.equal(env.data.formatProfile?.conversations, 2);
    assert.equal(env.source.length, 1);
    assert.equal(env.source[0]?.batchId, env.data.batchId);
    assert.equal(env.source[0]?.sourceLabel, 'conversations.json');
    assert.equal(env.source[0]?.provenance, 'official_chatgpt_export');
    assert.equal(env.source[0]?.importedAt, FIXED_NOW, 'the handle clock stamps the import');
    assert.equal(env.completeness, 'exported_tree');
    assert.deepEqual(env.warnings, []);
    assert.equal(env.untrustedContent, true);
  });

  it('importing the same input again is an idempotent no-op that says so', async () => {
    const path = await writeText(t.dir, 'again/conversations.json', conversationsJson([chat(ID.hidden, 'again', [['q', 'a']])]));
    const totalBefore = t.gcr.list().data.total ?? 0;
    const one = await t.gcr.importExport({ source: { kind: 'path', path } });
    const two = await t.gcr.importExport({ source: { kind: 'path', path } });
    assert.equal(one.data.alreadyImported, false);
    assert.equal(two.data.alreadyImported, true);
    assert.equal(two.data.batchId, one.data.batchId);
    assert.equal(two.data.conversations.newlyInserted, 0);
    assert.equal(t.gcr.list().data.total, totalBefore + 1, 'the conversation was stored once');
    assert.equal(two.data.formatProfile, undefined, 'the profile is only observed on the first import');
    // the profile of the FIRST import is still what stats reports for that batch
    assert.equal(t.gcr.stats({ groupBy: 'role' }).data.formatProfiles.find((p) => p.batchId === one.data.batchId)?.formatProfile.conversations, 1);
  });

  it('reads a ZIP and labels the source with the archive\'s basename only', async () => {
    const zip = buildZip([{ name: 'conversations.json', data: conversationsJson([chat(ID.unicode, 'zipped', [['zip question', 'zip answer']])]) }]);
    await mkdir(join(t.dir, 'deep', 'private', 'folder'), { recursive: true });
    const path = join(t.dir, 'deep', 'private', 'folder', 'my-export.zip');
    await writeFile(path, zip);
    const env = await t.gcr.importExport({ source: { kind: 'path', path } });
    assert.equal(env.data.sourceKind, 'zip');
    assert.equal(env.source[0]?.sourceLabel, 'my-export.zip');
    assert.ok(!JSON.stringify(env).includes('private'), 'no directory of the operator appears anywhere in the envelope');
  });

  it('reads a byte stream the caller already holds', async () => {
    async function* chunks(): AsyncGenerator<Buffer> {
      const text = conversationsJson([chat(ID.injection, 'streamed', [['streamed question', 'streamed answer']])]);
      for (let i = 0; i < text.length; i += 64) yield Buffer.from(text.slice(i, i + 64), 'utf8');
    }
    const env = await t.gcr.importExport({ source: { kind: 'stream', stream: chunks(), label: 'from-stdin.json' } });
    assert.equal(env.data.sourceKind, 'stdin_json');
    assert.equal(env.source[0]?.sourceLabel, 'from-stdin.json');
    assert.equal(t.gcr.get(ID.injection).data.thread?.messages[0]?.text, 'streamed question');
  });

  it('an account label keeps exports apart', async () => {
    const env = await importBuilders(t.gcr, t.dir, [chat(syntheticUuid(0x61), 'labelled', [['q', 'a']])], { accountLabel: 'work' });
    assert.equal(env.source[0]?.accountLabel, 'work');
    assert.equal(t.gcr.list({ accountLabel: 'work' }).data.total, 1);
  });

  it('a Claude export is "rendered_active_view_only": the envelope is flagged and says what is missing', async () => {
    const env = await importClaude(t.gcr, t.dir, [syntheticUuid(0x62)]);
    assert.equal(env.source[0]?.provenance, 'official_claude_export');
    assert.equal(env.completeness, 'rendered_active_view_only');
    assert.equal(env.warnings[0]?.code, 'SOURCE_NOT_FULL_HISTORY');
    assert.match(env.warnings[0]?.message ?? '', /active view/);
  });

  it('progress callbacks see counts and file names only, never message text', async () => {
    const events: unknown[] = [];
    const path = await writeText(t.dir, 'progress/conversations.json', conversationsJson([chat(syntheticUuid(0x63), 'progress', [['super secret question', 'super secret answer']])]));
    await t.gcr.importExport({ source: { kind: 'path', path }, onProgress: (e) => events.push(e) });
    assert.ok(events.length > 0);
    assert.ok(!JSON.stringify(events).includes('secret'));
  });

  it('an explicit clock option wins over the handle clock; a clock that is not ISO-8601 UTC is INVALID_ARGUMENT and stores nothing', async () => {
    const path = await writeText(t.dir, 'clock/conversations.json', conversationsJson([chat(syntheticUuid(0x64), 'clock', [['q', 'a']])]));
    const total = t.gcr.listBatches().length;
    await assertRejectCode(t.gcr.importExport({ source: { kind: 'path', path }, clock: () => 'yesterday' }), 'INVALID_ARGUMENT');
    assert.equal(t.gcr.listBatches().length, total);
    const env = await t.gcr.importExport({ source: { kind: 'path', path }, clock: () => '2030-01-01T00:00:00.000Z' });
    assert.equal(env.source[0]?.importedAt, '2030-01-01T00:00:00.000Z');
  });

  describe('refused input', () => {
    const bad: Array<[string, unknown]> = [
      ['no options', undefined],
      ['null options', null],
      ['a string instead of options', 'conversations.json'],
      ['no source', {}],
      ['null source', { source: null }],
      ['a URL source (GCR never fetches anything)', { source: { kind: 'url', url: 'https://chatgpt.com/c/00000000-0000-4000-8000-000000000001' } }],
      ['a path source without a path', { source: { kind: 'path' } }],
      ['an empty path', { source: { kind: 'path', path: '' } }],
      ['a non-string path', { source: { kind: 'path', path: 5 } }],
      ['a path with a NUL byte', { source: { kind: 'path', path: 'a\u0000b' } }],
      ['a stream source with a non-iterable stream', { source: { kind: 'stream', stream: 5, label: 'x' } }],
      ['a stream source without a label', { source: { kind: 'stream', stream: (async function* () { /* empty */ })() } }],
      ['an unknown option', { source: { kind: 'path', path: 'x' }, retries: 3 }],
    ];
    for (const [name, opts] of bad) {
      it(`${name} rejects with INVALID_ARGUMENT`, async () => {
        await assertRejectCode(Promise.resolve().then(() => t.gcr.importExport(opts as never)), 'INVALID_ARGUMENT');
      });
    }

    it('invalid account labels and providers are refused by the import layer, as GcrErrors', async () => {
      const path = await writeText(t.dir, 'refused/conversations.json', conversationsJson([chat(syntheticUuid(0x65), 'refused', [['q', 'a']])]));
      await assertRejectCode(t.gcr.importExport({ source: { kind: 'path', path }, accountLabel: '../escape' }), 'INVALID_ARGUMENT');
      await assertRejectCode(t.gcr.importExport({ source: { kind: 'path', path }, provider: 'gemini' as never }), 'INVALID_ARGUMENT');
      await assertRejectCode(t.gcr.importExport({ source: { kind: 'path', path }, provider: 'openai_api' as never }), 'NOT_IMPLEMENTED');
    });

    it('a missing input is IMPORT_INPUT_NOT_FOUND and the error does not carry the absolute path', async () => {
      const e = await assertRejectCode(t.gcr.importExport({ source: { kind: 'path', path: join(t.dir, 'nowhere', 'conversations.json') } }), 'IMPORT_INPUT_NOT_FOUND');
      assert.ok(!JSON.stringify(e.toEnvelope()).includes(t.dir), 'the operator\'s directory layout is not leaked');
    });

    it('a file that is not an export is refused as a GcrError without echoing its content', async () => {
      const path = await writeText(t.dir, 'junk/conversations.json', 'this is not json, it is TOP-SECRET-SENTENCE and more');
      const e = expectGcr(await rejected(t.gcr.importExport({ source: { kind: 'path', path } })), 'IMPORT_UNSUPPORTED_FORMAT');
      assert.ok(!JSON.stringify(e.toEnvelope()).includes('TOP-SECRET'));
    });

    it('an unsafe ZIP entry name is IMPORT_ZIP_UNSAFE and nothing is stored', async () => {
      const total = t.gcr.listBatches().length;
      const zip = buildZip([{ name: '../conversations.json', data: conversationsJson([chat(syntheticUuid(0x66), 'evil', [['q', 'a']])]) }]);
      const path = join(t.dir, 'evil.zip');
      await writeFile(path, zip);
      await assertRejectCode(t.gcr.importExport({ source: { kind: 'path', path } }), 'IMPORT_ZIP_UNSAFE');
      assert.equal(t.gcr.listBatches().length, total);
    });

    it('strict mode aborts on a damaged element and stores NOTHING; the default mode stores the rest and records a warning', async () => {
      const good = chat(syntheticUuid(0x67), 'strict good', [['q', 'a']]).text();
      const text = `[${good},{"not":"a conversation"}]`;
      const path = await writeText(t.dir, 'strict/conversations.json', text);
      const total = t.gcr.listBatches().length;
      const e = expectGcr(await rejected(t.gcr.importExport({ source: { kind: 'path', path }, strict: true })), 'IMPORT_PARSE_ERROR');
      assert.ok(e.code.startsWith('IMPORT_'));
      assert.equal(t.gcr.listBatches().length, total, 'a strict failure stores nothing');
      const lenient = await t.gcr.importExport({ source: { kind: 'path', path } });
      assert.equal(lenient.data.conversations.stored, 1);
      assert.ok(lenient.warnings.length > 0, 'the skipped element is reported');
    });

    it('a failed import leaves the handle usable (no open transaction, no stuck lock)', async () => {
      await assertRejectCode(t.gcr.importExport({ source: { kind: 'path', path: join(t.dir, 'still-nowhere.json') } }), 'IMPORT_INPUT_NOT_FOUND');
      assert.ok((t.gcr.list().data.total ?? 0) > 0);
      const path = await writeText(t.dir, 'after-failure/conversations.json', conversationsJson([chat(syntheticUuid(0x68), 'after', [['q', 'a']])]));
      assert.equal((await t.gcr.importExport({ source: { kind: 'path', path } })).data.conversations.stored, 1);
    });

    it('an exception thrown by the caller\'s progress callback fails that import as a GcrError, rolls it back and frees the lock', async () => {
      const path = await writeText(t.dir, 'cb/conversations.json', conversationsJson([chat(syntheticUuid(0x69), 'callback', [['q', 'a']])]));
      const total = t.gcr.listBatches().length;
      const e = expectGcr(
        await rejected(
          t.gcr.importExport({
            source: { kind: 'path', path },
            onProgress: () => {
              throw new Error('caller bug with /secret/path in it');
            },
          }),
        ),
        'INTERNAL_ERROR',
      );
      assert.ok(!JSON.stringify(e.toEnvelope()).includes('/secret/path'), 'foreign error text is never forwarded');
      assert.equal(t.gcr.listBatches().length, total);
      assert.equal((await t.gcr.importExport({ source: { kind: 'path', path } })).data.conversations.stored, 1);
    });
  });
});

describe('importManualCopy (Mode B)', () => {
  let t: Awaited<ReturnType<typeof emptyDb>>;
  before(async () => {
    t = await emptyDb();
  });
  after(async () => {
    await t.cleanup();
  });

  it('indexes the copy as PARTIAL: provenance user_supplied_copy, completeness partial_user_supplied, SOURCE_NOT_FULL_HISTORY first', async () => {
    const env = await t.gcr.importManualCopy(manualDoc(), { sourceLabel: '/private/dir/mycopy.json' });
    assertEnvelopeShape(env);
    assert.equal(env.source[0]?.provenance, 'user_supplied_copy');
    assert.equal(env.source[0]?.completeness, 'partial_user_supplied');
    assert.equal(env.source[0]?.sourceLabel, 'mycopy.json', 'basename only');
    assert.equal(env.completeness, 'partial_user_supplied');
    assert.equal(env.warnings[0]?.code, 'SOURCE_NOT_FULL_HISTORY');
    assert.match(env.warnings[0]?.message ?? '', /manual copy/);
    assert.ok(warningCodes(env).includes('PARTIAL_USER_SUPPLIED'));
    assert.equal(env.data.conversations.stored, 1);
    assert.equal(env.data.sourceKind, 'manual_copy');
  });

  it('what was copied can be read back, and every read says it is partial', () => {
    const got = t.gcr.get(syntheticUuid(0x41));
    assert.deepEqual(got.data.thread?.messages.map((m) => m.text), ['copied question about marmots', 'copied answer about marmots']);
    assert.equal(got.data.thread?.selectionPolicy, 'only_branch', 'a linear copy has one branch; the active branch is NOT claimed');
    assert.equal(got.data.thread?.activeness, 'unknown');
    assert.equal(got.completeness, 'partial_user_supplied');
    assert.equal(got.warnings[0]?.code, 'SOURCE_NOT_FULL_HISTORY');
    assert.equal(got.data.conversation.currentNodeId, null);
    const hits = t.gcr.search({ query: 'marmots' });
    assert.equal(hits.data.items.length, 2);
    assert.equal(hits.completeness, 'partial_user_supplied');
    assert.equal(hits.warnings[0]?.code, 'SOURCE_NOT_FULL_HISTORY');
    assert.equal(t.gcr.list().completeness, 'partial_user_supplied');
    assert.equal(t.gcr.branches(syntheticUuid(0x41)).warnings[0]?.code, 'SOURCE_NOT_FULL_HISTORY');
  });

  it('importing the same copy again is an idempotent no-op', async () => {
    const again = await t.gcr.importManualCopy(manualDoc());
    assert.equal(again.data.alreadyImported, true);
    assert.equal(t.gcr.list().data.total, 1);
  });

  it('without a conversationId a deterministic id is synthesized and reported', async () => {
    const env = await t.gcr.importManualCopy(JSON.stringify({ messages: [{ role: 'user', text: 'no id given' }] }));
    assert.ok(env.data.warnings.some((w) => w.code === 'CONVERSATION_ID_SYNTHESIZED'));
    const again = await t.gcr.importManualCopy(JSON.stringify({ messages: [{ role: 'user', text: 'no id given' }] }));
    assert.equal(again.data.alreadyImported, true);
  });

  it('a copy lives in its own account when asked, so it cannot overwrite an official export', async () => {
    const env = await t.gcr.importManualCopy(manualDoc({ messages: [{ role: 'user', text: 'other account copy' }] }), { accountLabel: 'scratch' });
    assert.equal(env.source[0]?.accountLabel, 'scratch');
    assertCode(() => t.gcr.get(syntheticUuid(0x41)), 'AMBIGUOUS_CONVERSATION');
  });

  const refused: Array<[string, () => Promise<unknown>, string]> = [
    ['a non-string document', () => t.gcr.importManualCopy(5 as never), 'INVALID_ARGUMENT'],
    ['text that is not JSON', () => t.gcr.importManualCopy('not json at all'), 'IMPORT_PARSE_ERROR'],
    ['a document without messages', () => t.gcr.importManualCopy('{"title":"x"}'), 'IMPORT_PARSE_ERROR'],
    ['a share link as sourceUri', () => t.gcr.importManualCopy(manualDoc({ sourceUri: `https://chatgpt.com/share/${ID.linear}` })), 'INVALID_URL'],
    ['a sourceUri on another host', () => t.gcr.importManualCopy(manualDoc({ sourceUri: `https://example.invalid/c/${ID.linear}` })), 'INVALID_URL'],
    ['an unknown option', () => t.gcr.importManualCopy(manualDoc(), { retries: 1 } as never), 'INVALID_ARGUMENT'],
    ['an invalid account label', () => t.gcr.importManualCopy(manualDoc(), { accountLabel: '../x' }), 'INVALID_ARGUMENT'],
    ['a non-function clock', () => t.gcr.importManualCopy(manualDoc(), { clock: 'now' as never }), 'INVALID_ARGUMENT'],
  ];
  for (const [name, run, code] of refused) {
    it(`${name} -> ${code}`, async () => {
      await assertRejectCode(run(), code as 'INVALID_ARGUMENT');
    });
  }

  it('a refused copy does not echo its content', async () => {
    const e = await assertRejectCode(t.gcr.importManualCopy('{"messages":[{"role":"user","text":"TOP-SECRET-LINE","createdAt":"not a time"}]}'), 'IMPORT_PARSE_ERROR').catch((x: unknown) => x);
    assert.ok(!JSON.stringify((e as { toEnvelope?: () => unknown }).toEnvelope?.() ?? e).includes('TOP-SECRET'));
  });
});

describe('the writer lock', () => {
  it('two concurrent imports never interleave and neither meets "import in progress" or SQLITE_BUSY', async () => {
    const t = await emptyDb();
    try {
      const events: string[] = [];
      const pA = await writeText(t.dir, 'A/conversations.json', conversationsJson([chat(syntheticUuid(0x71), 'lock a', [['aa', 'ab'], ['ac', 'ad']])]));
      const pB = await writeText(t.dir, 'B/conversations.json', conversationsJson([chat(syntheticUuid(0x72), 'lock b', [['ba', 'bb']])]));
      const mk = (label: string, path: string): Parameters<Gcr['importExport']>[0] => ({ source: { kind: 'path', path }, onProgress: (e) => events.push(`${label}:${e.phase}`) });
      const [a, b] = await Promise.all([t.gcr.importExport(mk('A', pA)), t.gcr.importExport(mk('B', pB))]);
      assert.equal(a.data.conversations.stored, 1);
      assert.equal(b.data.conversations.stored, 1);
      assert.ok(events.length > 0);
      const lastA = events.findLastIndex((e) => e.startsWith('A:'));
      const firstB = events.findIndex((e) => e.startsWith('B:'));
      assert.ok(lastA >= 0 && firstB >= 0 && lastA < firstB, `A's events all precede B's: ${events.join(',')}`);
      assert.equal(t.gcr.list().data.total, 2);
      assert.deepEqual(t.gcr.listBatches().map((x) => x.batchId), [a.data.batchId, b.data.batchId], 'batches are numbered in call order');
    } finally {
      await t.cleanup();
    }
  });

  it('a draft started together with an import runs only AFTER the import has committed', async () => {
    const dir = await makeTempDir();
    const dbPath = join(dir, 'lock.sqlite');
    const sidecar: { db?: DatabaseSync } = {};
    const seenByDraft: { batches: number; imports: number } = { batches: -1, imports: 0 };
    const importEvents: string[] = [];
    // The handle clock is only used by local writes here (imports pass their own), so it marks "the draft is running".
    const gcr = Gcr.open({
      dbPath,
      clock: () => {
        seenByDraft.batches = Number(sidecar.db?.prepare('SELECT count(*) AS n FROM source_batches').get()?.['n']);
        seenByDraft.imports = importEvents.length;
        return FIXED_NOW;
      },
    });
    try {
      await importBuilders(gcr, dir, [chat(ID.linear, 'anchor', [['anchor question', 'anchor answer']])]);
      sidecar.db = new DatabaseSync(dbPath, { readOnly: true });
      const path = await writeText(dir, 'late/conversations.json', conversationsJson([chat(ID.branched, 'late', [['late question', 'late answer']])]));
      const imp = gcr.importExport({ source: { kind: 'path', path }, clock: fixedClock, onProgress: (e) => importEvents.push(e.phase) });
      const draft = gcr.createDraft({ conversationRef: ID.linear, body: 'written while the import is in flight' });
      const [i, d] = await Promise.all([imp, draft]);
      assert.equal(i.data.conversations.stored, 1);
      assert.equal(d.data.draft.body, 'written while the import is in flight');
      assert.equal(seenByDraft.batches, 2, 'both batches were committed when the draft ran');
      assert.ok(seenByDraft.imports > 0 && importEvents.length === seenByDraft.imports, 'no import progress happened after the draft started');
    } finally {
      sidecar.db?.close();
      gcr.close();
      await removeDir(dir);
    }
  });

  it('a mixed burst of mutators (import, draft, graph build, annotation, archive) all succeed in call order', async () => {
    const t = await emptyDb();
    try {
      await importBuilders(t.gcr, t.dir, [chat(ID.linear, 'burst anchor', [['burst question', 'burst answer']])]);
      const done: string[] = [];
      const track = <T>(name: string, p: Promise<T>): Promise<T> => p.then((v) => (done.push(name), v));
      const path = await writeText(t.dir, 'burst/conversations.json', conversationsJson([chat(ID.branched, 'burst import', [['b', 'c']])]));
      const draft = track('draft', t.gcr.createDraft({ conversationRef: ID.linear, body: 'burst draft' }));
      const imp = track('import', t.gcr.importExport({ source: { kind: 'path', path } }));
      const graph = track('graph', t.gcr.buildGraph({ minEntityConversations: 1 }));
      const note = track('note', t.gcr.createAnnotation({ conversationRef: ID.linear, body: 'burst note' }));
      const archived = draft.then((d) => track('archive', t.gcr.archiveDraft(d.data.draft.draftId)));
      const [draftEnv, ...others] = await Promise.all([draft, imp, graph, note, archived]);
      for (const r of [draftEnv, ...others]) assertEnvelopeShape(r as never);
      assert.deepEqual(done.slice(0, 4), ['draft', 'import', 'graph', 'note']);
      assert.equal(t.gcr.getDraft(draftEnv.data.draft.draftId).data.draft.status, 'archived');
    } finally {
      await t.cleanup();
    }
  });

  it('25 concurrent draft creations all succeed, get distinct ids, and leave a gap-free audit log', async () => {
    const t = await emptyDb();
    try {
      await importBuilders(t.gcr, t.dir, [chat(ID.linear, 'many drafts', [['q', 'a']])]);
      const results = await Promise.all(Array.from({ length: 25 }, (_, i) => t.gcr.createDraft({ conversationRef: ID.linear, body: `draft number ${i}` })));
      assert.equal(new Set(results.map((r) => r.data.draft.draftId)).size, 25);
      assert.deepEqual(results.map((r) => r.data.draft.body), Array.from({ length: 25 }, (_, i) => `draft number ${i}`), 'created in call order');
      const raw = new DatabaseSync(t.dbPath, { readOnly: true });
      try {
        const seqs = raw.prepare('SELECT seq FROM local_audit_log ORDER BY seq').all().map((r) => Number(r['seq']));
        assert.deepEqual(seqs, Array.from({ length: 25 }, (_, i) => i + 1));
      } finally {
        raw.close();
      }
    } finally {
      await t.cleanup();
    }
  });

  it('reads are refused while a mutator is running (they would see uncommitted rows) and work again right after', async () => {
    const t = await emptyDb();
    try {
      const path = await writeText(t.dir, 'busy/conversations.json', conversationsJson([chat(syntheticUuid(0x73), 'busy', [['q', 'a']])]));
      const seen: unknown[] = [];
      const env = await t.gcr.importExport({
        source: { kind: 'path', path },
        onProgress: () => {
          for (const read of [() => t.gcr.list(), () => t.gcr.search({ query: 'q' }), () => t.gcr.listBatches(), () => t.gcr.stats({ groupBy: 'role' }), () => t.gcr.get(syntheticUuid(0x73)), () => t.gcr.listDrafts()]) {
            seen.push(thrown(read));
          }
        },
      });
      assert.ok(seen.length >= 6);
      for (const e of seen) {
        const g = expectGcr(e, 'DB_ERROR');
        assert.equal(g.details?.['reason'], 'write_in_progress');
        assert.match(g.remedy ?? '', /Await/);
      }
      assert.equal(t.gcr.list().data.total, 1);
      assert.equal(env.data.conversations.stored, 1);
    } finally {
      await t.cleanup();
    }
  });

  it('a failing mutator does not block the ones queued behind it', async () => {
    const t = await emptyDb();
    try {
      const good = await writeText(t.dir, 'good/conversations.json', conversationsJson([chat(syntheticUuid(0x74), 'survivor', [['q', 'a']])]));
      const [bad, ok1, bad2, ok2] = await Promise.allSettled([
        t.gcr.importExport({ source: { kind: 'path', path: join(t.dir, 'missing.json') } }),
        t.gcr.importExport({ source: { kind: 'path', path: good } }),
        t.gcr.createDraft({ conversationRef: syntheticUuid(0x7f), body: 'no such conversation' }),
        t.gcr.createDraft({ conversationRef: syntheticUuid(0x74), body: 'fine' }),
      ]);
      assert.equal(bad.status, 'rejected');
      assert.equal(ok1.status, 'fulfilled');
      assert.equal(bad2.status, 'rejected');
      assert.equal(ok2.status, 'fulfilled');
      expectGcr((bad2 as PromiseRejectedResult).reason, 'NOT_IN_LOCAL_EXPORT');
    } finally {
      await t.cleanup();
    }
  });

  it('reads on a handle that is idle are never blocked by an earlier mutator that has finished', async () => {
    const t = await emptyDb();
    try {
      await importBuilders(t.gcr, t.dir, [chat(ID.linear, 'idle', [['q', 'a']])]);
      await t.gcr.createDraft({ conversationRef: ID.linear, body: 'done' });
      assert.equal(t.gcr.list().data.total, 1);
      assert.equal(t.gcr.listDrafts().data.total, 1);
    } finally {
      await t.cleanup();
    }
  });
});
