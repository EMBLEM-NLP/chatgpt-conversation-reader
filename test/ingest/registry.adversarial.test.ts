/**
 * Independent adversarial review of the adapter registry (lens: provider confusion). Detection must never attribute
 * one provider's data to the other, the registry must not hand out mutable shared adapters whose identity a caller can
 * rewrite, and the id spaces of the two providers must stay apart.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { GcrError } from '../../src/errors.js';
import { ADAPTER_IDS, detectAdapterFromElementText, getAdapter, listAdapters } from '../../src/ingest/registry.js';
import type { AdapterId } from '../../src/ingest/registry.js';
import { claudeCtx } from '../helpers/claude-export-builder.js';

const SEED = 20261016;
const FIXTURES = new URL('../../../fixtures/', import.meta.url);

/** Each top-level array element (or the single top-level object) of every committed fixture of one provider. */
function fixtureElements(dir: 'chatgpt' | 'claude'): Array<{ file: string; index: number; text: string }> {
  const out: Array<{ file: string; index: number; text: string }> = [];
  for (const file of readdirSync(new URL(`${dir}/`, FIXTURES)).filter((f) => f.endsWith('.json')).sort()) {
    const parsed: unknown = JSON.parse(readFileSync(new URL(`${dir}/${file}`, FIXTURES), 'utf8'));
    (Array.isArray(parsed) ? parsed : [parsed]).forEach((el, index) => out.push({ file, index, text: JSON.stringify(el) }));
  }
  return out;
}

describe('detection never crosses providers on the committed fixtures', () => {
  it('no ChatGPT fixture element is ever attributed to Claude', () => {
    const els = fixtureElements('chatgpt');
    assert.ok(els.length >= 20, 'the fixture corpus is not empty');
    for (const e of els) assert.notEqual(detectAdapterFromElementText(e.text).adapter, 'claude', `${e.file}[${e.index}]`);
  });

  it('no Claude fixture element is ever attributed to ChatGPT, and every one is recognised as Claude', () => {
    const els = fixtureElements('claude');
    assert.ok(els.length >= 8);
    for (const e of els) assert.equal(detectAdapterFromElementText(e.text).adapter, 'claude', `${e.file}[${e.index}]`);
  });

  it('every ChatGPT fixture element that carries a conversation mapping is recognised as ChatGPT', () => {
    let recognised = 0;
    for (const e of fixtureElements('chatgpt')) {
      const v = JSON.parse(e.text) as unknown;
      const mapping = typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>)['mapping'] : undefined;
      if (typeof mapping === 'object' && mapping !== null && !Array.isArray(mapping)) {
        assert.equal(detectAdapterFromElementText(e.text).adapter, 'chatgpt', `${e.file}[${e.index}]`);
        recognised++;
      }
    }
    assert.ok(recognised >= 20);
  });
});

describe('detection and the Claude adapter agree exactly', () => {
  const value = fc.oneof(fc.constant(null), fc.constant({}), fc.constant([]), fc.constant([{ uuid: 'm' }]), fc.string(), fc.integer(), fc.constant({ a: [1] }));
  const element = fc
    .tuple(fc.option(value, { nil: undefined }), fc.option(value, { nil: undefined }), fc.dictionary(fc.constantFrom('uuid', 'name', 'id', 'title', 'extra'), fc.jsonValue({ maxDepth: 1 }), { maxKeys: 3 }))
    .map(([mapping, chat, rest]) => {
      const o: Record<string, unknown> = { ...rest };
      if (mapping !== undefined) o['mapping'] = mapping;
      if (chat !== undefined) o['chat_messages'] = chat;
      return JSON.stringify(o);
    });

  it('detected "claude" => the Claude adapter converts it; detected "chatgpt" => the Claude adapter refuses it as NOT_A_CONVERSATION', () => {
    const claude = getAdapter('claude');
    fc.assert(
      fc.property(element, (text) => {
        const d = detectAdapterFromElementText(text);
        let kind = 'threw';
        let reason = '';
        try {
          const out = claude.normalizeElementText(text, claudeCtx(), 0);
          kind = out.kind;
          if (out.kind === 'skipped') reason = out.reason;
        } catch (e) {
          assert.ok(e instanceof GcrError);
        }
        if (d.adapter === 'claude') assert.equal(kind, 'record', text);
        if (d.adapter === 'chatgpt') assert.deepEqual([kind, reason], ['skipped', 'NOT_A_CONVERSATION'], text);
      }),
      { seed: SEED, numRuns: 400 },
    );
  });
});

describe('the registry hands out adapters whose identity cannot be rewritten', () => {
  for (const id of ['chatgpt', 'claude'] as const) {
    it(`the shared ${id} adapter is frozen: provider, provenance and name cannot be reassigned by any caller`, () => {
      const adapter = getAdapter(id);
      assert.ok(Object.isFrozen(adapter));
      const before = JSON.stringify(listAdapters());
      const writable = adapter as unknown as Record<string, unknown>;
      for (const key of ['provider', 'provenance', 'name']) {
        assert.throws(() => {
          writable[key] = 'x';
        }, TypeError, `${id}.${key}`);
      }
      assert.equal(JSON.stringify(listAdapters()), before, 'listAdapters is unaffected');
    });
  }

  it('listAdapters hands out fresh objects: mutating one entry cannot change what the next caller sees', () => {
    const first = listAdapters();
    first[1]!.provenance = 'official_chatgpt_export';
    first[1]!.provider = 'chatgpt';
    assert.deepEqual(listAdapters()[1], { id: 'claude', name: 'claude-export', provider: 'claude', provenance: 'official_claude_export' });
    assert.throws(() => (ADAPTER_IDS as AdapterId[]).push('chatgpt'), TypeError);
  });

  it('identity of every registered adapter matches the provider id it is registered under (no crossed wiring)', () => {
    for (const info of listAdapters()) {
      assert.equal(getAdapter(info.id).provider, info.id, info.id);
      assert.ok(getAdapter(info.id).provenance.includes(info.id), info.id);
    }
  });

  it('non-string ids that stringify to a valid id are still rejected (no coercion)', () => {
    for (const bad of [{ toString: () => 'claude' }, new String('claude'), ['claude'], { [Symbol.toPrimitive]: () => 'chatgpt' }]) {
      assert.throws(() => getAdapter(bad as never), (e: unknown) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT');
    }
  });
});
