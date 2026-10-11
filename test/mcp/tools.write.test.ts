/**
 * The write policy and the three write tools (gcr_create_local_draft, gcr_update_local_annotation, gcr_import_export):
 *  - the server is read-only by default and says so with WRITE_FORBIDDEN and the remedy;
 *  - with writes enabled, drafts and annotations are stored locally, audited (ids and hashes only, never body text), and
 *    nothing can be sent anywhere (a draft has no "sent" state);
 *  - import reads only paths under approved roots.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { ErrorCode } from '../../src/errors.js';
import { parseApprovedRoots } from '../../src/mcp/approved-roots.js';
import type { McpEnvelope } from '../../src/mcp/envelope.js';
import { Gcr } from '../../src/sdk/gcr.js';
import { syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import { buildZip } from '../helpers/zip-builder.js';
import type { Fixture, MemHarness } from './mcp.helpers.test.js';
import { ID, connectMem, conversationsJson, createFixture, dbContentHash, linearChat, makeTempDir, removeDir, tableRows, writeText } from './mcp.helpers.test.js';

function assertError(env: McpEnvelope, code: ErrorCode): NonNullable<McpEnvelope['error']> {
  assert.equal(env.ok, false, `expected ${code}, got success`);
  assert.ok(env.error);
  assert.equal(env.error.code, code, `expected ${code}, got ${env.error.code}: ${env.error.message}`);
  return env.error;
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

const DRAFT = { conversation: ID.linear, body: 'DRAFT-BODY-MARKER please review this reply', title: 'DRAFT-TITLE-MARKER' } as const;

describe('read-only is the default: every write tool answers WRITE_FORBIDDEN with the remedy', () => {
  let fx: Fixture;
  let h: MemHarness;
  before(async () => {
    fx = await createFixture();
    h = await connectMem(fx.dbPath); // read-only handle, allowWrites false
  });
  after(async () => {
    await h.close();
    await fx.cleanup();
  });

  it('drafts, annotations (create and update) are refused and the database is byte-for-byte unchanged', async () => {
    const before = dbContentHash(fx.dbPath);
    const calls: Array<[string, Record<string, unknown>]> = [
      ['gcr_create_local_draft', { ...DRAFT }],
      ['gcr_update_local_annotation', { conversation: ID.linear, body: 'a note' }],
      ['gcr_update_local_annotation', { annotationId: 'note-1', expectedVersion: 1, body: 'changed' }],
    ];
    for (const [tool, args] of calls) {
      const err = assertError(await h.env(tool, args), 'WRITE_FORBIDDEN');
      assert.match(err.remedy ?? '', /--allow-local-writes/);
      assert.match(err.remedy ?? '', /GCR_MCP_ALLOW_WRITES=1/);
      assert.equal(err.details?.['reason'], 'writes_disabled');
    }
    assert.equal(dbContentHash(fx.dbPath), before);
  });

  it('import is refused: IMPORT_PATH_NOT_ALLOWED while no root is configured, and the remedy explains how to enable it', async () => {
    const err = assertError(await h.env('gcr_import_export', { path: '/etc/passwd' }), 'IMPORT_PATH_NOT_ALLOWED');
    assert.equal(err.details?.['reason'], 'no_approved_roots');
    assert.match(err.remedy ?? '', /GCR_APPROVED_IMPORT_ROOTS/);
    assert.match(err.remedy ?? '', /--allow-local-writes/);
    assert.ok(!JSON.stringify(err).includes('/etc/passwd'), 'the path is never echoed');
  });

  it('the tool list is the same with writes disabled: the write tools are registered, not hidden', async () => {
    const names = (await h.client.listTools()).tools.map((t) => t.name);
    for (const n of ['gcr_create_local_draft', 'gcr_update_local_annotation', 'gcr_import_export']) assert.ok(names.includes(n), n);
  });
});

describe('the policy is enforced by the server, not only by the handle', () => {
  it('allowWrites:false over a WRITABLE handle still refuses (the flag, not the file mode, is the switch)', async () => {
    const fx = await createFixture();
    const gcr = Gcr.open({ dbPath: fx.dbPath, actor: 'mcp' });
    const { createGcrMcpServer } = await import('../../src/mcp/server.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { callTool, envelopeOf } = await import('./mcp.helpers.test.js');
    const server = createGcrMcpServer(gcr, { allowWrites: false });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    await client.listTools();
    try {
      const before = dbContentHash(fx.dbPath);
      assertError(envelopeOf(await callTool(client, 'gcr_create_local_draft', { ...DRAFT })), 'WRITE_FORBIDDEN');
      assert.equal(dbContentHash(fx.dbPath), before);
    } finally {
      await client.close();
      await server.close();
      gcr.close();
      await fx.cleanup();
    }
  });

  it('allowWrites:true over a READ-ONLY handle is WRITE_FORBIDDEN with its own reason', async () => {
    const fx = await createFixture();
    const h = await connectMem(fx.dbPath, { writable: false, server: { allowWrites: true } });
    try {
      const err = assertError(await h.env('gcr_create_local_draft', { ...DRAFT }), 'WRITE_FORBIDDEN');
      assert.equal(err.details?.['reason'], 'database_read_only');
    } finally {
      await h.close();
      await fx.cleanup();
    }
  });
});

describe('local writes enabled', () => {
  let fx: Fixture;
  let h: MemHarness;
  before(async () => {
    fx = await createFixture({ secondAccount: true });
    h = await connectMem(fx.dbPath, { writable: true });
  });
  after(async () => {
    await h.close();
    await fx.cleanup();
  });

  describe('gcr_create_local_draft', () => {
    it('stores a local draft anchored to the conversation and labels it local-only, never sent', async () => {
      const importedBefore = tableRows(fx.dbPath, 'conversations');
      const env = await h.env('gcr_create_local_draft', { ...DRAFT, accountLabel: 'default' });
      assert.equal(env.ok, true, env.error?.message);
      const data = env.data as { localOnly: boolean; draft: Record<string, unknown> };
      assert.equal(data.localOnly, true);
      assert.equal(data.draft['status'], 'draft', 'a draft has no "sent" state');
      assert.equal(data.draft['conversationId'], ID.linear);
      assert.equal(data.draft['accountLabel'], 'default');
      assert.equal(data.draft['createdVia'], 'mcp');
      assert.equal(data.draft['body'], DRAFT.body);
      assert.equal(data.draft['bodySha256'], sha256(DRAFT.body));
      const cont = data.draft['manualContinuation'] as { url: string; note: string };
      assert.equal(cont.url, `https://chatgpt.com/c/${ID.linear}`, 'link TEXT for the human; never opened by GCR');
      assert.match(cont.note, /never sends/i);
      assert.deepEqual(env.ids.draftIds, [data.draft['draftId']]);
      assert.equal(env.untrustedContent, true);
      // stored locally, imported rows untouched
      const rows = tableRows(fx.dbPath, 'local_drafts');
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.['body'], DRAFT.body);
      assert.equal(rows[0]?.['created_via'], 'mcp');
      assert.deepEqual(tableRows(fx.dbPath, 'conversations'), importedBefore);
    });

    it('audits the write with ids and hashes only: no body or title text anywhere in the log', async () => {
      const rows = tableRows(fx.dbPath, 'local_audit_log');
      assert.ok(rows.length >= 1);
      const last = rows[rows.length - 1] as Record<string, unknown>;
      assert.equal(last['actor'], 'mcp');
      assert.match(String(last['action']), /draft/);
      const everything = JSON.stringify(rows);
      assert.ok(!everything.includes('DRAFT-BODY-MARKER'));
      assert.ok(!everything.includes('DRAFT-TITLE-MARKER'));
    });

    it('anchors to a message, rejects an unknown message and an unknown conversation', async () => {
      const ok = await h.env('gcr_create_local_draft', { conversation: ID.branched, body: 'anchored', anchorMessageId: fx.branched.a1 });
      assert.equal(ok.ok, true, ok.error?.message);
      assert.equal((ok.data as { draft: { anchorMessageId: string } }).draft.anchorMessageId, fx.branched.a1);
      assert.deepEqual(ok.ids.messageIds, [fx.branched.a1]);
      assertError(await h.env('gcr_create_local_draft', { conversation: ID.branched, body: 'x', anchorMessageId: 'no-such-message' }), 'MESSAGE_NOT_FOUND');
      assertError(await h.env('gcr_create_local_draft', { conversation: ID.absent, body: 'x' }), 'NOT_IN_LOCAL_EXPORT');
      assertError(await h.env('gcr_create_local_draft', { conversation: `https://chatgpt.com/c/${ID.absent}`, body: 'x' }), 'NOT_IN_LOCAL_EXPORT');
    });

    it('an id that exists under two accounts needs the account (ambiguity is not guessed away)', async () => {
      assertError(await h.env('gcr_create_local_draft', { conversation: ID.linear, body: 'x' }), 'AMBIGUOUS_CONVERSATION');
      assert.equal((await h.env('gcr_create_local_draft', { conversation: ID.linear, accountLabel: 'other', body: 'x' })).ok, true);
    });

    it('bounds are enforced by the schema, text hygiene by the store', async () => {
      const cases: Array<Record<string, unknown>> = [
        { conversation: ID.branched, body: '' },
        { conversation: ID.branched, body: 'x'.repeat(65_537) },
        { conversation: ID.branched, body: 'x', title: 'y'.repeat(201) },
        { conversation: ID.branched, body: 'x', namespace: 'Has Space' },
        { conversation: ID.branched, body: 'x', status: 'sent' },
        { conversation: ID.branched, body: 'x', send: true },
      ];
      for (const args of cases) assertError(await h.env('gcr_create_local_draft', args), 'INVALID_ARGUMENT');
      // a lone surrogate would be silently rewritten by SQLite, so the store refuses it
      assertError(await h.env('gcr_create_local_draft', { conversation: ID.branched, body: `bad ${String.fromCharCode(0xd800)} text` }), 'INVALID_ARGUMENT');
      // NUL bytes are stripped (SPEC), and the hash is of exactly what is stored
      const env = await h.env('gcr_create_local_draft', { conversation: ID.branched, body: 'a\u0000b' });
      assert.equal(env.ok, true, env.error?.message);
      const draft = (env.data as { draft: { body: string; bodySha256: string } }).draft;
      assert.equal(draft.body, 'ab');
      assert.equal(draft.bodySha256, sha256('ab'));
    });

    it('keeps drafts of different namespaces apart and never offers a way to mark one as sent', async () => {
      const env = await h.env('gcr_create_local_draft', { conversation: ID.branched, body: 'ns draft', namespace: 'review.queue' });
      assert.equal((env.data as { draft: { namespace: string } }).draft.namespace, 'review.queue');
      const tools = (await h.client.listTools()).tools;
      for (const t of tools) {
        const props = Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
        assert.ok(!props.includes('status'), `${t.name} exposes no status field`);
      }
    });

    it('creates distinct drafts under concurrent calls, each with one audit row', async () => {
      const before = tableRows(fx.dbPath, 'local_audit_log').length;
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => h.env('gcr_create_local_draft', { conversation: ID.branched, body: `concurrent ${i}` })));
      assert.ok(results.every((r) => r.ok));
      const ids = results.map((r) => (r.data as { draft: { draftId: string } }).draft.draftId);
      assert.equal(new Set(ids).size, 20);
      assert.equal(tableRows(fx.dbPath, 'local_audit_log').length - before, 20);
    });
  });

  describe('gcr_update_local_annotation', () => {
    let annotationId = '';

    it('creates a conversation-level annotation and a message-level one', async () => {
      const created = await h.env('gcr_update_local_annotation', { conversation: ID.branched, body: 'ANNOTATION-BODY-MARKER v1', kind: 'review', namespace: 'notes' });
      assert.equal(created.ok, true, created.error?.message);
      const a = (created.data as { localOnly: boolean; annotation: { annotationId: string; version: number; messageId: string | null; kind: string; namespace: string; createdVia: string } });
      assert.equal(a.localOnly, true);
      assert.equal(a.annotation.version, 1);
      assert.equal(a.annotation.messageId, null);
      assert.equal(a.annotation.kind, 'review');
      assert.equal(a.annotation.namespace, 'notes');
      assert.equal(a.annotation.createdVia, 'mcp');
      annotationId = a.annotation.annotationId;
      assert.deepEqual(created.ids.annotationIds, [annotationId]);
      const onMessage = await h.env('gcr_update_local_annotation', { conversation: ID.branched, body: 'on a message', messageId: fx.branched.u1 });
      assert.equal((onMessage.data as { annotation: { messageId: string } }).annotation.messageId, fx.branched.u1);
    });

    it('updates with optimistic concurrency: the version moves, a stale version is ANNOTATION_CONFLICT, nothing is written then', async () => {
      const updated = await h.env('gcr_update_local_annotation', { annotationId, expectedVersion: 1, body: 'ANNOTATION-BODY-MARKER v2' });
      assert.equal(updated.ok, true, updated.error?.message);
      assert.equal((updated.data as { annotation: { version: number; body: string } }).annotation.version, 2);
      const hashBefore = dbContentHash(fx.dbPath);
      const err = assertError(await h.env('gcr_update_local_annotation', { annotationId, expectedVersion: 1, body: 'stale write' }), 'ANNOTATION_CONFLICT');
      assert.ok(err.message.length > 0);
      assert.equal(dbContentHash(fx.dbPath), hashBefore, 'a conflict writes nothing, not even an audit row');
    });

    it('unknown annotation id is ANNOTATION_NOT_FOUND', async () => {
      assertError(await h.env('gcr_update_local_annotation', { annotationId: 'does-not-exist', expectedVersion: 1, body: 'x' }), 'ANNOTATION_NOT_FOUND');
    });

    it('refuses ambiguous or mixed modes instead of silently ignoring a field', async () => {
      assertError(await h.env('gcr_update_local_annotation', { body: 'no target' }), 'INVALID_ARGUMENT');
      assertError(await h.env('gcr_update_local_annotation', { annotationId, body: 'missing version' }), 'INVALID_ARGUMENT');
      assertError(await h.env('gcr_update_local_annotation', { conversation: ID.branched, expectedVersion: 1, body: 'version on create' }), 'INVALID_ARGUMENT');
      assertError(await h.env('gcr_update_local_annotation', { annotationId, expectedVersion: 2, conversation: ID.branched, body: 'create fields on update' }), 'INVALID_ARGUMENT');
      assertError(await h.env('gcr_update_local_annotation', { annotationId, expectedVersion: 2, kind: 'x', body: 'kind on update' }), 'INVALID_ARGUMENT');
    });

    it('schema bounds: body size, id and kind shapes', async () => {
      const cases: Array<Record<string, unknown>> = [
        { conversation: ID.branched, body: '' },
        { conversation: ID.branched, body: 'x'.repeat(16_385) },
        { annotationId: '../etc', expectedVersion: 1, body: 'x' },
        { annotationId, expectedVersion: 0, body: 'x' },
        { conversation: ID.branched, body: 'x', kind: 'Bad Kind' },
      ];
      for (const args of cases) assertError(await h.env('gcr_update_local_annotation', args), 'INVALID_ARGUMENT');
    });

    it('the audit log carries ids and hashes, never annotation text, and every row names the mcp actor', async () => {
      const rows = tableRows(fx.dbPath, 'local_audit_log');
      assert.ok(rows.some((r) => /annotation/.test(String(r['action']))));
      assert.ok(rows.every((r) => r['actor'] === 'mcp'));
      assert.ok(!JSON.stringify(rows).includes('ANNOTATION-BODY-MARKER'));
    });
  });

  it('no write left the imported tables different', async () => {
    const check = Gcr.open({ dbPath: fx.dbPath, readOnly: true });
    try {
      assert.equal(check.list().data.total, 6, 'five conversations plus the second-account snapshot of the first');
    } finally {
      check.close();
    }
  });
});

describe('write results never fail after the write committed: the echoed body is elided instead', () => {
  it('a draft body larger than the result cap is stored in full but omitted from the response, with a warning', async () => {
    const fx = await createFixture();
    const h = await connectMem(fx.dbPath, { writable: true, server: { maxResultBytes: 8192 } });
    try {
      const body = 'long-body '.repeat(5000); // 50 000 chars
      const env = await h.env('gcr_create_local_draft', { conversation: ID.linear, body });
      assert.equal(env.ok, true, env.error?.message);
      assert.equal(env.truncated, true);
      const draft = (env.data as { draft: { body: string; bodySha256: string } }).draft;
      assert.equal(draft.body, '');
      assert.equal(draft.bodySha256, sha256(body), 'the hash still identifies what was stored');
      assert.ok(env.warnings.some((w) => w.code === 'RESULT_TRUNCATED' && /omitted/.test(w.message)));
      assert.equal(tableRows(fx.dbPath, 'local_drafts')[0]?.['body'], body, 'stored in full');
    } finally {
      await h.close();
      await fx.cleanup();
    }
  });
});

describe('gcr_import_export', () => {
  let dir: string;
  let root: string;
  let outside: string;
  let dbPath: string;
  let h: MemHarness;
  const IMPORTED = syntheticUuid(0x77);

  before(async () => {
    dir = await makeTempDir();
    root = join(dir, 'approved');
    outside = join(dir, 'outside');
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    dbPath = join(dir, 'target.sqlite');
    Gcr.open({ dbPath }).close();
    await writeText(root, join('export-a', 'conversations.json'), conversationsJson([linearChat(IMPORTED, 'imported through mcp', [['hello import', 'hi there']])]));
    await writeText(outside, 'conversations.json', conversationsJson([linearChat(syntheticUuid(0x78), 'outside', [['x', 'y']])]));
    await writeFile(join(root, 'broken.json'), '{"this is": not json');
    await symlink(join(outside, 'conversations.json'), join(root, 'escape.json'));
    await symlink(join(root, 'export-a', 'conversations.json'), join(root, 'inside-link.json'));
    h = await connectMem(dbPath, { writable: true, server: { approvedImportRoots: parseApprovedRoots(root) } });
  });
  after(async () => {
    await h.close();
    await removeDir(dir);
  });

  it('imports a file inside an approved root, reports provenance, and the data is then readable and listed', async () => {
    const env = await h.env('gcr_import_export', { path: join(root, 'export-a', 'conversations.json') });
    assert.equal(env.ok, true, env.error?.message);
    const report = env.data as { alreadyImported: boolean; conversations: { stored: number }; sourceLabel: string };
    assert.equal(report.alreadyImported, false);
    assert.equal(report.conversations.stored, 1);
    assert.equal(report.sourceLabel, 'conversations.json', 'a basename, not the path');
    assert.ok(!JSON.stringify(env).includes(root), 'no absolute path in the result');
    assert.equal(env.source.length, 1);
    const got = await h.env('gcr_get', { conversation: IMPORTED });
    assert.equal(got.ok, true);
    assert.equal(((await h.env('gcr_list')).data as { total: number }).total, 1);
  });

  it('importing the same input again is an idempotent no-op', async () => {
    const env = await h.env('gcr_import_export', { path: join(root, 'export-a', 'conversations.json') });
    assert.equal(env.ok, true);
    assert.equal((env.data as { alreadyImported: boolean }).alreadyImported, true);
    assert.equal(((await h.env('gcr_list')).data as { total: number }).total, 1);
  });

  it('imports a folder, including the approved root itself (as a directory)', async () => {
    const folder = await h.env('gcr_import_export', { path: join(root, 'export-a'), accountLabel: 'folder' });
    assert.equal(folder.ok, true, folder.error?.message);
    assert.equal((folder.data as { alreadyImported: boolean }).alreadyImported, false, 'a different account label is a different batch');
  });

  it('follows a symlink that stays inside the root', async () => {
    const env = await h.env('gcr_import_export', { path: join(root, 'inside-link.json'), accountLabel: 'viaLink' });
    assert.equal(env.ok, true, env.error?.message);
    // The SDK was handed the CANONICAL path that was just verified, not the caller's spelling (a later swap of the link is not
    // followed): the batch is labelled with the target's name, not with "inside-link.json".
    assert.equal((env.data as { sourceLabel: string }).sourceLabel, 'conversations.json');
  });

  it('refuses everything else with one and the same answer: outside, missing, "..", escaping symlink, sibling prefix', async () => {
    const refused: string[] = [
      join(outside, 'conversations.json'),
      join(root, 'does-not-exist.json'),
      join(root, '..', 'outside', 'conversations.json'),
      join(root, 'export-a', '..', '..', 'outside', 'conversations.json'),
      join(root, 'escape.json'),
      `${root}-evil`,
      '/etc/passwd',
      '/',
      'relative-does-not-exist.json',
    ];
    const answers = new Set<string>();
    for (const path of refused) {
      const err = assertError(await h.env('gcr_import_export', { path }), 'IMPORT_PATH_NOT_ALLOWED');
      assert.ok(!JSON.stringify(err).includes(path) || path === '/', 'the path is never echoed');
      answers.add(JSON.stringify(err));
    }
    assert.equal(answers.size, 1, 'no oracle: an existing outside file, a missing file and an escape look identical');
  });

  it('a NUL byte or an oversized path is stopped by the schema, before any file system call', async () => {
    assertError(await h.env('gcr_import_export', { path: `${join(root, 'export-a')}\u0000/../../outside` }), 'INVALID_ARGUMENT');
    assertError(await h.env('gcr_import_export', { path: 'x'.repeat(4097) }), 'INVALID_ARGUMENT');
    assertError(await h.env('gcr_import_export', { path: '' }), 'INVALID_ARGUMENT');
    assertError(await h.env('gcr_import_export', { path: root, url: 'https://example.test/export.zip' }), 'INVALID_ARGUMENT');
  });

  it('an unreadable export inside the root is reported with an import error code, not a crash', async () => {
    const env = await h.env('gcr_import_export', { path: join(root, 'broken.json'), accountLabel: 'broken' });
    assert.equal(env.ok, false);
    assert.match(env.error?.code ?? '', /^IMPORT_/);
  });

  it('hostile archives inside the root are refused by the importer with their own codes, and nothing is stored', async () => {
    const before = ((await h.env('gcr_list', { allBatches: true })).data as { total: number }).total;
    await writeFile(join(root, 'zip-slip.zip'), buildZip([{ name: '../../escape/conversations.json', data: '[]' }]));
    await writeFile(join(root, 'wrong-shape.zip'), buildZip([{ name: 'notes.txt', data: 'not an export' }]));
    await mkdir(join(root, 'empty-folder'));
    const slip = await h.env('gcr_import_export', { path: join(root, 'zip-slip.zip'), accountLabel: 'slip' });
    assertError(slip, 'IMPORT_ZIP_UNSAFE');
    assert.ok(!JSON.stringify(slip).includes(root), 'no absolute path in the error');
    assertError(await h.env('gcr_import_export', { path: join(root, 'wrong-shape.zip'), accountLabel: 'shape' }), 'IMPORT_UNSUPPORTED_FORMAT');
    const folder = await h.env('gcr_import_export', { path: join(root, 'empty-folder'), accountLabel: 'folder-empty' });
    assert.equal(folder.ok, false);
    assert.match(folder.error?.code ?? '', /^IMPORT_/);
    assert.equal(((await h.env('gcr_list', { allBatches: true })).data as { total: number }).total, before, 'a refused import stores nothing');
  });

  it('import needs the write switch even for an allowed path', async () => {
    const readOnly = await connectMem(dbPath, { writable: false, server: { approvedImportRoots: parseApprovedRoots(root) } });
    try {
      const before = dbContentHash(dbPath);
      assertError(await readOnly.env('gcr_import_export', { path: join(root, 'export-a', 'conversations.json'), accountLabel: 'ro' }), 'WRITE_FORBIDDEN');
      assert.equal(dbContentHash(dbPath), before);
    } finally {
      await readOnly.close();
    }
  });

  it('accepts progress requests without failing (progress is advisory)', async () => {
    const seen: number[] = [];
    const env = await h.env('gcr_import_export', { path: join(root, 'export-a', 'conversations.json'), accountLabel: 'progress' }, { onprogress: (p) => seen.push(p.progress) });
    assert.equal(env.ok, true, env.error?.message);
    assert.deepEqual(seen, [...seen].sort((a, b) => a - b), 'progress, when delivered, is monotonic');
  });
});

describe('the audit trail of a writable server is never rewritten by reads', () => {
  it('reads after writes leave the audit log as it was', async () => {
    const fx = await createFixture();
    const h = await connectMem(fx.dbPath, { writable: true });
    try {
      await h.env('gcr_create_local_draft', { conversation: ID.linear, body: 'one' });
      const log = JSON.stringify(tableRows(fx.dbPath, 'local_audit_log'));
      await h.env('gcr_list');
      await h.env('gcr_search', { query: 'quokka' });
      assert.equal(JSON.stringify(tableRows(fx.dbPath, 'local_audit_log')), log);
    } finally {
      await h.close();
      await fx.cleanup();
    }
  });
});
