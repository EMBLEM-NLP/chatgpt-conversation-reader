/**
 * Mode B adversarial review (lens: idempotency, leaks, hostile identifiers). Real Repository, no mocks.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GcrError } from '../../src/errors.js';
import { manualCopyDigest, parseManualCopyJson, runManualCopyImport } from '../../src/ingest/manual-copy.js';
import { count, errorSurface, fixedClock, freshRepo } from './import-runner.helpers.test.js';

const doc = (over: Record<string, unknown> = {}, message: Record<string, unknown> = {}): string =>
  JSON.stringify({ messages: [{ role: 'user', text: 'hello', ...message }], ...over });

describe('Mode B identifiers must survive storage unchanged', () => {
  // DEFECT: a role or modelSlug with a lone surrogate was accepted, then silently rewritten to U+FFFD by SQLite, so the stored
  // value differed from the digested one (and from what the operator typed).
  it('a lone surrogate in role or modelSlug is refused (field path only, value not echoed)', async () => {
    const t = freshRepo();
    try {
      for (const [label, text, field] of [
        ['role', '{"messages":[{"role":"user\\ud800SECRETQQ","text":"x"}]}', 'messages[0].role'],
        ['role (trailing low surrogate)', '{"messages":[{"role":"\\udc00SECRETQQ","text":"x"}]}', 'messages[0].role'],
        ['modelSlug', '{"messages":[{"role":"user","text":"x","modelSlug":"m\\ud800SECRETQQ"}]}', 'messages[0].modelSlug'],
      ] as const) {
        await assert.rejects(runManualCopyImport(t.repo, { text, clock: fixedClock }), (e: unknown) => {
          assert.ok(e instanceof GcrError, label);
          assert.equal(e.code, 'IMPORT_PARSE_ERROR', label);
          assert.equal(e.details?.['field'], field, label);
          assert.ok(!errorSurface(e).includes('SECRETQQ'), label);
          return true;
        });
      }
      assert.equal(count(t.db, 'source_batches'), 0);
    } finally {
      t.close();
    }
  });

  it('well-formed surrogate PAIRS (emoji, astral CJK) in role, modelSlug, title and text are fine and round-trip', async () => {
    const t = freshRepo();
    try {
      const r = await runManualCopyImport(t.repo, { text: doc({ title: 'caf\u00e9 \ud83d\ude00' }, { role: 'r\ud83d\ude00le', text: '\ud842\udfb7 text', modelSlug: 'm\ud83d\ude00' }), clock: fixedClock });
      const rec = t.repo.getConversation({ conversationId: r.warnings.find((w) => w.code === 'PARTIAL_USER_SUPPLIED')?.sampleIds[0] ?? '' });
      assert.equal(rec?.title, 'caf\u00e9 \ud83d\ude00');
      assert.equal(rec?.messages[0]?.authorRole, 'r\ud83d\ude00le');
      assert.equal(rec?.messages[0]?.modelSlug, 'm\ud83d\ude00');
      assert.equal(rec?.messages[0]?.text, '\ud842\udfb7 text');
    } finally {
      t.close();
    }
  });
});

describe('Mode B idempotency', () => {
  it('spellings that normalize to the same content are ONE batch: NULs, key order, whitespace, time zones, an explicit null model', async () => {
    const t = freshRepo();
    try {
      const a = await runManualCopyImport(t.repo, { text: '{"title":"T","messages":[{"role":"user","text":"he\\u0000llo","createdAt":"2025-01-01T01:00:00+01:00"},{"role":"assistant","text":"ok","modelSlug":""}]}', clock: fixedClock });
      const b = await runManualCopyImport(t.repo, {
        text: '{\n "messages": [ {"createdAt":"2025-01-01T00:00:00.000Z","text":"hello","role":"user"}, {"modelSlug":null,"text":"ok","role":"assistant"} ],\n "title": "T" }',
        clock: () => '2041-01-01T00:00:00.000Z',
      });
      assert.equal(b.alreadyImported, true);
      assert.equal(b.batchId, a.batchId);
      assert.equal(count(t.db, 'conversations'), 1);
      // The no-op report still says "partial": it is restored from the stored batch, not recomputed.
      assert.ok(b.warnings.some((w) => w.code === 'PARTIAL_USER_SUPPLIED'));
      assert.deepEqual(b.warnings, a.warnings);
      assert.equal(t.repo.getBatch(a.batchId)?.importedAt, '2026-02-03T04:05:06.007Z');
    } finally {
      t.close();
    }
  });

  it('anything meaningful changes the digest: a role, a message order, a single character, the sourceUri, the title', () => {
    const base = parseManualCopyJson(doc({ title: 'T' }));
    const d0 = manualCopyDigest(base);
    const variants = [
      doc({ title: 'T2' }),
      doc({ title: 'T' }, { role: 'assistant' }),
      doc({ title: 'T' }, { text: 'hellO' }),
      doc({ title: 'T', sourceUri: 'https://chatgpt.com/c/00000000-0000-4000-8000-0000000000aa' }),
      JSON.stringify({ title: 'T', messages: [{ role: 'user', text: 'hello' }, { role: 'user', text: 'hello' }] }),
    ];
    const seen = new Set([d0]);
    for (const v of variants) seen.add(manualCopyDigest(parseManualCopyJson(v)));
    assert.equal(seen.size, variants.length + 1);
  });
});

describe('Mode B hostile documents', () => {
  it('prototype-looking keys and roles are plain data: nothing leaks into Object.prototype, the unknown keys are only counted', async () => {
    const t = freshRepo();
    try {
      const text = '{"__proto__":{"polluted":true},"constructor":1,"toString":2,"messages":[{"role":"__proto__","text":"x","__proto__":{"polluted":true},"hasOwnProperty":3}]}';
      const r = await runManualCopyImport(t.repo, { text, clock: fixedClock });
      assert.equal(r.conversations.stored, 1);
      assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
      const w = r.warnings.find((x) => x.code === 'UNKNOWN_KEY_IGNORED');
      assert.equal(w?.count, 5, 'three unknown top-level keys and two unknown message keys, in ONE summary entry');
      assert.equal(r.warnings.filter((x) => x.code === 'UNKNOWN_KEY_IGNORED').length, 1);
      assert.ok(!JSON.stringify(r).includes('hasOwnProperty'), 'key names are never echoed');
    } finally {
      t.close();
    }
  });

  it('a document that is not an object, deeply nested garbage and absurd shapes are INVALID/PARSE errors, never crashes', async () => {
    const t = freshRepo();
    try {
      const deep = '['.repeat(50_000) + ']'.repeat(50_000);
      for (const text of ['[]', 'null', '42', '"s"', deep, '{"messages":' + deep + '}', '{"messages":{"0":{"role":"user","text":"x"}}}', '{"messages":[null]}', '{"messages":[[]]}', '{"messages":[{"role":"","text":"x"}]}']) {
        await assert.rejects(runManualCopyImport(t.repo, { text, clock: fixedClock }), (e: unknown) => e instanceof GcrError && ['IMPORT_PARSE_ERROR', 'IMPORT_LIMIT_EXCEEDED'].includes(e.code), text.slice(0, 30));
      }
      assert.equal(count(t.db, 'source_batches'), 0);
    } finally {
      t.close();
    }
  });

  it('the source label is a basename in the report and in the stored batch, however hostile', async () => {
    const t = freshRepo();
    try {
      for (const [label, expected] of [
        ['/home/someone/secret/notes.json', 'notes.json'],
        ['C:\\Users\\someone\\secret\\notes2.json', 'notes2.json'],
        ['..', 'manual-copy'],
        ['', 'manual-copy'],
        ['a/b/', 'b'],
      ] as const) {
        const r = await runManualCopyImport(t.repo, { text: doc({ title: label }), sourceLabel: label, clock: fixedClock });
        assert.equal(r.sourceLabel, expected, label);
        assert.equal(t.repo.getBatch(r.batchId)?.sourceLabel, expected, label);
      }
    } finally {
      t.close();
    }
  });
});
