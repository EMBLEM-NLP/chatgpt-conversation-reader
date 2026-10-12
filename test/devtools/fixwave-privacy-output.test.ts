/**
 * ATK-03 (part 3): the privacy scanner recognises files that GCR itself writes.
 *
 * `gcr graph export` pages and the JSON / JSONL / Markdown / compact output of the CLI hold conversation titles, entity labels and
 * message text. They are private data under whatever name someone saves them, and before this change the scanner missed all of them.
 * The outputs below are produced by the REAL compiled CLI and the REAL exporter from the synthetic fixtures of this repository,
 * so the recognition rules cannot drift away from the code that writes the files.
 *
 * All secret-shaped text is assembled at run time from fragments so this file contains none.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { errorEnvelope, successEnvelope } from '../../src/mcp/envelope.js';
import { GcrError } from '../../src/errors.js';
import { LARGE_FILE_HEAD_BYTES, LARGE_FILE_TAIL_BYTES, SYNTHETIC_MARKER, scanContent, scanRepo } from '../../src/devtools/privacy-scan.js';
import { exportGraphHtml } from '../../src/graph/export-html.js';
import { withTempDir } from '../helpers/tmp.js';
import { inRepo, put, summarize } from './fixwave-privacy-helpers.js';

const execFileAsync = promisify(execFile);
// Compiled tests live at <root>/<outDir>/test/devtools, whatever the out dir is called.
const here = dirname(fileURLToPath(import.meta.url));
const CLI_MAIN = join(here, '..', '..', 'src', 'cli', 'main.js');
const REPO_ROOT = join(here, '..', '..', '..');
const FIXTURE = join(REPO_ROOT, 'fixtures', 'chatgpt', 'branching.json');

const outputRules = (path: string, content: string): string[] =>
  scanContent(path, content)
    .map((f) => f.rule)
    .filter((r) => r === 'gcr-output-file');

/** Output of the real CLI, keyed `<command>.<format>`. */
const outputs = new Map<string, string>();
let graphPage = '';

async function gcr(cwd: string, ...args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GCR_') && !k.startsWith('NODE_OPTIONS')) env[k] = v;
  const { stdout } = await execFileAsync(process.execPath, [CLI_MAIN, ...args], { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

before(async () => {
  await withTempDir(async (dir) => {
    const db = join(dir, 'g.sqlite');
    await gcr(dir, 'import', FIXTURE, '--db', db);
    await gcr(dir, 'graph', 'build', '--db', db);
    // The id of the first imported conversation, read from the CLI's own JSON so that a change of the fixture cannot break this file.
    const listed = JSON.parse(await gcr(dir, 'list', '--db', db, '--format', 'json')) as { data: { items: Array<{ conversationId: string }> } };
    const conversation = listed.data.items[0]?.conversationId ?? '';
    assert.match(conversation, /^[0-9a-f-]{36}$/);
    const commands: Record<string, string[]> = {
      list: ['list'],
      get: ['get', conversation],
      search: ['search', 'synthetic'],
      stats: ['stats'],
      audit: ['audit'],
      batches: ['batches'],
    };
    for (const [name, args] of Object.entries(commands)) {
      for (const format of ['json', 'jsonl', 'compact', 'markdown']) outputs.set(`${name}.${format}`, await gcr(dir, ...args, '--db', db, '--format', format));
    }
    const page = join(dir, 'page.html');
    await gcr(dir, 'graph', 'export', '--db', db, '--out', page);
    graphPage = await readFile(page, 'utf8');
  });
});

describe('ATK-03: GCR output files are recognised by content, whatever they are called', () => {
  it('has real output for every command and format (the premise of the tests below)', () => {
    assert.equal(outputs.size, 24);
    for (const [name, text] of outputs) assert.ok(text.length > 100, name);
    assert.match(graphPage, /^<!DOCTYPE html>/);
  });

  it('flags the output of every command in every format', () => {
    for (const [name, text] of outputs) {
      for (const path of ['out.txt', `${name}`, 'notes/report.md', 'data/anything.dat', 'x/get.json']) {
        assert.deepEqual(outputRules(path, text), ['gcr-output-file'], `${name} saved as ${path}`);
      }
    }
  });

  it('flags a graph page whatever it is called, and whatever title it carries', () => {
    for (const path of ['graph.html', 'out/g.htm', 'page.txt', 'report', 'docs/notes.md']) assert.deepEqual(outputRules(path, graphPage), ['gcr-output-file'], path);
    // The page title the caller passes lives in the JSON data block; the markers are static text of the exporter.
    const retitled = exportGraphHtml({ nodes: [], edges: [] }, { title: 'Totally unrelated holiday photos' });
    assert.deepEqual(outputRules('holiday.html', retitled), ['gcr-output-file']);
    // Any ONE of the three markers is enough, so editing out the title (or the footer sentence) by hand does not hide the page.
    const noTitle = graphPage.replace('<title>GCR graph export</title>', '<title>holiday</title>');
    const noTitleNoFooter = noTitle.replace(/Generated locally by GCR from your own imported data/g, 'Generated');
    assert.notEqual(noTitle, graphPage);
    assert.notEqual(noTitleNoFooter, noTitle);
    assert.deepEqual(outputRules('a.html', noTitle), ['gcr-output-file']);
    assert.deepEqual(outputRules('a.html', noTitleNoFooter), ['gcr-output-file']);
  });

  it('flags the MCP result envelope, success and error, compact and pretty-printed', () => {
    const success = successEnvelope({
      ok: true,
      data: { items: [{ title: 'a private title', messageText: 'hello' }] },
      source: [{ provider: 'chatgpt', accountLabel: 'default', provenance: 'official_chatgpt_export', completeness: 'exported_tree', batchId: 'b_synthetic', sourceLabel: 'x.json', importedAt: '2026-01-01T00:00:00Z', toolVersion: '0.0.0' }],
      completeness: 'exported_tree',
      warnings: [],
      ids: {},
      untrustedContent: true,
    });
    const failure = errorEnvelope(new GcrError('NOT_IN_LOCAL_EXPORT', 'not here'));
    for (const env of [success, failure]) {
      for (const text of [JSON.stringify(env), JSON.stringify(env, null, 2), `${JSON.stringify(env)}\n${JSON.stringify(env)}\n`]) {
        for (const path of ['mcp-result.json', 'results.jsonl', 'dump.txt', 'tool-call']) assert.deepEqual(outputRules(path, text), ['gcr-output-file'], path);
      }
    }
  });

  it('flags a UTF-8 byte-order mark and CRLF line endings in front of the same content', () => {
    for (const [name, text] of outputs) {
      assert.deepEqual(outputRules('a.txt', `\uFEFF${text}`), ['gcr-output-file'], name);
      assert.deepEqual(outputRules('a.txt', text.replace(/\n/g, '\r\n')), ['gcr-output-file'], name);
    }
  });

  it('is exempt only under fixtures/ and only with the synthetic-fixture marker', () => {
    const withMarker = outputs.get('get.json') ?? '';
    assert.ok(withMarker.includes(SYNTHETIC_MARKER)); // the titles of the synthetic fixtures carry it
    const without = withMarker.replaceAll(SYNTHETIC_MARKER, 'SYNTH');
    assert.ok(!without.includes(SYNTHETIC_MARKER));
    assert.deepEqual(outputRules('fixtures/outputs/get.json', withMarker), []);
    assert.deepEqual(outputRules('fixtures/outputs/get.json', without), ['gcr-output-file']);
    assert.deepEqual(outputRules('docs/get.json', withMarker), ['gcr-output-file']); // the marker alone is not enough
    assert.deepEqual(outputRules('get.json', withMarker), ['gcr-output-file']);
    assert.deepEqual(outputRules('notfixtures/get.json', withMarker), ['gcr-output-file']);
    assert.deepEqual(scanContent('docs/get.json', withMarker, { allow: ['docs/get.json'] }), []); // the allow-file is the other exemption
  });

  it('judges a large envelope from its windows: head lead + provenance, or the tail keys', async () => {
    const big = 'x'.repeat(LARGE_FILE_HEAD_BYTES + LARGE_FILE_TAIL_BYTES);
    const data = { conversation: { provenance: 'official_chatgpt_export', completeness: 'exported_tree', title: 'a title' }, messages: [{ text: big }] };
    // 1. the CLI order: `ok` and `data` first; the untrustedContent flag lies beyond the head window and the last bytes are something else
    const headOnly = `{"ok":true,"data":${JSON.stringify(data)},"untrustedContent":true,"padding":"${'p'.repeat(100_000)}"}`;
    // 2. another key order: nothing useful at the start, completeness and the flag at the very end
    const tailOnly = `{"data":${JSON.stringify({ messages: [{ text: big }] })},"completeness":"exported_tree","untrustedContent":true}`;
    for (const [label, text] of [['head', headOnly], ['tail', tailOnly]] as const) {
      await inRepo(async (dir) => {
        await put(dir, 'out/result.json', text);
        const result = await scanRepo(dir, { maxFileBytes: 100_000 });
        assert.equal(result.skippedLarge, 1, label);
        assert.deepEqual(
          result.findings.map((f) => f.rule),
          ['gcr-output-file', 'unscanned-large-file'],
          label,
        );
      });
    }
  });

  it('is reported by scanRepo with the path, in the work tree and in history, and the detail never copies a title', async () => {
    await inRepo(async (dir) => {
      const text = outputs.get('get.json') ?? '';
      await put(dir, 'out/get.json', text);
      await put(dir, 'out/graph.html', graphPage);
      const result = await scanRepo(dir);
      assert.deepEqual(summarize(result.findings), [
        ['gcr-output-file', 'out/get.json', undefined],
        ['gcr-output-file', 'out/graph.html', undefined],
      ]);
      for (const f of result.findings) assert.ok(!f.detail.includes('branching') && !f.detail.includes('regenerated'), f.detail);
    });
  });
});

describe('ATK-03: no false positives on this repository\'s own text about the output', () => {
  const real = async (rel: string): Promise<string> => readFile(join(REPO_ROOT, rel), 'utf8');

  it('leaves the exporter source, its tests, the docs that show example output and the schema file alone', async () => {
    for (const rel of ['src/graph/export-html.ts', 'test/graph/export-html.test.ts', 'src/format/render.ts', 'test/format/render.thread.test.ts', 'README.md', 'docs/USER_GUIDE.md', 'docs/MCP_TOOLS.md', 'docs/mcp-tool-schemas.json', 'docs/SDK.md']) {
      assert.deepEqual(outputRules(rel, await real(rel)), [], rel);
    }
  });

  it('leaves look-alikes alone: an ordinary HTML page, a schema, an envelope-shaped object with no GCR keys, a Markdown note', () => {
    assert.deepEqual(outputRules('page.html', '<!DOCTYPE html>\n<html><head><title>A graph of my holiday</title></head><body>a page about nothing</body></html>'), []);
    assert.deepEqual(outputRules('schema.json', '{"type":"object","properties":{"untrustedContent":{"type":"boolean"},"completeness":{"type":"string"},"provenance":{"type":"string"}}}'), []);
    assert.deepEqual(outputRules('api.json', '{"ok":true,"data":{"value":1}}'), []);
    assert.deepEqual(outputRules('lines.jsonl', '{"type":"header","ok":true,"kind":"other"}\n{"type":"row","n":1}\n'), []);
    assert.deepEqual(outputRules('note.md', '# A heading\n\n- Tool version: gcr 0.2.0 is what I used\n- another bullet\n'), []);
    assert.deepEqual(outputRules('note2.md', 'Some words first.\n# source: provenance=official_chatgpt_export | account=default\n'), []);
    assert.deepEqual(outputRules('package.json', '{"name":"x","completeness":"yes","provenance":"none"}'), []);
  });
});
