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
 *    stdio/in-memory subpaths, and why the dependency allow-list is asserted. The relative-import closure of
 *    those subpaths inside the installed SDK is scanned for forbidden modules and for packages outside a reviewed
 *    set (SDK_REACHABLE_EXTERNALS); the third-party packages it names (ajv, zod, ...) and any other transitive
 *    code are not scanned.
 *  - It is a tripwire against accidents and lazy shortcuts, not a sandbox. Determined obfuscation (reading code
 *    from disk and evaluating it, strings assembled from computed pieces, base64, ...) can only be partly
 *    anticipated. The runtime guarantee comes from there being no network code to call, plus code review of this
 *    allow-list.
 *  - src/devtools may import { execFile } from child_process (SPEC: devtools are allow-listed for child_process
 *    only). The scan cannot tell WHICH executable it runs: `execFile('curl', ...)` there would pass. Reviewers must
 *    keep devtools to fixed, local programs (today: git).
 *  - Sources are read as UTF-8 only (a BOM is fine). UTF-16 files, invalid UTF-8 and NUL bytes fail the scan,
 *    because the TypeScript compiler decodes UTF-16 and a UTF-8 text scan would not see what it emits.
 *  - A relative import must stay inside src/: whatever it reaches outside is code this scan never read.
 *  - A source file larger than 2 MiB fails the scan (the tokenizer keeps one object per token, ~140x the file size).
 *  - Known gaps, all deliberate obfuscation rather than accident: a Function constructor held in a variable
 *    (`const F = (() => {}).constructor`), `class X extends Function`, a marker or specifier assembled by
 *    `.concat()`, `.join()`, template substitutions of constants or any other computed piece, and a computed key
 *    in a destructuring of process (`const { [k]: f } = process`).
 *  - Fixing a finding by renaming is intended: the rules flag declarations as well as uses where the two cannot
 *    be told apart without a parser (a method or property named fetch, a method named import, a binding named global).
 *
 * All sources analysed here are synthetic strings. Strings that name private endpoints or cookie names are
 * assembled from fragments at runtime so this file never contains them literally (they would otherwise trip
 * the repository's own privacy scanner).
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, symlink, truncate, writeFile } from 'node:fs/promises';
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

/** ECMAScript LineTerminator: a `//` comment and a hashbang end at any of these, and a regex literal cannot contain one. */
const isLineTerminator = (ch: string | undefined): boolean => ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029';

/**
 * Whitespace as the TypeScript compiler (the tool that produces what runs) reads it. That is a JavaScript `\s` plus
 * U+0085 (NEL) and U+200B (zero width space): tsc accepts both between tokens and prints the module again without them,
 * so `import​('node:http')` becomes a plain dynamic import. Neither is a line terminator.
 */
const isWhitespace = (ch: string): boolean => /\s/.test(ch) || ch === '\u0085' || ch === '​';

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
    case '1':
    case '2':
    case '3':
    case '4':
    case '5':
    case '6':
    case '7': {
      // Legacy octal escape (sloppy-mode scripts): \0-\3 take up to two more octal digits, \4-\7 up to one more.
      // Not decoding it would let `'\57...'` hide a character that the engine sees (\0 alone stays NUL).
      let j = i + 2;
      let digits = c;
      const extra = c <= '3' ? 2 : 1;
      while (digits.length <= extra && src[j] !== undefined && src[j]! >= '0' && src[j]! <= '7') {
        digits += src[j];
        j++;
      }
      return { value: String.fromCharCode(parseInt(digits, 8)), length: j - i, newlines: 0 };
    }
    case 'x': {
      const h = src.slice(i + 2, i + 4);
      if (/^[0-9a-fA-F]{2}$/.test(h)) return { value: String.fromCharCode(parseInt(h, 16)), length: 4, newlines: 0 };
      break;
    }
    case 'u': {
      if (src[i + 2] === '{') {
        // At most 6 hex digits and the closing brace: look in a window, not to the end of the file (a file made of
        // `\u{` repeats would otherwise cost O(n^2)).
        const rel = src.slice(i + 3, i + 10).indexOf('}');
        const close = rel < 0 ? -1 : i + 3 + rel;
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
        if (p.afterDot) return false;
        // `of` is an ordinary identifier outside a for-head: `of / 2` is a division. Treating it as a keyword there
        // would turn everything up to the next slash on the line into a "regex" and hide it from the rules.
        if (p.text === 'of') return this.parenStack[this.parenStack.length - 1] === true;
        return REGEX_PRECEDING_WORDS.has(p.text);
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
      if (ch === '\u2028' || ch === '\u2029') this.line++; // legal unescaped in a string since ES2019
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
      if (ch === '\n' || ch === '\u2028' || ch === '\u2029' || (ch === '\r' && src[this.i + 1] !== '\n')) this.line++;
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
      if (ch === '\u2028' || ch === '\u2029') {
        // tsc 7 accepts this and emits it verbatim, but Node refuses to load the module ("Invalid regular expression: missing /").
        throw this.err('regular expression literal contains a raw U+2028/U+2029 line separator (a SyntaxError at load time; write it as \\u2028 or \\u2029)');
      }
      if (ch === undefined || isLineTerminator(ch)) throw this.err('unterminated regular expression literal');
      if (ch === '\\') {
        const nx = src[j + 1];
        if (nx === undefined || isLineTerminator(nx)) throw this.err('unterminated regular expression literal');
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
        // After an exponent (`1e3`) or a BigInt suffix (`10n`) a dot is member access, never a fraction.
        if ((!radix && (ch === 'e' || ch === 'E')) || ch === 'n') seenDot = true;
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
      while (this.i < n && !isLineTerminator(src[this.i])) this.i++;
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
      if (c === '\u2028' || c === '\u2029') {
        this.line++;
        this.i++;
        continue;
      }
      if (isWhitespace(c)) {
        this.i++;
        continue;
      }
      if (c === '/') {
        const d = src[this.i + 1];
        if (d === '/') {
          // U+2028 / U+2029 end a line comment too (the compiler agrees); a \n-only scan would hide the code after them.
          while (this.i < n && !isLineTerminator(src[this.i])) this.i++;
          continue;
        }
        if (d === '*') {
          const end = src.indexOf('*/', this.i + 2);
          if (end < 0) throw this.err('unterminated block comment');
          for (let k = this.i; k < end; k++) {
            if (src[k] === '\n' || src[k] === '\u2028' || src[k] === '\u2029' || (src[k] === '\r' && src[k + 1] !== '\n')) this.line++;
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
  | 'outside-src'
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
  ['test', 'node:test run() spawns node subprocesses'],
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
  // Superset spellings: the three above miss `https://host/backend-api` (no trailing slash) and the CSRF cookie, which
  // carries a __Host- prefix instead of __Secure-. A bare `next-auth` is deliberately NOT a marker: src/devtools/privacy-scan.ts
  // must name that cookie to detect it. Reported once per literal.
  ['/back', 'end-api'].join(''),
  ['__Host-', 'next-auth'].join(''),
];

const GLOBAL_OBJECT_NAMES: ReadonlySet<string> = new Set(['globalThis', 'global', 'window', 'self']);
/** Receivers of computed lookups (`x['name']`) that are checked for dynamic access to forbidden members. */
const COMPUTED_LOOKUP_RECEIVERS: ReadonlySet<string> = new Set(['globalThis', 'global', 'window', 'self', 'process', 'navigator']);
const COMPUTED_FORBIDDEN_NAMES: ReadonlySet<string> = new Set([
  'fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource', 'sendBeacon', 'binding', 'dlopen', '_linkedBinding', 'getBuiltinModule', 'mainModule', 'createRequire',
  'loadExtension', 'enableLoadExtension', 'eval', 'Function', '_load',
]);
/** Identifiers that, however they are reached (destructuring, aliases, named imports), load native code or process internals. */
const NATIVE_LOADER_NAMES: ReadonlySet<string> = new Set([
  'dlopen', '_linkedBinding', 'mainModule', 'loadExtension', 'enableLoadExtension', 'allowExtension',
  'execve', // process.execve (Node >= 22.15) replaces the process image with any program: spawning without child_process
  'setEngine', // crypto.setEngine(path) loads an OpenSSL engine, i.e. a native library, like dlopen
]);
/** Names flagged wherever they appear as identifiers (see NATIVE_LOADER_NAMES and the switch in scanSource); a quoted key spelling them is flagged as well. */
const QUOTED_KEY_FORBIDDEN_NAMES: ReadonlySet<string> = new Set([
  'WebSocket', 'XMLHttpRequest', 'EventSource', 'sendBeacon', 'createRequire', 'getBuiltinModule',
  'dlopen', '_linkedBinding', 'mainModule', 'loadExtension', 'enableLoadExtension', 'allowExtension', 'execve', 'setEngine',
]);
/** A binding of these words declares a new name, so a following/preceding occurrence is not a use of the global object. */
const DECLARATION_WORDS: ReadonlySet<string> = new Set(['const', 'let', 'var', 'function', 'class', 'interface', 'type', 'enum', 'namespace', 'import', 'as', 'typeof', 'declare']);

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

  const mentionsProcess = toks.some(
    (tk) => (tk.kind === 'ident' && !tk.afterDot && tk.text === 'process') || (tk.kind === 'str' && (tk.text === 'process' || tk.text === 'node:process')),
  );
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
          // process.binding(...), p.binding(...) through any alias, and a bare `binding` (destructured from process or
          // imported from node:process) in a file that touches process at all. A first-party variable that happens to be
          // called `binding` in a file that never mentions process is fine.
          if (recv === 'process' || (t.afterDot && isPunct(next, '(')) || (!t.afterDot && mentionsProcess)) {
            add('forbidden-global', t.line, 'process.binding reaches Node internals (tcp_wrap, tls_wrap, ...) without an import the scan can see');
          }
          break;
        case 'globalThis':
        case 'global': {
          if (t.afterDot) break;
          const before = toks[k - 1];
          const declares = before !== undefined && before.kind === 'ident' && !before.afterDot && DECLARATION_WORDS.has(before.text);
          const member = isPunct(next, '.') || isPunct(next, '?.') || isPunct(next, '[');
          // An object key, interface member or parameter *named* global (`{ global: true }`, `global?: boolean`, `(global: boolean)`).
          const keyBefore = before !== undefined && before.kind === 'punct' && ['{', ',', ';', '('].includes(before.text);
          const key = keyBefore && (isPunct(next, ':') || (isPunct(next, '?') && isPunct(toks[k + 2], ':')));
          if (!declares && !member && !key) {
            add('forbidden-global', t.line, `${t.text} used as a value: an alias or reflection target hides fetch/WebSocket/... from this scan (use ${t.text}.name directly)`);
          }
          break;
        }
        case '_load':
          // Module._load / module.constructor._load: the CommonJS loader, which loads any builtin by a runtime name.
          if (t.afterDot) add('forbidden-global', t.line, 'the CommonJS loader (_load) loads modules by a runtime name');
          break;
        case 'constructor':
          if (t.afterDot) {
            const recvTok = toks[k - 2];
            if (recvTok !== undefined && recvTok.kind === 'ident' && recvTok.text === 'module') {
              add('forbidden-global', t.line, 'module.constructor is the CommonJS loader');
            }
            const chained = recvTok !== undefined && recvTok.kind === 'ident' && recvTok.text === 'constructor' && recvTok.afterDot;
            // `x.constructor('code')`, `x.constructor?.('code')` and `x.constructor.call/apply/bind(...)`: on a function value that is the
            // Function constructor (`Object.constructor`, `fn.constructor`, `[].map.constructor`).
            const after = toks[k + 2];
            const called =
              isPunct(next, '(') ||
              (isPunct(next, '?.') && isPunct(after, '(')) ||
              (isPunct(next, '.') && after !== undefined && after.kind === 'ident' && (after.text === 'call' || after.text === 'apply' || after.text === 'bind'));
            // `new this.constructor(...)` and `new a.b.constructor(...)` build a subclass-aware copy: not a call of the constructor as a function.
            let head = k - 2;
            while (head >= 2 && toks[head]?.kind === 'ident' && (isPunct(toks[head - 1], '.') || isPunct(toks[head - 1], '?.')) && toks[head - 2]?.kind === 'ident') head -= 2;
            const underNew = recvTok !== undefined && recvTok.kind === 'ident' && toks[head - 1]?.kind === 'ident' && toks[head - 1]?.text === 'new';
            if (chained || (called && !underNew)) add('forbidden-global', t.line, 'the Function constructor reached through .constructor defeats static analysis');
          }
          break;
        case 'eval':
          // Any reference, not only a direct call: `(0, eval)(src)` and `const run = eval` are indirect evals.
          if (!t.afterDot || (recv !== undefined && GLOBAL_OBJECT_NAMES.has(recv))) add('forbidden-global', t.line, 'eval defeats static analysis');
          break;
        case 'Function': {
          const before = toks[k - 1];
          const afterNew = before !== undefined && before.kind === 'ident' && before.text === 'new';
          if ((!t.afterDot && (isPunct(next, '(') || afterNew)) || (t.afterDot && recv !== undefined && GLOBAL_OBJECT_NAMES.has(recv))) {
            add('forbidden-global', t.line, 'the Function constructor defeats static analysis');
          } else if (!t.afterDot && before !== undefined && !isPunct(next, '.') && !isPunct(next, '?.') && !isPunct(next, '[')) {
            // `Reflect.construct(Function, ...)`, `const F = Function`: the constructor as a value. Type positions
            // (`: Function`, `as Function`, `<Function>`, `Record<string, Function>`, `type T = Function`, `instanceof Function`)
            // are not value positions, hence the short list of tokens that may precede a value.
            const valueBefore =
              (before.kind === 'punct' && ['(', '=', '||', '&&', '??'].includes(before.text)) || (before.kind === 'ident' && before.text === 'return');
            const typeAlias = isPunct(before, '=') && toks[k - 3]?.kind === 'ident' && toks[k - 3]?.text === 'type';
            if (valueBefore && !typeAlias) add('forbidden-global', t.line, 'Function used as a value (alias, Reflect.construct) defeats static analysis');
          }
          break;
        }
        default:
          break;
      }
      // Native-code loaders and process internals, however they are reached (destructuring, alias, named import).
      if (NATIVE_LOADER_NAMES.has(t.text)) add('forbidden-global', t.line, `reference to ${t.text} (loads native code or exposes process internals)`);
    }
    // devtools only ever run a fixed executable with an argument array; a shell would reintroduce string injection. Every spelling
    // of the option must be `shell: false` exactly: shorthand `{ shell }`, quoted/computed keys, member assignment and expressions fail.
    if (ctx.allowChildProcess && ((t.kind === 'ident' && t.text === 'shell') || (t.kind === 'str' && t.text === 'shell'))) {
      let j = k + 1;
      if (isPunct(toks[j], ']')) j++;
      const value = toks[j + 1];
      const after = toks[j + 2];
      const literalFalse =
        isPunct(toks[j], ':') && value !== undefined && value.kind === 'ident' && value.text === 'false' && (isPunct(after, ',') || isPunct(after, '}'));
      if (!literalFalse) add('child-process-usage', t.line, 'a `shell` option other than the literal `shell: false`');
    }
    // A forbidden member named by a quoted key: `p['binding']` on an alias of process, `const { 'binding': b } = process`,
    // `{ ['dlopen']: d } = process`. The identifier spellings are flagged wherever they appear, so the quoted ones are too.
    if (t.kind === 'str' && (QUOTED_KEY_FORBIDDEN_NAMES.has(t.text) || (t.text === 'binding' && mentionsProcess))) {
      const open = toks[k - 1];
      const beforeOpen = toks[k - 2];
      const subscript =
        isPunct(open, '[') && isPunct(next, ']') && beforeOpen !== undefined &&
        ((beforeOpen.kind === 'ident' && !REGEX_PRECEDING_WORDS.has(beforeOpen.text)) || isPunct(beforeOpen, ')') || isPunct(beforeOpen, ']'));
      const computedKey = isPunct(open, '[') && isPunct(next, ']') && (isPunct(beforeOpen, '{') || isPunct(beforeOpen, ',')) && isPunct(toks[k + 2], ':');
      const quotedKey = (isPunct(open, '{') || isPunct(open, ',')) && isPunct(next, ':');
      if (subscript || computedKey || quotedKey) add('forbidden-global', t.line, `forbidden member ${show(t.text)} named by a quoted key`);
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
  // A server decodes percent-escapes in a path (and a proxy may decode twice), so `/%62ackend-api` names the same endpoint: check the
  // literal as written and after one and two lenient decoding passes.
  const percentDecode = (s: string): string => s.replace(/%([0-9a-f]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  const checkLiteralText = (text: string, line: number): void => {
    const forms = text.includes('%') ? [text, percentDecode(text), percentDecode(percentDecode(text))] : [text];
    for (const form of forms) {
      const lower = form.toLowerCase();
      const needle = FORBIDDEN_LITERALS.find((n) => lower.includes(n.toLowerCase()));
      if (needle !== undefined) {
        add('forbidden-literal', line, `string literal contains a forbidden marker (${needle.length} chars, starts ${show(needle.slice(0, 6))})`);
        return;
      }
    }
  };
  // Literals added together are folded before the check, so splitting a marker over `'a' + 'b'`, `('a') + ('b')` or a
  // `+` followed by a template chunk does not help. Parentheses are transparent; anything else ends the run.
  let run: { text: string; line: number } | null = null;
  let plus = false; // a '+' (possibly followed by parentheses) separates the next literal from `run`
  const flush = (): void => {
    if (run !== null) checkLiteralText(run.text, run.line);
    run = null;
    plus = false;
  };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t === undefined) continue;
    const joined = run !== null && plus;
    // A string, a template without substitution, or the last chunk of a template (its start is dynamic, its end is not).
    const joinable = t.kind === 'str' || (t.kind === 'tmpl' && !t.subst);
    if (joinable) {
      if (run !== null && joined) {
        run.text += t.text;
        plus = false;
      } else {
        flush();
        run = { text: t.text, line: t.line };
      }
    } else if (t.kind === 'tmpl') {
      // A chunk followed by a substitution: the head can still be the right-hand side of a `+`.
      if (run !== null && joined && t.head) run.text += t.text;
      else checkLiteralText(t.text, t.line);
      flush();
    } else if (run !== null && t.kind === 'punct' && t.text === '+') {
      plus = true;
    } else if (run !== null && t.kind === 'punct' && (t.text === '(' || t.text === ')')) {
      // transparent
    } else {
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
/**
 * Real source files are far smaller (the largest in src/ is a few hundred KiB); a bigger one fails the scan instead of being read.
 * The cap is what bounds memory: the tokenizer holds one object per token, ~140x the file size for dense code (a 16 MiB file
 * of `a;a;...` took ~11 s and ~2.2 GB).
 */
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
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

/**
 * Decodes a source file the way this scan can vouch for: UTF-8 only (a BOM is allowed). The TypeScript compiler also
 * decodes BOM-marked UTF-16 files and emits their imports, so a UTF-16 `evil.ts` would be invisible to a UTF-8 text
 * scan while still reaching dist/. Anything that is not clean UTF-8 text (invalid sequences, NUL bytes) fails closed.
 */
function decodeSource(buf: Buffer): string | { problem: string } {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    return { problem: 'not valid UTF-8 (UTF-16 and legacy encodings are decoded by the TypeScript compiler but cannot be audited here)' };
  }
  if (text.includes('\u0000')) return { problem: 'contains NUL characters, so it is not plain UTF-8 text and cannot be audited' };
  return text.replace(/^\uFEFF/, '');
}

/** Scans every source file below `srcRoot`. src/devtools/ is the only place child_process may appear (and only as { execFile }). */
async function scanTree(srcRoot: string): Promise<TreeScan> {
  const files: string[] = [];
  const findings: TreeFinding[] = [];
  await listFiles(srcRoot, '', files, findings);
  for (const file of files) {
    const inDevtools = file.startsWith('devtools/');
    const size = (await stat(join(srcRoot, file))).size;
    if (size > MAX_SOURCE_BYTES) {
      findings.push({ file, rule: 'scanner', line: 0, detail: `source file is ${size} bytes (limit ${MAX_SOURCE_BYTES}); it cannot be audited` });
      continue;
    }
    const decoded = decodeSource(await readFile(join(srcRoot, file)));
    if (typeof decoded !== 'string') {
      findings.push({ file, rule: 'scanner', line: 0, detail: decoded.problem });
      continue;
    }
    const result = scanSource(decoded, { allowChildProcess: inDevtools });
    for (const f of result.findings) findings.push({ ...f, file });
    for (const { spec, line } of result.specifiers) {
      if (!spec.startsWith('.')) continue;
      const resolved = posix.normalize(posix.join(posix.dirname(file), spec));
      // A relative import that leaves the scanned tree loads code this scan never read (scripts/, test/, a sibling checkout).
      if (resolved === '..' || resolved.startsWith('../')) {
        findings.push({ file, rule: 'outside-src', line, detail: `relative import ${show(spec)} resolves outside the scanned source tree` });
      }
      // src/devtools is a dev tool (it may spawn git): the product (SDK, CLI, MCP) must never be able to load it.
      if (!inDevtools && (resolved === 'devtools' || resolved.startsWith('devtools/'))) {
        findings.push({ file, rule: 'devtools-import', line, detail: `product code imports the dev tool ${show(spec)}` });
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
  // npm `overrides` can replace any package in the tree, including an allow-listed one, by an alias or URL.
  const nonRegistry: string[] = [];
  const walkOverrides = (node: unknown, depth: number): void => {
    if (depth > 20) return;
    if (typeof node === 'string') {
      if (/[:/]/.test(node)) nonRegistry.push(node);
    } else if (typeof node === 'object' && node !== null) {
      for (const child of Object.values(node)) walkOverrides(child, depth + 1);
    }
  };
  walkOverrides(record['overrides'], 0);
  if (nonRegistry.length > 0) {
    problems.push(`"overrides" contains non-registry specifier(s) (${nonRegistry.map((v) => show(v)).join(', ')}): an override can swap an allow-listed dependency for different code.`);
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

// ===================================================================================================
// 5. Adversarial regressions (independent review). Each block pins a bypass or false positive that
//    the first version of this scanner got wrong; the comment above each says what the evasion was.
// ===================================================================================================

/** Private-endpoint / cookie markers assembled from fragments so this file never contains them literally. */
const PATH_MARKER = ['/back', 'end-api'].join('');
const CSRF_COOKIE_MARKER = ['__Host-', 'next-auth'].join('');
const summarizeFiles = (scan: TreeScan): string[] => scan.findings.map((f) => `${f.file}:${f.line}:${f.rule}`);

describe('adversarial: U+2028 / U+2029 terminate a // comment (the compiler agrees, a \\n-only scanner does not)', () => {
  for (const [name, ch] of [['U+2028', '\u2028'], ['U+2029', '\u2029']] as const) {
    it(`${name} ends a line comment, so a static import after it is still found`, () => {
      assert.ok(rulesOf(`// harmless${ch}import http from 'node:http';`).includes('forbidden-module'));
    });
    it(`${name} ends a line comment, so a global after it is still found`, () => {
      assert.ok(rulesOf(`export const a = 1; // harmless${ch}await fetch(u);`).includes('forbidden-global'));
    });
    it(`${name} ends a hashbang line`, () => {
      assert.ok(rulesOf(`#!/usr/bin/env node${ch}import http from 'node:http';`).includes('forbidden-module'));
    });
    it(`${name} counts as a line break in reported line numbers`, () => {
      const found = scanSource(`// a${ch}import http from 'node:http';`, NO_CP).findings;
      assert.deepEqual(found.map((f) => [f.rule, f.line]), [['forbidden-module', 2]]);
    });
    it(`${name} inside a string literal is data (allowed since ES2019)`, () => {
      assert.deepEqual(sig(`'a${ch}b' x`), [`s:a${ch}b`, 'i:x']);
    });
    it(`${name} cannot appear inside a regular expression literal (fail closed)`, () => {
      assert.throws(() => tokenize(`x = /a${ch}b/`), (e: unknown) => e instanceof ScanError && /raw U\+202[89]/.test(e.message));
    });
  }
});

describe('adversarial: numeric literals end before a member access', () => {
  it('an exponent literal followed by .member is two tokens', () => {
    assert.deepEqual(sig('1e3.toString()'), ['n:1e3', 'p:.', 'i:toString', 'p:(', 'p:)']);
    assert.deepEqual(sig('1.5e-3.toFixed(1)'), ['n:1.5e-3', 'p:.', 'i:toFixed', 'p:(', 'n:1', 'p:)']);
  });
  it('a BigInt literal followed by .member is two tokens', () => {
    assert.deepEqual(sig('10n.toString()'), ['n:10n', 'p:.', 'i:toString', 'p:(', 'p:)']);
    assert.deepEqual(sig('0xFFn.valueOf()'), ['n:0xFFn', 'p:.', 'i:valueOf', 'p:(', 'p:)']);
  });
  it('an ordinary decimal still takes exactly one dot', () => {
    assert.deepEqual(sig('1.5.toFixed(1)'), ['n:1.5', 'p:.', 'i:toFixed', 'p:(', 'n:1', 'p:)']);
  });
});

describe('adversarial: `of` is an ordinary identifier outside a for-head', () => {
  it('division after a variable named `of` does not start a regex that swallows code', () => {
    const src = 'const of = 4; const z = of / 2; fetch(u); const q = 6 / 3;';
    assert.ok(rulesOf(src).includes('forbidden-global'), JSON.stringify(sig(src)));
  });
  it('a regex after `of` in a for-of head is still a regex', () => {
    assert.deepEqual(sig('for (const x of /"/.exec(s)) y').filter((s) => s.startsWith('r:')), ['r:"']);
    assert.deepEqual(sig('for await (const x of /\'/.exec(s)) y').filter((s) => s.startsWith('r:')), ["r:'"]);
    assert.deepEqual(sig('for (const [a, b] of /"/.exec(s)) y').filter((s) => s.startsWith('r:')), ['r:"']);
  });
});

describe('adversarial: legacy octal escapes decode like the engine (sloppy-mode .js/.cjs)', () => {
  it('decodes \\0nn, \\nn and \\n escapes', () => {
    assert.deepEqual(sig("'\\150\\164tp \\57 \\101\\60 \\8\\9 \\0'"), ['s:http / A0 89 \0']);
  });
  it('an octal-escaped private-endpoint marker is still found', () => {
    assert.ok(rulesOf(`const p = '\\57${PATH_MARKER.slice(1)}';`).includes('forbidden-literal'));
  });
  it('an octal-escaped module specifier is still found', () => {
    assert.ok(rulesOf("const m = require('\\150ttp');").includes('forbidden-module'));
  });
});

describe('adversarial: process / globalThis laundering', () => {
  const positives: ReadonlyArray<readonly [string, string]> = [
    ['destructured binding', "const { binding } = process; binding('tcp_wrap');"],
    ['destructured binding with a rename', "const { binding: b } = process; b('tcp_wrap');"],
    ['named import of binding', "import { binding } from 'node:process';"],
    ['binding called through an alias', "const p = process; p.binding('tcp_wrap');"],
    ['binding called through a default import', "import proc from 'node:process'; proc.binding('tcp_wrap');"],
    ['dlopen through an alias', 'const p = process; p.dlopen(m, f);'],
    ['destructured dlopen', 'const { dlopen } = process;'],
    ['process._linkedBinding', "process._linkedBinding('x');"],
    ['destructured mainModule', 'const { mainModule } = process; mainModule.require(x);'],
    ['globalThis alias', 'const g = globalThis; g.fetch(u);'],
    ['global alias', 'const g = global; g.fetch(u);'],
    ['Reflect.get on globalThis', "Reflect.get(globalThis, 'fetch')(u);"],
    ['property descriptor of globalThis', "Object.getOwnPropertyDescriptor(globalThis, 'fetch');"],
    ['spread of globalThis', 'const copy = { ...globalThis };'],
    ['globalThis passed as an argument', 'inspect(globalThis);'],
    ['global in a ternary', 'const g = ok ? global : other;'],
  ];
  for (const [name, src] of positives) {
    it(`flags: ${name}`, () => {
      assert.ok(rulesOf(src).includes('forbidden-global'), `expected forbidden-global for: ${src}`);
    });
  }
  const negatives: ReadonlyArray<readonly [string, string]> = [
    ['plain member access on process', "process.stdout.write('x'); process.exitCode = 1; const a = process.argv.slice(2);"],
    ['destructuring ordinary members of process', 'const { argv, env, platform } = process;'],
    ['default import of node:process', "import process from 'node:process'; process.exit(1);"],
    ['named imports of ordinary process members', "import { argv, env } from 'node:process';"],
    ['typeof process', "const hasProcess = typeof process !== 'undefined';"],
    ['an object key named process', 'const o = { process: 1 }; o.process;'],
    ['options, members and parameters named global', 'interface Opts { global: boolean; globalThis?: string } function f(global: boolean, other = 1) {} const o = { global: true };'],
    ['member access on globalThis with a literal name', "const c = globalThis.structuredClone(x); const d = globalThis['structuredClone'];"],
    ['typeof globalThis', "const ok = typeof globalThis === 'object';"],
    ['a member called binding on a first-party object (not a call)', 'const b = stmt.binding;'],
    ['the word in comments and strings', "// const { binding } = process; globalThis\nconst s = 'const g = globalThis; p.dlopen(x)';"],
  ];
  for (const [name, src] of negatives) {
    it(`ignores: ${name}`, () => {
      assert.deepEqual(scanSource(src, NO_CP).findings, []);
    });
  }
});

describe('adversarial: Function constructor reached without writing `Function(`', () => {
  const positives: ReadonlyArray<readonly [string, string]> = [
    ['.constructor.constructor', "[].constructor.constructor('return 1')();"],
    ['constructor call on a function expression', "(function () {}).constructor('return 1')();"],
    ['Reflect.construct(Function, ...)', "Reflect.construct(Function, ['return 1']);"],
    ['alias of Function', "const F = Function; new F('return 1');"],
    ['Function as a call argument', "make(Function, 'return 1');"],
  ];
  for (const [name, src] of positives) {
    it(`flags: ${name}`, () => {
      assert.ok(rulesOf(src).includes('forbidden-global'), `expected forbidden-global for: ${src}`);
    });
  }
  const negatives: ReadonlyArray<readonly [string, string]> = [
    ['Function as a type', 'let f: Function | undefined; const g = (h: Function): boolean => h === f;'],
    ['type alias of Function', 'type Handler = Function;'],
    ['Function inside generic arguments and tuple types', 'type R = Record<string, Function>; type T = [number, Function]; type E = Exclude<A[0], Function>;'],
    ['instanceof Function', 'const ok = x instanceof Function;'],
    ['members of Function', 'const s = Function.prototype.toString.call(f);'],
    ['constructor.name for diagnostics', 'const n = err.constructor.name; const m = this.constructor.name;'],
    ['new this.constructor(...) for subclass-aware copies', 'class A { clone() { return new this.constructor(1); } }'],
    ['a class constructor declaration', 'class A { constructor() {} }'],
  ];
  for (const [name, src] of negatives) {
    it(`ignores: ${name}`, () => {
      assert.deepEqual(scanSource(src, NO_CP).findings, []);
    });
  }
});

describe('adversarial: eval and the Function constructor through an alias, an indirect call or the global object', () => {
  const positives: ReadonlyArray<readonly [string, string]> = [
    ['indirect eval (0, eval)(...)', "(0, eval)('1');"],
    ['eval stored in a variable', "const run = eval; run('1');"],
    ['globalThis.eval', "globalThis.eval('1');"],
    ['global?.eval', "global?.eval('1');"],
    ["globalThis['eval']", "globalThis['eval']('1');"],
    ['globalThis.Function', "globalThis.Function('return 1')();"],
    ['new globalThis.Function', "const f = new globalThis.Function('a', 'return a');"],
    ["globalThis['Function']", "globalThis['Function']('return 1')();"],
    ['module.constructor._load (CommonJS loader)', "module.constructor._load('node:http', module, false);"],
    ['a _load call on any receiver', "loader._load('node:http');"],
    ['module.constructor', 'const M = module.constructor;'],
  ];
  for (const [name, src] of positives) {
    it(`flags: ${name}`, () => {
      assert.ok(rulesOf(src).includes('forbidden-global'), `expected forbidden-global for: ${src}`);
    });
  }
  const negatives: ReadonlyArray<readonly [string, string]> = [
    ['a first-party method called eval', "sandbox.eval('x'); db.eval(sql);"],
    ['lookalike identifiers', 'const evaluator = 1; const evaluate = () => 2; const functional = 3;'],
    ['_load as a plain name', 'function _load() {} const load_ = 1; _load();'],
    ['the words in comments and strings', "// eval('x'); globalThis.Function\nconst s = '(0, eval)(1)';"],
  ];
  for (const [name, src] of negatives) {
    it(`ignores: ${name}`, () => {
      assert.deepEqual(scanSource(src, NO_CP).findings, []);
    });
  }
});

describe('adversarial: hostile input cannot make the tokenizer quadratic', () => {
  it('many unterminated \\u{ escapes in one string stay fast', () => {
    const src = `const s = '${'\\u{'.repeat(800000)}';`;
    const started = Date.now();
    scanSource(src, NO_CP);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 3000, `scanning 2.4 MB of \\u{ escapes took ${elapsed} ms`);
  });
  it('a source file above the size cap is refused without being read into memory', async () => {
    await withTempDir(async (dir) => {
      const big = join(dir, 'big.ts');
      await writeFile(big, '');
      await truncate(big, 16 * 1024 * 1024 + 1); // sparse: no disk is used
      assert.deepEqual(summarizeFiles(await scanTree(dir)), ['big.ts:0:scanner']);
    });
  });
});

describe('adversarial: native code through node:sqlite extensions', () => {
  for (const [name, src] of [
    ['loadExtension', "db.loadExtension('/tmp/x.so');"],
    ['enableLoadExtension', 'db.enableLoadExtension(true);'],
    ['allowExtension option', "new DatabaseSync(path, { allowExtension: true });"],
  ] as const) {
    it(`flags ${name}`, () => {
      assert.ok(rulesOf(src).includes('forbidden-global'), `expected forbidden-global for: ${src}`);
    });
  }
});

describe('adversarial: private-endpoint markers beyond the three literal spellings', () => {
  it('a base URL that ends right after the path segment (no trailing slash)', () => {
    assert.ok(rulesOf(`const base = 'https://chat.example.test${PATH_MARKER}';`).includes('forbidden-literal'));
    assert.ok(rulesOf(`const p = new URL('${PATH_MARKER}', host);`).includes('forbidden-literal'));
  });
  it('the __Host- prefixed CSRF cookie name', () => {
    assert.ok(rulesOf(`const c = '${CSRF_COOKIE_MARKER}.csrf-token';`).includes('forbidden-literal'));
    assert.ok(rulesOf(`const c = '__Host-' + 'next-' + 'auth.csrf-token';`).includes('forbidden-literal'));
  });
  it('a pattern that merely names the library (as the privacy scanner does) is not a marker', () => {
    assert.deepEqual(rulesOf("const lib = 'next-auth';"), []);
  });
  it('the documented consumer URL form and unrelated words stay allowed', () => {
    assert.deepEqual(rulesOf("const re = 'https://chatgpt.com/c/<uuid>'; const a = 'backend'; const b = '/api/v1/';"), []);
  });
});

describe('adversarial: src/devtools `shell` option must be literal false in every spelling', () => {
  const exec = "import { execFile } from 'node:child_process';\n";
  const bad: ReadonlyArray<readonly [string, string]> = [
    ['shorthand property', `${exec}const shell = true;\nexecFile('git', [], { shell });`],
    ['quoted key', `${exec}execFile('git', [], { 'shell': true });`],
    ['computed literal key', `${exec}execFile('git', [], { ['shell']: true });`],
    ['member assignment', `${exec}const o = {};\no.shell = true;\nexecFile('git', [], o);`],
    ['false with a fallback expression', `${exec}execFile('git', [], { shell: false || flag });`],
    ['negated number', `${exec}execFile('git', [], { shell: !0 });`],
    ['a shell path', `${exec}execFile('git', [], { shell: '/bin/sh' });`],
    ['conditional', `${exec}execFile('git', [], { shell: ok ? false : true });`],
  ];
  for (const [name, src] of bad) {
    it(`devtools may not: ${name}`, () => {
      assert.ok(rulesOf(src, DEVTOOLS).includes('child-process-usage'), `expected child-process-usage for: ${src}`);
    });
  }
  const good: ReadonlyArray<readonly [string, string]> = [
    ['literal false, last', `${exec}execFile('git', [], { cwd, shell: false });`],
    ['literal false, first', `${exec}execFile('git', [], { shell: false, cwd });`],
    ['literal false, only', `${exec}execFile('git', [], { shell: false });`],
    ['quoted key with literal false', `${exec}execFile('git', [], { 'shell': false });`],
    ['the word in a comment or string', `${exec}// shell: true is forbidden\nconst s = 'shell: true';`],
  ];
  for (const [name, src] of good) {
    it(`devtools may: ${name}`, () => {
      assert.deepEqual(scanSource(src, DEVTOOLS).findings, []);
    });
  }
});

describe('adversarial: source files are scanned as the compiler reads them', () => {
  const body = "import http from 'node:http';\nexport const x = typeof http.get;\n";

  it('refuses UTF-16 sources (the TypeScript compiler decodes a BOM-marked UTF-16 file and emits its imports)', async () => {
    await withTempDir(async (dir) => {
      const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, 'utf16le')]);
      const beBody = Buffer.from(body, 'utf16le');
      beBody.swap16();
      const be = Buffer.concat([Buffer.from([0xfe, 0xff]), beBody]);
      await writeFile(join(dir, 'le.ts'), le);
      await writeFile(join(dir, 'be.ts'), be);
      await writeFile(join(dir, 'nobom.ts'), Buffer.from(body, 'utf16le'));
      assert.deepEqual(summarizeFiles(await scanTree(dir)), ['be.ts:0:scanner', 'le.ts:0:scanner', 'nobom.ts:0:scanner']);
    });
  });

  it('refuses invalid UTF-8 and NUL bytes instead of guessing how the compiler will decode them', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'bad8.ts'), Buffer.from([0x2f, 0x2f, 0x20, 0xc3, 0x28, 0x0a]));
      await writeFile(join(dir, 'nul.ts'), Buffer.from("export const a = 1;\u0000\n", 'utf8'));
      assert.deepEqual(summarizeFiles(await scanTree(dir)), ['bad8.ts:0:scanner', 'nul.ts:0:scanner']);
    });
  });

  it('still accepts plain UTF-8 with or without a BOM, including non-ASCII text', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'bom.ts'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('export const a = 1;\n')]));
      await writeFile(join(dir, 'uni.ts'), 'export const café = "日本語 \u{1f600}";\n');
      assert.deepEqual((await scanTree(dir)).findings, []);
    });
  });
});

describe('adversarial: a relative import may not leave src/ (unscanned code)', () => {
  it('flags imports, re-exports, dynamic imports and require() that resolve outside the scanned tree', async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, 'src', 'a'), { recursive: true });
      await mkdir(join(dir, 'src', 'c'), { recursive: true });
      await mkdir(join(dir, 'src', 'ok'), { recursive: true });
      const files: Record<string, string> = {
        'a/b.ts': "import x from '../../scripts/net.mjs';\nexport const b = x;\n",
        'top.ts': "import y from './../up.js';\nexport const t = y;\n",
        'c/d.ts': "export * from '../../../far.js';\n",
        'c/e.ts': "const m = await import('../../outside/net.js');\n",
        'c/f.cjs': "const m = require('../../x');\n",
        'ok/inside.ts': "import z from '../a/b.js';\nimport w from './sibling.js';\nexport const i = [z, w];\n",
        'ok/sibling.ts': 'export const s = 1;\n',
      };
      for (const [rel, text] of Object.entries(files)) await writeFile(join(dir, 'src', rel), text);
      const scan = await scanTree(join(dir, 'src'));
      assert.deepEqual(summarizeFiles(scan), [
        'a/b.ts:1:outside-src',
        'c/d.ts:1:outside-src',
        'c/e.ts:1:outside-src',
        'c/f.cjs:1:outside-src',
        'top.ts:1:outside-src',
      ]);
    });
  });
});

describe('adversarial: package.json overrides cannot swap an allow-listed dependency', () => {
  const base = { dependencies: { '@modelcontextprotocol/sdk': '1.32.1', zod: '4.6.5' } };
  it('rejects an override that aliases a package to another source', () => {
    for (const spec of ['npm:other@1.0.0', 'https://example.test/z.tgz', 'git+https://example.test/z.git', 'user/repo', 'file:../z']) {
      assert.ok(runtimeDependencyProblems({ ...base, overrides: { zod: spec } }).some((p) => p.includes('overrides')), spec);
    }
  });
  it('rejects a nested override with a non-registry specifier', () => {
    assert.ok(runtimeDependencyProblems({ ...base, overrides: { express: { qs: 'npm:x@1' } } }).some((p) => p.includes('overrides')));
  });
  it('allows version-only overrides (security pins) and absent overrides', () => {
    assert.deepEqual(runtimeDependencyProblems({ ...base, overrides: { qs: '6.13.0', express: { 'path-to-regexp': '^8.2.0' } } }), []);
    assert.deepEqual(runtimeDependencyProblems(base), []);
  });
});

// ---------------------------------------------------------------------------------------------------
// 6. Second adversarial pass. Found by differential testing (tsc 7 emission for every BMP code point; the
//    TypeScript 6 and acorn token streams over ~23,000 real .ts/.js files, which agree with this tokenizer apart
//    from CRLF folding inside template text) and by attack on the rules.
// ---------------------------------------------------------------------------------------------------

/**
 * The 23 code points tsc 7 accepts as whitespace: obtained by compiling `import<cp>("node:http")` for every BMP code
 * point and keeping those whose emit is still a clean dynamic import. A JavaScript `\s` knows 21 of them. U+0085 (NEL)
 * and U+200B (zero width space) are the two it does not, and the compiler prints the module again without them, so
 * `import​('node:http')` compiles to a plain dynamic import while a `\s`-based tokenizer sees a stray symbol.
 */
const TSC_WHITESPACE: readonly string[] = [
  0x0009, 0x000b, 0x000c, 0x0020, 0x0085, 0x00a0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x200b,
  0x202f, 0x205f, 0x3000, 0xfeff,
].map((cp) => String.fromCharCode(cp));
const cpLabel = (ch: string): string => `U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;

describe('adversarial: whitespace the TypeScript compiler accepts is whitespace here too', () => {
  for (const ch of TSC_WHITESPACE) {
    it(`${cpLabel(ch)} separates tokens`, () => {
      assert.deepEqual(sig(`a${ch}b`), ['i:a', 'i:b']);
    });
    it(`${cpLabel(ch)} between import and ( does not hide a dynamic import`, () => {
      assert.ok(rulesOf(`export const m = import${ch}('node:http');`).includes('forbidden-module'));
      assert.ok(rulesOf(`export const m = import${ch}(name);`).includes('dynamic-specifier'));
    });
    it(`${cpLabel(ch)} between from and the specifier does not hide a static import or re-export`, () => {
      assert.ok(rulesOf(`import x from${ch}'node:http';`).includes('forbidden-module'));
      assert.ok(rulesOf(`export *${ch}from${ch}'node:net';`).includes('forbidden-module'));
    });
    it(`${cpLabel(ch)} before ( does not hide require, Function or eval calls`, () => {
      assert.ok(rulesOf(`const m = require${ch}('node:http');`).includes('forbidden-module'));
      assert.ok(rulesOf(`const f = Function${ch}('return 1');`).includes('forbidden-global'));
      assert.ok(rulesOf(`eval${ch}('1');`).includes('forbidden-global'));
    });
  }
  it('whitespace in any of the gaps of a violation never hides it (property)', () => {
    runProperty(
      fc.property(fc.array(fc.constantFrom(...TSC_WHITESPACE), { minLength: 4, maxLength: 4 }), (ws) => {
        const src = `export const m = import${ws[0]}(${ws[1]}'node:http'${ws[2]})${ws[3]};`;
        assert.ok(rulesOf(src).includes('forbidden-module'), JSON.stringify(src));
      }),
    );
  });
  it('U+0085 and U+200B are not line terminators: a // comment runs past them (the compiler agrees), line numbers do not move', () => {
    assert.deepEqual(rulesOf("// note\u0085import x from 'node:http';"), []);
    assert.deepEqual(rulesOf("// note​import x from 'node:http';"), []);
    const found = scanSource("export const a = 1;\u0085​\nimport x from 'node:http';", NO_CP).findings;
    assert.deepEqual(found.map((f) => [f.rule, f.line]), [['forbidden-module', 2]]);
  });
});

describe('adversarial: a private-endpoint marker split across parenthesised literals is still one literal', () => {
  const head = PATH_MARKER.slice(0, 5);
  const tail = PATH_MARKER.slice(5);
  const positives: ReadonlyArray<readonly [string, string]> = [
    ['both halves parenthesised', `const p = ('${head}') + ('${tail}');`],
    ['second half parenthesised', `const p = '${head}' + ('${tail}');`],
    ['first half parenthesised', `const p = ('${head}') + '${tail}';`],
    ['doubly parenthesised', `const p = (('${head}')) + (('${tail}'));`],
    ['whole sum parenthesised', `const p = ('${head}' + '${tail}');`],
    ['line breaks and comments between', `const p = ( '${head}' ) /* x */ +\n  ( // y\n '${tail}' );`],
    ['template chunk with a substitution after the plus', `const p = '${head}' + \`${tail}\${suffix}\`;`],
    ['three parts, the middle one parenthesised', `const p = 'a' + ('${head}') + '${tail}';`],
  ];
  for (const [name, src] of positives) {
    it(`detects: ${name}`, () => {
      assert.ok(rulesOf(src).includes('forbidden-literal'), `expected forbidden-literal for: ${src}`);
    });
  }
  const negatives: ReadonlyArray<readonly [string, string]> = [
    ['two separate statements', `log('${head}'); log('${tail}');`],
    ['array elements', `const l = ['${head}', '${tail}'];`],
    ['call arguments', `f('${head}', '${tail}');`],
    ['two calls added together', `const q = g('${head}') + h('${tail}');`],
    ['a number between', `const q = '${head}' + 1 + '${tail}';`],
  ];
  for (const [name, src] of negatives) {
    it(`ignores: ${name}`, () => {
      assert.deepEqual(rulesOf(src), []);
    });
  }
});

describe('adversarial: percent-encoded private-endpoint markers', () => {
  const encodedB = PATH_MARKER.replace('b', '%62');
  const encodedSlash = `host${PATH_MARKER.replace('/', '%2F')}`;
  const doubleEncoded = PATH_MARKER.replace('b', '%2562');
  for (const [name, text] of [
    ['one letter encoded', `${encodedB}/`],
    ['the slash encoded, upper-case hex', encodedSlash],
    ['lower-case hex', PATH_MARKER.replace('/', '%2f')],
    ['double encoded', `${doubleEncoded}/`],
    ['the whole segment encoded', `/${[...PATH_MARKER.slice(1)].map((c) => `%${c.charCodeAt(0).toString(16)}`).join('')}/`],
  ] as const) {
    it(`detects: ${name}`, () => {
      assert.ok(rulesOf(`const p = '${text}';`).includes('forbidden-literal'), text);
    });
  }
  it('an ordinary percent sign or encoded text is not a marker', () => {
    assert.deepEqual(rulesOf("const a = '100%'; const b = '%41%42'; const c = '50%25 off'; const d = '/a%2Fb';"), []);
  });
});

describe('adversarial: the Function constructor reached through .constructor on a named function', () => {
  const positives: ReadonlyArray<readonly [string, string]> = [
    ['Object.constructor(...)', "Object.constructor('return fetch')()(u);"],
    ['a function value .constructor(...)', "fn.constructor('return 1')();"],
    ['a member chain', "[].map.constructor('return 1')();"],
    ['.constructor.call', "Math.max.constructor.call(null, 'return 1')();"],
    ['.constructor.apply', "Object.constructor.apply(null, ['return 1'])();"],
    ['.constructor.bind', "Object.constructor.bind(null)('return 1')();"],
    ['this.constructor(...) called without new', "this.constructor('return 1');"],
    ['optional call', "fn?.constructor?.('return 1');"],
  ];
  for (const [name, src] of positives) {
    it(`flags: ${name}`, () => {
      assert.ok(rulesOf(src).includes('forbidden-global'), `expected forbidden-global for: ${src}`);
    });
  }
  const negatives: ReadonlyArray<readonly [string, string]> = [
    ['new this.constructor(...)', 'class A { clone() { return new this.constructor(1); } }'],
    ['new on a longer chain', 'const c = new a.b.constructor(1, 2);'],
    ['constructor.name', 'const n = err.constructor.name; const m = Object.getPrototypeOf(x).constructor.name;'],
    ['comparison', 'if (x.constructor === Object || y.constructor !== Array) {}'],
    ['constructor declaration and super call', 'class B extends A { constructor() { super(); } }'],
  ];
  for (const [name, src] of negatives) {
    it(`ignores: ${name}`, () => {
      assert.deepEqual(scanSource(src, NO_CP).findings, []);
    });
  }
});

describe('adversarial: process replacement, the test runner and OpenSSL engines run or load programs without child_process or dlopen', () => {
  for (const [name, src] of [
    ['process.execve', "process.execve('/usr/bin/curl', ['curl', u]);"],
    ['process.execve through an alias', "const p = process; p.execve('/usr/bin/curl', [], {});"],
    ['destructured execve', 'const { execve } = process;'],
    ['node:test run()', "import { run } from 'node:test';"],
    ['node:test through a dynamic import', "const t = await import('node:test');"],
    ['node:test sub-path', "import 'node:test/reporters';"],
    ['node:test via require', "const t = require('node:test');"],
    ['crypto.setEngine', "import { setEngine } from 'node:crypto'; setEngine('/tmp/engine.so', 0);"],
    ['quoted setEngine', "const e = crypto['setEngine'];"],
  ] as const) {
    it(`flags: ${name}`, () => {
      assert.ok(rulesOf(src).length > 0, `expected a finding for: ${src}`);
    });
  }
  it('the words in comments and strings are fine', () => {
    assert.deepEqual(rulesOf("// process.execve, node:test, setEngine\nconst s = 'execve node:test setEngine';"), []);
  });
});

describe('adversarial: forbidden members named by a quoted key', () => {
  const positives: ReadonlyArray<readonly [string, string]> = [
    ['destructuring process with a quoted key', "const { 'binding': b } = process; b('tcp_wrap');"],
    ['quoted key on an alias of process', "const p = process; p['binding']('tcp_wrap');"],
    ['computed literal key in a pattern', "const { ['dlopen']: d } = process;"],
    ['quoted key getBuiltinModule', "const g = loader['getBuiltinModule']('node:http');"],
    ['quoted key WebSocket', "const W = host['WebSocket'];"],
    ['quoted key in an object literal', "const o = { 'createRequire': make };"],
    ['quoted execve', "const x = proc['execve'];"],
  ];
  for (const [name, src] of positives) {
    it(`flags: ${name}`, () => {
      assert.ok(rulesOf(src).includes('forbidden-global'), `expected forbidden-global for: ${src}`);
    });
  }
  const negatives: ReadonlyArray<readonly [string, string]> = [
    ['an unrelated quoted key', "const o = { 'content-type': 1 }; const b = o['name'];"],
    ['binding as a quoted key in a file that never mentions process', "const o = { 'binding': 1 }; const b = o['binding'];"],
    ['a longer word', "const n = row['WebSocketCount'] + row['fetchedAt'];"],
    ['a plain string that is not a key', "const kind = 'WebSocket'; const label = 'dlopen';"],
    ['a quoted fetch key on a first-party object (member fetch is allowed too)', "const f = repo['fetch'];"],
  ];
  for (const [name, src] of negatives) {
    it(`ignores: ${name}`, () => {
      assert.deepEqual(scanSource(src, NO_CP).findings, []);
    });
  }
});

describe('adversarial: the source size cap bounds the scanner memory', () => {
  // A 16 MiB file of `a;a;a;...` needed ~11 s and ~2.2 GB of resident memory (one token object per two bytes) before the cap was lowered.
  it('refuses a source just over the cap even though it is valid text (it is not read into memory)', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'big.ts'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
      assert.deepEqual(summarizeFiles(await scanTree(dir)), ['big.ts:0:scanner']);
    });
  });
  it('accepts a 2 MiB source (the cap is inclusive)', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'edge.ts'), `// ${'a'.repeat(2 * 1024 * 1024 - 4)}\n`);
      assert.deepEqual((await scanTree(dir)).findings, []);
    });
  });
});

/** Packages and builtins the allowed SDK subpaths may import (checked against the installed SDK below). Anything else is a decision to review. */
const SDK_REACHABLE_EXTERNALS: ReadonlySet<string> = new Set(['ajv', 'ajv-formats', 'zod', 'zod-to-json-schema', 'node:process']);

/** Follows relative imports from the entry file of each allowed SDK subpath and returns the files read and the non-relative specifiers met. */
async function sdkImportClosure(sdkRoot: string): Promise<{ files: string[]; externals: Map<string, string>; problems: string[] }> {
  const pkg = JSON.parse(await readFile(join(sdkRoot, 'package.json'), 'utf8')) as { exports?: Record<string, { import?: string }> };
  const entryOf = (sub: string): string | undefined => {
    const exact = pkg.exports?.[sub === '' ? '.' : `./${sub}`]?.import;
    return exact ?? pkg.exports?.['./*']?.import?.replace('*', `${sub}.js`);
  };
  const files = new Set<string>();
  const externals = new Map<string, string>();
  const problems: string[] = [];
  const visit = async (abs: string, via: string): Promise<void> => {
    if (files.has(abs)) return;
    files.add(abs);
    let text: string;
    try {
      text = await readFile(abs, 'utf8');
    } catch {
      problems.push(`${via}: ${abs} cannot be read`);
      return;
    }
    const scan = scanSource(text, NO_CP);
    for (const f of scan.findings) {
      if (f.rule === 'scanner' || f.rule === 'dynamic-specifier') problems.push(`${abs.slice(sdkRoot.length)}:${f.line} [${f.rule}] ${f.detail}`);
    }
    for (const { spec } of scan.specifiers) {
      if (spec.startsWith('.')) await visit(join(dirname(abs), spec), abs.slice(sdkRoot.length));
      else if (!externals.has(spec)) externals.set(spec, abs.slice(sdkRoot.length));
    }
  };
  for (const sub of MCP_SDK_ALLOWED_SUBPATHS) {
    const target = entryOf(sub);
    const abs = target === undefined ? undefined : join(sdkRoot, target);
    // The package root is listed but the installed SDK ships no dist/esm/index.js: importing it fails, so there is nothing to follow.
    if (abs === undefined || (sub === '' && !existsSync(abs))) continue;
    await visit(abs, `allowed subpath ${show(sub)}`);
  }
  return { files: [...files], externals, problems };
}

describe('repository: the allowed MCP SDK subpaths reach no network code (allow-list soundness)', () => {
  const sdkRoot = join(findRepoRoot(), 'node_modules', '@modelcontextprotocol', 'sdk');
  let closure: Awaited<ReturnType<typeof sdkImportClosure>>;
  before(async () => {
    closure = await sdkImportClosure(sdkRoot);
  });

  it('actually followed the SDK (guards against a vacuous pass)', () => {
    assert.ok(closure.files.length >= 15, `only ${closure.files.length} SDK files followed`);
    assert.ok(closure.files.some((f) => f.endsWith('/server/mcp.js')), 'server/mcp.js must be among them');
  });
  it('every file followed is readable and every import in it is a literal', () => {
    assert.deepEqual(closure.problems, []);
  });
  it('imports no network, process-spawning or code-loading module, nor any package outside the reviewed set', () => {
    const bad: string[] = [];
    for (const [spec, file] of closure.externals) {
      const verdict = checkSpecifier(spec, NO_CP);
      const pkg = spec.startsWith('node:') ? spec : packageNameOf(spec);
      if (verdict !== null && verdict.rule === 'forbidden-module') bad.push(`${file} imports ${show(spec)}: ${verdict.detail}`);
      else if (!SDK_REACHABLE_EXTERNALS.has(pkg)) bad.push(`${file} imports ${show(spec)}: not in SDK_REACHABLE_EXTERNALS, review it and extend the set deliberately`);
    }
    assert.deepEqual(bad, []);
  });
  it('the check can fail: a network-capable SDK subpath reaches a forbidden module', async () => {
    // The HTTP transport is exactly what the allow-list keeps out; following it must surface node:http (or a forbidden package).
    const probe = await withTempDir(async (dir) => {
      await mkdir(join(dir, 'dist', 'esm', 'server'), { recursive: true });
      await writeFile(join(dir, 'package.json'), JSON.stringify({ exports: { './*': { import: './dist/esm/*' } } }));
      await writeFile(join(dir, 'dist', 'esm', 'server', 'index.js'), "import './transport.js';\n");
      await writeFile(join(dir, 'dist', 'esm', 'server', 'transport.js'), "import http from 'node:http';\nexport const s = http;\n");
      await writeFile(join(dir, 'dist', 'esm', 'server', 'mcp.js'), "export const m = 1;\n");
      return sdkImportClosure(dir);
    });
    assert.ok(probe.externals.has('node:http'));
    assert.equal(checkSpecifier('node:http', NO_CP)?.rule, 'forbidden-module');
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
