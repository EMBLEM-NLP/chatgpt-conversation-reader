/**
 * Adversarial tests from an independent review of src/graph/build.ts (provenance, privacy, labels, pathological inputs).
 *
 * "defects found by review" failed against the reviewed code before the matching fix and stay as regression tests.
 * Databases are real: synthetic conversations go through Repository.importBatch, then buildGraph.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../src/db/open.js';
import { Repository } from '../../src/db/repo.js';
import type { ImportBatchMeta } from '../../src/db/repo.js';
import type { ConversationRecord } from '../../src/domain/types.js';
import { GcrError } from '../../src/errors.js';
import { buildGraph, cleanLabel, conversationNodeId, entityNodeId, parseNodeId } from '../../src/graph/build.js';
import { convo, iso, link, msg } from '../helpers/records.js';

const META: ImportBatchMeta = {
  provider: 'chatgpt',
  accountLabel: 'default',
  provenance: 'official_chatgpt_export',
  completeness: 'exported_tree',
  sourceKind: 'zip',
  sourceLabel: 'export.zip',
  contentDigest: 'adv',
  importedAt: '2025-02-01T00:00:00.000Z',
  toolVersion: '0.2.0-dev.0',
  warnings: [],
};

function chain(id: string, texts: string[], over: Partial<ConversationRecord> = {}): ConversationRecord {
  const msgs = [msg({ id: `${id}-root`, conversationId: id, nodeKind: 'structural_empty', authorRole: '', contentType: null, ordinal: 0 })];
  let prev = `${id}-root`;
  texts.forEach((text, i) => {
    const mid = `${id}-m${i}`;
    msgs.push(msg({ id: mid, conversationId: id, parentId: prev, authorRole: i % 2 === 0 ? 'user' : 'assistant', text, createdAt: iso(i + 1), ordinal: i + 1 }));
    prev = mid;
  });
  return convo(id, link(msgs), { currentNodeId: prev, ...over });
}

function fresh(): { db: DatabaseSync; repo: Repository } {
  const h = openDatabase(':memory:');
  return { db: h.db, repo: new Repository(h.db) };
}

let digest = 0;
async function importAll(repo: Repository, convs: ConversationRecord[], over: Partial<ImportBatchMeta> = {}): Promise<void> {
  await repo.importBatch({ batch: { ...META, contentDigest: `adv-${++digest}`, ...over }, conversations: convs });
}

const DERIVED = ['entities', 'entity_mentions', 'graph_nodes', 'graph_edges', 'graph_edge_evidence', 'graph_communities'] as const;

function scalar(db: DatabaseSync, sql: string, ...params: Array<string | number>): number {
  return Number(db.prepare(sql).get(...params)?.['n']);
}

function rows(db: DatabaseSync, sql: string): Array<Record<string, unknown>> {
  return db.prepare(sql).all().map((r) => ({ ...r })) as Array<Record<string, unknown>>;
}

const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u{200E}\u{200F}\u{2028}\u{2029}\u{202A}-\u{202E}\u{2066}-\u{2069}]/u;

describe('defects found by review: labels are clean whatever the fallback is', () => {
  it('cleanLabel cleans the fallback too, and never returns an empty or unsafe label', () => {
    assert.equal(cleanLabel('', '\u{2028}'), '(unnamed)');
    assert.equal(cleanLabel('\n\t', '\u{202E}\u{2066}'), '(unnamed)');
    assert.equal(cleanLabel('   ', 'fallback'), 'fallback');
    assert.equal(cleanLabel('', `a\u{202E}b\nc`), 'a b c');
    assert.equal(cleanLabel('', 'x'.repeat(500)).length, 200);
    assert.doesNotThrow(() => encodeURIComponent(cleanLabel('', '\u{1F600}'.repeat(150))));
    const hostile = ['', ' ', '\u{2028}', '\u{202E}\u{202E}', '\u0000', 'a\u0007b', '\u{200F}', '\u{1F600}'.repeat(300), 'plain'];
    for (const raw of hostile) {
      for (const fb of hostile) {
        const out = cleanLabel(raw, fb);
        assert.ok(out.length > 0 && out.length <= 200, JSON.stringify([raw.slice(0, 5), fb.slice(0, 5)]));
        assert.equal(UNSAFE.test(out), false, JSON.stringify([raw.slice(0, 5), fb.slice(0, 5)]));
      }
    }
  });

  it('a conversation whose id and title are only control or bidi characters still gets a clean node label', async () => {
    const { db, repo } = fresh();
    const id = '\u{202E}\u{2028}';
    await importAll(repo, [chain(id, ['alphax betax'], { title: null }), chain('t', ['alphax betax'], { title: '\u{202E}\u{2066}\n' })]);
    buildGraph(db);
    for (const r of rows(db, 'SELECT node_id, label FROM graph_nodes')) {
      assert.equal(UNSAFE.test(String(r['label'])), false, `label of ${JSON.stringify(r['node_id'])}`);
      assert.ok(String(r['label']).length > 0);
    }
    const labels = new Map(rows(db, "SELECT node_id, label FROM graph_nodes WHERE kind = 'conversation'").map((r) => [String(r['node_id']), String(r['label'])]));
    assert.equal(labels.get(conversationNodeId('chatgpt', 'default', id)), '(unnamed)');
    assert.equal(labels.get('conv:chatgpt:default:t'), 't', 'a title of only control characters falls back to the (clean) id');
    // The community name is built from labels and must be clean as well.
    for (const r of rows(db, 'SELECT label FROM graph_communities')) assert.equal(UNSAFE.test(String(r['label'])), false);
  });
});

describe('defects found by review: a cut caused by NFKC expansion is reported, not swallowed', () => {
  // U+FDFA is ONE UTF-16 unit that NFKC expands to 18. 30 of them are 30 units (below a cap of 100 for SQLite and for the
  // raw cut) but 540 units for the extractor.
  const expanding = '\u{FDFA}'.repeat(30);

  it('warns and extracts only from the capped normalised text', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chain('nfkc', [expanding])]);
    const r = buildGraph(db, { maxTextChars: 100, minEntityConversations: 1 });
    const w = r.warnings.find((x) => x.code === 'TEXT_TRUNCATED_FOR_EXTRACTION');
    assert.ok(w !== undefined, 'the silent cut must be reported');
    assert.deepEqual(w.ids, ['nfkc-m0']);
    const mention = rows(db, "SELECT m.count AS count FROM entity_mentions m JOIN entities e USING (entity_id) WHERE e.normalized = '\u{627}\u{644}\u{644}\u{647}'");
    assert.equal(mention.length, 1);
    assert.ok(Number(mention[0]?.['count']) <= Math.ceil(100 / 18), `count ${String(mention[0]?.['count'])}`);
  });

  it('does not warn when the normalised text fits, and not for non-expanding non-ASCII text', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chain('fits', ['\u{FDFA}\u{FDFA}']), chain('accents', ['\u{E9}'.repeat(30)]), chain('exact', ['a'.repeat(100)])]);
    assert.deepEqual(buildGraph(db, { maxTextChars: 100, minEntityConversations: 1 }).warnings, []);
    const over = fresh();
    await importAll(over.repo, [chain('over', ['a'.repeat(101)])]);
    assert.ok(buildGraph(over.db, { maxTextChars: 100, minEntityConversations: 1 }).warnings.some((w) => w.code === 'TEXT_TRUNCATED_FOR_EXTRACTION'));
  });
});

describe('privacy: secrets of URL-shaped text never reach any derived table', () => {
  it('glued schemes and non-http URLs with credentials, queries or fragments are blanked before extraction', async () => {
    const { db, repo } = fresh();
    const text =
      'linkhttps://files.example.com/a?token=zqxsecretalpha then ftp://alice:zqxpassone@ftp.example.com/pub?zqxquerytwo=1 and ' +
      'postgres://admin:zqxpassthree@db.internal:5432/prod?sslmode=zqxquerytwo#zqxfragfour plus plainword';
    await importAll(repo, [chain('p1', [text]), chain('p2', [text])]);
    buildGraph(db, { minEntityConversations: 1 });
    const dump = DERIVED.map((t) => JSON.stringify(rows(db, `SELECT * FROM ${t}`))).join('\n').toLowerCase();
    assert.equal(dump.includes('zqx'), false);
    assert.ok(dump.includes('plainword'), 'ordinary words around the blanked secrets are still extracted');
  });
});

describe('provenance: every edge traces to messages of the right account, provider and batch', () => {
  it('with the same conversation and message ids under two accounts, evidence never crosses accounts', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chain('c1', ['alphax betax', 'alphax'], { accountLabel: 'A' }), chain('c2', ['alphax betax'], { accountLabel: 'A' })], { accountLabel: 'A' });
    await importAll(repo, [chain('c1', ['gammax deltax', 'gammax'], { accountLabel: 'B' }), chain('c2', ['gammax deltax'], { accountLabel: 'B' })], { accountLabel: 'B' });
    buildGraph(db);
    // Every mentioned_in evidence row names a stored message of the SAME account whose text really contains the keyword.
    const bad = scalar(
      db,
      `SELECT count(*) AS n FROM graph_edges e
         JOIN graph_edge_evidence v ON v.edge_id = e.edge_id
         LEFT JOIN messages m ON m.provider = v.provider AND m.account_label = v.account_label AND m.conversation_id = v.conversation_id
              AND m.message_id = v.message_id AND m.source_batch = v.source_batch
        WHERE e.kind = 'mentioned_in' AND (m.message_id IS NULL OR instr(lower(m.text), substr(e.src, 13)) = 0)`,
    );
    assert.equal(bad, 0);
    assert.ok(scalar(db, "SELECT count(*) AS n FROM graph_edges WHERE kind = 'mentioned_in'") >= 8, 'both accounts contribute edges');
    // The conversation nodes of an account are only linked to entities found in that account's messages.
    assert.equal(scalar(db, "SELECT count(*) AS n FROM graph_edges WHERE kind = 'mentioned_in' AND dst LIKE 'conv:chatgpt:A:%' AND src IN ('ent:keyword:gammax', 'ent:keyword:deltax')"), 0);
    assert.equal(scalar(db, "SELECT count(*) AS n FROM graph_edges WHERE kind = 'mentioned_in' AND dst LIKE 'conv:chatgpt:B:%' AND src IN ('ent:keyword:alphax', 'ent:keyword:betax')"), 0);
    // And an account-scoped build contains nothing of the other account at all.
    buildGraph(db, { accountLabel: 'A' });
    assert.equal(scalar(db, "SELECT count(*) AS n FROM graph_nodes WHERE node_id LIKE '%gammax%' OR node_id LIKE 'conv:chatgpt:B:%'"), 0);
    assert.equal(scalar(db, "SELECT count(*) AS n FROM graph_edge_evidence WHERE account_label <> 'A'"), 0);
  });
});

describe('node ids: parsing and injectivity', () => {
  it('conversation ids are injective and round-trip for every combination over a hostile alphabet', () => {
    const alphabet = [':', '%', '3', 'A', '2', '5'];
    const strings: string[] = [''];
    let layer: string[] = [''];
    for (let len = 1; len <= 3; len++) {
      layer = layer.flatMap((s) => alphabet.map((c) => s + c));
      strings.push(...layer);
    }
    const seen = new Map<string, string>();
    for (const provider of ['chatgpt', 'x:y', '%']) {
      for (const account of strings) {
        for (const conv of strings) {
          const id = conversationNodeId(provider, account, conv);
          const key = JSON.stringify([provider, account, conv]);
          const prior = seen.get(id);
          assert.ok(prior === undefined || prior === key, `collision: ${id}`);
          seen.set(id, key);
          const parsed = parseNodeId(id);
          assert.deepEqual(parsed, { type: 'conversation', provider, accountLabel: account, conversationId: conv });
        }
      }
    }
  });

  it('parseNodeId returns null for everything that is not a node id, including non-strings', () => {
    for (const bad of ['', 'x', 'conv:', 'conv:a:b', 'conv:a:b:c:d', 'conv::', 'ent:', 'ent::x', 'ent:keyword', 'ent:tool:x', 'ent:Keyword:x', 'ent:email:x', 'tool', 'TOOL:x', ' tool:x']) {
      assert.equal(parseNodeId(bad), null, JSON.stringify(bad));
    }
    for (const notAString of [undefined, null, 5, {}, [], Symbol.iterator]) {
      assert.equal(parseNodeId(notAString as never), null, String(notAString));
    }
  });

  it('an id built from an unknown entity kind is not a node id', () => {
    assert.equal(parseNodeId(entityNodeId('bogus' as never, 'x')), null);
    assert.equal(parseNodeId(entityNodeId('email' as never, 'a@b.org')), null);
  });

  it('entity ids with colons in the normalized part keep their kind', () => {
    assert.deepEqual(parseNodeId(entityNodeId('timestamp', '2025-01-15T10:30:00Z')), { type: 'entity', kind: 'timestamp', normalized: '2025-01-15T10:30:00Z' });
    assert.deepEqual(parseNodeId(entityNodeId('url', 'example.com:8080/a:b')), { type: 'entity', kind: 'url', normalized: 'example.com:8080/a:b' });
    assert.deepEqual(parseNodeId(entityNodeId('tool', 'a:b')), { type: 'tool', kind: 'tool', normalized: 'a:b' });
  });
});

describe('defects found by review: attachment names that differ only in lone surrogates', () => {
  // attachments_json keeps a lone surrogate as the JSON escape; the build used to try to insert two entities that SQLite
  // stores as the same row, and failed with DB_ERROR (UNIQUE constraint) for the whole graph.
  const attachment = (name: string) => ({ id: null, name, mimeType: null, sizeBytes: null, assetPointer: null, presentInExportAs: null });

  it('the build succeeds and treats them as one file name', async () => {
    const { db, repo } = fresh();
    const withAttachments = (id: string, names: string[]): ConversationRecord => {
      const c = chain(id, ['hello world']);
      const m = c.messages.find((x) => x.nodeKind === 'message');
      assert.ok(m !== undefined);
      m.attachments = names.map(attachment);
      return c;
    };
    await importAll(repo, [withAttachments('c1', ['f\ud800', 'f\ud801']), withAttachments('c2', ['f\ud800'])]);
    const r = buildGraph(db, { minEntityConversations: 1 });
    assert.deepEqual(r.warnings.filter((w) => w.code !== 'EVIDENCE_TRUNCATED'), []);
    const names = rows(db, "SELECT value, normalized FROM entities WHERE kind = 'file_name'");
    assert.deepEqual(names, [{ value: 'f\u{FFFD}', normalized: 'f\u{FFFD}' }]);
    assert.equal(scalar(db, "SELECT count(*) AS n FROM entity_mentions m JOIN entities e USING (entity_id) WHERE e.kind = 'file_name'"), 2);
  });
});

describe('pathological inputs', () => {
  it('a message with 100 000 URLs yields at most 64 URL entities, no secrets, a truncation warning and a bounded build', async () => {
    const { db, repo } = fresh();
    const urls = Array.from({ length: 100_000 }, (_, i) => `https://h${i}.example.com/p${i}?t=zqx${i}#f${i}`).join(' ');
    await importAll(repo, [chain('u1', [urls]), chain('u2', [urls])]);
    const t0 = performance.now();
    const r = buildGraph(db);
    const ms = performance.now() - t0;
    assert.ok(ms < 20_000, `${ms.toFixed(0)} ms`);
    assert.ok(r.warnings.some((w) => w.code === 'TEXT_TRUNCATED_FOR_EXTRACTION'));
    assert.ok(scalar(db, "SELECT count(*) AS n FROM entities WHERE kind = 'url'") <= 64);
    assert.ok(scalar(db, "SELECT count(*) AS n FROM graph_edges WHERE kind = 'co_occurs'") <= (32 * 31) / 2);
    const dump = DERIVED.map((t) => JSON.stringify(rows(db, `SELECT * FROM ${t}`))).join('\n');
    assert.equal(dump.includes('zqx'), false);
    assert.equal(scalar(db, 'SELECT count(*) AS n FROM graph_edges e WHERE NOT EXISTS (SELECT 1 FROM graph_edge_evidence v WHERE v.edge_id = e.edge_id)'), 0);
  });

  it('one entity in every message of a 3000-message hub keeps exact weights, capped evidence and valid foreign keys', async () => {
    const { db, repo } = fresh();
    const texts = Array.from({ length: 1500 }, (_, i) => `hubwordx alphax betax gammax msg${i}x`);
    await importAll(repo, [chain('h1', texts), chain('h2', texts)]);
    const r = buildGraph(db, { maxEvidencePerEdge: 100 });
    assert.ok(r.warnings.some((w) => w.code === 'EVIDENCE_TRUNCATED'));
    assert.equal(scalar(db, "SELECT weight AS n FROM graph_edges WHERE src = 'ent:keyword:hubwordx' AND dst = 'conv:chatgpt:default:h1'"), 1500);
    assert.equal(scalar(db, "SELECT weight AS n FROM graph_edges WHERE src = 'ent:keyword:alphax' AND dst = 'ent:keyword:hubwordx' AND kind = 'co_occurs'"), 3000);
    assert.equal(scalar(db, 'SELECT max(c) AS n FROM (SELECT count(*) AS c FROM graph_edge_evidence GROUP BY edge_id)'), 100);
    assert.equal(scalar(db, 'SELECT count(*) AS n FROM graph_edges e WHERE NOT EXISTS (SELECT 1 FROM graph_edge_evidence v WHERE v.edge_id = e.edge_id)'), 0);
    assert.deepEqual(rows(db, 'PRAGMA foreign_key_check'), []);
  });

  it('options are validated before anything is written: a bad option leaves the previous graph intact', async () => {
    const { db, repo } = fresh();
    await importAll(repo, [chain('k1', ['alphax betax']), chain('k2', ['alphax betax'])]);
    buildGraph(db);
    const before = JSON.stringify(rows(db, 'SELECT * FROM graph_edges ORDER BY edge_id'));
    for (const o of [null, 5, 'x', { provider: 5 }, { accountLabel: 'x'.repeat(513) }, { kinds: ['url', 'bogus'] }, { maxTextChars: 16_777_217 }, { maxEntitiesPerMessage: 2.5 }]) {
      assert.throws(() => buildGraph(db, o as never), (e: unknown) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT', JSON.stringify(o));
    }
    assert.equal(JSON.stringify(rows(db, 'SELECT * FROM graph_edges ORDER BY edge_id')), before);
    assert.equal(db.isTransaction, false);
  });
});
