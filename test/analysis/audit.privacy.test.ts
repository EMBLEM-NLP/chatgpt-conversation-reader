/**
 * Privacy tests for src/analysis/audit.ts (NFR-07, AGENTS.md): the audit output is counts and ids only. A distinctive
 * canary string is planted in every free-text and raw field of a dataset that triggers ALL nine checks; the serialized
 * result must not contain it. Also: samples are real ids, byCode keys are codes or short vocabulary values, results are
 * plain JSON data. Synthetic data only.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AUDIT_CHECKS, runAudit } from '../../src/analysis/audit.js';
import type { AuditResult } from '../../src/analysis/audit.js';
import type { ConversationRecord } from '../../src/domain/types.js';
import { chat, claudeChat, cyclic, fresh, importAll, iso, mismatched, orphaned, selfParent, star } from './support.test.js';

const CANARY = 'PRIVATE-CANARY-9b7e51d3';

/** Puts the canary into every field that carries user content or raw source, without changing structure or blankness. */
function plant(rec: ConversationRecord): ConversationRecord {
  if (rec.title !== null) rec.title = `${CANARY} title`;
  rec.rawMetadata = { note: CANARY };
  rec.sourceUri = `https://example.invalid/c/${CANARY}`;
  rec.warnings = [{ code: 'SYNTHETIC', message: CANARY }];
  for (const m of rec.messages) {
    if (m.nodeKind !== 'message') continue;
    if (m.text.trim() !== '') m.text = `${CANARY} ${m.text}`;
    m.authorName = CANARY;
    m.recipient = CANARY;
    m.status = CANARY;
    m.rawSource = { leak: CANARY };
    m.blocks = [{ type: 'text', text: CANARY, metadata: { s: CANARY } }];
    m.attachments = [{ id: 'att-1', name: `${CANARY}.png`, mimeType: 'image/png', sizeBytes: 1, assetPointer: `file-service://${CANARY}`, presentInExportAs: null }];
  }
  return rec;
}

function dataset(): ConversationRecord[] {
  return [
    chat('p-empty', [{ text: ' ' }, { text: '' }], { title: null }), //                                        empty + untitled
    chat('p-roles', [
      { role: 'function', text: 'one' }, //                                                                     unknown role
      { role: 'user', text: 'two', contentType: 'weird_ct' }, //                                                unknown content type
      { role: 'assistant', text: 'three', model: null }, //                                                     missing model
      { role: 'system', text: 'four', hidden: true }, //                                                        hidden
    ]),
    chat('p-ts', [{ at: iso(5), text: 'five' }, { at: iso(2), text: 'six' }, { at: null, text: 'seven' }], { currentNodeId: null }), // timestamps + no current node
    cyclic('p-cyc'),
    orphaned('p-orph'),
    selfParent('p-self'),
    mismatched('p-mis'),
    star('p-star', 3),
    claudeChat('p-claude', [{ text: 'eight' }]),
    chat('p-partial', [{ text: 'nine' }], { completeness: 'partial_user_supplied', provenance: 'user_supplied_copy' }),
  ].map(plant);
}

async function audited(): Promise<{ result: AuditResult; ids: Set<string> }> {
  const { db, repo } = fresh();
  const recs = dataset();
  await importAll(repo, recs);
  const ids = new Set<string>(['ghost-node', 'ghost-child']); // dangling references that legitimately appear as ids in warnings
  for (const r of recs) {
    ids.add(r.id);
    for (const m of r.messages) ids.add(m.id);
  }
  return { result: runAudit(db, { allBatches: true, sampleSize: 50 }), ids };
}

describe('audit output carries ids and counts only', () => {
  it('the dataset really triggers every check (otherwise the leak assertions below would prove nothing)', async () => {
    const { result } = await audited();
    for (const check of AUDIT_CHECKS) {
      const f = result.findings.find((x) => x.check === check);
      assert.ok(f && f.count > 0, `${check} must have findings in the privacy dataset`);
    }
    assert.ok(result.warnings.some((w) => w.code === 'INCOMPLETE_SOURCE'));
  });

  it('the canary planted in text, titles, raw source, block text, attachments, author names and warnings never appears', async () => {
    const { result } = await audited();
    const text = JSON.stringify(result);
    assert.ok(!text.includes(CANARY), 'canary leaked');
    assert.ok(!text.includes('canary') && !/PRIVATE/i.test(text));
    // Baseline texts and titles that chat() generates must not appear either.
    assert.ok(!/Title of|text of|first prompt|follow up/.test(text));
  });

  it('every sample is an id of the data (or a dangling reference named by the data), never free text', async () => {
    const { result, ids } = await audited();
    for (const f of result.findings) {
      for (const id of [...f.sampleConversationIds, ...f.sampleMessageIds]) assert.ok(ids.has(id), `${f.check}: "${id}" is not a known id`);
    }
    for (const w of result.warnings) for (const id of w.ids ?? []) assert.ok(ids.has(id), `warning ${w.code}: "${id}" is not a known id`);
  });

  it('byCode keys are warning codes or short vocabulary values (roles, content types), nothing else', async () => {
    const { result } = await audited();
    const allowed = new Set([
      // analyzer / audit codes
      'MISSING_PARENT', 'CYCLE_DETECTED', 'SELF_PARENT', 'CHILD_PARENT_MISMATCH', 'NO_CURRENT_NODE', 'INVALID_CURRENT_NODE',
      'MESSAGE_BEFORE_PARENT', 'MESSAGE_CREATED_AT_NULL',
      // vocabulary used by the dataset
      'function', 'weird_ct', 'system', 'user', 'assistant',
    ]);
    for (const f of result.findings) {
      for (const key of Object.keys(f.byCode ?? {})) assert.ok(allowed.has(key), `${f.check}: unexpected byCode key "${key}"`);
    }
  });

  it('descriptions and warning messages are fixed text with numbers: they do not contain any data value from the dataset', async () => {
    const { result } = await audited();
    const strings = [...result.findings.map((f) => f.description), ...result.warnings.map((w) => w.message)];
    for (const s of strings) {
      assert.ok(!s.includes('function') && !s.includes('weird_ct'), s);
      assert.ok(!s.includes('p-cyc') && !s.includes('p-orph'), 'descriptions never name conversations');
      assert.ok(!/\n/.test(s), 'single-line text');
    }
  });

  it('the result is plain JSON data: a JSON round trip changes nothing', async () => {
    const { result } = await audited();
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  });

  it('the error path is content-free as well: a bad option reports only the field name', async () => {
    const { db, repo } = fresh();
    await importAll(repo, dataset());
    try {
      runAudit(db, { provider: `${CANARY}\0` });
      assert.fail('expected a throw');
    } catch (e) {
      assert.ok(!JSON.stringify(e, Object.getOwnPropertyNames(e)).includes(CANARY));
    }
  });
});
