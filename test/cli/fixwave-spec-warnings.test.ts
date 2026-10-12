/**
 * SPEC-02 regression tests (spec-conformance finding, medium): `gcr get` and `gcr thread` printed only the THREAD-level
 * warnings, so a partial (Mode B manual copy) or rendered-only (Claude) source lost SOURCE_NOT_FULL_HISTORY, which docs and the
 * SDK/MCP promise as the first warning (FR-09). `gcr branches`, `list` and `search` already merged the envelope warnings.
 *
 * Reproduction (before the fix): `gcr import-copy copy.json --db mc.sqlite; gcr get <id> --format json --db mc.sqlite` gave
 * warnings ['NO_CURRENT_NODE', 'PARTIAL_USER_SUPPLIED'] while `gcr.get(id).warnings` of the SDK gave
 * ['SOURCE_NOT_FULL_HISTORY', 'NO_CURRENT_NODE', 'PARTIAL_USER_SUPPLIED'].
 *
 * All four formats, get and thread, on a manual-copy conversation, on the Claude fixture and on a complete exported tree
 * (negative control); plus: the CLI and the SDK list the same warning codes in the same order for the same call.
 * SYNTHETIC data only (ids 00000000-0000-4000-8000-<12 hex>).
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Gcr } from '../../src/sdk/gcr.js';
import { FIXTURES, FORMATS, ID, assertOk, envelope, gcr, parseJsonl, templateDb, tempDir, writeFile } from './cli.helpers.test.js';
import type { Format } from './cli.helpers.test.js';

const COPY_ID = '00000000-0000-4000-8000-0000000000aa';
const COPY_DOC = JSON.stringify({
  conversationId: COPY_ID,
  title: 'GCR-SYNTHETIC-FIXTURE manual copy',
  messages: [
    { role: 'user', text: 'hello from a manual copy' },
    { role: 'assistant', text: 'hi back' },
  ],
});
const CLAUDE_ID = '00000000-0000-4000-8000-000000000001';

/** The warning codes a printed document lists, in printed order. */
function printedCodes(stdout: string, format: Format): string[] {
  switch (format) {
    case 'json':
      return envelope(stdout).warnings.map((w) => w.code);
    case 'jsonl': {
      const footer = parseJsonl(stdout).at(-1);
      assert.equal(footer?.['type'], 'footer');
      return (footer?.['warnings'] as Array<{ code: string }>).map((w) => w.code);
    }
    case 'markdown': {
      const at = stdout.indexOf('\n## Warnings\n');
      assert.ok(at >= 0, 'markdown output has a Warnings section');
      return [...stdout.slice(at).matchAll(/^- `([A-Z][A-Z0-9_]+)`: /gm)].map((m) => m[1] as string);
    }
    case 'compact': {
      const line = stdout.split('\n').find((l) => l.startsWith('# warnings: '));
      if (line === undefined) return []; // the compact format prints the line only when there is at least one warning
      // "CODE: message; CODE2: message" - take each code that starts an entry.
      return [...line.slice('# warnings: '.length).matchAll(/(?:^|; )([A-Z][A-Z0-9_]+): /g)].map((m) => m[1] as string);
    }
  }
}

async function run(args: string[], dbPath: string, format: Format): Promise<string> {
  const r = await gcr([...args, '--db', dbPath, '--format', format]);
  assertOk(r, `gcr ${args.join(' ')} --format ${format}`);
  return r.stdout;
}

/** SDK codes for the same call, from a read-only handle on the same file. */
function sdkCodes(dbPath: string, call: (g: Gcr) => { warnings: Array<{ code: string }> }): string[] {
  const g = Gcr.open({ dbPath, readOnly: true });
  try {
    return call(g).warnings.map((w) => w.code);
  } finally {
    g.close();
  }
}

async function manualCopyDb(): Promise<string> {
  const dir = tempDir('gcr-spec02-');
  const dbPath = join(dir, 'mc.sqlite');
  const r = await gcr(['import-copy', writeFile(dir, 'copy.json', COPY_DOC), '--db', dbPath, '--format', 'json']);
  assertOk(r, 'import-copy');
  return dbPath;
}

async function claudeDb(): Promise<string> {
  const dir = tempDir('gcr-spec02-');
  const dbPath = join(dir, 'claude.sqlite');
  const r = await gcr(['import', join(FIXTURES, 'claude', 'linear.json'), '--db', dbPath, '--format', 'json']);
  assertOk(r, 'import claude fixture');
  return dbPath;
}

describe('SPEC-02: get and thread show SOURCE_NOT_FULL_HISTORY first (manual copy, Mode B)', () => {
  for (const format of FORMATS) {
    it(`get --format ${format}`, async () => {
      const db = await manualCopyDb();
      const codes = printedCodes(await run(['get', COPY_ID], db, format), format);
      assert.deepEqual(codes, ['SOURCE_NOT_FULL_HISTORY', 'NO_CURRENT_NODE', 'PARTIAL_USER_SUPPLIED']);
    });

    it(`thread --branch manual-00002 --format ${format}`, async () => {
      const db = await manualCopyDb();
      const codes = printedCodes(await run(['thread', COPY_ID, '--branch', 'manual-00002'], db, format), format);
      assert.deepEqual(codes, ['SOURCE_NOT_FULL_HISTORY', 'NO_CURRENT_NODE', 'PARTIAL_USER_SUPPLIED']);
    });
  }

  it('get --all-branches in the text formats: every document carries the lead warning', async () => {
    const db = await manualCopyDb();
    for (const format of ['markdown', 'compact', 'jsonl'] as const) {
      const out = await run(['get', COPY_ID, '--all-branches'], db, format);
      if (format === 'jsonl') assert.ok(out.includes('"SOURCE_NOT_FULL_HISTORY"'));
      else assert.ok(out.includes('SOURCE_NOT_FULL_HISTORY'), `${format}: lead warning present`);
    }
  });
});

describe('SPEC-02: get and thread show SOURCE_NOT_FULL_HISTORY first (Claude export, rendered_active_view_only)', () => {
  for (const format of FORMATS) {
    it(`get --format ${format}`, async () => {
      const db = await claudeDb();
      const codes = printedCodes(await run(['get', CLAUDE_ID], db, format), format);
      assert.equal(codes[0], 'SOURCE_NOT_FULL_HISTORY');
      assert.ok(codes.includes('LINEAR_EXPORT_ACTIVE_BRANCH_ONLY'), codes.join(','));
    });

    it(`thread --format ${format}`, async () => {
      const db = await claudeDb();
      const codes = printedCodes(await run(['thread', CLAUDE_ID], db, format), format);
      assert.equal(codes[0], 'SOURCE_NOT_FULL_HISTORY');
      assert.ok(codes.includes('LINEAR_EXPORT_ACTIVE_BRANCH_ONLY'), codes.join(','));
    });
  }
});

describe('SPEC-02: the CLI lists exactly the warning codes the SDK returns for the same call', () => {
  it('manual copy: get and thread (JSON) equal gcr.get / gcr.thread', async () => {
    const db = await manualCopyDb();
    const cliGet = printedCodes(await run(['get', COPY_ID], db, 'json'), 'json');
    assert.deepEqual(cliGet, sdkCodes(db, (g) => g.get(COPY_ID)));
    const cliThread = printedCodes(await run(['thread', COPY_ID, '--branch', 'manual-00002'], db, 'json'), 'json');
    assert.deepEqual(cliThread, sdkCodes(db, (g) => g.thread(COPY_ID, { branch: 'manual-00002' })));
  });

  it('Claude export: get and thread (JSON, markdown, compact, jsonl) equal the SDK', async () => {
    const db = await claudeDb();
    const expectGet = sdkCodes(db, (g) => g.get(CLAUDE_ID));
    const expectThread = sdkCodes(db, (g) => g.thread(CLAUDE_ID));
    for (const format of FORMATS) {
      assert.deepEqual(printedCodes(await run(['get', CLAUDE_ID], db, format), format), expectGet, `get ${format}`);
      assert.deepEqual(printedCodes(await run(['thread', CLAUDE_ID], db, format), format), expectThread, `thread ${format}`);
    }
  });

  it('complete exported tree (negative control): no SOURCE_NOT_FULL_HISTORY, still equal to the SDK', async () => {
    const { dbPath } = await templateDb();
    for (const format of FORMATS) {
      const codes = printedCodes(await run(['get', ID.linear], dbPath, format), format);
      assert.ok(!codes.includes('SOURCE_NOT_FULL_HISTORY'), `${format}: a complete export must not claim to be partial`);
      assert.deepEqual(codes, sdkCodes(dbPath, (g) => g.get(ID.linear)));
    }
  });

  it('a conversation with tree warnings keeps them, de-duplicated by code, envelope order first (no pointer -> explicit branch)', async () => {
    const { dbPath, std } = await templateDb();
    const leaf = std.noPointerLeaves[0] as string;
    const sdk = sdkCodes(dbPath, (g) => g.thread(ID.noPointer, { branch: leaf }));
    for (const format of FORMATS) {
      const codes = printedCodes(await run(['thread', ID.noPointer, '--branch', leaf], dbPath, format), format);
      assert.deepEqual(codes, sdk, `thread ${format}`);
      assert.equal(new Set(codes).size, codes.length, 'no code is listed twice');
    }
  });
});
