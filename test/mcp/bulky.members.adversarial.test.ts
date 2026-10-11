/**
 * Adversarial review, second pass (MCP lens: "result-size and time bounds", "tools that write what they claim",
 * "resource cleanup on client disconnect").
 *
 * Defects pinned here:
 *  1. A result member that is not a list cannot be cut, so one bulky member made the WHOLE result unreturnable. The SDK attaches
 *     the observed `FormatProfile` of an import to the import result and (for the life of the handle) to every stats and audit
 *     result; its `roleCounts` is keyed by the export's own role strings, which are data. After importing an export with a few
 *     thousand distinct role names through `gcr_import_export`, the import itself was reported as a failure (result_too_large,
 *     although it had committed) and `gcr_stats` / `gcr_audit` answered result_too_large for as long as the server ran, whatever
 *     the arguments (no narrowing can help). The bulky member must be dropped, with a warning, and the rest returned.
 *  2. When the FIRST item of a page alone exceeded the cap (a title of 8192 quote characters is 16 KB once escaped; the smallest
 *     allowed cap is 8192 bytes), the page came back empty with `nextOffset` equal to the offset it was asked for. A client that
 *     pages by following `nextOffset` (every automated pager does) then asked for the same page for ever.
 *  3. The provenance list `source` (one entry per import batch that contributed) is not part of `data`, so no reduction plan could
 *     shorten it. A database that holds a few hundred separate batches (every manual copy and every separate export is one)
 *     made `gcr_stats` and `gcr_audit` answer result_too_large for ever: 900 one-conversation batches, default cap. A bulky
 *     provenance list is now cut to a prefix (announced; `completeness` still covers every batch) instead of failing the call.
 *  4. Warning lists are not reducible either. The SDK caps the ids of one warning at 1000 (about 40 KB) and repeats every tree
 *     warning in `data.warnings` as well as in the envelope, so a conversation that raises a few such warnings (thousands of
 *     orphaned nodes, phantom children, unknown content types) could not be read through gcr_thread, gcr_get or gcr_branches at
 *     all: result_too_large for any arguments. The ids of an oversize warning list are now cut to the first 20 per warning
 *     (the message still gives the total).
 *  5. A write tool that was cancelled (or timed out) before it reached the SDK still performed the write: `abortable` only stops
 *     WAITING, so an import whose path checks were still in flight when the client cancelled went on to commit a batch that
 *     nobody was waiting for. A write must not START once its signal has fired.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { parseApprovedRoots } from '../../src/mcp/approved-roots.js';
import { abortable } from '../../src/mcp/registry.js';
import type { ToolCallContext, ToolEntry } from '../../src/mcp/registry.js';
import { buildToolTable } from '../../src/mcp/tools.js';
import { Gcr } from '../../src/sdk/gcr.js';
import { ConversationBuilder, syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import { ID, connectMem, conversationsJson, linearChat, makeTempDir, removeDir, tableRows, writeText } from './mcp.helpers.test.js';
import type { MemHarness } from './mcp.helpers.test.js';

const CAP = 20_000;

/** One conversation whose messages are authored by `roles` distinct role names (role strings are DATA taken from the export). */
function manyRolesExport(roles: number): string {
  const b = new ConversationBuilder({ id: syntheticUuid(0x31), title: 'many roles' });
  let prev = b.user(b.root(), 'hello');
  for (let i = 0; i < roles; i++) prev = b.message(prev, `role-${i}-${'x'.repeat(20)}`, { content_type: 'text', parts: ['m'] });
  return `[${b.text()}]`;
}

describe('one bulky non-list member must not make a whole result unreturnable', () => {
  let dir: string;
  let root: string;
  let h: MemHarness;
  before(async () => {
    dir = await makeTempDir();
    root = join(dir, 'approved');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'many-roles.json'), manyRolesExport(1500)); // about 55 KB of role names: far above the 20 KB cap
    await writeText(root, join('normal', 'conversations.json'), conversationsJson([linearChat(ID.linear, 'normal export', [['hello', 'hi']])]));
    const dbPath = join(dir, 'g.sqlite');
    Gcr.open({ dbPath }).close();
    h = await connectMem(dbPath, { writable: true, server: { maxResultBytes: CAP, approvedImportRoots: parseApprovedRoots(root) } });
  });
  after(async () => {
    await h.close();
    await removeDir(dir);
  });

  it('control: a normal export keeps its format profile in the import, stats and audit results', async () => {
    const imp = await h.env('gcr_import_export', { path: join(root, 'normal', 'conversations.json') });
    assert.equal(imp.ok, true, imp.error?.message);
    assert.equal(imp.truncated, false);
    assert.ok((imp.data as { formatProfile?: unknown }).formatProfile !== undefined, 'the observed profile is part of the import result');
    const stats = await h.env('gcr_stats', { groupBy: 'role' });
    assert.equal(stats.ok, true, stats.error?.message);
    assert.equal(stats.truncated, false);
    assert.equal((stats.data as { formatProfiles: unknown[] }).formatProfiles.length, 1);
  });

  it('an import with thousands of distinct role names succeeds and says what it left out', async () => {
    const imp = await h.env('gcr_import_export', { path: join(root, 'many-roles.json') });
    assert.equal(imp.ok, true, `the import committed; the result must not claim a failure: ${JSON.stringify(imp.error)}`);
    const report = imp.data as { alreadyImported: boolean; conversations: { stored: number }; formatProfile?: unknown };
    assert.equal(report.alreadyImported, false);
    assert.equal(report.conversations.stored, 1);
    assert.equal(report.formatProfile, undefined, 'the oversize profile was omitted');
    assert.equal(imp.truncated, true);
    const warning = imp.warnings.find((w) => w.code === 'RESULT_TRUNCATED');
    assert.ok(warning !== undefined, 'the omission is announced');
    assert.match(warning.message, /formatProfile/);
    assert.ok(Buffer.byteLength(JSON.stringify(imp)) <= CAP);
  });

  it('stats and audit keep working afterwards, whatever the arguments, and announce the omitted profiles', async () => {
    for (const [tool, args] of [
      ['gcr_stats', { groupBy: 'role', limit: 5 }],
      ['gcr_stats', { groupBy: 'provider' }],
      ['gcr_audit', {}],
      ['gcr_audit', { checks: ['empty'], sampleSize: 1 }],
    ] as const) {
      const env = await h.env(tool, args);
      assert.equal(env.ok, true, `${tool} ${JSON.stringify(args)}: ${env.error?.details?.['reason']}`);
      assert.equal(env.truncated, true, tool);
      assert.match(env.warnings.find((w) => w.code === 'RESULT_TRUNCATED')?.message ?? '', /formatProfiles/, tool);
      assert.deepEqual((env.data as { formatProfiles: unknown[] }).formatProfiles, [], tool);
      assert.ok(Buffer.byteLength(JSON.stringify(env)) <= CAP, tool);
    }
  });
});

describe('a page whose first item cannot fit still lets a pager make progress', () => {
  let dir: string;
  let h: MemHarness;
  before(async () => {
    dir = await makeTempDir();
    const make = (n: number, title: string): ConversationBuilder => {
      const b = new ConversationBuilder({ id: syntheticUuid(0x60 + n), title });
      b.assistant(b.user(b.root(), 'q'), 'a');
      return b;
    };
    const path = await writeText(dir, join('e', 'conversations.json'), conversationsJson([make(1, 'small one'), make(2, '"'.repeat(8000)), make(3, 'small three')]));
    const dbPath = join(dir, 'g.sqlite');
    const gcr = Gcr.open({ dbPath });
    await gcr.importExport({ source: { kind: 'path', path } });
    gcr.close();
    h = await connectMem(dbPath, { server: { maxResultBytes: 8192 } });
  });
  after(async () => {
    await h.close();
    await removeDir(dir);
  });

  it('following nextOffset one item at a time terminates, steps over the unreturnable item and says so', async () => {
    const seen: string[] = [];
    const offsets: number[] = [];
    let offset: number | null = 0;
    let announced = false;
    while (offset !== null) {
      assert.ok(offsets.length < 10, `the pager is stuck: offsets ${offsets.join(',')}`);
      offsets.push(offset);
      const env = await h.env('gcr_list', { limit: 1, offset, sort: 'title_asc' });
      assert.equal(env.ok, true);
      const data = env.data as { items: Array<{ title: string | null }>; nextOffset: number | null };
      for (const item of data.items) seen.push(item.title ?? '');
      if (env.truncated) announced = env.warnings.some((w) => w.code === 'RESULT_TRUNCATED');
      assert.ok(data.nextOffset === null || data.nextOffset > offset, `nextOffset ${data.nextOffset} must move past ${offset}`);
      offset = data.nextOffset;
    }
    assert.deepEqual(seen, ['small one', 'small three']);
    assert.equal(announced, true, 'the skipped item is announced by a RESULT_TRUNCATED warning');
  });
});

describe('a database with very many import batches', () => {
  const BATCHES = 140; // each contributes one `source` entry of about 300 bytes: 42 KB, above the 20 KB cap used here
  let dir: string;
  let h: MemHarness;
  before(async () => {
    dir = await makeTempDir();
    const dbPath = join(dir, 'g.sqlite');
    const gcr = Gcr.open({ dbPath });
    for (let i = 0; i < BATCHES; i++) {
      const b = new ConversationBuilder({ id: syntheticUuid(0x200 + i), title: `batch conversation ${i}` });
      b.assistant(b.user(b.root(), `question ${i}`), `answer ${i}`);
      await gcr.importExport({ source: { kind: 'stream', stream: (async function* () { yield Buffer.from(`[${b.text()}]`); })(), label: 'conversations.json' } });
    }
    gcr.close();
    h = await connectMem(dbPath, { server: { maxResultBytes: CAP } });
  });
  after(async () => {
    await h.close();
    await removeDir(dir);
  });

  for (const [tool, args] of [
    ['gcr_stats', { groupBy: 'role' }],
    ['gcr_audit', {}],
  ] as const) {
    it(`${tool} answers, with the provenance list cut to a prefix and said so`, async () => {
      const env = await h.env(tool, args);
      assert.equal(env.ok, true, `${env.error?.code} ${JSON.stringify(env.error?.details)}`);
      assert.equal(env.truncated, true);
      assert.ok(env.source.length > 0 && env.source.length < BATCHES, `${env.source.length} sources kept`);
      const warning = env.warnings.find((w) => w.code === 'RESULT_TRUNCATED');
      assert.match(warning?.message ?? '', new RegExp(`source: kept ${env.source.length} of ${BATCHES}`));
      assert.ok(Buffer.byteLength(JSON.stringify(env)) <= CAP);
      assert.equal(new Set(env.source.map((x) => x.batchId)).size, env.source.length, 'a prefix of distinct batches');
    });
  }

  it('a result whose provenance is small is untouched (control)', async () => {
    const env = await h.env('gcr_list', { limit: 3 });
    assert.equal(env.ok, true);
    assert.equal(env.truncated, false);
  });
});

describe('a conversation that raises several very large warning lists', () => {
  let dir: string;
  let h: MemHarness;
  const id = syntheticUuid(0x33);
  before(async () => {
    dir = await makeTempDir();
    const b = new ConversationBuilder({ id, title: 'many warnings' });
    const fork = b.user(b.root(), 'hello');
    for (let i = 0; i < 2500; i++) b.message(`missing-${i}`, 'user', { content_type: 'text', parts: [`orphan ${i}`] }); // MISSING_PARENT
    for (let i = 0; i < 2500; i++) b.message(fork, 'assistant', { content_type: `weird_type_${i}`, parts: [`odd ${i}`] }); // UNKNOWN_CONTENT_TYPE
    for (let i = 0; i < 2500; i++) b.rawNode(`raw-${i}`, { id: `raw-${i}`, message: null, parent: fork, children: [`ghost-${i}`] }); // CHILD_NOT_FOUND
    const path = await writeText(dir, join('e', 'conversations.json'), conversationsJson([b]));
    const dbPath = join(dir, 'g.sqlite');
    const gcr = Gcr.open({ dbPath });
    await gcr.importExport({ source: { kind: 'path', path } });
    gcr.close();
    h = await connectMem(dbPath);
  });
  after(async () => {
    await h.close();
    await removeDir(dir);
  });

  for (const [tool, args] of [
    ['gcr_thread', { conversation: id, branchPolicy: 'last_child' }],
    ['gcr_get', { conversation: id, branchPolicy: 'last_child' }],
    ['gcr_branches', { conversation: id }],
  ] as const) {
    it(`${tool} answers: the ids of each oversize warning are cut to a prefix and the totals stay in the message`, async () => {
      const env = await h.env(tool, args);
      assert.equal(env.ok, true, `${env.error?.code} ${JSON.stringify(env.error?.details)}`);
      assert.equal(env.truncated, true);
      assert.ok(Buffer.byteLength(JSON.stringify(env)) <= 200_000);
      const missing = env.warnings.find((w) => w.code === 'MISSING_PARENT');
      assert.ok(missing !== undefined, 'the warning itself is kept');
      assert.ok((missing.ids?.length ?? 0) <= 20, `${missing.ids?.length} ids listed`);
      assert.match(missing.message, /2500 ids; first 1000 listed/, 'the SDK total stays');
      assert.match(missing.message, /lists the first 20/, 'and this response says how many it lists');
      const note = env.warnings.find((w) => w.code === 'RESULT_TRUNCATED');
      assert.match(note?.message ?? '', /warnings/);
    });
  }

  it('control: a conversation with a few small warnings keeps every id and is not flagged', async () => {
    const env = await h.env('gcr_list', {});
    assert.equal(env.truncated, false);
  });
});

describe('a write does not start once its signal has fired', () => {
  let dir: string;
  let root: string;
  let dbPath: string;
  let gcr: Gcr;
  let table: readonly ToolEntry[];
  before(async () => {
    dir = await makeTempDir();
    root = join(dir, 'approved');
    dbPath = join(dir, 'g.sqlite');
    await writeText(root, join('export', 'conversations.json'), conversationsJson([linearChat(syntheticUuid(0x41), 'import me', [['hello', 'hi']])]));
    const seed = Gcr.open({ dbPath });
    await seed.importExport({ source: { kind: 'path', path: join(root, 'export', 'conversations.json') }, accountLabel: 'seed' });
    seed.close();
    gcr = Gcr.open({ dbPath, actor: 'mcp' });
    table = buildToolTable({ gcr, allowWrites: true, approvedRoots: parseApprovedRoots(root), importDeadlineMs: 60_000 });
  });
  after(async () => {
    gcr.close();
    await removeDir(dir);
  });

  const entry = (name: string): ToolEntry => {
    const found = table.find((t) => t.name === name);
    assert.ok(found !== undefined, name);
    return found;
  };
  /** The context the registry would hand over for a call whose client has already cancelled. */
  function cancelledContext(): ToolCallContext {
    const controller = new AbortController();
    controller.abort(new Error('cancelled by the client'));
    return { signal: controller.signal, abortable: (work) => abortable(controller.signal, work), reportProgress: () => undefined };
  }
  const abortedBy = (e: unknown): boolean => e instanceof Error && e.message === 'cancelled by the client';
  const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const counts = (): { batches: number; drafts: number; annotations: number; audit: number } => ({
    batches: tableRows(dbPath, 'source_batches').length,
    drafts: tableRows(dbPath, 'local_drafts').length,
    annotations: tableRows(dbPath, 'local_annotations').length,
    audit: tableRows(dbPath, 'local_audit_log').length,
  });

  it('gcr_import_export: nothing is imported for a cancelled call', async () => {
    const before = counts();
    await assert.rejects(async () => entry('gcr_import_export').run({ path: join(root, 'export', 'conversations.json'), accountLabel: 'late' }, cancelledContext()), abortedBy);
    await settle(700); // the import, if it had been started, takes a few milliseconds
    assert.deepEqual(counts(), before, 'no batch was committed for a call nobody is waiting for');
  });

  it('gcr_create_local_draft and gcr_update_local_annotation: nothing is written for a cancelled call', async () => {
    const before = counts();
    await assert.rejects(async () => entry('gcr_create_local_draft').run({ conversation: syntheticUuid(0x41), accountLabel: 'seed', body: 'late draft' }, cancelledContext()), abortedBy);
    await assert.rejects(async () => entry('gcr_update_local_annotation').run({ conversation: syntheticUuid(0x41), accountLabel: 'seed', body: 'late note' }, cancelledContext()), abortedBy);
    await settle(300);
    assert.deepEqual(counts(), before);
  });

  it('control: the same calls with a live signal do write', async () => {
    const live: ToolCallContext = { signal: new AbortController().signal, abortable: (work) => work, reportProgress: () => undefined };
    const before = counts();
    await entry('gcr_create_local_draft').run({ conversation: syntheticUuid(0x41), accountLabel: 'seed', body: 'on time' }, live);
    assert.equal(counts().drafts, before.drafts + 1);
  });
});
