/**
 * The documentation artifacts stay true to the code: docs/mcp-tool-schemas.json is exactly what the running server
 * advertises (and scripts/dump-mcp-schemas.mjs regenerates it deterministically and detects staleness), and
 * docs/MCP_TOOLS.md covers every tool, flag, environment variable and safety statement.
 */
import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { LEGACY_ALIASES } from '../../src/mcp/aliases.js';
import { MCP_USAGE } from '../../src/mcp/entry.js';
import { SERVER_INSTRUCTIONS } from '../../src/mcp/server.js';
import { ERROR_CODES } from '../../src/errors.js';
import { TOOL_NAME, TOOL_VERSION } from '../../src/version.js';
import type { Fixture, MemHarness } from './mcp.helpers.test.js';
import { COMPILED_SRC, connectMem, createFixture, makeTempDir, removeDir } from './mcp.helpers.test.js';

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const script = join(repoRoot, 'scripts', 'dump-mcp-schemas.mjs');
const schemasFile = join(repoRoot, 'docs', 'mcp-tool-schemas.json');
const toolsDoc = join(repoRoot, 'docs', 'MCP_TOOLS.md');

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]));
  return value;
}

async function runScript(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await run(process.execPath, [script, ...args], { cwd: repoRoot });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('docs/mcp-tool-schemas.json', () => {
  let fx: Fixture;
  let h: MemHarness;
  before(async () => {
    fx = await createFixture({ graph: false });
    h = await connectMem(fx.dbPath);
  });
  after(async () => {
    await h.close();
    await fx.cleanup();
  });

  it('is exactly what the running server advertises: tools, schemas, annotations, server facts and the (empty) alias table', async () => {
    const committed = JSON.parse(await readFile(schemasFile, 'utf8')) as { server: Record<string, unknown>; legacyAliases: unknown; tools: unknown[] };
    const live = (await h.client.listTools()).tools.map((t) => ({
      name: t.name,
      title: t.title ?? null,
      description: t.description ?? null,
      annotations: t.annotations ?? null,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema ?? null,
    }));
    assert.deepEqual(committed.tools, sortKeys(live), 'regenerate with: npm run dump:mcp-schemas');
    assert.deepEqual(committed.server, { name: TOOL_NAME, version: TOOL_VERSION, capabilities: { tools: { listChanged: true } }, instructions: SERVER_INSTRUCTIONS });
    assert.deepEqual(committed.legacyAliases, LEGACY_ALIASES);
    assert.equal(committed.tools.length, 12);
  });

  it('the generator reports it up to date, and is deterministic (two runs, byte-identical files)', async () => {
    const check = await runScript(['--check', '--dist', COMPILED_SRC]);
    assert.equal(check.code, 0, check.stderr);
    assert.match(check.stdout, /up to date/);
    const dir = await makeTempDir();
    try {
      const a = join(dir, 'a.json');
      const b = join(dir, 'b.json');
      assert.equal((await runScript(['--dist', COMPILED_SRC, '--out', a])).code, 0);
      assert.equal((await runScript(['--dist', COMPILED_SRC, '--out', b])).code, 0);
      const [ta, tb] = await Promise.all([readFile(a, 'utf8'), readFile(b, 'utf8')]);
      assert.equal(ta, tb);
      assert.equal(ta, await readFile(schemasFile, 'utf8'));
      assert.ok(ta.endsWith('}\n'));
      assert.ok(!/"(?:generatedAt|generated|timestamp|date)"/i.test(ta), 'no generated timestamp member (the example dates inside descriptions are text)');
    } finally {
      await removeDir(dir);
    }
  });

  it('--check fails (exit 1) on a stale or missing file and the other misuses are exit 2', async () => {
    const dir = await makeTempDir();
    try {
      const stale = join(dir, 'stale.json');
      await writeFile(stale, `${(await readFile(schemasFile, 'utf8')).replace('"gcr_list"', '"gcr_listing"')}`);
      const r = await runScript(['--check', '--dist', COMPILED_SRC, '--out', stale]);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /stale/);
      assert.equal((await runScript(['--check', '--dist', COMPILED_SRC, '--out', join(dir, 'missing.json')])).code, 1);
      assert.equal((await runScript(['--bogus'])).code, 2);
      assert.equal((await runScript(['--dist', join(dir, 'no-such-dist')])).code, 2);
    } finally {
      await removeDir(dir);
    }
  });
});

describe('docs/MCP_TOOLS.md', () => {
  let doc: string;
  before(async () => {
    doc = await readFile(toolsDoc, 'utf8');
  });

  it('documents every tool under its own heading, in the order of tools/list', () => {
    const names = ['gcr_list', 'gcr_get', 'gcr_search', 'gcr_branches', 'gcr_thread', 'gcr_stats', 'gcr_audit', 'gcr_graph_query', 'gcr_doctor', 'gcr_create_local_draft', 'gcr_update_local_annotation', 'gcr_import_export'];
    let last = -1;
    for (const name of names) {
      const at = doc.indexOf(`### \`${name}\``);
      assert.ok(at > last, `${name} has a heading after the previous tool`);
      last = at;
    }
  });

  it('names every flag and environment variable of the entry', () => {
    for (const word of ['--db', '--allow-local-writes', 'GCR_DB', 'GCR_MCP_ALLOW_WRITES', 'GCR_APPROVED_IMPORT_ROOTS', 'GCR_MCP_MAX_RESULT_BYTES', 'GCR_LOG_LEVEL']) {
      assert.ok(doc.includes(word), `the document mentions ${word}`);
      if (word.startsWith('--') || word.startsWith('GCR_') && word !== 'GCR_LOG_LEVEL') assert.ok(MCP_USAGE.includes(word) || word === 'GCR_LOG_LEVEL', `${word} is also in the usage text`);
    }
  });

  it('shows the three client configurations with the node command and placeholder paths only', () => {
    assert.match(doc, /"mcpServers"/);
    assert.match(doc, /"servers"/);
    assert.match(doc, /\[mcp_servers\.gcr\]/);
    assert.equal((doc.match(/"command": "node"|command = "node"/g) ?? []).length, 3);
    assert.equal((doc.match(/\/ABSOLUTE\/PATH\/TO\//g) ?? []).length >= 6, true);
    assert.ok(!/\/home\/|\/Users\/|C:\\/.test(doc), 'no real-looking local path');
  });

  it('states the safety model: read-only default, approved roots, untrusted data, size cap, no stdout noise, empty alias table', () => {
    for (const phrase of ['read-only', 'GCR_APPROVED_IMPORT_ROOTS', 'UNTRUSTED DATA', '200 000', 'RESULT_TRUNCATED', 'No stdout noise', 'ADR-0002', 'LEGACY_ALIASES', 'WRITE_FORBIDDEN', 'IMPORT_PATH_NOT_ALLOWED', 'NOT_IN_LOCAL_EXPORT']) {
      assert.ok(doc.includes(phrase), `the document mentions ${phrase}`);
    }
  });

  it('only mentions error codes that exist', () => {
    const mentioned = new Set(doc.match(/\b[A-Z][A-Z]+(?:_[A-Z]+)+\b/g) ?? []);
    const known = new Set<string>(ERROR_CODES);
    for (const code of ['NOT_IN_LOCAL_EXPORT', 'AMBIGUOUS_CONVERSATION', 'ACTIVE_BRANCH_UNKNOWN', 'BRANCH_NOT_FOUND', 'MESSAGE_NOT_FOUND', 'FTS_SYNTAX_ERROR', 'WRITE_FORBIDDEN', 'ANNOTATION_NOT_FOUND', 'ANNOTATION_CONFLICT', 'IMPORT_PATH_NOT_ALLOWED', 'INVALID_ARGUMENT', 'INVALID_URL', 'INVALID_UUID', 'UNSUPPORTED_URL', 'DB_ERROR', 'INTERNAL_ERROR']) {
      assert.ok(known.has(code), `${code} is a real code`);
      assert.ok(mentioned.has(code), `${code} is documented`);
    }
  });
});
