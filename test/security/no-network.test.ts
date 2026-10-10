/**
 * NFR-01 / CODEX_TASK "No network contact to ChatGPT consumer endpoints from CI or MCP" / ADR-0010 /
 * docs/BROWSER_GATE.md: first-party code under src/ must contain no network, browser-automation or
 * process-spawning capability, and the runtime dependency set must stay at the reviewed allow-list.
 *
 * HOW: a hand-written JavaScript/TypeScript tokenizer (below) strips comments and string/template/regex
 * literals correctly, so words in comments or in documented URL strings never trip a rule, while the
 * decoded text of import/require specifiers and of string literals is still inspected. The TypeScript
 * compiler API is deliberately not used: it is a dev dependency and its JS API may not exist in TypeScript 7.
 * The scanner FAILS CLOSED: a construct it cannot tokenize (unterminated literal, unbalanced brackets) is a
 * finding, never a silent skip, so a lexer desynchronisation cannot hide code.
 *
 * LIMITATIONS (stated so nobody over-trusts this test):
 *  - It covers first-party src/ only. The MCP SDK dependency itself contains network code in node_modules
 *    (HTTP/SSE/WebSocket transports, OAuth); that is why importing the SDK is restricted to an allow-list of
 *    stdio/in-memory subpaths, and why the dependency allow-list is asserted. Transitive code is not scanned.
 *  - It is a tripwire against accidents and lazy shortcuts, not a sandbox. Determined obfuscation (aliasing
 *    globalThis, reading code from disk and evaluating it, ...) can only be partly anticipated. The runtime
 *    guarantee comes from there being no network code to call, plus code review of this allow-list.
 *
 * All sources analysed here are synthetic strings. Strings that name private endpoints or cookie names are
 * assembled from fragments at runtime so this file never contains them literally (they would otherwise trip
 * the repository's own privacy scanner).
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { dirname, extname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, describe, it } from 'node:test';
import fc from 'fast-check';
import { withTempDir } from '../helpers/tmp.js';

const SEED = 20261010;

// ===================================================================================================
// 1. Tokenizer
// ===================================================================================================

type TokKind = 'ident' | 'punct' | 'num' | 'str' | 'tmpl' | 'regex';

interface Tok {
  readonly kind: TokKind;
  /** ident: name with \u escapes decoded; punct: operator; str/tmpl: decoded value; regex: source between the slashes. */
  readonly text: string;
  readonly line: number;
  /** ident directly after '.' or '?.', i.e. a property name rather than a binding or a global. */
  readonly afterDot: boolean;
  /** tmpl: first chunk of its template literal. */
  readonly head: boolean;
  /** tmpl: this chunk is followed by a `${` substitution. */
  readonly subst: boolean;
  /** ')': closed the parenthesised head of if/while/for/with, so a statement (hence a regex) may follow. */
  readonly closesCond: boolean;
  /** '}': closed a statement block (not an object literal), so a statement (hence a regex) may follow. */
  readonly closesBlock: boolean;
  /** '!': TypeScript postfix non-null assertion (`x!`), so a division may follow. */
  readonly postfix: boolean;
}

class ScanError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = 'ScanError';
    this.line = line;
  }
}

/** After these keywords an expression starts, so '/' begins a regex. */
const REGEX_PRECEDING_WORDS: ReadonlySet<string> = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await', 'default',
]);
/** `)` that closes the head of one of these is followed by a statement. */
const COND_HEAD_WORDS: ReadonlySet<string> = new Set(['if', 'while', 'for', 'with']);
/** Longest first. '/=' is deliberately absent: it is produced only in the division branch. */
const PUNCTUATORS: readonly string[] = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '%=', '&=', '|=', '^=', '<<', '>>', '**',
];

const ID_START = /[\p{ID_Start}$_]/u;
const ID_PART = /[\p{ID_Continue}$\u200c\u200d]/u;
const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= '0' && ch <= '9';

interface Escape {
  value: string;
  length: number;
  newlines: number;
}

/** Decodes the escape sequence starting at src[i] === '\\'. Unknown escapes decode to the character itself. */
function readEscape(src: string, i: number): Escape {
  const c = src[i + 1];
  if (c === undefined) return { value: '', length: 1, newlines: 0 };
  // Line continuations contribute nothing to the value (and are why a string may span source lines).
  if (c === '\r') return { value: '', length: src[i + 2] === '\n' ? 3 : 2, newlines: 1 };
  if (c === '\n') return { value: '', length: 2, newlines: 1 };
  if (c === '\u2028' || c === '\u2029') return { value: '', length: 2, newlines: 0 };
  switch (c) {
    case 'n': return { value: '\n', length: 2, newlines: 0 };
    case 't': return { value: '\t', length: 2, newlines: 0 };
    case 'r': return { value: '\r', length: 2, newlines: 0 };
    case 'b': return { value: '\b', length: 2, newlines: 0 };
    case 'f': return { value: '\f', length: 2, newlines: 0 };
    case 'v': return { value: '\v', length: 2, newlines: 0 };
    case '0':
      if (!isDigit(src[i + 2])) return { value: '\0', length: 2, newlines: 0 };
      break;
    case 'x': {
      const h = src.slice(i + 2, i + 4);
      if (/^[0-9a-fA-F]{2}$/.test(h)) return { value: String.fromCharCode(parseInt(h, 16)), length: 4, newlines: 0 };
      break;
    }
    case 'u': {
      if (src[i + 2] === '{') {
        const close = src.indexOf('}', i + 3);
        const h = close > 0 ? src.slice(i + 3, close) : '';
        if (/^[0-9a-fA-F]{1,6}$/.test(h) && parseInt(h, 16) <= 0x10ffff) {
          return { value: String.fromCodePoint(parseInt(h, 16)), length: close - i + 1, newlines: 0 };
        }
      } else {
        const h = src.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(h)) return { value: String.fromCharCode(parseInt(h, 16)), length: 6, newlines: 0 };
      }
      break;
    }
    default:
      break;
  }
  const ch = String.fromCodePoint(src.codePointAt(i + 1) ?? 0);
  return { value: ch, length: 1 + ch.length, newlines: 0 };
}

class Lexer {
  private readonly src: string;
  private readonly toks: Tok[] = [];
  private i = 0;
  private line = 1;
  private prev: Tok | null = null;
  private prev2: Tok | null = null;
  private readonly parenStack: boolean[] = [];
  private readonly braceStack: boolean[] = [];
  /** braceStack.length at each open `${`, so the matching `}` can be told apart from an ordinary one. */
  private readonly tmplStack: number[] = [];

  constructor(src: string) {
    this.src = src;
  }

  private err(message: string): ScanError {
    return new ScanError(message, this.line);
  }

  private emit(kind: TokKind, text: string, line: number, extra: Partial<Tok> = {}): void {
    const p = this.prev;
    const afterDot = kind === 'ident' && p !== null && p.kind === 'punct' && (p.text === '.' || p.text === '?.');
    const t: Tok = { kind, text, line, afterDot, head: false, subst: false, closesCond: false, closesBlock: false, postfix: false, ...extra };
    this.toks.push(t);
    this.prev2 = this.prev;
    this.prev = t;
  }

  /** Is a '/' at this point the start of a regex literal (true) or a division operator (false)? */
  private regexAllowed(): boolean {
    const p = this.prev;
    if (p === null) return true;
    switch (p.kind) {
      case 'num':
      case 'str':
      case 'regex':
        return false;
      case 'tmpl':
        return p.subst;
      case 'ident':
        return !p.afterDot && REGEX_PRECEDING_WORDS.has(p.text);
      case 'punct':
        if (p.text === ')') return p.closesCond;
        if (p.text === ']') return false;
        if (p.text === '}') return p.closesBlock;
        if (p.text === '++' || p.text === '--') return false;
        if (p.text === '!') return !p.postfix;
        return true;
    }
  }

  /** Does a '{' here open a statement block (true) or an object literal / type literal (false)? */
  private braceIsBlock(): boolean {
    const p = this.prev;
    if (p === null) return true;
    switch (p.kind) {
      case 'punct':
        return p.text === ')' || p.text === ';' || p.text === '{' || p.text === '}' || p.text === '=>' || p.text === '>';
      case 'ident':
        return p.afterDot || !REGEX_PRECEDING_WORDS.has(p.text);
      case 'str':
        return true; // `declare module 'x' {`, `import ... from 'x' with {`
      default:
        return false;
    }
  }

  private readIdentifier(): string {
    const { src } = this;
    let name = '';
    for (;;) {
      if (src[this.i] === '\\') {
        const esc = readEscape(src, this.i);
        // Only \uXXXX / \u{...} are legal in an identifier; readEscape falls back to length 2 for anything else.
        if (src[this.i + 1] !== 'u' || esc.length < 5) throw this.err('unexpected backslash in code');
        name += esc.value;
        this.i += esc.length;
        continue;
      }
      const cp = src.codePointAt(this.i);
      if (cp === undefined) break;
      const ch = String.fromCodePoint(cp);
      if (!(name === '' ? ID_START.test(ch) : ID_PART.test(ch))) break;
      name += ch;
      this.i += ch.length;
    }
    return name;
  }

  private readString(quote: string): void {
    const { src } = this;
    const startLine = this.line;
    this.i++;
    let buf = '';
    for (;;) {
      const ch = src[this.i];
      if (ch === undefined) throw this.err('unterminated string literal');
      if (ch === quote) {
        this.i++;
        break;
      }
      if (ch === '\n' || ch === '\r') throw this.err('unterminated string literal (newline)');
      if (ch === '\\') {
        const esc = readEscape(src, this.i);
        buf += esc.value;
        this.i += esc.length;
        this.line += esc.newlines;
        continue;
      }
      buf += ch;
      this.i++;
    }
    this.emit('str', buf, startLine);
  }

  /** Reads template text from this.i (just after a backtick or after the `}` closing a substitution). */
  private readTemplate(head: boolean): void {
    const { src } = this;
    const startLine = this.line;
    let buf = '';
    for (;;) {
      const ch = src[this.i];
      if (ch === undefined) throw this.err('unterminated template literal');
      if (ch === '`') {
        this.i++;
        this.emit('tmpl', buf, startLine, { head, subst: false });
        return;
      }
      if (ch === '$' && src[this.i + 1] === '{') {
        this.i += 2;
        this.emit('tmpl', buf, startLine, { head, subst: true });
        this.tmplStack.push(this.braceStack.length);
        this.emit('punct', '${', this.line);
        return;
      }
      if (ch === '\\') {
        const esc = readEscape(src, this.i);
        buf += esc.value;
        this.i += esc.length;
        this.line += esc.newlines;
        continue;
      }
      if (ch === '\n' || (ch === '\r' && src[this.i + 1] !== '\n')) this.line++;
      buf += ch;
      this.i++;
    }
  }

  private readRegex(): void {
    const { src } = this;
    const startLine = this.line;
    let j = this.i + 1;
    let inClass = false;
    for (;;) {
      const ch = src[j];
      if (ch === undefined || ch === '\n' || ch === '\r') throw this.err('unterminated regular expression literal');
      if (ch === '\\') {
        const nx = src[j + 1];
        if (nx === undefined || nx === '\n' || nx === '\r') throw this.err('unterminated regular expression literal');
        j += 2;
        continue;
      }
      if (inClass) {
        if (ch === ']') inClass = false;
      } else if (ch === '[') {
        inClass = true;
      } else if (ch === '/') {
        break;
      }
      j++;
    }
    const body = src.slice(this.i + 1, j);
    j++;
    while (j < src.length && /[A-Za-z]/.test(src[j] ?? '')) j++;
    this.i = j;
    this.emit('regex', body, startLine);
  }

  private readNumber(): void {
    const { src } = this;
    let j = this.i;
    const radix = src[j] === '0' && /[xXbBoO]/.test(src[j + 1] ?? '');
    if (radix) j += 2;
    let seenDot = false;
    if (src[j] === '.') {
      seenDot = true;
      j++;
    }
    while (j < src.length) {
      const ch = src[j] ?? '';
      if (/[0-9A-Za-z_]/.test(ch)) {
        if (!radix && (ch === 'e' || ch === 'E') && (src[j + 1] === '+' || src[j + 1] === '-')) {
          j += 2;
          continue;
        }
        j++;
        continue;
      }
      // One dot only, so `1..toString()` and `1.5.toFixed(1)` leave the member access to the next token.
      if (ch === '.' && !radix && !seenDot) {
        seenDot = true;
        j++;
        continue;
      }
      break;
    }
    this.emit('num', src.slice(this.i, j), this.line);
    this.i = j;
  }

  run(): Tok[] {
    const { src } = this;
    const n = src.length;
    if (src.startsWith('#!')) {
      while (this.i < n && src[this.i] !== '\n' && src[this.i] !== '\r') this.i++;
    }
    while (this.i < n) {
      const c = src[this.i] ?? '';
      if (c === '\n') {
        this.line++;
        this.i++;
        continue;
      }
      if (c === '\r') {
        if (src[this.i + 1] !== '\n') this.line++;
        this.i++;
        continue;
      }
      if (/\s/.test(c)) {
        this.i++;
        continue;
      }
      if (c === '/') {
        const d = src[this.i + 1];
        if (d === '/') {
          while (this.i < n && src[this.i] !== '\n' && src[this.i] !== '\r') this.i++;
          continue;
        }
        if (d === '*') {
          const end = src.indexOf('*/', this.i + 2);
          if (end < 0) throw this.err('unterminated block comment');
          for (let k = this.i; k < end; k++) {
            if (src[k] === '\n' || (src[k] === '\r' && src[k + 1] !== '\n')) this.line++;
          }
          this.i = end + 2;
          continue;
        }
        if (this.regexAllowed()) {
          this.readRegex();
        } else if (d === '=') {
          this.emit('punct', '/=', this.line);
          this.i += 2;
        } else {
          this.emit('punct', '/', this.line);
          this.i++;
        }
        continue;
      }
      if (c === '"' || c === "'") {
        this.readString(c);
        continue;
      }
      if (c === '`') {
        this.i++;
        this.readTemplate(true);
        continue;
      }
      if (isDigit(c) || (c === '.' && isDigit(src[this.i + 1]))) {
        this.readNumber();
        continue;
      }
      if (c === '#' && /[\p{ID_Start}$_\\]/u.test(String.fromCodePoint(src.codePointAt(this.i + 1) ?? 0))) {
        const line = this.line;
        this.i++;
        this.emit('ident', `#${this.readIdentifier()}`, line);
        continue;
      }
      const cp = src.codePointAt(this.i) ?? 0;
      if (c === '\\' || ID_START.test(String.fromCodePoint(cp))) {
        const line = this.line;
        this.emit('ident', this.readIdentifier(), line);
        continue;
      }
      if (c === '(') {
        const p = this.prev;
        const p2 = this.prev2;
        const cond =
          p !== null && p.kind === 'ident' && !p.afterDot &&
          (COND_HEAD_WORDS.has(p.text) || (p.text === 'await' && p2 !== null && p2.kind === 'ident' && p2.text === 'for'));
        this.parenStack.push(cond);
        this.emit('punct', '(', this.line);
        this.i++;
        continue;
      }
      if (c === ')') {
        const cond = this.parenStack.pop();
        if (cond === undefined) throw this.err('unbalanced )');
        this.emit('punct', ')', this.line, { closesCond: cond });
        this.i++;
        continue;
      }
      if (c === '{') {
        this.braceStack.push(this.braceIsBlock());
        this.emit('punct', '{', this.line);
        this.i++;
        continue;
      }
      if (c === '}') {
        if (this.tmplStack.length > 0 && this.tmplStack[this.tmplStack.length - 1] === this.braceStack.length) {
          this.tmplStack.pop();
          this.i++;
          this.readTemplate(false);
          continue;
        }
        const block = this.braceStack.pop();
        if (block === undefined) throw this.err('unbalanced }');
        this.emit('punct', '}', this.line, { closesBlock: block });
        this.i++;
        continue;
      }
      if (c === '!' && src[this.i + 1] !== '=') {
        const p = this.prev;
        const postfix =
          p !== null &&
          ((p.kind === 'ident' && (p.afterDot || !REGEX_PRECEDING_WORDS.has(p.text))) || (p.kind === 'punct' && (p.text === ')' || p.text === ']')));
        this.emit('punct', '!', this.line, { postfix });
        this.i++;
        continue;
      }
      let matched = '';
      for (const op of PUNCTUATORS) {
        if (src.startsWith(op, this.i)) {
          // `a?.5:1` is a ternary, not optional chaining.
          if (op === '?.' && isDigit(src[this.i + 2])) continue;
          matched = op;
          break;
        }
      }
      if (matched === '') matched = String.fromCodePoint(cp);
      this.emit('punct', matched, this.line);
      this.i += matched.length;
    }
    if (this.tmplStack.length > 0) throw this.err('unterminated template substitution');
    if (this.parenStack.length > 0) throw this.err('unbalanced (');
    if (this.braceStack.length > 0) throw this.err('unbalanced {');
    return this.toks;
  }
}

function tokenize(src: string): Tok[] {
  return new Lexer(src).run();
}

// ===================================================================================================
// 2. Rules
// ===================================================================================================

type Rule =
  | 'forbidden-module'
  | 'unlisted-module'
  | 'dynamic-specifier'
  | 'forbidden-global'
  | 'forbidden-literal'
  | 'child-process-usage'
  | 'devtools-import'
  | 'scanner';

interface Finding {
  rule: Rule;
  line: number;
  detail: string;
}

interface ScanContext {
  /** True only for files under src/devtools/. Allows importing { execFile } from child_process and nothing else. */
  allowChildProcess: boolean;
}

/** Node builtins (bare name, `node:` prefix optional, sub-paths included) that give network, process or code-loading reach. */
const FORBIDDEN_BUILTINS: ReadonlyMap<string, string> = new Map([
  ['http', 'HTTP client/server'],
  ['https', 'HTTPS client/server'],
  ['http2', 'HTTP/2 client/server'],
  ['net', 'raw TCP / IPC sockets'],
  ['tls', 'TLS sockets'],
  ['dns', 'DNS lookups'],
  ['dgram', 'UDP sockets'],
  ['quic', 'QUIC transport'],
  ['cluster', 'worker processes with IPC'],
  ['worker_threads', 'threads that could run unscanned code'],
  ['vm', 'runtime code evaluation'],
  ['inspector', 'debugger protocol (opens a socket)'],
  ['child_process', 'process spawning (allowed only as { execFile } under src/devtools)'],
  ['repl', 'interactive evaluation'],
  ['module', 'createRequire / computed-name module loading bypasses this scan'],
]);

/** Third-party packages whose only purpose is network or browser automation. */
const FORBIDDEN_PACKAGES: ReadonlyMap<string, string> = new Map([
  ['undici', 'HTTP client'],
  ['ws', 'WebSocket client/server'],
  ['chrome-remote-interface', 'browser automation (DevTools protocol)'],
  ['axios', 'HTTP client'],
  ['node-fetch', 'HTTP client'],
  ['got', 'HTTP client'],
  ['cross-fetch', 'HTTP client'],
  ['isomorphic-fetch', 'HTTP client'],
  ['isomorphic-ws', 'WebSocket client'],
  ['ky', 'HTTP client'],
  ['superagent', 'HTTP client'],
  ['request', 'HTTP client'],
  ['needle', 'HTTP client'],
  ['websocket', 'WebSocket client/server'],
  ['socket.io', 'WebSocket server'],
  ['socket.io-client', 'WebSocket client'],
  ['eventsource', 'server-sent-events client'],
  ['express', 'HTTP server'],
  ['fastify', 'HTTP server'],
  ['koa', 'HTTP server'],
  ['hono', 'HTTP server'],
  ['@hono/node-server', 'HTTP server'],
  ['selenium-webdriver', 'browser automation'],
  ['webdriverio', 'browser automation'],
  ['cypress', 'browser automation'],
]);

function forbiddenPackageReason(pkg: string): string | undefined {
  const exact = FORBIDDEN_PACKAGES.get(pkg);
  if (exact !== undefined) return exact;
  if (pkg.startsWith('playwright') || pkg.startsWith('@playwright/')) return 'browser automation (playwright*)';
  if (pkg.startsWith('puppeteer') || pkg.startsWith('@puppeteer/')) return 'browser automation (puppeteer*)';
  return undefined;
}

/** SPEC / ARCHITECTURE: runtime dependencies are exactly these two. Adding one must be a conscious, reviewed decision. */
const RUNTIME_DEPENDENCY_ALLOWLIST: readonly string[] = ['@modelcontextprotocol/sdk', 'zod'];

/**
 * The only SDK subpaths first-party code may import (without a `.js` suffix). Everything else in the SDK is
 * either an HTTP/SSE/WebSocket transport, an OAuth client, an Express/Hono adapter or a process spawner.
 */
const MCP_SDK_ALLOWED_SUBPATHS: ReadonlySet<string> = new Set([
  '', 'server', 'server/index', 'server/mcp', 'server/stdio', 'server/completable', 'server/zod-compat', 'server/zod-json-schema-compat',
  'client', 'client/index', 'types', 'spec.types', 'inMemory', 'validation', 'validation/types',
  'shared/protocol', 'shared/transport', 'shared/stdio', 'shared/uriTemplate', 'shared/toolNameValidation', 'shared/responseMessage',
]);

/** Private-endpoint markers, assembled from fragments (see the file header). Compared case-insensitively. */
const FORBIDDEN_LITERALS: readonly string[] = [
  ['chatgpt', '.com/back', 'end-api'].join(''),
  ['/back', 'end-api', '/'].join(''),
  ['__Secure-', 'next-auth'].join(''),
];

const GLOBAL_OBJECT_NAMES: ReadonlySet<string> = new Set(['globalThis', 'global', 'window', 'self']);
/** Receivers of computed lookups (`x['name']`) that are checked for dynamic access to forbidden members. */
const COMPUTED_LOOKUP_RECEIVERS: ReadonlySet<string> = new Set(['globalThis', 'global', 'window', 'self', 'process', 'navigator']);
const COMPUTED_FORBIDDEN_NAMES: ReadonlySet<string> = new Set([
  'fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource', 'sendBeacon', 'binding', 'dlopen', 'getBuiltinModule', 'mainModule', 'createRequire',
]);

function packageNameOf(bare: string): string {
  const parts = bare.split('/');
  return bare.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? '');
}

const show = (s: string): string => JSON.stringify(s.length > 80 ? `${s.slice(0, 77)}...` : s);

function isChildProcessSpecifier(spec: string): boolean {
  return (spec.startsWith('node:') ? spec.slice(5) : spec).split('/')[0] === 'child_process';
}

/** Classifies one module specifier; null means acceptable. */
function checkSpecifier(spec: string, ctx: ScanContext): { rule: Rule; detail: string } | null {
  if (spec === '') return { rule: 'forbidden-module', detail: 'empty module specifier' };
  if (/^\.\.?(\/|$)/.test(spec)) {
    return spec.split('/').includes('node_modules')
      ? { rule: 'forbidden-module', detail: `relative import reaches into node_modules: ${show(spec)}` }
      : null;
  }
  if (spec.startsWith('/') || spec.startsWith('#') || spec.includes('\\')) {
    return { rule: 'unlisted-module', detail: `absolute, backslash or "#imports" specifier is not allowed: ${show(spec)}` };
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(spec)?.[1]?.toLowerCase();
  if (scheme !== undefined && scheme !== 'node') {
    return { rule: 'forbidden-module', detail: `URL import (${scheme}:) is not allowed: ${show(spec)}` };
  }
  const bare = scheme === 'node' ? spec.slice(5) : spec;
  const first = bare.split('/')[0] ?? '';
  const builtinReason = FORBIDDEN_BUILTINS.get(first) ?? (/^_(?:http|tls)_/.test(first) ? 'internal HTTP/TLS implementation module' : undefined);
  if (builtinReason !== undefined) {
    if (first === 'child_process' && ctx.allowChildProcess) return null; // the import clause is verified by the caller
    return { rule: 'forbidden-module', detail: `${show(spec)}: ${builtinReason}` };
  }
  if (scheme === 'node' || builtinModules.includes(first)) return null; // fs, path, zlib, sqlite, crypto, ...
  const pkg = packageNameOf(bare);
  const denied = forbiddenPackageReason(pkg);
  if (denied !== undefined) return { rule: 'forbidden-module', detail: `${show(spec)}: ${denied}` };
  if (pkg === '@modelcontextprotocol/sdk') {
    const sub = bare.slice(pkg.length + 1).replace(/\.js$/, '');
    if (MCP_SDK_ALLOWED_SUBPATHS.has(sub)) return null;
    return {
      rule: 'forbidden-module',
      detail: `${show(spec)}: MCP SDK subpath is not on the stdio/in-memory allow-list (HTTP, SSE, WebSocket, OAuth and spawning transports are network code)`,
    };
  }
  if (RUNTIME_DEPENDENCY_ALLOWLIST.includes(pkg)) return null;
  return {
    rule: 'unlisted-module',
    detail: `${show(spec)}: package ${show(pkg)} is not in the runtime dependency allow-list [${RUNTIME_DEPENDENCY_ALLOWLIST.join(', ')}]`,
  };
}

/** Tokens between `import`/`export` and the `from` at toks[fromIdx], or null if no such keyword is nearby. */
function clauseBefore(toks: readonly Tok[], fromIdx: number): Tok[] | null {
  for (let j = fromIdx - 1; j >= 0 && fromIdx - j <= 300; j--) {
    const t = toks[j];
    if (t === undefined) break;
    if (t.kind === 'punct' && t.text === ';') return null;
    if (t.kind === 'ident' && !t.afterDot && t.text === 'import') return toks.slice(j + 1, fromIdx);
    if (t.kind === 'ident' && !t.afterDot && t.text === 'export') return null; // re-exports are never allowed from child_process
  }
  return null;
}

/**
 * True for `{ execFile }`, `{ execFile as x }` and `type`-modifier forms. Type-only imports (erased at compile
 * time, so they cannot spawn anything) may name any export.
 */
function clauseImportsOnlyExecFile(clause: readonly Tok[] | null): boolean {
  if (clause === null || clause.length === 0) return false;
  const first = clause[0];
  const second = clause[1];
  const typeOnly = first !== undefined && first.kind === 'ident' && first.text === 'type' && second !== undefined && second.kind === 'punct' && second.text === '{';
  const open = clause[typeOnly ? 1 : 0];
  const close = clause[clause.length - 1];
  if (open === undefined || open.kind !== 'punct' || open.text !== '{') return false;
  if (close === undefined || close.kind !== 'punct' || close.text !== '}') return false;
  if (typeOnly) return true;
  const items: Tok[][] = [[]];
  for (const t of clause.slice(1, clause.length - 1)) {
    if (t.kind === 'punct' && t.text === ',') items.push([]);
    else items[items.length - 1]?.push(t);
  }
  let named = 0;
  for (const item of items) {
    if (item.length === 0) continue; // trailing comma
    if (item[0]?.text === 'type' && item.length > 1 && item[1]?.text !== 'as') continue; // inline `type X`
    const okShape = item.length === 1 || (item.length === 3 && item[1]?.text === 'as');
    if (!okShape || item[0]?.kind !== 'ident' || item[0].text !== 'execFile') return false;
    named++;
  }
  return named > 0;
}

interface SourceScan {
  findings: Finding[];
  /** Every module specifier that was a literal, for the devtools-import check. */
  specifiers: Array<{ spec: string; line: number }>;
}

function scanSource(src: string, ctx: ScanContext): SourceScan {
  let toks: Tok[];
  try {
    toks = tokenize(src);
  } catch (e) {
    if (!(e instanceof ScanError)) throw e;
    return { findings: [{ rule: 'scanner', line: e.line, detail: `cannot tokenize, failing closed: ${e.message}` }], specifiers: [] };
  }
  const findings: Finding[] = [];
  const specifiers: Array<{ spec: string; line: number }> = [];
  const add = (rule: Rule, line: number, detail: string): void => {
    findings.push({ rule, line, detail });
  };

  const checkLiteralSpecifier = (spec: string, line: number, form: 'static' | 'call', clause: Tok[] | null): void => {
    specifiers.push({ spec, line });
    const f = checkSpecifier(spec, ctx);
    if (f !== null) {
      add(f.rule, line, f.detail);
      return;
    }
    if (isChildProcessSpecifier(spec)) {
      // Reaching here means ctx.allowChildProcess. Only the static { execFile } form is acceptable.
      if (form !== 'static' || !clauseImportsOnlyExecFile(clause)) {
        add('child-process-usage', line, 'src/devtools may import only { execFile } from child_process (no default/namespace import, spawn, exec, require or import())');
      }
    }
  };

  /** `import(` and `require(` / `module.require(`: the specifier must be a plain literal. */
  const checkCall = (k: number, what: string): void => {
    const t = toks[k];
    const arg = toks[k + 2];
    const close = toks[k + 3];
    if (t === undefined) return;
    const literal =
      arg !== undefined &&
      (arg.kind === 'str' || (arg.kind === 'tmpl' && arg.head && !arg.subst)) &&
      close !== undefined && close.kind === 'punct' && (close.text === ')' || close.text === ',');
    if (literal && arg !== undefined) checkLiteralSpecifier(arg.text, arg.line, 'call', null);
    else add('dynamic-specifier', t.line, `${what} with a non-literal specifier (assembled at runtime) cannot be audited`);
  };

  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t === undefined) continue;
    const next = toks[k + 1];
    const isPunct = (tok: Tok | undefined, text: string): boolean => tok !== undefined && tok.kind === 'punct' && tok.text === text;
    const receiver = (): string | undefined => {
      const dot = toks[k - 1];
      const recv = toks[k - 2];
      return dot !== undefined && dot.kind === 'punct' && (dot.text === '.' || dot.text === '?.') && recv !== undefined && recv.kind === 'ident'
        ? recv.text
        : undefined;
    };

    // --- module specifiers ---------------------------------------------------------------------
    if (t.kind === 'ident' && t.text === 'from' && next !== undefined && next.kind === 'str') {
      checkLiteralSpecifier(next.text, next.line, 'static', clauseBefore(toks, k));
    }
    if (t.kind === 'ident' && !t.afterDot && t.text === 'import') {
      if (isPunct(next, '(')) checkCall(k, 'import()');
      else if (next !== undefined && next.kind === 'str') checkLiteralSpecifier(next.text, next.line, 'static', []);
    }
    if (t.kind === 'ident' && t.text === 'require') {
      if (!t.afterDot) {
        if (isPunct(next, '(')) checkCall(k, 'require()');
        else add('dynamic-specifier', t.line, 'bare `require` reference (anything but a literal-specifier call cannot be audited)');
      } else if (receiver() === 'module' && isPunct(next, '(')) {
        checkCall(k, 'module.require()');
      }
    }

    // --- globals and escape hatches ------------------------------------------------------------
    if (t.kind === 'ident') {
      const recv = receiver();
      switch (t.text) {
        case 'WebSocket':
        case 'XMLHttpRequest':
        case 'EventSource':
          add('forbidden-global', t.line, `reference to ${t.text}`);
          break;
        case 'fetch':
          if (!t.afterDot || (recv !== undefined && GLOBAL_OBJECT_NAMES.has(recv))) add('forbidden-global', t.line, 'reference to the global fetch');
          break;
        case 'sendBeacon':
          add('forbidden-global', t.line, 'reference to navigator.sendBeacon');
          break;
        case 'getBuiltinModule':
          add('forbidden-global', t.line, 'process.getBuiltinModule loads builtins without an import the scan can see');
          break;
        case 'createRequire':
          add('forbidden-global', t.line, 'createRequire yields a require function under another name, bypassing the require() check');
          break;
        case 'binding':
        case 'dlopen':
        case 'mainModule':
          if (recv === 'process') add('forbidden-global', t.line, `reference to process.${t.text}`);
          break;
        case 'eval':
          if (!t.afterDot && isPunct(next, '(')) add('forbidden-global', t.line, 'eval() defeats static analysis');
          break;
        case 'Function': {
          const before = toks[k - 1];
          const afterNew = before !== undefined && before.kind === 'ident' && before.text === 'new';
          if (!t.afterDot && (isPunct(next, '(') || afterNew)) add('forbidden-global', t.line, 'the Function constructor defeats static analysis');
          break;
        }
        case 'shell':
          // devtools only ever run a fixed executable with an argument array; a shell would reintroduce string injection.
          if (ctx.allowChildProcess && isPunct(next, ':')) {
            const value = toks[k + 2];
            if (value === undefined || value.kind !== 'ident' || value.text !== 'false') add('child-process-usage', t.line, 'a `shell` option other than literal false');
          }
          break;
        default:
          break;
      }
    }
    // x['name'] on global-ish receivers: a non-literal or forbidden name is a dynamic lookup of a forbidden member.
    if (isPunct(t, '[')) {
      const recvTok = toks[k - 1];
      if (recvTok !== undefined && recvTok.kind === 'ident' && !recvTok.afterDot && COMPUTED_LOOKUP_RECEIVERS.has(recvTok.text)) {
        const arg = toks[k + 1];
        const close = toks[k + 2];
        const plain = arg !== undefined && arg.kind === 'str' && isPunct(close, ']');
        if (!plain) add('forbidden-global', t.line, `computed lookup on ${recvTok.text} with a non-literal key`);
        else if (arg !== undefined && COMPUTED_FORBIDDEN_NAMES.has(arg.text)) add('forbidden-global', t.line, `${recvTok.text}[${show(arg.text)}]`);
      }
    }
  }

  // --- string literals: private endpoint / cookie markers --------------------------------------
  // Adjacent literals joined by '+' are folded first, so splitting a marker across two strings does not help.
  const checkLiteralText = (text: string, line: number): void => {
    const lower = text.toLowerCase();
    for (const needle of FORBIDDEN_LITERALS) {
      if (lower.includes(needle.toLowerCase())) add('forbidden-literal', line, `string literal contains a forbidden marker (${needle.length} chars, starts ${show(needle.slice(0, 6))})`);
    }
  };
  let run: { text: string; line: number } | null = null;
  const flush = (): void => {
    if (run !== null) checkLiteralText(run.text, run.line);
    run = null;
  };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t === undefined) continue;
    const before = toks[k - 1];
    const joinable = t.kind === 'str' || (t.kind === 'tmpl' && t.head && !t.subst);
    if (joinable) {
      if (run !== null && before !== undefined && before.kind === 'punct' && before.text === '+') run.text += t.text;
      else {
        flush();
        run = { text: t.text, line: t.line };
      }
    } else if (t.kind === 'tmpl') {
      flush();
      checkLiteralText(t.text, t.line);
    } else if (!(t.kind === 'punct' && t.text === '+' && run !== null)) {
      flush();
    }
  }
  flush();

  // Deduplicate identical findings and report in source order.
  const seen = new Set<string>();
  const unique = findings
    .filter((f) => {
      const key = `${f.line}\u0000${f.rule}\u0000${f.detail}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.line - b.line || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
  return { findings: unique, specifiers };
}

// ===================================================================================================
// 3. Tree scan + package.json policy
// ===================================================================================================

const SCANNED_EXTENSIONS: ReadonlySet<string> = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']);
/** The tokenizer has no JSX grammar: refuse such files rather than mis-scan them. */
const UNSUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set(['.tsx', '.jsx']);
/** Native or wasm binaries would be code the text scan cannot see. */
const OPAQUE_EXTENSIONS: ReadonlySet<string> = new Set(['.node', '.wasm']);

interface TreeFinding extends Finding {
  /** Path relative to the scanned root, with '/' separators. */
  file: string;
}

interface TreeScan {
  files: string[];
  findings: TreeFinding[];
}

async function listFiles(root: string, rel: string, files: string[], problems: TreeFinding[]): Promise<void> {
  const entries = await readdir(join(root, rel), { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isSymbolicLink()) {
      problems.push({ file: childRel, rule: 'scanner', line: 0, detail: 'symlink inside the scanned tree could smuggle in unscanned code' });
    } else if (e.isDirectory()) {
      await listFiles(root, childRel, files, problems);
    } else if (e.isFile()) {
      const ext = extname(e.name).toLowerCase();
      if (SCANNED_EXTENSIONS.has(ext)) files.push(childRel);
      else if (UNSUPPORTED_EXTENSIONS.has(ext)) problems.push({ file: childRel, rule: 'scanner', line: 0, detail: `${ext} files are not supported by the scanner` });
      else if (OPAQUE_EXTENSIONS.has(ext)) problems.push({ file: childRel, rule: 'scanner', line: 0, detail: `${ext} binaries cannot be audited` });
    }
  }
}

/** Scans every source file below `srcRoot`. src/devtools/ is the only place child_process may appear (and only as { execFile }). */
async function scanTree(srcRoot: string): Promise<TreeScan> {
  const files: string[] = [];
  const findings: TreeFinding[] = [];
  await listFiles(srcRoot, '', files, findings);
  for (const file of files) {
    const inDevtools = file.startsWith('devtools/');
    const text = (await readFile(join(srcRoot, file), 'utf8')).replace(/^\uFEFF/, '');
    const result = scanSource(text, { allowChildProcess: inDevtools });
    for (const f of result.findings) findings.push({ ...f, file });
    if (!inDevtools) {
      // src/devtools is a dev tool (it may spawn git): the product (SDK, CLI, MCP) must never be able to load it.
      for (const { spec, line } of result.specifiers) {
        if (!spec.startsWith('.')) continue;
        const resolved = posix.normalize(posix.join(posix.dirname(file), spec));
        if (resolved === 'devtools' || resolved.startsWith('devtools/')) {
          findings.push({ file, rule: 'devtools-import', line, detail: `product code imports the dev tool ${show(spec)}` });
        }
      }
    }
  }
  findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.line - b.line || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
  return { files, findings };
}

function formatFindings(findings: readonly TreeFinding[]): string {
  return findings.map((f) => `  src/${f.file}:${f.line} [${f.rule}] ${f.detail}`).join('\n');
}

/** Policy for package.json. Returns human-readable problems (empty = compliant). */
function runtimeDependencyProblems(pkg: unknown): string[] {
  if (typeof pkg !== 'object' || pkg === null || Array.isArray(pkg)) return ['package.json is not a JSON object'];
  const record = pkg as Record<string, unknown>;
  const problems: string[] = [];
  const depsRaw = record['dependencies'];
  const deps: Record<string, unknown> =
    typeof depsRaw === 'object' && depsRaw !== null && !Array.isArray(depsRaw) ? (depsRaw as Record<string, unknown>) : {};
  const actual = Object.keys(deps).sort();
  const unexpected = actual.filter((n) => !RUNTIME_DEPENDENCY_ALLOWLIST.includes(n));
  const missing = RUNTIME_DEPENDENCY_ALLOWLIST.filter((n) => !actual.includes(n));
  if (unexpected.length > 0) {
    problems.push(
      `Unexpected runtime "dependencies": ${unexpected.join(', ')}. Runtime dependencies must be exactly [${RUNTIME_DEPENDENCY_ALLOWLIST.join(', ')}] ` +
        '(docs/ARCHITECTURE.md, ADR-0003). Adding one is a conscious decision: record an ADR and update the allow-list in test/security/no-network.test.ts.',
    );
  }
  if (missing.length > 0) problems.push(`Missing runtime "dependencies": ${missing.join(', ')} (the allow-list is exact).`);
  for (const name of actual) {
    const spec = deps[name];
    // URL, git, file and alias specifiers bypass the registry and the lockfile integrity story.
    if (typeof spec !== 'string' || /[:/]/.test(spec)) problems.push(`Dependency ${name} uses a non-registry version specifier (${show(String(spec))}).`);
  }
  for (const key of ['optionalDependencies', 'peerDependencies', 'bundledDependencies', 'bundleDependencies']) {
    const v = record[key];
    const count = Array.isArray(v) ? v.length : typeof v === 'object' && v !== null ? Object.keys(v).length : v === undefined || v === false ? 0 : 1;
    if (count > 0) problems.push(`"${key}" must be absent or empty: it would ship extra runtime code outside the "dependencies" allow-list.`);
  }
  return problems;
}

function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth++) {
    // Both markers: the compiled output directory also contains src/ but no package.json.
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'src'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('repository root (package.json + src/) not found above the test file');
}

// ===================================================================================================
// 4. Tests
// ===================================================================================================

/** One-line view of a token stream: i=identifier p=punctuation n=number s=string t=template chunk r=regex. */
function sig(src: string): string[] {
  return tokenize(src).map((t) => `${t.kind === 'ident' ? 'i' : t.kind === 'punct' ? 'p' : t.kind === 'num' ? 'n' : t.kind === 'str' ? 's' : t.kind === 'tmpl' ? 't' : 'r'}:${t.text}`);
}

const NO_CP: ScanContext = { allowChildProcess: false };
const DEVTOOLS: ScanContext = { allowChildProcess: true };
const rulesOf = (src: string, ctx: ScanContext = NO_CP): Rule[] => scanSource(src, ctx).findings.map((f) => f.rule);

function runProperty<Ts extends unknown[]>(prop: fc.IPropertyWithHooks<Ts>, numRuns = 300): void {
  try {
    fc.assert(prop, { seed: SEED, numRuns });
  } catch (e) {
    throw new Error(`property failed (fast-check seed=${SEED}): ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

describe('tokenizer: comments', () => {
  it('a line comment hides everything up to the newline', () => {
    assert.deepEqual(sig('x // import http from "node:http"; fetch(u)\ny'), ['i:x', 'i:y']);
  });
  it('a block comment hides code, quotes and comment markers', () => {
    assert.deepEqual(sig('x /* it\'s "q" // `t` */ y'), ['i:x', 'i:y']);
  });
  it('a block comment does not end at a lookalike and spans lines', () => {
    const toks = tokenize('x /* a * / b\n\n */ y');
    assert.deepEqual(toks.map((t) => [t.text, t.line]), [['x', 1], ['y', 3]]);
  });
  it('an apostrophe in a comment does not open a string', () => {
    const toks = tokenize("// don't\nfetch(u)");
    assert.deepEqual(toks.map((t) => [t.text, t.line]).slice(0, 1), [['fetch', 2]]);
  });
  it('a hashbang is skipped', () => {
    assert.deepEqual(sig('#!/usr/bin/env node\nx'), ['i:x']);
  });
});

describe('tokenizer: string literals', () => {
  it('comment markers inside strings are data', () => {
    assert.deepEqual(sig("'http://example.test' // c"), ['s:http://example.test']);
    assert.deepEqual(sig('"/* not a comment */" x'), ['s:/* not a comment */', 'i:x']);
  });
  it('decodes escaped quotes', () => {
    assert.deepEqual(sig('"say \\"hi\\" // still string" x'), ['s:say "hi" // still string', 'i:x']);
    assert.deepEqual(sig("'it\\'s' y"), ["s:it's", 'i:y']);
  });
  it('decodes hex, unicode and code-point escapes', () => {
    assert.deepEqual(sig("'\\x66\\u0065tch\\u{28}'"), ['s:fetch(']);
  });
  it('line continuations join the string and keep line numbers right', () => {
    const toks = tokenize("'ab\\\ncd' y");
    assert.deepEqual(toks.map((t) => [t.text, t.line]), [['abcd', 1], ['y', 2]]);
    const crlf = tokenize("'ab\\\r\ncd' y");
    assert.deepEqual(crlf.map((t) => [t.text, t.line]), [['abcd', 1], ['y', 2]]);
  });
  it('an unescaped newline inside a string is a scan error (fail closed)', () => {
    assert.throws(() => tokenize("'abc\ndef'"), ScanError);
  });
});

describe('tokenizer: template literals', () => {
  it('plain template is one chunk; code-like text inside is data', () => {
    assert.deepEqual(sig('`fetch(u) // /* \' "` x'), ['t:fetch(u) // /* \' "', 'i:x']);
  });
  it('substitution switches back to code', () => {
    assert.deepEqual(sig('`a${b}c`'), ['t:a', 'p:${', 'i:b', 't:c']);
  });
  it('nested templates and substitutions resume the right template', () => {
    assert.deepEqual(sig('`a${`b${c}d`}e`'), ['t:a', 'p:${', 't:b', 'p:${', 'i:c', 't:d', 't:e']);
  });
  it('a closing brace inside a string within a substitution does not end it', () => {
    assert.deepEqual(sig('`a${"}"}b`'), ['t:a', 'p:${', 's:}', 't:b']);
  });
  it('an object literal inside a substitution has its own braces', () => {
    assert.deepEqual(sig('`a${{k:1}.k}b`'), ['t:a', 'p:${', 'p:{', 'i:k', 'p::', 'n:1', 'p:}', 'p:.', 'i:k', 't:b']);
  });
  it('escaped backtick and dollar-brace are text', () => {
    assert.deepEqual(sig('`\\`\\${x}`'), ['t:`${x}']);
  });
  it('a regex with a quote inside a substitution does not derail the template', () => {
    assert.deepEqual(sig('`a${/"/.test(s)}b`').filter((s) => s.startsWith('r:') || s.startsWith('t:')), ['t:a', 'r:"', 't:b']);
  });
  it('multi-line templates keep line numbers right', () => {
    const toks = tokenize('`a\nb\nc` x');
    assert.deepEqual(toks.map((t) => [t.text, t.line]), [['a\nb\nc', 1], ['x', 3]]);
  });
  it('an unterminated template is a scan error', () => {
    assert.throws(() => tokenize('`abc'), ScanError);
    assert.throws(() => tokenize('`abc${x'), ScanError);
  });
});

describe('tokenizer: regex literals', () => {
  it('quotes, backticks and slashes inside a regex do not open strings or comments', () => {
    assert.deepEqual(sig('x = /[\'"`]/g; y'), ['i:x', 'p:=', 'r:[\'"`]', 'p:;', 'i:y']);
    assert.deepEqual(sig("x = /[/]'/.test(s)").slice(0, 3), ['i:x', 'p:=', "r:[/]'"]);
    assert.deepEqual(sig('x = /\\/\\/ not a comment/'), ['i:x', 'p:=', 'r:\\/\\/ not a comment']);
  });
  it('code after a quote-bearing regex is still seen as code', () => {
    assert.deepEqual(rulesOf('const r = /["\']/; fetch(u)'), ['forbidden-global']);
    assert.deepEqual(rulesOf('const r = /["\']/; // fetch(u)'), []);
    assert.deepEqual(rulesOf('const r = /fetch\\(|WebSocket/;'), []);
  });
  it('an unterminated regex is a scan error', () => {
    assert.throws(() => tokenize('x = /abc'), ScanError);
  });
});

describe('tokenizer: division versus regex', () => {
  const noRegex = (src: string): void => {
    const toks = tokenize(src);
    assert.equal(toks.some((t) => t.kind === 'regex'), false, `unexpected regex in ${JSON.stringify(src)}: ${sig(src).join(' ')}`);
  };
  const regexAt = (src: string, body: string): void => {
    assert.ok(sig(src).includes(`r:${body}`), `expected regex ${JSON.stringify(body)} in ${JSON.stringify(src)}: ${sig(src).join(' ')}`);
  };

  it('identifiers, numbers, strings, templates and brackets are followed by division', () => {
    noRegex('a / b / c');
    noRegex('a[0] / 2 / 3');
    noRegex('"s" / 2 / 3');
    noRegex('`t` / 2 / 3');
    noRegex('0x1F / 2 / 3');
    noRegex('1e+5 / 2 / 3');
    noRegex('.5 / 2 / 3');
    noRegex('1.5.toFixed(2) / 3 / 4');
    noRegex('5..toString() / 2 / 3');
  });
  it('a parenthesised expression is followed by division', () => {
    noRegex('(a + b) / 2 / c');
    noRegex('foo(x) / 2 / 3');
  });
  it('postfix ++/-- and the TypeScript non-null assertion are followed by division', () => {
    noRegex('x++ / 2 / 3');
    noRegex('y-- / 2 / 3');
    noRegex('arr[i]! / total / 2');
    noRegex('(maybe)! / 2 / 3');
  });
  it('!= and !== are comparisons, so a regex may follow', () => {
    regexAt('x !== /"/', '"');
  });
  it('a keyword used as a property name is a value, so division follows', () => {
    noRegex('a.return / 2 / 3');
    noRegex('obj?.typeof / 2 / 3');
  });
  it('after an object literal a division is possible; after a block a regex is', () => {
    noRegex('x = {} / 2 / 3');
    regexAt("function f() {}\n/'/.test(s)", "'");
  });
  it('a regex starts after operators, keywords and the head of if/while/for', () => {
    regexAt('x = /"/', '"');
    regexAt('return /"/.test(s)', '"');
    regexAt('typeof /"/', '"');
    regexAt('f(/"/)', '"');
    regexAt('[/"/]', '"');
    regexAt('a ? /"/ : /\'/', '"');
    regexAt('if (ok) /"/.test(s)', '"');
    regexAt('while (ok) /"/.test(s)', '"');
    regexAt('for (const x of /"/.exec(s)) y', '"');
    regexAt('x = a && /"/.test(s)', '"');
  });
  it('a comment between operand and slash does not change the decision', () => {
    noRegex('a /* c */ / b / c');
  });
  it('distinguishes a comparison-like `<`/`>` followed by a regex', () => {
    regexAt('a > /"/.exec(s)', '"');
  });
});

describe('tokenizer: identifiers and punctuation', () => {
  it('decodes unicode escapes in identifiers', () => {
    assert.deepEqual(sig('\\u0066etch(u)'), ['i:fetch', 'p:(', 'i:u', 'p:)']);
    assert.deepEqual(sig('\\u{66}etch(u)'), ['i:fetch', 'p:(', 'i:u', 'p:)']);
    assert.throws(() => tokenize('a \\q b'), ScanError);
  });
  it('private names keep their hash, so #fetch is not the global fetch', () => {
    assert.deepEqual(sig('this.#fetch(u)'), ['i:this', 'p:.', 'i:#fetch', 'p:(', 'i:u', 'p:)']);
    assert.deepEqual(rulesOf('class A { #fetch(u) {} m() { return this.#fetch(1); } }'), []);
  });
  it('optional chaining versus ternary with a leading-dot number', () => {
    assert.deepEqual(sig('a?.b'), ['i:a', 'p:?.', 'i:b']);
    assert.deepEqual(sig('a?.5:1'), ['i:a', 'p:?', 'n:.5', 'p::', 'n:1']);
  });
  it('non-ASCII identifiers are identifiers', () => {
    assert.deepEqual(sig('const café = π'), ['i:const', 'i:café', 'p:=', 'i:π']);
  });
});

describe('tokenizer: fail-closed behaviour', () => {
  it('rejects unbalanced or unterminated input instead of guessing', () => {
    for (const src of ['/* open', "x = 'open", 'f(', 'f)', '{', '}', 'x = `${', '(a))']) {
      assert.throws(() => tokenize(src), ScanError, JSON.stringify(src));
    }
  });
  it('scanSource turns a scan error into a finding', () => {
    const r = scanSource("x = 'open", NO_CP);
    assert.deepEqual(r.findings.map((f) => f.rule), ['scanner']);
  });
  it('JSON.stringify of any string round-trips through the tokenizer (property)', () => {
    runProperty(
      fc.property(fc.string({ unit: 'binary', maxLength: 60 }), (s) => {
        const toks = tokenize(JSON.stringify(s));
        assert.equal(toks.length, 1);
        assert.equal(toks[0]?.kind, 'str');
        assert.equal(toks[0]?.text, s);
      }),
    );
  });
  it('an escaped template literal round-trips (property)', () => {
    runProperty(
      fc.property(fc.string({ unit: 'binary', maxLength: 60 }).filter((s) => !s.includes('\r')), (s) => {
        const escaped = s.replace(/[\\`]/g, '\\$&').replace(/\$\{/g, '\\${');
        const toks = tokenize(`\`${escaped}\``);
        assert.equal(toks.length, 1);
        assert.equal(toks[0]?.kind, 'tmpl');
        assert.equal(toks[0]?.text, s);
      }),
    );
  });
  it('a comment hides arbitrary text and the following line is still scanned (property)', () => {
    runProperty(
      fc.property(fc.string({ maxLength: 60 }).filter((s) => !/[\r\n\u2028\u2029]/.test(s)), (s) => {
        const found = scanSource(`// ${s}\nfetch(u)`, NO_CP).findings;
        assert.deepEqual(found.map((f) => [f.rule, f.line]), [['forbidden-global', 2]]);
      }),
    );
    runProperty(
      fc.property(fc.string({ maxLength: 60 }).filter((s) => !s.includes('*/')), (s) => {
        const found = scanSource(`/* ${s} */ fetch(u)`, NO_CP).findings;
        assert.deepEqual(found.map((f) => f.rule), ['forbidden-global']);
      }),
    );
  });
  it('the tokenizer only ever throws ScanError on arbitrary text (property)', () => {
    runProperty(
      fc.property(fc.string({ unit: 'binary', maxLength: 80 }), (s) => {
        try {
          tokenize(s);
        } catch (e) {
          assert.ok(e instanceof ScanError, `non-ScanError thrown: ${String(e)}`);
        }
      }),
      500,
    );
  });
});

// --- rule tests -------------------------------------------------------------------------------------

const FORBIDDEN_SPECIFIERS: readonly string[] = [
  'node:http', 'http', 'node:https', 'https', 'node:http2', 'http2', 'node:net', 'net', 'node:tls', 'tls', 'node:dns', 'dns', 'node:dns/promises',
  'node:dgram', 'dgram', 'node:cluster', 'cluster', 'node:worker_threads', 'worker_threads', 'node:vm', 'vm', 'node:inspector', 'node:inspector/promises',
  'node:child_process', 'child_process', 'node:repl', 'node:module', '_http_agent', 'node:_tls_wrap',
  'undici', 'ws', 'ws/lib/websocket.js', 'playwright', 'playwright-core', '@playwright/test', 'puppeteer', 'puppeteer-core', '@puppeteer/browsers',
  'chrome-remote-interface', 'axios', 'node-fetch', 'got',
  '@modelcontextprotocol/sdk/server/streamableHttp.js', '@modelcontextprotocol/sdk/client/streamableHttp.js', '@modelcontextprotocol/sdk/server/sse.js',
  '@modelcontextprotocol/sdk/client/sse.js', '@modelcontextprotocol/sdk/client/websocket.js', '@modelcontextprotocol/sdk/server/express.js',
  '@modelcontextprotocol/sdk/client/auth.js', '@modelcontextprotocol/sdk/client/stdio.js',
  'https://example.test/x.js', 'data:text/javascript,1', 'file:///tmp/x.js',
];

const FORM_TEMPLATES: ReadonlyArray<readonly [string, (spec: string) => string]> = [
  ['default import', (s) => `import x from '${s}';`],
  ['side-effect import', (s) => `import '${s}';`],
  ['named import', (s) => `import { a, b as c } from '${s}';`],
  ['namespace import', (s) => `import * as ns from "${s}";`],
  ['type import', (s) => `import type { T } from '${s}';`],
  ['export star', (s) => `export * from '${s}';`],
  ['export named', (s) => `export { a } from '${s}';`],
  ['dynamic import', (s) => `const m = await import('${s}');`],
  ['dynamic import with attributes', (s) => `const m = await import('${s}', { with: {} });`],
  ['template-literal import', (s) => `const m = await import(\`${s}\`);`],
  ['import type expression', (s) => `type T = typeof import('${s}');`],
  ['require call', (s) => `const m = require('${s}');`],
  ['module.require call', (s) => `const m = module.require('${s}');`],
  ['specifier given through an escape', (s) => `import x from '${s.replace(/^./, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)}';`],
];

describe('rules: forbidden modules (positive cases)', () => {
  for (const spec of FORBIDDEN_SPECIFIERS) {
    for (const [form, build] of FORM_TEMPLATES) {
      it(`${spec} via ${form}`, () => {
        // Escaped-specifier variants only make sense when the first character is a plain ASCII char.
        const src = build(spec);
        const rules = rulesOf(src);
        assert.ok(rules.length > 0, `expected a finding for: ${src}`);
        assert.ok(rules.every((r) => r === 'forbidden-module' || r === 'unlisted-module'), `unexpected rules ${rules.join(',')} for: ${src}`);
      });
    }
  }
});

describe('rules: dynamic and runtime-assembled specifiers', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['import(variable)', 'const m = await import(name);'],
    ['import(concatenation)', "const m = await import('node:' + 'http');"],
    ['import(template with substitution)', 'const m = await import(`node:${name}`);'],
    ['import() with no argument', 'const m = await import();'],
    ['require(variable)', 'const m = require(name);'],
    ['require(concatenation)', "const m = require('ht' + 'tp');"],
    ['require(template with substitution)', 'const m = require(`${a}`);'],
    ['bare require reference', 'const r = require; r("x");'],
    ['typeof require', "const ok = typeof require === 'function';"],
    ['module.require(variable)', 'module.require(name);'],
  ];
  for (const [name, src] of cases) {
    it(name, () => {
      assert.ok(rulesOf(src).includes('dynamic-specifier'), `expected dynamic-specifier for: ${src}`);
    });
  }
});

describe('rules: globals and escape hatches (positive cases)', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['fetch call', 'const r = await fetch(url);'],
    ['fetch call with a space', 'const r = await fetch (url);'],
    ['fetch reference', 'const f = fetch;'],
    ['globalThis.fetch', 'await globalThis.fetch(url);'],
    ['window.fetch', 'await window.fetch(url);'],
    ['global?.fetch', 'await global?.fetch(url);'],
    ['fetch spelled with a unicode escape', 'await \\u0066etch(url);'],
    ['new WebSocket', 'const s = new WebSocket(url);'],
    ['new XMLHttpRequest', 'const x = new XMLHttpRequest();'],
    ['new EventSource', 'const e = new EventSource(url);'],
    ['navigator.sendBeacon', 'navigator.sendBeacon(url, data);'],
    ['process.binding', "process.binding('tcp_wrap');"],
    ['process.dlopen', 'process.dlopen(module, file);'],
    ["process['binding']", "process['binding']('tcp_wrap');"],
    ["globalThis['fetch']", "globalThis['fetch'](url);"],
    ["globalThis['fet' + 'ch']", "globalThis['fet' + 'ch'](url);"],
    ['globalThis[name]', 'globalThis[name](url);'],
    ['process[name]', 'process[name]();'],
    ['process.getBuiltinModule', "process.getBuiltinModule('node:http');"],
    ['process.mainModule', 'process.mainModule.require(x);'],
    ['createRequire', "const r = createRequire(import.meta.url); r('node:http');"],
    ['eval', "eval('1');"],
    ['Function constructor call', "Function('return fetch')();"],
    ['new Function', "const f = new Function('a', 'return a');"],
    ['code inside a template substitution is still code', 'const s = `${fetch(url)}`;'],
    ['code inside nested substitution', 'const s = `a${`b${new WebSocket(u)}`}`;'],
  ];
  for (const [name, src] of cases) {
    it(name, () => {
      assert.ok(rulesOf(src).includes('forbidden-global'), `expected forbidden-global for: ${src}\n${JSON.stringify(scanSource(src, NO_CP).findings)}`);
    });
  }
});

describe('rules: forbidden string literals', () => {
  const [backendHost, backendPath, cookieName] = FORBIDDEN_LITERALS as [string, string, string];
  const positives: ReadonlyArray<readonly [string, string]> = [
    ['plain string', `const u = 'https://${backendHost}/conversations';`],
    ['bare path marker', `const p = "${backendPath}";`],
    ['cookie name', `const c = '${cookieName}.session-token';`],
    ['case-insensitive', `const u = '${backendHost.toUpperCase()}';`],
    ['template literal text', `const u = \`https://\${host}${backendPath}list\`;`],
    ['two strings concatenated', `const u = '${backendHost.slice(0, 14)}' + '${backendHost.slice(14)}';`],
    ['three strings concatenated', `const u = 'a' + '${backendPath.slice(0, 4)}' + '${backendPath.slice(4)}';`],
    ['hex-escaped slash', `const p = '\\x2f${backendPath.slice(1)}';`],
    ['unicode-escaped character', `const c = '__Secure\\u002dnext-auth';`],
  ];
  for (const [name, src] of positives) {
    it(`detects: ${name}`, () => {
      assert.ok(rulesOf(src).includes('forbidden-literal'), `expected forbidden-literal for: ${src}`);
    });
  }
  const negatives: ReadonlyArray<readonly [string, string]> = [
    ['marker only in a line comment', `// see ${backendHost}\nconst x = 1;`],
    ['marker only in a block comment', `/* ${cookieName} */ const x = 1;`],
    ['documented consumer URL form', "const re = 'https://chatgpt.com/c/<uuid>';"],
    ['unrelated path', "const p = '/api/backend/';"],
  ];
  for (const [name, src] of negatives) {
    it(`ignores: ${name}`, () => {
      assert.deepEqual(rulesOf(src), []);
    });
  }
  it('does not echo the marker in the finding (messages stay free of private-endpoint text)', () => {
    const f = scanSource(`const u = '${backendHost}';`, NO_CP).findings[0];
    assert.ok(f !== undefined);
    assert.equal(FORBIDDEN_LITERALS.some((m) => f.detail.includes(m)), false);
  });
});

describe('rules: unlisted third-party packages', () => {
  for (const spec of ['fast-check', 'typescript', '@types/node', 'left-pad', 'zod-extra', '@modelcontextprotocol/other', 'test', '#internal', '/abs/x.js', '../../node_modules/undici/index.js']) {
    it(`${spec} is rejected`, () => {
      assert.ok(rulesOf(`import x from '${spec}';`).length > 0);
    });
  }
});

describe('rules: negative cases (nothing to report)', () => {
  const benign: ReadonlyArray<readonly [string, string]> = [
    ['builtin imports', "import { readFile } from 'node:fs/promises';\nimport path from 'node:path';\nimport { DatabaseSync } from 'node:sqlite';\nimport { createHash } from 'node:crypto';\nimport fs from 'fs';"],
    ['relative imports', "import { x } from './x.js';\nimport type { Y } from '../y.js';\nexport * from './z.js';\nimport data from './d.json' with { type: 'json' };"],
    ['allowed packages', "import { z } from 'zod';\nimport { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\nimport { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';\nimport type { Tool } from '@modelcontextprotocol/sdk/types.js';"],
    ['dynamic import of a literal relative module', "const m = await import('./lazy.js');"],
    ['imports and calls named in comments', "// import http from 'node:http'; fetch(url); new WebSocket(u)\n/* require('net'); process.binding('x'); eval('1') */\nconst a = 1;"],
    ['imports and calls named in strings', "const s = \"import http from 'node:http'; fetch(url); new WebSocket(u); require('net')\";\nconst t = 'process.dlopen navigator.sendBeacon';"],
    ['calls named in template text', 'const t = `fetch(url) and new WebSocket() and ${1 + 1}`;'],
    ['calls named in a regex', 'const r = /fetch\\(|WebSocket|require\\(/;'],
    ['lookalike identifiers', 'const fetchSize = 1; function refetch() {} const prefetch = refetch; const WebSockets = []; const fetcher = {};'],
    ['member named fetch on a first-party object', 'await repo.fetch(id); await this.fetch(id); const f = repo?.fetch;'],
    ['member named require or import on a first-party object', 'contract.require(x); loader.import(y);'],
    ['Buffer.from and Array.from', "const b = Buffer.from('abc'); const a = Array.from([1]);"],
    ['import.meta', 'const u = new URL(import.meta.url);'],
    ['property access on process and globalThis with a literal key', "const h = process.env['HOME']; const t = globalThis['structuredClone'];"],
    ['Function as a type', 'let f: Function | undefined; const g = x instanceof Function;'],
    ['ordinary arithmetic with division', 'const avg = (a + b) / 2; const r = a / b / c;'],
  ];
  for (const [name, src] of benign) {
    it(name, () => {
      assert.deepEqual(scanSource(src, NO_CP).findings, []);
    });
  }

  it('wrapping any positive case in a string, comment or template yields nothing (positive controls are not accidents)', () => {
    const snippets = [
      ...FORBIDDEN_SPECIFIERS.slice(0, 12).map((s) => `import x from '${s}';`),
      "await import('node:http');",
      "require('net');",
      'await fetch(u);',
      'new WebSocket(u);',
      "process.binding('x');",
    ];
    for (const snippet of snippets) {
      const asString = `const s = ${JSON.stringify(snippet)};`;
      const asComment = `// ${snippet}\nconst a = 1;`;
      const asBlock = `/* ${snippet} */ const a = 1;`;
      const asTemplate = `const t = \`${snippet.replace(/[\\`]/g, '\\$&').replace(/\$\{/g, '\\${')}\`;`;
      for (const wrapped of [asString, asComment, asBlock, asTemplate]) {
        assert.deepEqual(scanSource(wrapped, NO_CP).findings, [], `wrapped snippet reported: ${wrapped}`);
      }
    }
  });
});

describe('rules: src/devtools allow-list is child_process { execFile } only', () => {
  const ok = [
    "import { execFile } from 'node:child_process';",
    "import { execFile } from 'child_process';",
    "import { execFile as run } from 'node:child_process';",
    "import { type ExecFileOptions, execFile } from 'node:child_process';",
    "import type { ExecFileOptions } from 'node:child_process';\nimport { execFile } from 'node:child_process';",
    "import { execFile } from 'node:child_process';\nconst opts = { shell: false, encoding: 'buffer' };",
  ];
  for (const src of ok) {
    it(`devtools may: ${src.split('\n')[0]}`, () => {
      assert.deepEqual(scanSource(src, DEVTOOLS).findings, []);
    });
    it(`non-devtools may not: ${src.split('\n')[0]}`, () => {
      assert.ok(rulesOf(src, NO_CP).includes('forbidden-module'));
    });
  }
  const bad: ReadonlyArray<readonly [string, string, Rule]> = [
    ['spawn', "import { spawn } from 'node:child_process';", 'child-process-usage'],
    ['exec', "import { exec } from 'node:child_process';", 'child-process-usage'],
    ['execFileSync', "import { execFileSync } from 'node:child_process';", 'child-process-usage'],
    ['execFile with another name', "import { execFile, spawn } from 'node:child_process';", 'child-process-usage'],
    ['default import', "import cp from 'node:child_process';", 'child-process-usage'],
    ['namespace import', "import * as cp from 'node:child_process';", 'child-process-usage'],
    ['side-effect import', "import 'node:child_process';", 'child-process-usage'],
    ['re-export', "export { execFile } from 'node:child_process';", 'child-process-usage'],
    ['dynamic import', "const cp = await import('node:child_process');", 'child-process-usage'],
    ['require', "const cp = require('node:child_process');", 'child-process-usage'],
    ['shell: true', "import { execFile } from 'node:child_process';\nexecFile('git', [], { shell: true });", 'child-process-usage'],
    ['shell: variable', "import { execFile } from 'node:child_process';\nexecFile('git', [], { shell: flag });", 'child-process-usage'],
    ['http inside devtools', "import http from 'node:http';", 'forbidden-module'],
    ['fetch inside devtools', 'await fetch(u);', 'forbidden-global'],
    ['unlisted package inside devtools', "import x from 'left-pad';", 'unlisted-module'],
    ['dynamic specifier inside devtools', 'await import(name);', 'dynamic-specifier'],
  ];
  for (const [name, src, rule] of bad) {
    it(`devtools may not: ${name}`, () => {
      assert.ok(rulesOf(src, DEVTOOLS).includes(rule), `expected ${rule} for: ${src}; got ${rulesOf(src, DEVTOOLS).join(',')}`);
    });
  }
});

describe('findings carry correct line numbers', () => {
  it('reports the line of the offending token in multi-line sources', () => {
    const src = ['// header', 'const a = `multi', 'line`;', "import x from 'node:http';", 'const b = 1;', 'await fetch(u);'].join('\n');
    const lines = scanSource(src, NO_CP).findings.map((f) => [f.rule, f.line]);
    assert.deepEqual(lines, [['forbidden-module', 4], ['forbidden-global', 6]]);
  });
});

describe('package.json runtime dependency policy', () => {
  const good = { dependencies: { '@modelcontextprotocol/sdk': '1.32.1', zod: '4.6.5' }, devDependencies: { typescript: '7.0.2' } };
  it('accepts exactly the allow-list (dev dependencies are unrestricted)', () => {
    assert.deepEqual(runtimeDependencyProblems(good), []);
  });
  it('fails clearly when a dependency is added', () => {
    const problems = runtimeDependencyProblems({ dependencies: { ...good.dependencies, undici: '7.0.0' } });
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /Unexpected runtime "dependencies": undici/);
    assert.match(problems[0] ?? '', /conscious decision/);
  });
  it('fails when an allow-listed dependency is missing', () => {
    assert.match(runtimeDependencyProblems({ dependencies: { zod: '4.6.5' } }).join('\n'), /Missing runtime "dependencies": @modelcontextprotocol\/sdk/);
    assert.ok(runtimeDependencyProblems({}).length > 0);
  });
  it('fails on optional, peer and bundled dependencies', () => {
    for (const key of ['optionalDependencies', 'peerDependencies']) {
      assert.ok(runtimeDependencyProblems({ ...good, [key]: { ws: '8.0.0' } }).some((p) => p.includes(key)), key);
    }
    assert.ok(runtimeDependencyProblems({ ...good, bundledDependencies: ['zod'] }).some((p) => p.includes('bundledDependencies')));
    assert.deepEqual(runtimeDependencyProblems({ ...good, optionalDependencies: {} }), []);
  });
  it('fails on URL, git, file, alias and path version specifiers', () => {
    for (const spec of ['https://example.test/z.tgz', 'git+https://example.test/z.git', 'file:../z', 'npm:other@1', 'user/repo#main']) {
      assert.ok(runtimeDependencyProblems({ dependencies: { ...good.dependencies, zod: spec } }).some((p) => p.includes('non-registry')), spec);
    }
  });
  it('rejects a non-object package.json', () => {
    assert.ok(runtimeDependencyProblems(null).length > 0);
    assert.ok(runtimeDependencyProblems([]).length > 0);
  });
});

describe('tree scan (synthetic src/ trees)', () => {
  async function writeTree(root: string, files: Record<string, string>): Promise<void> {
    for (const [rel, text] of Object.entries(files)) {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, text);
    }
  }
  const summarize = (scan: TreeScan): string[] => scan.findings.map((f) => `${f.file}:${f.line}:${f.rule}`);

  it('walks nested directories, scans .ts/.mts/.cts/.js/.mjs/.cjs and reports sorted findings', async () => {
    await withTempDir(async (dir) => {
      await writeTree(dir, {
        'ok.ts': "import { x } from './a/b/c.js';\nexport const y = 1;\n",
        'a/b/c.ts': 'export const x = 1;\n',
        'a/b/bad.ts': "import net from 'node:net';\n",
        'z/deep/er/bad.mts': 'await fetch(u);\n',
        'bad.cjs': "const m = require('http');\n",
        'bad.js': "import 'https';\n",
        'bad.mjs': 'const m = await import(name);\n',
        'notes.md': "import http from 'node:http'; not source\n",
      });
      const scan = await scanTree(dir);
      assert.deepEqual(scan.files, ['a/b/bad.ts', 'a/b/c.ts', 'bad.cjs', 'bad.js', 'bad.mjs', 'ok.ts', 'z/deep/er/bad.mts']);
      assert.deepEqual(summarize(scan), [
        'a/b/bad.ts:1:forbidden-module',
        'bad.cjs:1:forbidden-module',
        'bad.js:1:forbidden-module',
        'bad.mjs:1:dynamic-specifier',
        'z/deep/er/bad.mts:1:forbidden-global',
      ]);
    });
  });

  it('a clean tree has no findings', async () => {
    await withTempDir(async (dir) => {
      await writeTree(dir, { 'index.ts': "export * from './lib.js';\n", 'lib.ts': "import { readFile } from 'node:fs/promises';\nexport const r = readFile;\n" });
      const scan = await scanTree(dir);
      assert.deepEqual(scan.findings, []);
      assert.equal(scan.files.length, 2);
    });
  });

  it('child_process is allowed under devtools/ as { execFile } only, and nowhere else', async () => {
    await withTempDir(async (dir) => {
      await writeTree(dir, {
        'devtools/git.ts': "import { execFile } from 'node:child_process';\nexport const run = execFile;\n",
        'devtools/evil.ts': "import { spawn } from 'node:child_process';\nimport http from 'node:http';\n",
        'core/git.ts': "import { execFile } from 'node:child_process';\n",
        'notdevtools/git.ts': "import { execFile } from 'node:child_process';\n",
      });
      const scan = await scanTree(dir);
      assert.deepEqual(summarize(scan), [
        'core/git.ts:1:forbidden-module',
        'devtools/evil.ts:1:child-process-usage',
        'devtools/evil.ts:2:forbidden-module',
        'notdevtools/git.ts:1:forbidden-module',
      ]);
    });
  });

  it('product code may not import src/devtools (any relative spelling), devtools may import itself', async () => {
    await withTempDir(async (dir) => {
      await writeTree(dir, {
        'devtools/a.ts': "import { b } from './b.js';\nexport const a = b;\n",
        'devtools/b.ts': 'export const b = 1;\n',
        'sdk/gcr.ts': "import { b } from '../devtools/b.js';\nexport const g = b;\n",
        'cli/main.ts': "import { b } from '../sdk/../devtools/b.js';\nexport const m = b;\n",
        'index.ts': "export * from './devtools/a.js';\n",
        'mcp/server.ts': "const m = await import('../devtools/a.js');\n",
        'sdk/ok.ts': "import { x } from './gcr.js';\nexport const o = x;\n",
      });
      const scan = await scanTree(dir);
      assert.deepEqual(summarize(scan), [
        'cli/main.ts:1:devtools-import',
        'index.ts:1:devtools-import',
        'mcp/server.ts:1:devtools-import',
        'sdk/gcr.ts:1:devtools-import',
      ]);
    });
  });

  it('flags symlinks, JSX files and native binaries instead of silently skipping them', async (t) => {
    await withTempDir(async (dir) => {
      await writeTree(dir, { 'ok.ts': 'export const a = 1;\n', 'view.tsx': 'export const v = <div/>;\n', 'addon.node': 'binary', 'mod.wasm': 'binary' });
      try {
        await symlink(join(dir, 'ok.ts'), join(dir, 'link.ts'));
      } catch {
        t.diagnostic('symlink creation not permitted here; symlink assertion skipped');
      }
      const scan = await scanTree(dir);
      const got = summarize(scan);
      assert.ok(got.includes('view.tsx:0:scanner'));
      assert.ok(got.includes('addon.node:0:scanner'));
      assert.ok(got.includes('mod.wasm:0:scanner'));
      if (existsSync(join(dir, 'link.ts'))) assert.ok(got.includes('link.ts:0:scanner'));
    });
  });

  it('strips a UTF-8 BOM and still finds problems', async () => {
    await withTempDir(async (dir) => {
      await writeTree(dir, { 'bom.ts': "\uFEFFimport http from 'node:http';\n" });
      assert.deepEqual(summarize(await scanTree(dir)), ['bom.ts:1:forbidden-module']);
    });
  });

  it('a file the scanner cannot tokenize fails the scan', async () => {
    await withTempDir(async (dir) => {
      await writeTree(dir, { 'broken.ts': "const s = 'unterminated\n" });
      assert.deepEqual(summarize(await scanTree(dir)), ['broken.ts:1:scanner']);
    });
  });
});

describe('repository: first-party src/ contains no network-capable code (NFR-01, ADR-0010)', () => {
  const root = findRepoRoot();
  let scan: TreeScan;
  before(async () => {
    scan = await scanTree(join(root, 'src'));
  });

  const only = (...rules: Rule[]): TreeFinding[] => scan.findings.filter((f) => rules.includes(f.rule));

  it('actually scanned the source tree (guards against a vacuous pass)', () => {
    assert.ok(scan.files.length >= 5, `only ${scan.files.length} files scanned`);
    assert.ok(scan.files.includes('errors.ts'), 'src/errors.ts must be among the scanned files');
  });

  it('imports no network, browser-automation, process or code-loading module and no unlisted package', () => {
    const bad = only('forbidden-module', 'unlisted-module', 'dynamic-specifier', 'child-process-usage', 'devtools-import');
    assert.equal(bad.length, 0, `module findings:\n${formatFindings(bad)}`);
  });

  it('references no network or escape-hatch global (fetch, WebSocket, XMLHttpRequest, EventSource, sendBeacon, process.binding, process.dlopen, ...)', () => {
    const bad = only('forbidden-global');
    assert.equal(bad.length, 0, `global findings:\n${formatFindings(bad)}`);
  });

  it('contains no string literal naming a private ChatGPT endpoint or session cookie', () => {
    const bad = only('forbidden-literal');
    assert.equal(bad.length, 0, `literal findings:\n${formatFindings(bad)}`);
  });

  it('every file was tokenizable and no symlink, JSX or native artifact is present', () => {
    const bad = only('scanner');
    assert.equal(bad.length, 0, `scanner findings:\n${formatFindings(bad)}`);
  });

  it('has no other finding of any kind', () => {
    assert.equal(scan.findings.length, 0, `findings:\n${formatFindings(scan.findings)}`);
  });

  it('package.json runtime dependencies are exactly [@modelcontextprotocol/sdk, zod]', async () => {
    const pkg: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const problems = runtimeDependencyProblems(pkg);
    assert.equal(problems.length, 0, problems.join('\n'));
  });
});
