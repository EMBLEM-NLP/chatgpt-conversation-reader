/**
 * Source-level boundaries of src/mcp (NFR-01, AGENTS.md hard boundary): no network or process-spawning module, nothing that
 * can send or fetch from chatgpt.com, no console output, stdout only through the guard, the bootstrap import first in the
 * entry, no characters that break TypeScript 7's emit; and no tool whose name or description promises to send, post or
 * submit anything, except in negation.
 *
 * test/security/no-network.test.ts scans all of src/ with a real tokenizer; this file adds the MCP-specific rules.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import type { Fixture, MemHarness } from './mcp.helpers.test.js';
import { connectMem, createFixture, LINE_SEPARATOR, PARAGRAPH_SEPARATOR } from './mcp.helpers.test.js';

// Compiled tests live at <root>/<outDir>/test/mcp, whatever the out dir is called.
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const mcpDir = `${repoRoot}src/mcp/`;

/** Remove comments, keep string and template literals intact (so a URL inside a string is not mistaken for a comment). */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
    } else if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') {
          out += src[i];
          i++;
        }
        out += src[i] ?? '';
        i++;
      }
      out += quote;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

describe('src/mcp source boundaries', () => {
  const sources = new Map<string, string>();
  before(async () => {
    assert.ok(existsSync(`${repoRoot}package.json`), 'located the repository root');
    for (const name of (await readdir(mcpDir)).filter((n) => n.endsWith('.ts'))) sources.set(name, await readFile(`${mcpDir}${name}`, 'utf8'));
  });

  it('has the expected files', () => {
    for (const f of ['server.ts', 'tools.ts', 'envelope.ts', 'approved-roots.ts', 'aliases.ts', 'entry.ts', 'registry.ts', 'stdout-guard.ts', 'stdio-bootstrap.ts']) assert.ok(sources.has(f), f);
  });

  it('imports no network, process-spawning, evaluation or module-loader builtin, and only reviewed packages', () => {
    const forbidden = /^(?:node:)?(?:http|https|http2|net|tls|dns|dgram|quic|cluster|worker_threads|vm|inspector|child_process|repl|module|test)(?:\/|$)/;
    const allowedPackages = new Set([
      '@modelcontextprotocol/sdk/server/mcp.js',
      '@modelcontextprotocol/sdk/server/stdio.js',
      '@modelcontextprotocol/sdk/shared/protocol.js',
      '@modelcontextprotocol/sdk/types.js',
      'zod',
    ]);
    for (const [file, raw] of sources) {
      const code = stripComments(raw);
      const specifiers = [
        ...[...code.matchAll(/^(?:import|export)\s[^;]*?\bfrom\s*['"]([^'"]+)['"]\s*;/gm)].map((m) => m[1] as string),
        ...[...code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] as string),
      ];
      assert.ok(specifiers.length > 0 || file === 'stdout-guard.ts', `${file} has imports`);
      for (const spec of specifiers) {
        assert.ok(!forbidden.test(spec), `${file} imports ${spec}`);
        if (spec.startsWith('.')) assert.ok(/^\.\.?\//.test(spec) && spec.endsWith('.js'), `${file}: relative imports use .js: ${spec}`);
        else if (!spec.startsWith('node:')) assert.ok(allowedPackages.has(spec), `${file} imports the unreviewed package ${spec}`);
      }
      assert.ok(!/require\s*\(/.test(code), `${file} must not use require()`);
      assert.ok(!/import\s*\(/.test(code.replace(/import\s*\(\s*['"][^'"]+['"]\s*\)/g, '')), `${file}: dynamic import with a computed specifier`);
    }
  });

  it('contains no fetch, socket, browser or evaluation primitive', () => {
    for (const [file, raw] of sources) {
      const code = stripComments(raw);
      for (const word of [/\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bEventSource\b/, /\bsendBeacon\b/, /\beval\s*\(/, /\bnew\s+Function\b/, /\bglobalThis\b/, /\bspawn\s*\(/, /\bexecFile?\s*\(/]) {
        assert.ok(!word.test(code), `${file} uses ${String(word)}`);
      }
    }
  });

  it('names no URL except the documented chatgpt.com/c/<uuid> lookup-key form', () => {
    for (const [file, raw] of sources) {
      for (const url of stripComments(raw).match(/https?:\/\/[^'"\s)`]*/g) ?? []) assert.equal(url, 'https://chatgpt.com/c/<uuid>', `${file}: ${url}`);
    }
  });

  it('writes no console output; stdout is touched only by the guard', () => {
    for (const [file, raw] of sources) {
      const code = stripComments(raw);
      assert.ok(!/\bconsole\s*\./.test(code), `${file} uses console`);
      if (file !== 'stdout-guard.ts') assert.ok(!/process\.stdout/.test(code), `${file} touches process.stdout`);
    }
  });

  it('entry.ts imports the stdio bootstrap FIRST, so the stdout guard is in place before any other module loads', () => {
    const code = stripComments(sources.get('entry.ts') as string).replace(/^#!.*\n/, '');
    const firstImport = /^\s*import\s[^;]*?from\s*['"]([^'"]+)['"]/m.exec(code);
    assert.equal(firstImport?.[1], './stdio-bootstrap.js');
    assert.match(sources.get('entry.ts') as string, /^#!\/usr\/bin\/env node\n/, 'directly executable: shebang on line 1');
  });

  it('the bootstrap imports nothing but the guard and node builtins (so nothing can print before it runs)', () => {
    const code = stripComments(sources.get('stdio-bootstrap.ts') as string);
    const specifiers = [...code.matchAll(/^import\s[^;]*?\bfrom\s*['"]([^'"]+)['"]\s*;/gm)].map((m) => m[1]);
    assert.deepEqual(specifiers.sort(), ['./stdout-guard.js', 'node:fs', 'node:url']);
    const guardSpecs = [...stripComments(sources.get('stdout-guard.ts') as string).matchAll(/^import\s[^;]*?\bfrom\s*['"]([^'"]+)['"]\s*;/gm)].map((m) => m[1] as string);
    assert.deepEqual(guardSpecs, ['node:stream'], 'the guard depends on nothing but a node builtin');
  });

  it('the server module has no I/O at import time: no top-level statement other than declarations', () => {
    for (const f of ['server.ts', 'tools.ts', 'envelope.ts', 'approved-roots.ts', 'aliases.ts', 'registry.ts']) {
      const code = stripComments(sources.get(f) as string);
      const topLevelCalls = code.split('\n').filter((line) => /^(?!export |import |const |let |function |class |type |interface |async function |\s|\}|\)|\]|$)/.test(line));
      assert.deepEqual(topLevelCalls, [], `${f} has top-level statements`);
    }
  });

  it('contains no raw U+2028, U+2029 or byte-order mark (TypeScript 7 re-prints them inside regex literals, breaking the emitted file)', () => {
    for (const [file, raw] of sources) {
      assert.ok(!raw.includes(LINE_SEPARATOR), `${file} has a raw U+2028`);
      assert.ok(!raw.includes(PARAGRAPH_SEPARATOR), `${file} has a raw U+2029`);
      assert.ok(!raw.startsWith(String.fromCharCode(0xfeff)), `${file} has a byte-order mark`);
    }
  });

  it('is plain ASCII (messages and descriptions reach clients that may not render anything else)', () => {
    for (const [file, raw] of sources) assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(raw), `${file} contains non-ASCII text`);
  });

  it('no use of `any`', () => {
    for (const [file, raw] of sources) {
      const code = stripComments(raw);
      assert.ok(!/:\s*any\b|<any>|\bas\s+any\b|any\[\]/.test(code), `${file} uses any`);
    }
  });
});

describe('no write path to ChatGPT in the advertised surface', () => {
  let fx: Fixture;
  let h: MemHarness;
  before(async () => {
    fx = await createFixture({ graph: false });
    h = await connectMem(fx.dbPath);
  });
  after(async () => {
    await h.close();
    await fx.cleanup();
  });

  const VERBS = /\b(?:send|sends|sending|sent|post|posts|posting|posted|submit|submits|submitting|submitted|transmit|transmits|transmitting|transmitted|upload|uploads|uploading|uploaded|publish|publishes|publishing|forward|forwards|reply|replies|message|messages)\b/gi;
  /** In a sentence with one of these the verb is being denied, not promised. */
  const NEGATION = /\b(?:cannot|can not|never|nothing|not|no|without|neither|nor)\b/i;

  it('no tool NAME contains a sending, posting, submitting or fetching word', async () => {
    for (const tool of (await h.client.listTools()).tools) {
      assert.ok(!/(?:send|post|submit|transmit|upload|publish|forward|reply|fetch|browse|open_url|navigate|click|type_text)/.test(tool.name), tool.name);
    }
  });

  it('a sending word appears in a tool title or description only in a sentence that denies it', async () => {
    const tools = (await h.client.listTools()).tools;
    let denials = 0;
    for (const tool of tools) {
      for (const [where, text] of [
        ['title', tool.title ?? ''],
        ['description', tool.description ?? ''],
        ...Object.entries((tool.inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {}).map(([k, v]) => [`input ${k}`, v.description ?? ''] as const),
      ] as Array<readonly [string, string]>) {
        for (const sentence of text.split(/(?<=[.!?])\s+/)) {
          const hits = sentence.match(VERBS);
          if (hits === null) continue;
          // "message(s)" is data here (a conversation message), not an action; the action verbs must be denied
          const actionHits = hits.filter((w) => !/^messages?$/i.test(w));
          if (actionHits.length === 0) continue;
          assert.match(sentence, NEGATION, `${tool.name} ${where}: "${sentence}" mentions ${actionHits.join(', ')} without denying it`);
          denials++;
        }
      }
    }
    assert.ok(denials >= 1, 'at least the draft tool states the denial');
  });

  it('the server instructions deny sending in the same way', () => {
    const instructions = h.client.getInstructions() ?? '';
    for (const sentence of instructions.split(/(?<=[.!?])\s+/)) {
      const hits = sentence.match(/\b(?:send|post|submit|transmit|upload|publish)\b/gi);
      if (hits !== null) assert.match(sentence, NEGATION, sentence);
    }
  });

  it('no tool accepts a URL, a host, a header, a cookie or a token as input', async () => {
    for (const tool of (await h.client.listTools()).tools) {
      for (const prop of Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})) {
        assert.ok(!/(?:url|uri|host|endpoint|header|cookie|token|secret|password|credential|auth|session)/i.test(prop), `${tool.name}.${prop}`);
      }
    }
  });

  it('a draft can never be marked as sent: no status in any input, no sent state in what a draft returns', async () => {
    const writable = await connectMem(fx.dbPath, { writable: true });
    try {
      const env = await writable.env('gcr_create_local_draft', { conversation: '00000000-0000-4000-8000-000000000001', body: 'draft' });
      assert.equal(env.ok, true, env.error?.message);
      const draft = (env.data as { draft: { status: string; manualContinuation: { note: string } } }).draft;
      assert.equal(draft.status, 'draft');
      assert.match(draft.manualContinuation.note, /never sends/i);
    } finally {
      await writable.close();
    }
  });
});
