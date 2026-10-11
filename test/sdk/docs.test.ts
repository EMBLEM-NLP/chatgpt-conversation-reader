/**
 * docs/SDK.md must describe the SDK that exists: every public method, every runtime export, every error code with its
 * exit code, the exact NOT_IN_LOCAL_EXPORT remedy, the Node floor of package.json, and only synthetic conversation links.
 * Also covers the two ARCHITECTURE.md section 8 names kept as aliases (getByUrl, graphExport).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import * as sdk from '../../src/index.js';
import { NOT_IN_LOCAL_EXPORT_REMEDY } from '../../src/sdk/resolve.js';
import type { TestDb } from './sdk.helpers.test.js';
import { ID, assertCode, standardDb, warningCodes } from './sdk.helpers.test.js';

const root = new URL('../../../', import.meta.url);

async function sdkDoc(): Promise<string> {
  return readFile(new URL('docs/SDK.md', root), 'utf8');
}

describe('docs/SDK.md', () => {
  it('mentions every public method of Gcr (and no method that does not exist)', async () => {
    const doc = await sdkDoc();
    const methods = [
      'open', 'doctor', 'close', 'list', 'get', 'getByUrl', 'branches', 'thread', 'search', 'stats', 'audit', 'listBatches',
      'importExport', 'importManualCopy', 'buildGraph', 'graphQuery', 'graphPath', 'graphNeighbors', 'graphGodNodes', 'graphExplain',
      'graphExportHtml', 'graphExport', 'createDraft', 'getDraft', 'listDrafts', 'archiveDraft', 'renderDraftMarkdown',
      'createAnnotation', 'updateAnnotation', 'getAnnotation', 'listAnnotations',
    ];
    for (const m of methods) {
      assert.ok(doc.includes(`${m}(`), `docs/SDK.md should show ${m}(...)`);
      if (m !== 'open') assert.equal(typeof (sdk.Gcr.prototype as unknown as Record<string, unknown>)[m], 'function', `${m} exists on Gcr`);
    }
    // every identifier the docs call on a `gcr.` handle exists
    for (const m of doc.matchAll(/\bgcr\.([A-Za-z]+)\(/g)) {
      const name = m[1] as string;
      assert.equal(typeof (sdk.Gcr.prototype as unknown as Record<string, unknown>)[name], 'function', `docs call gcr.${name}() which must exist`);
    }
  });

  it('mentions every runtime export of the package', async () => {
    const doc = await sdkDoc();
    for (const name of Object.keys(sdk)) assert.ok(doc.includes(name), `docs/SDK.md should mention ${name}`);
  });

  it('lists every error code with the exit code the SDK uses', async () => {
    const doc = await sdkDoc();
    const rows = new Map<string, number>();
    for (const m of doc.matchAll(/^\|\s*([A-Z_]+)\s*\|\s*(\d+)\s*\|/gm)) rows.set(m[1] as string, Number(m[2]));
    for (const code of sdk.ERROR_CODES) {
      assert.ok(rows.has(code), `error table should list ${code}`);
      assert.equal(rows.get(code), sdk.EXIT_CODES[code], `exit code of ${code}`);
    }
    for (const code of rows.keys()) assert.ok((sdk.ERROR_CODES as readonly string[]).includes(code), `${code} in the table is a real code`);
  });

  it('quotes the NOT_IN_LOCAL_EXPORT remedy exactly and explains why there is no remote fallback', async () => {
    const doc = await sdkDoc();
    assert.ok(doc.includes(NOT_IN_LOCAL_EXPORT_REMEDY));
    assert.match(doc, /never falls back/);
    assert.match(doc, /ChatGPT Settings > Data controls > Export data|Settings, Data controls, Export data/);
  });

  it('states the same Node floor as package.json engines', async () => {
    const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as { engines: { node: string } };
    assert.ok((await sdkDoc()).includes(pkg.engines.node), `docs/SDK.md should state ${pkg.engines.node}`);
  });

  it('uses only synthetic conversation links (privacy gate) and documents the envelope contract', async () => {
    const doc = await sdkDoc();
    for (const m of doc.matchAll(/chatgpt\.com\/c\/([0-9a-f-]+)/gi)) {
      assert.match(m[1] as string, /^00000000-0000-4000-8000-0000000000[0-9a-f]{2}$|^<uuid>$/i, `link ${m[0]} must be synthetic`);
    }
    for (const field of ['source', 'completeness', 'warnings', 'ids', 'untrustedContent', 'SOURCE_NOT_FULL_HISTORY', 'localOnly']) assert.ok(doc.includes(field), field);
    for (const c of ['exported_tree', 'api_owned_conversation', 'rendered_active_view_only', 'partial_user_supplied', 'unknown', 'mixed']) assert.ok(doc.includes(c), c);
  });

  it('documents every branch-selection policy name', async () => {
    const doc = await sdkDoc();
    for (const p of ['explicit_branch', 'source_current_node', 'only_branch', 'last_child', 'latest_leaf', 'ACTIVE_BRANCH_HEURISTIC', 'ACTIVE_BRANCH_UNKNOWN', 'CURRENT_NODE_NOT_LEAF']) assert.ok(doc.includes(p), p);
  });
});

describe('names kept from docs/ARCHITECTURE.md section 8', () => {
  let t: TestDb;
  before(async () => {
    t = await standardDb();
  });
  after(async () => {
    await t.cleanup();
  });

  it('getByUrl accepts only an exact chatgpt.com link and returns what get returns', () => {
    const url = `https://chatgpt.com/c/${ID.linear}?x=1`;
    assert.deepEqual(t.gcr.getByUrl(url), t.gcr.get(url));
    assert.deepEqual(t.gcr.getByUrl(url, { includeHidden: true }).data, t.gcr.get(ID.linear, { includeHidden: true }).data);
    assertCode(() => t.gcr.getByUrl(ID.linear), 'INVALID_URL'); // a bare UUID is not a link
    assertCode(() => t.gcr.getByUrl(`https://chatgpt.com/share/${ID.linear}`), 'UNSUPPORTED_URL');
    assertCode(() => t.gcr.getByUrl('https://chatgpt.com/c/not-a-uuid'), 'INVALID_UUID');
    assertCode(() => t.gcr.getByUrl(5 as never), 'INVALID_ARGUMENT');
    assertCode(() => t.gcr.getByUrl('https://chatgpt.com/c/00000000-0000-4000-8000-0000000000ef'), 'NOT_IN_LOCAL_EXPORT');
  });

  it('getByUrl names provider chatgpt: the link of a Claude-only id is not found', async () => {
    const { importClaude } = await import('./sdk.helpers.test.js');
    const claudeId = '00000000-0000-4000-8000-0000000000c9';
    await importClaude(t.gcr, t.dir, [claudeId]);
    assertCode(() => t.gcr.getByUrl(`https://chatgpt.com/c/${claudeId}`), 'NOT_IN_LOCAL_EXPORT');
    assert.equal(t.gcr.get(claudeId).data.conversation.provider, 'claude');
  });

  it('graphExport is graphExportHtml', async () => {
    await t.gcr.buildGraph({ minEntityConversations: 1 });
    assert.deepEqual(t.gcr.graphExport({ term: 'quokka' }), t.gcr.graphExportHtml({ term: 'quokka' }));
    assert.ok(!warningCodes(t.gcr.graphExport()).includes('GRAPH_EMPTY'));
  });
});
