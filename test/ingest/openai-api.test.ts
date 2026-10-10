/**
 * Mode D contract (SPEC section 3): the OpenAI developer API is a separately authorized capability for the user's OWN
 * API-created conversations. This version ships only the interface and a disabled implementation; the tests pin that
 * every method refuses with NOT_IMPLEMENTED and that the module cannot perform I/O.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { EXIT_CODES, GcrError } from '../../src/errors.js';
import type { AdapterContext } from '../../src/ingest/adapter.js';
import { DisabledOpenAIAPIOwnedAdapter, modeDNotImplemented } from '../../src/ingest/openai-api.js';
import type { OpenAIAPIOwnedAdapter } from '../../src/ingest/openai-api.js';
import { IO_CAPABLE_MODULES, claudeCtx, codeOf, moduleSpecifiers } from '../helpers/claude-export-builder.js';

function notImplemented(fn: () => unknown): GcrError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof GcrError, `expected GcrError, got ${String(e)}`);
    assert.equal(e.code, 'NOT_IMPLEMENTED');
    return e;
  }
  return assert.fail('expected NOT_IMPLEMENTED, nothing was thrown');
}

describe('DisabledOpenAIAPIOwnedAdapter', () => {
  // Compile-time proof that the disabled class satisfies the documented Mode D contract.
  const adapter: OpenAIAPIOwnedAdapter = new DisabledOpenAIAPIOwnedAdapter();

  it('declares Mode D identity: provider openai_api, provenance openai_developer_api, mode D, not implemented', () => {
    assert.equal(adapter.provider, 'openai_api');
    assert.equal(adapter.provenance, 'openai_developer_api');
    assert.equal(adapter.mode, 'D');
    assert.equal(adapter.implemented, false);
    assert.match(adapter.name, /disabled/);
  });

  it('is NOT a ChatGPT adapter: it can never claim the chatgpt provider or the official-export provenance', () => {
    assert.notEqual(adapter.provider, 'chatgpt');
    assert.notEqual(adapter.provider, 'claude');
    assert.notEqual(adapter.provenance, 'official_chatgpt_export');
  });

  const ctx: AdapterContext = { ...claudeCtx(), provider: 'openai_api' };
  const calls: Array<[string, () => unknown]> = [
    ['normalizeElementText', () => adapter.normalizeElementText('{}', ctx, 0)],
    ['normalizeElementText (a plausible ChatGPT element)', () => adapter.normalizeElementText('{"mapping":{},"id":"6ac95b6e-9fa0-83e8-bbb0-8107079a8720"}', ctx, 0)],
    ['listOwnedConversations()', () => adapter.listOwnedConversations()],
    ['listOwnedConversations({limit,cursor})', () => adapter.listOwnedConversations({ limit: 10, cursor: 'abc' })],
    ['readOwnedConversation(uuid)', () => adapter.readOwnedConversation('6ac95b6e-9fa0-83e8-bbb0-8107079a8720')],
    ['readOwnedConversation(chatgpt.com URL)', () => adapter.readOwnedConversation('https://chatgpt.com/c/6ac95b6e-9fa0-83e8-bbb0-8107079a8720')],
    ['readOwnedConversation("")', () => adapter.readOwnedConversation('')],
  ];

  for (const [label, call] of calls) {
    it(`${label} throws GcrError NOT_IMPLEMENTED synchronously (not a promise that could be left unawaited)`, () => {
      const e = notImplemented(call);
      assert.equal(e.exitCode, EXIT_CODES.NOT_IMPLEMENTED);
      assert.equal(typeof e.details?.['method'], 'string');
      assert.equal(e.details?.['mode'], 'D');
    });
  }

  it('the remedy explains Mode D: not consumer history, separately authorized key held outside GCR, not implemented here', () => {
    const e = notImplemented(() => adapter.listOwnedConversations());
    const remedy = e.remedy ?? '';
    assert.match(remedy, /not ChatGPT consumer history/);
    assert.match(remedy, /chatgpt\.com\/c\/<uuid>/);
    assert.match(remedy, /separately authorized API key/);
    assert.match(remedy, /outside GCR/);
    assert.match(remedy, /never requests, stores or logs credentials/);
    assert.match(remedy, /not implemented in this version/);
    assert.match(remedy, /official data export/, 'points the operator to the supported path');
    assert.match(e.message, /Mode D/);
  });

  it('the error envelope is a normal structured error (ok:false, code, remedy) and never echoes arguments', () => {
    const e = notImplemented(() => adapter.readOwnedConversation('LEAKMARKER-conversation-id'));
    const env = e.toEnvelope();
    assert.equal(env.ok, false);
    assert.equal(env.error.code, 'NOT_IMPLEMENTED');
    assert.ok(env.error.remedy !== undefined);
    assert.ok(!JSON.stringify(env).includes('LEAKMARKER'));
  });

  it('modeDNotImplemented RETURNS the error for the given method (the registry reuses it)', () => {
    const e = modeDNotImplemented('getAdapter');
    assert.ok(e instanceof GcrError);
    assert.equal(e.details?.['method'], 'getAdapter');
  });
});

describe('openai-api.ts cannot perform I/O (source-level assertion)', () => {
  const ts = codeOf('src/ingest/openai-api.ts');

  it('imports exactly the pure error class and two type-only modules', () => {
    assert.deepEqual(moduleSpecifiers(ts), ['../domain/types.js', '../errors.js', './adapter.js']);
    for (const line of ts.split('\n').filter((l) => /\bfrom\s*'(\.\.\/domain\/types|\.\/adapter)\.js'/.test(l))) {
      assert.match(line, /^\s*import type\b/, `must be a type-only import: ${line}`);
    }
  });

  it('names none of the I/O-capable built-ins, with or without the node: prefix', () => {
    const specs = moduleSpecifiers(ts).map((s) => s.replace(/^node:/, ''));
    for (const forbidden of IO_CAPABLE_MODULES) assert.ok(!specs.includes(forbidden), forbidden);
    for (const forbidden of IO_CAPABLE_MODULES) {
      assert.ok(!ts.includes(`'${forbidden}'`) && !ts.includes(`'node:${forbidden}'`), `string literal naming ${forbidden}`);
    }
  });

  it('uses no fetch/XHR/WebSocket/require/dynamic import/process/globalThis/eval', () => {
    for (const pattern of [/\bfetch\b/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\brequire\s*\(/, /\bimport\s*\(/, /\bprocess\b/, /\bglobalThis\b/, /\beval\b/, /new\s+Function/, /\bDate\b/, /Math\.random/, /\bconsole\b/]) {
      assert.ok(!pattern.test(ts), `forbidden construct: ${pattern}`);
    }
  });

  it('holds for the COMPILED module too (type imports are erased, so this is what actually runs)', () => {
    const js = readFileSync(new URL('../../src/ingest/openai-api.js', import.meta.url), 'utf8');
    assert.deepEqual(moduleSpecifiers(js.replace(/\/\*[\s\S]*?\*\//g, '')), ['../errors.js']);
  });
});
