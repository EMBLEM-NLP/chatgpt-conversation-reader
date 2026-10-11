/**
 * The format matrix for the commands that are not plain reads: every one of them, in every output format, must succeed with
 * an EMPTY stderr and print a well-formed document of that format (JSON parses, every JSONL line parses, Markdown and compact
 * have their title line). The read commands have their own, deeper, matrix in cli.read.test.ts.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { buildZip } from '../helpers/zip-builder.js';
import { FORMATS, ID, arr, assertFormat, assertOk, copyDb, envelope, gcr, obj, standardExport, tempDir, writeFile } from './cli.helpers.test.js';
import type { Format } from './cli.helpers.test.js';

async function every(name: string, args: (format: Format) => Promise<string[]> | string[]): Promise<void> {
  for (const format of FORMATS) {
    const r = await gcr([...(await args(format)), '--format', format]);
    assertOk(r, `${name} --format ${format}`);
    assertFormat(r.stdout, format, `${name} --format ${format}`);
  }
}

describe('format matrix: doctor and imports', () => {
  it('doctor', async () => {
    const { dbPath } = await copyDb();
    await every('doctor', () => ['doctor', '--db', dbPath]);
    await every('doctor (no database yet)', () => ['doctor', '--db', join(tempDir(), 'none.sqlite')]);
    const report = envelope((await gcr(['doctor', '--db', dbPath, '--format', 'json'])).stdout).data;
    assert.equal(report['ok'], true);
    assert.equal(obj(report['database'])['schemaStatus'], 'ok');
    assert.equal(arr(report['modes']).length, 5);
    assert.equal(obj(report['network'])['used'], false);
    const text = (await gcr(['doctor', '--db', dbPath])).stdout;
    assert.match(text, /Commands never fall back to remote browser access\./);
    assert.match(text, /no live export verified/);
  });

  it('import', async () => {
    const dir = tempDir();
    const file = writeFile(dir, 'conversations.json', standardExport().json);
    let n = 0;
    await every('import', () => ['import', file, '--db', join(dir, `i${n++}.sqlite`)]);
    const zip = writeFile(dir, 'e.zip', buildZip([{ name: 'conversations.json', data: standardExport().json }]));
    await every('import (zip)', () => ['import', zip, '--db', join(dir, `z${n++}.sqlite`)]);
  });

  it('import-copy', async () => {
    const dir = tempDir();
    const file = writeFile(dir, 'copy.json', JSON.stringify({ messages: [{ role: 'user', text: 'a copied question' }, { role: 'assistant', text: 'a copied answer' }] }));
    let n = 0;
    await every('import-copy', () => ['import-copy', file, '--db', join(dir, `c${n++}.sqlite`)]);
  });
});

describe('format matrix: graph', () => {
  it('build, query, path, neighbors, god-nodes, explain, export', async () => {
    const { dbPath, dir } = await copyDb();
    await every('graph build', () => ['graph', 'build', '--min-conversations', '1', '--db', dbPath]);
    const q = envelope((await gcr(['graph', 'query', 'quokka', '--format', 'json', '--db', dbPath])).stdout);
    const nodes = arr(q.data['nodes']);
    const conv = String(nodes.find((n) => n['kind'] === 'conversation')?.['id']);
    const keyword = String(nodes.find((n) => n['label'] === 'quokka')?.['id']);
    const edge = arr(q.data['edges'])[0];
    await every('graph query', () => ['graph', 'query', 'quokka', '--db', dbPath]);
    await every('graph path', () => ['graph', 'path', conv, keyword, '--db', dbPath]);
    await every('graph neighbors', () => ['graph', 'neighbors', keyword, '--db', dbPath]);
    await every('graph god-nodes', () => ['graph', 'god-nodes', '--db', dbPath]);
    await every('graph explain', () => ['graph', 'explain', String(edge?.['id']), '--db', dbPath]);
    await every('graph explain (triple)', () => ['graph', 'explain', String(edge?.['src']), String(edge?.['dst']), String(edge?.['kind']), '--db', dbPath]);
    let n = 0;
    await every('graph export', () => ['graph', 'export', '--out', join(dir, `g${n++}.html`), '--db', dbPath]);
    await every('graph export --term', () => ['graph', 'export', '--term', 'quokka', '--out', join(dir, `t${n++}.html`), '--db', dbPath]);
  });
});

describe('format matrix: local drafts and annotations', () => {
  it('draft create, list, show, archive', async () => {
    const { dbPath, dir } = await copyDb();
    const body = writeFile(dir, 'd.md', 'a draft');
    await every('draft create', () => ['draft', 'create', '--conversation', ID.linear, '--input', body, '--db', dbPath]);
    await every('draft list', () => ['draft', 'list', '--db', dbPath]);
    const first = arr(envelope((await gcr(['draft', 'list', '--format', 'json', '--db', dbPath])).stdout).data['items'])[0];
    const id = String(first?.['draftId']);
    await every('draft show', () => ['draft', 'show', id, '--db', dbPath]);
    await every('draft archive', () => ['draft', 'archive', id, '--db', dbPath]);
    await every('draft list (archived)', () => ['draft', 'list', '--status', 'archived', '--db', dbPath]);
  });

  it('annotate create, show, update, list', async () => {
    const { dbPath, dir } = await copyDb();
    const note = writeFile(dir, 'n.txt', 'a note');
    const created = await gcr(['annotate', 'create', '--conversation', ID.linear, '--input', note, '--format', 'json', '--db', dbPath]);
    assertOk(created);
    const id = String(obj(envelope(created.stdout).data['annotation'])['annotationId']);
    await every('annotate create', () => ['annotate', 'create', '--conversation', ID.linear, '--input', note, '--db', dbPath]);
    await every('annotate show', () => ['annotate', 'show', id, '--db', dbPath]);
    let version = 1;
    await every('annotate update', () => ['annotate', 'update', id, '--input', note, '--expected-version', String(version++), '--db', dbPath]);
    await every('annotate list', () => ['annotate', 'list', '--db', dbPath]);
  });
});
