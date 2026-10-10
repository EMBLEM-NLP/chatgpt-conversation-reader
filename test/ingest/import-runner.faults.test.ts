/**
 * Fault injection around the REAL adapter instance (the runner and the repository are the real ones): an unexpected
 * exception, a record the domain validator rejects, and two winners that normalize to the same record id. The shared
 * adapter instance from the registry is wrapped for the duration of one test and always restored.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AdapterOutcome, ConversationSourceAdapter } from '../../src/ingest/adapter.js';
import { runImport } from '../../src/ingest/import-runner.js';
import { getAdapter } from '../../src/ingest/registry.js';
import { syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import { withTempDir } from '../helpers/tmp.js';
import { GcrError } from '../../src/errors.js';
import { arrayOf, captureStderr, chatConv, count, dbDump, expectCode, fixedClock, freshRepo, writeFileIn } from './import-runner.helpers.test.js';

type Normalize = ConversationSourceAdapter['normalizeElementText'];

/** The adapter instance is frozen, so the method is wrapped on its prototype (restored in `finally`). */
async function withWrappedAdapter<T>(wrap: (real: Normalize) => Normalize, fn: () => Promise<T>): Promise<T> {
  const adapter = getAdapter('chatgpt');
  const proto = Object.getPrototypeOf(adapter) as { normalizeElementText: Normalize };
  const original = proto.normalizeElementText;
  const bound: Normalize = original.bind(adapter);
  proto.normalizeElementText = wrap(bound);
  try {
    return await fn();
  } finally {
    proto.normalizeElementText = original;
  }
}

describe('faults', () => {
  it('an unexpected exception from the adapter skips that element (ELEMENT_INTERNAL_ERROR), logs counts only, and the rest imports', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const file = await writeFileIn(dir, 'conversations.json', arrayOf([chatConv(1), chatConv(2, { title: 'PLANTED-FAULT-TITLE' }), chatConv(3)]));
        const { result: r, stderr } = await captureStderr(() =>
          withWrappedAdapter(
            (real) => (text, ctx, i) => {
              if (i === 1) throw new TypeError(`boom while reading ${text.slice(0, 40)}`);
              return real(text, ctx, i);
            },
            () => runImport(t.repo, { source: { kind: 'path', path: file }, clock: fixedClock }),
          ),
        );
        assert.deepEqual(r.conversations, { read: 3, stored: 2, failed: 1, newlyInserted: 2 });
        assert.deepEqual(r.warnings.find((w) => w.code === 'ELEMENT_INTERNAL_ERROR')?.sampleIds, ['conversations.json#1']);
        assert.ok(stderr.includes('element normalization raised an unexpected error'));
        assert.ok(!stderr.includes('boom') && !stderr.includes('conversations.json'.repeat(2)), 'the exception text is never logged');
      });
    } finally {
      t.close();
    }
  });

  it('under --strict an unexpected exception becomes a generic INTERNAL_ERROR and nothing is stored', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const file = await writeFileIn(dir, 'conversations.json', arrayOf([chatConv(1), chatConv(2), chatConv(3)]));
        const before = dbDump(t.db);
        await withWrappedAdapter(
          (real) => (text, ctx, i) => {
            if (i === 2) throw new Error('PLANTED-INTERNAL-DETAIL');
            return real(text, ctx, i);
          },
          async () => {
            await assert.rejects(runImport(t.repo, { source: { kind: 'path', path: file }, strict: true, clock: fixedClock }), (e: unknown) => {
              assert.ok(e instanceof GcrError);
              assert.equal(e.code, 'INTERNAL_ERROR');
              assert.ok(!JSON.stringify(e.toEnvelope()).includes('PLANTED-INTERNAL-DETAIL'));
              return true;
            });
          },
        );
        assert.equal(dbDump(t.db), before);
      });
    } finally {
      t.close();
    }
  });

  it('a record the domain validator rejects fails ONE element instead of aborting the whole transaction', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const file = await writeFileIn(dir, 'conversations.json', arrayOf([chatConv(1), chatConv(2), chatConv(3)]));
        const corrupt = (real: Normalize): Normalize => (text, ctx, i): AdapterOutcome => {
          const out = real(text, ctx, i);
          if (i === 1 && out.kind === 'record') {
            const bad = structuredClone(out.record);
            const m = bad.messages[0];
            if (m !== undefined) m.id = ''; // schema: identifier must be non-empty
            return { ...out, record: bad };
          }
          return out;
        };
        const r = await withWrappedAdapter(corrupt, () => runImport(t.repo, { source: { kind: 'path', path: file }, clock: fixedClock }));
        assert.deepEqual(r.conversations, { read: 3, stored: 2, failed: 1, newlyInserted: 2 });
        assert.equal(r.warnings.find((w) => w.code === 'ELEMENT_PARSE_FAILED')?.count, 1);

        const t2 = freshRepo();
        try {
          await withWrappedAdapter(corrupt, async () => {
            await assert.rejects(runImport(t2.repo, { source: { kind: 'path', path: file }, strict: true, clock: fixedClock }), expectCode('IMPORT_PARSE_ERROR'));
          });
          assert.equal(count(t2.db, 'source_batches'), 0);
        } finally {
          t2.close();
        }
      });
    } finally {
      t.close();
    }
  });

  it('two winners that normalize to the same record id: the repository keeps the first and the report says so', async () => {
    const t = freshRepo();
    try {
      await withTempDir(async (dir) => {
        const file = await writeFileIn(dir, 'conversations.json', arrayOf([chatConv(1), chatConv(2), chatConv(3)]));
        const clash = (real: Normalize): Normalize => (text, ctx, i): AdapterOutcome => {
          const out = real(text, ctx, i);
          if (i === 2 && out.kind === 'record') {
            const record = { ...out.record, id: syntheticUuid(1), messages: out.record.messages.map((m) => ({ ...m, conversationId: syntheticUuid(1) })) };
            return { ...out, record };
          }
          return out;
        };
        const r = await withWrappedAdapter(clash, () => runImport(t.repo, { source: { kind: 'path', path: file }, clock: fixedClock }));
        assert.equal(r.conversations.stored, 2);
        assert.equal(r.warnings.find((w) => w.code === 'DUPLICATE_CONVERSATION_IN_BATCH')?.count, 1);
        assert.ok(t.repo.getBatch(r.batchId)?.warnings.some((w) => w.code === 'DUPLICATE_CONVERSATION_IN_BATCH'));
      });
    } finally {
      t.close();
    }
  });

  it('the wrapped adapter is restored after every test (no cross-test contamination)', () => {
    const adapter = getAdapter('chatgpt');
    assert.equal(adapter.normalizeElementText.toString().includes('boom'), false);
    assert.equal(adapter.normalizeElementText.toString().includes('PLANTED'), false);
    assert.equal(adapter.provider, 'chatgpt');
  });
});
