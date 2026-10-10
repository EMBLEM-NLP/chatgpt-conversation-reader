/**
 * Independent adversarial review of the Mode D contract (lens: "the disabled OpenAI-API adapter accidentally doing
 * anything"). The disabled adapter must (1) refuse every call without touching its arguments, (2) perform no I/O at
 * runtime (network, files, processes, DNS) and (3) not be reconfigurable into an "implemented" adapter by a caller,
 * because a process-wide shared instance with a writable `implemented` flag is a switch someone else can flip.
 */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { describe, it, mock } from 'node:test';
import { GcrError } from '../../src/errors.js';
import { DisabledOpenAIAPIOwnedAdapter } from '../../src/ingest/openai-api.js';
import { IO_CAPABLE_MODULES, claudeCtx, codeOf, moduleSpecifiers } from '../helpers/claude-export-builder.js';

function throwsNotImplemented(fn: () => unknown): GcrError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof GcrError, `expected GcrError, got ${String(e)}`);
    assert.equal(e.code, 'NOT_IMPLEMENTED');
    return e;
  }
  return assert.fail('nothing was thrown');
}

describe('DisabledOpenAIAPIOwnedAdapter refuses without reading its arguments', () => {
  const adapter = new DisabledOpenAIAPIOwnedAdapter();

  it('never touches a hostile request object, a throwing getter, or a proxy', () => {
    let touched = 0;
    const hostile = new Proxy({}, { get: () => (touched++, undefined), has: () => (touched++, false), ownKeys: () => (touched++, []) });
    const getter = {
      get limit(): number {
        touched++;
        throw new Error('LEAKMARKER getter was read');
      },
    };
    throwsNotImplemented(() => adapter.listOwnedConversations(hostile as never));
    throwsNotImplemented(() => adapter.listOwnedConversations(getter as never));
    throwsNotImplemented(() => adapter.readOwnedConversation({ toString: () => (touched++, 'x') } as never));
    throwsNotImplemented(() => adapter.normalizeElementText({ toString: () => (touched++, '{}') } as never, hostile as never, Number.NaN));
    assert.equal(touched, 0);
  });

  it('echoes nothing about the request in the error (message, remedy, details)', () => {
    const e = throwsNotImplemented(() => adapter.readOwnedConversation('LEAKMARKER-id-6ac95b6e-9fa0-83e8-bbb0-8107079a8720'));
    assert.ok(!JSON.stringify(e.toEnvelope()).includes('LEAKMARKER'));
    assert.ok(!(e.stack ?? '').includes('LEAKMARKER'));
  });

  it('answers a claimed Claude or ChatGPT context with the same refusal (it cannot be repurposed as an export adapter)', () => {
    for (const provider of ['claude', 'chatgpt', 'openai_api'] as const) {
      throwsNotImplemented(() => adapter.normalizeElementText('{"mapping":{},"chat_messages":[]}', { ...claudeCtx(), provider }, 0));
    }
  });
});

describe('DisabledOpenAIAPIOwnedAdapter performs no I/O at runtime', () => {
  it('calling every method opens no socket, request, DNS lookup, process or file, and never calls fetch', () => {
    const adapter = new DisabledOpenAIAPIOwnedAdapter();
    const spies = [
      mock.method(globalThis, 'fetch', () => Promise.reject(new Error('fetch must not be called'))),
      mock.method(net, 'connect', () => assert.fail('net.connect')),
      mock.method(http, 'request', () => assert.fail('http.request')),
      mock.method(https, 'request', () => assert.fail('https.request')),
      mock.method(dns, 'lookup', () => assert.fail('dns.lookup')),
      mock.method(childProcess, 'spawn', () => assert.fail('child_process.spawn')),
      mock.method(childProcess, 'execSync', () => assert.fail('child_process.execSync')),
      mock.method(fs, 'openSync', () => assert.fail('fs.openSync')),
      mock.method(fs, 'readFileSync', () => assert.fail('fs.readFileSync')),
    ];
    try {
      throwsNotImplemented(() => adapter.listOwnedConversations({ limit: 5, cursor: 'c' }));
      throwsNotImplemented(() => adapter.readOwnedConversation('00000000-0000-4000-8000-000000000001'));
      throwsNotImplemented(() => adapter.normalizeElementText('{}', claudeCtx(), 0));
      for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
    } finally {
      mock.restoreAll();
    }
  });
});

describe('DisabledOpenAIAPIOwnedAdapter cannot be switched on', () => {
  it('the instance is frozen: `implemented`, `provider`, `provenance`, `mode` and the methods cannot be reassigned', () => {
    const adapter = new DisabledOpenAIAPIOwnedAdapter();
    assert.ok(Object.isFrozen(adapter));
    const writable = adapter as unknown as Record<string, unknown>;
    for (const key of ['implemented', 'provider', 'provenance', 'mode', 'name', 'listOwnedConversations', 'readOwnedConversation', 'normalizeElementText']) {
      assert.throws(() => {
        writable[key] = key === 'implemented' ? true : 'official_chatgpt_export';
      }, TypeError, key);
    }
    assert.equal(adapter.implemented, false);
    assert.equal(adapter.provider, 'openai_api');
    assert.equal(adapter.provenance, 'openai_developer_api');
    assert.equal(adapter.mode, 'D');
    assert.throws(() => {
      writable['credentials'] = 'placeholder-credential-value';
    }, TypeError);
    assert.equal(Object.keys(adapter).includes('credentials'), false);
  });

  it('has no credential, token, key or endpoint property anywhere on the instance or its prototype chain', () => {
    const adapter = new DisabledOpenAIAPIOwnedAdapter();
    const names: string[] = [];
    for (let o: object | null = adapter; o !== null && o !== Object.prototype; o = Object.getPrototypeOf(o) as object | null) names.push(...Object.getOwnPropertyNames(o));
    assert.deepEqual(names.filter((n) => /key|token|secret|credential|auth|url|endpoint|host|fetch|client/i.test(n)), []);
  });
});

describe('openai-api.ts purity holds transitively', () => {
  /** Runtime (non-type) relative imports reachable from a source file. */
  function runtimeRelativeImports(file: string): string[] {
    const code = codeOf(file);
    const found: string[] = [];
    for (const m of code.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s*['"](\.[^'"]+)['"]/gm)) found.push(m[1] ?? '');
    return found;
  }

  it('every module reachable by a runtime import imports no I/O-capable built-in', () => {
    const seen = new Set<string>();
    const queue = ['src/ingest/openai-api.ts'];
    while (queue.length > 0) {
      const file = queue.pop();
      if (file === undefined || seen.has(file)) continue;
      seen.add(file);
      const specs = moduleSpecifiers(codeOf(file)).map((s) => s.replace(/^node:/, ''));
      for (const forbidden of IO_CAPABLE_MODULES) assert.ok(!specs.includes(forbidden), `${file} imports ${forbidden}`);
      for (const rel of runtimeRelativeImports(file)) {
        const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
        const target = new URL(rel.replace(/\.js$/, '.ts'), `file:///${dir}/`).pathname.slice(1);
        queue.push(target);
      }
    }
    assert.deepEqual([...seen].sort(), ['src/errors.ts', 'src/ingest/openai-api.ts']);
  });

  it('the only runtime dependency (errors.ts) has no imports at all', () => {
    assert.deepEqual(moduleSpecifiers(codeOf('src/errors.ts')), []);
  });

  it('the compiled module contains no network or process vocabulary either', () => {
    const js = fs.readFileSync(new URL('../../src/ingest/openai-api.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
    for (const pattern of [/\bfetch\b/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bprocess\b/, /\bBuffer\b/, /\brequire\s*\(/, /\bimport\s*\(/, /\bglobalThis\b/, /\bsk-[A-Za-z0-9]/, /api\.openai\.com/, /OPENAI_API_KEY/, /Authorization/i]) {
      assert.ok(!pattern.test(js), `forbidden in compiled output: ${pattern}`);
    }
  });
});
