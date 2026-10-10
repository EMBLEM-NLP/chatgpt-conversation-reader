/**
 * Privacy scanner: ADVERSARIAL review of the pure rules (scanContent / scanPaths / parseAllowFile).
 *
 * Every case here was a false negative (a leak the scanner did not flag), a crash, or a complexity bug when the
 * review began; each assertion pins the corrected behaviour. All secret-shaped text is assembled at run time from
 * fragments so this file contains none and passes the scanner it tests.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_FINDINGS_PER_FILE, SYNTHETIC_MARKER, parseAllowFile, scanContent, scanPaths } from '../../src/devtools/privacy-scan.js';

const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const HEX = '0123456789abcdef';

function rnd(length: number, seed: number, alphabet: string = B62): string {
  let s = (seed * 2654435761) >>> 0;
  let out = '';
  for (let i = 0; i < length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out += alphabet[(s >>> 16) % alphabet.length] ?? '';
  }
  return out;
}
const join = (...parts: string[]): string => parts.join('');
const rules = (path: string, content: string): string[] => scanContent(path, content).map((f) => f.rule);
const pathRules = (path: string, allow?: string[]): string[] => scanPaths([path], allow === undefined ? {} : { allow }).map((f) => f.rule);
function uuid(seed: number): string {
  const h = rnd(32, seed, HEX);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const CHATGPT = join('chat', 'gpt.com');
const OPENAI_CHAT = join('chat.open', 'ai.com');
const CLEARANCE = join('cf_', 'clearance');
const PUID = join('_pu', 'id');
const DID = join('oai-', 'did');
const DEVICE_ID = join('oai-device', '-id');
const BS = '\\'; // one backslash

describe('escaped quotes: JSON inside JSON, and header text inside string literals', () => {
  const token = rnd(40, 1, `${B62}._-`);

  it('finds an Authorization bearer token whose quotes are backslash-escaped', () => {
    for (const line of [
      `{"headers":"{${BS}"Authorization${BS}": ${BS}"Bearer ${token}${BS}"}"}`,
      `const h = "{${BS}"authorization${BS}":${BS}"bearer ${token}${BS}"}";`,
      `{"h":"{${BS}${BS}"Authorization${BS}${BS}": ${BS}${BS}"Bearer ${token}${BS}${BS}"}"}`,
      `curl -H ${BS}"Authorization: Bearer ${token}${BS}" https://example.invalid`,
    ]) {
      assert.deepEqual(rules('src/a.ts', line), ['bearer-token'], line);
    }
  });

  it('finds an escaped Cookie / Set-Cookie header value', () => {
    const value = rnd(24, 2);
    assert.deepEqual(rules('a.json', `{"h":"{${BS}"Cookie${BS}": ${BS}"sid=${value}${BS}"}"}`), ['cookie-header']);
    assert.deepEqual(rules('a.json', `{"h":"{${BS}"Set-Cookie${BS}":${BS}"sid=${value}; Path=/${BS}"}"}`), ['cookie-header']);
  });

  it('finds an escaped device-id assignment', () => {
    assert.deepEqual(rules('a.json', `{"h":"{${BS}"${DID}${BS}":${BS}"${uuid(3)}${BS}"}"}`), ['device-id']);
  });

  it('finds a conversation URL whose slashes are escaped (PHP-style JSON)', () => {
    const escaped = `https:${BS}/${BS}/${CHATGPT}${BS}/c${BS}/${uuid(4)}`;
    assert.deepEqual(rules('a.json', `{"u":"${escaped}"}`), ['chatgpt-conversation-url']);
  });

  it('keeps ignoring escaped placeholders', () => {
    for (const line of [
      `{"h":"{${BS}"Authorization${BS}": ${BS}"Bearer <token>${BS}"}"}`,
      `{"h":"{${BS}"Cookie${BS}": ${BS}"sid=\${value}${BS}"}"}`,
      `{"u":"https:${BS}/${BS}/${CHATGPT}${BS}/c${BS}/<uuid>"}`,
    ]) {
      assert.deepEqual(rules('a.json', line), [], line);
    }
  });

  it('does not take quadratic time on very long backslash runs', () => {
    const start = process.hrtime.bigint();
    scanContent('a.txt', `${BS.repeat(300_000)}x ${BS.repeat(300_000)}`);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 3000, `${ms.toFixed(0)} ms`);
  });
});

describe('cookie header values in quotes', () => {
  it('flags a double-quoted cookie value (RFC 6265 allows DQUOTE-wrapped values)', () => {
    const v = rnd(30, 5);
    assert.deepEqual(rules('a.txt', `Cookie: session="${v}"`), ['cookie-header']);
    assert.deepEqual(rules('a.txt', `Set-Cookie: sid="${v}"; Path=/; HttpOnly`), ['cookie-header']);
    assert.deepEqual(rules('a.txt', `Cookie: session='${v}'`), ['cookie-header']);
  });
  it('still ignores empty and placeholder quoted values', () => {
    for (const line of ['Cookie: sid=""', 'Cookie: sid="${token}"', 'Cookie: sid="<value>"', 'Set-Cookie: sid="{{ value }}"']) {
      assert.deepEqual(rules('a.txt', line), [], line);
    }
  });
});

describe('cookie-jar exports (Playwright / browser extensions / Netscape / dict literals)', () => {
  const names = [CLEARANCE, PUID, DID, DEVICE_ID];

  it('flags JSON cookie objects by cookie name even when the value is on another line', () => {
    for (const name of names) {
      assert.deepEqual(rules('state/dump.json', `{"name":"${name}","value":"${rnd(40, 6)}","domain":".${CHATGPT}"}`), ['cookie-jar-entry'], name);
      assert.deepEqual(rules('state/dump.json', `      "name": "${name}",\n      "value": "${rnd(40, 7)}",`), ['cookie-jar-entry'], name);
      assert.deepEqual(rules('state/dump.js', `{ 'name': '${name}', 'value': 'x' }`), ['cookie-jar-entry'], name);
    }
  });

  it('flags a Netscape cookies.txt line (name TAB value)', () => {
    for (const name of names) {
      const line = `.${CHATGPT}\tTRUE\t/\tTRUE\t1893456000\t${name}\t${rnd(40, 8)}`;
      assert.deepEqual(rules('jar/export.txt', line), ['cookie-jar-entry'], name);
    }
  });

  it('flags a quoted-key dict entry with a quoted value', () => {
    for (const name of [CLEARANCE, PUID]) {
      assert.deepEqual(rules('a.py', `cookies = {"${name}": "${rnd(40, 9)}"}`), ['cookie-jar-entry'], name);
    }
  });

  it('never prints the cookie value', () => {
    const value = rnd(40, 10);
    for (const f of scanContent('a.txt', `.${CHATGPT}\tTRUE\t/\tTRUE\t1893456000\t${CLEARANCE}\t${value}`)) {
      assert.ok(!f.detail.includes(value.slice(0, 5)), f.detail);
    }
  });

  it('ignores prose, unrelated cookies, identifiers and short or unquoted values', () => {
    for (const line of [
      `the ${CLEARANCE} cookie is set by a CDN`,
      '{"name":"theme","value":"dark"}',
      `${PUID}: string;`,
      `${CLEARANCE}: process.env.VALUE,`,
      `const ${PUID}Count = 3;`,
      `x${CLEARANCE}\tabcdefghijklmnop`,
      `${CLEARANCE}\tshort`,
      `{"name":"${CLEARANCE}x","value":"1"}`,
    ]) {
      assert.deepEqual(rules('a.txt', line), [], line);
    }
  });
});

describe('conversation URLs without a scheme', () => {
  it('flags host/c/<uuid> written without http(s)://, including www and the legacy host', () => {
    assert.deepEqual(rules('README.md', `see ${CHATGPT}/c/${uuid(11)} for details`), ['chatgpt-conversation-url']);
    assert.deepEqual(rules('README.md', `www.${CHATGPT}/c/${uuid(12)}`), ['chatgpt-conversation-url']);
    assert.deepEqual(rules('README.md', `(${OPENAI_CHAT}/c/${uuid(13)})`), ['chatgpt-conversation-url']);
    assert.deepEqual(rules('README.md', `${CHATGPT}/g/g-${rnd(9, 14)}/c/${uuid(15)}`), ['chatgpt-conversation-url']);
    assert.deepEqual(rules('README.md', `next=${CHATGPT}/c/${uuid(16)}`), ['chatgpt-conversation-url']);
  });
  it('allows the reference, synthetic and nil ids, and ignores look-alike hosts and placeholders', () => {
    for (const line of [
      `${CHATGPT}/c/6ac95b6e-9fa0-83e8-bbb0-8107079a8720`,
      `${CHATGPT}/c/00000000-0000-4000-8000-0123456789ab`,
      `${CHATGPT}/c/00000000-0000-0000-0000-000000000000`,
      `${CHATGPT}/c/<uuid>`,
      `not${CHATGPT}/c/${uuid(17)}`,
      `${CHATGPT}.example.org/c/${uuid(18)}`,
      `${CHATGPT}/share/${uuid(19)}`,
    ]) {
      assert.deepEqual(rules('README.md', line), [], line);
    }
  });
});

describe('complexity and volume', () => {
  it('stays linear when a single huge line yields tens of thousands of overlapping matches', () => {
    // Every 80-character token is reported by the key rule AND is a blob candidate, so each candidate used to be
    // compared with every earlier match (8 MiB took about 30 s).
    const token = join('sk-', rnd(77, 20));
    const input = `${token} `.repeat(Math.floor((8 * 1024 * 1024) / 81));
    const start = process.hrtime.bigint();
    const found = scanContent('src/minified.js', input);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(found.length >= 1);
    assert.ok(ms < 5000, `${ms.toFixed(0)} ms for ${input.length} characters`);
  });

  it('keeps one finding per overlapping secret (the blob rule still yields to the key rule)', () => {
    const token = join('sk-', rnd(100, 21));
    assert.deepEqual(rules('src/a.ts', `x ${token} y`), ['openai-api-key']);
  });

  it('caps the findings reported for one file and says so', () => {
    const lines = Array.from({ length: MAX_FINDINGS_PER_FILE * 3 }, (_, i) => join('AKIA', rnd(16, 1000 + i, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')));
    const found = scanContent('src/many.txt', lines.join('\n'));
    assert.equal(found.length, MAX_FINDINGS_PER_FILE + 1);
    const last = found.filter((f) => f.rule === 'too-many-findings');
    assert.equal(last.length, 1);
    assert.equal(last[0]?.path, 'src/many.txt');
    assert.match(last[0]?.detail ?? '', /further findings in this file were not listed/);
  });
});

describe('linear-time matching for the rules added by the review (ReDoS)', () => {
  const N = 200_000;
  const hostile: Record<string, string> = {
    'name field then whitespace': join('"name"', ' '.repeat(N), 'x'),
    'name field, colon, whitespace': join('"name":', ' '.repeat(N)),
    'repeated name fields': '"name":"'.repeat(N / 8),
    'netscape name then one long run': join(CLEARANCE, '\t', 'a'.repeat(N)),
    'repeated netscape heads': join(CLEARANCE, '\t').repeat(N / 14),
    'quoted pair then whitespace': join('"', CLEARANCE, '":', ' '.repeat(N), '"'),
    'repeated quoted cookie starts': 'Cookie: a="'.repeat(N / 11),
    'repeated schemes': 'https://'.repeat(N / 8),
    'repeated hosts with a GPT prefix': join(CHATGPT, '/g/a').repeat(N / 16),
    'repeated scheme-less URL heads': join('www.', CHATGPT, '/c/').repeat(N / 20),
    'alternating escaped quotes': `${BS}"`.repeat(N / 2),
    'long backslash runs closed by a quote': `${BS.repeat(50)}"`.repeat(N / 51),
  };
  for (const [label, input] of Object.entries(hostile)) {
    it(`stays fast on: ${label}`, () => {
      const start = process.hrtime.bigint();
      scanContent('src/hostile.txt', input);
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      assert.ok(ms < 3000, `${label} took ${ms.toFixed(0)} ms for ${input.length} characters`);
    });
  }
});

describe('path rules: renamed and sidecar copies of private data', () => {
  it('flags SQLite sidecars of .sqlite3 databases and rollback journals', () => {
    for (const ext of ['.sqlite3-wal', '.sqlite3-shm', '.db-journal', '.sqlite-journal', '.sqlite3-journal']) {
      assert.deepEqual(pathRules(`data/chats${ext}`), ['forbidden-extension'], ext);
      assert.deepEqual(pathRules(`DATA/CHATS${ext.toUpperCase()}`), ['forbidden-extension'], ext);
    }
  });

  it('flags the other common compressed-archive extensions', () => {
    for (const ext of ['.xz', '.bz2', '.zst', '.tbz', '.tbz2', '.txz']) {
      assert.deepEqual(pathRules(`backup/export${ext}`), ['forbidden-extension'], ext);
    }
    assert.deepEqual(pathRules('export.tar.xz'), ['forbidden-extension']);
  });

  it('flags log files (SPEC FR-08 lists logs next to exports, databases and secrets)', () => {
    for (const p of ['app.log', 'logs/server.LOG', 'a/b/npm-debug.log']) assert.deepEqual(pathRules(p), ['forbidden-extension'], p);
    for (const p of ['catalog.md', 'src/logger.ts', 'log', 'docs/log.md', 'blog.html']) assert.deepEqual(pathRules(p), [], p);
  });

  it('flags Netscape cookie-jar file names', () => {
    for (const p of ['cookies.txt', 'cookie.txt', 'tools/Cookies.TXT']) assert.deepEqual(pathRules(p), ['forbidden-filename'], p);
    for (const p of ['cookies.txt.md', 'my-cookies.txt', 'cookies.ts']) assert.deepEqual(pathRules(p), [], p);
  });

  it('sees through a backup/copy suffix: the copy holds the same private data', () => {
    const cases: Array<[string, string]> = [
      ['chats.sqlite.bak', 'forbidden-extension'],
      ['data/chats.DB.old', 'forbidden-extension'],
      ['Backup.ZIP.copy', 'forbidden-extension'],
      ['user.json.bak', 'forbidden-filename'],
      ['a/cookies.json~', 'forbidden-filename'],
      ['auth.json.orig', 'forbidden-filename'],
      ['session.json.backup', 'forbidden-filename'],
      ['conversations.json.bak', 'export-file-outside-fixtures'],
      ['src/conversations-001.json.old', 'export-file-outside-fixtures'],
    ];
    for (const [p, rule] of cases) assert.deepEqual(pathRules(p), [rule], p);
    for (const p of ['notes.bak', 'readme.md.bak', 'src/dbutil.ts~', 'user.json.bak.md', 'users.json.bak', 'plain.old']) assert.deepEqual(pathRules(p), [], p);
  });

  it('does not let an allow-list entry for a file cover its backup copy', () => {
    assert.deepEqual(pathRules('fixtures/user.json.bak', ['fixtures/user.json']), ['forbidden-filename']);
  });

  it('flags browser-style duplicate names of the raw export', () => {
    for (const p of ['conversations (1).json', 'Downloads/conversations_2.json', 'a/conversations-3.json', 'conversations (12).JSON']) {
      assert.deepEqual(pathRules(p), ['export-file-outside-fixtures'], p);
    }
    for (const p of ['conversations (a).json', 'conversations_.json', 'conversations (1) copy.json', 'conversations2x.json', 'conversations ().json']) {
      assert.deepEqual(pathRules(p), [], p);
    }
    assert.deepEqual(pathRules('fixtures/conversations (1).json'), []); // tolerated under fixtures/ (content rules require the marker)
  });

  it('flags anything inside the local GCR data directory (.gcr/ is the .gitignore-d private store)', () => {
    for (const p of ['.gcr/index.dat', 'a/.gcr/notes.md', '.GCR/drafts/1.txt']) assert.deepEqual(pathRules(p), ['private-data-directory'], p);
    for (const p of ['gcr/index.dat', '.gcrc', 'x.gcr/a.txt', 'src/.gcr', 'docs/gcr.md']) assert.deepEqual(pathRules(p), [], p);
  });
});

describe('export-shaped data that is not named like an export', () => {
  const chatgpt = '[{"title":"private chat","mapping":{"a":{"id":"a","message":null,"parent":null,"children":[]}},"current_node":"a","create_time":1.5}]';
  const claude = '[{"uuid":"u","name":"private chat","chat_messages":[{"uuid":"m","text":"hello","sender":"human"}]}]';
  const marked = (text: string): string => text.replace('private chat', `${SYNTHETIC_MARKER} chat`);

  it('requires the synthetic marker for export-shaped JSON anywhere under fixtures/', () => {
    for (const path of ['fixtures/chatgpt/real-history.json', 'fixtures/claude/me.json', 'fixtures/x/y/z.jsonl', 'fixtures/notes.txt']) {
      for (const body of [chatgpt, claude]) {
        assert.deepEqual(rules(path, body), ['synthetic-marker-missing'], path);
        assert.deepEqual(rules(path, marked(body)), [], path);
      }
    }
  });

  it('flags unmarked export-shaped data outside fixtures/ too, in any data-like file name', () => {
    for (const path of ['data/history.json', 'history', 'my-chats.txt', 'dump.dat', 'chats.json.bak', 'exports2/a.ndjson']) {
      assert.deepEqual(rules(path, chatgpt), ['synthetic-marker-missing'], path);
    }
    assert.deepEqual(rules('data/history.json', marked(chatgpt)), []);
  });

  it('leaves source code, docs and configuration that merely mention the keys alone', () => {
    for (const path of ['src/ingest/registry.ts', 'test/a.test.ts', 'docs/ARCHITECTURE.md', 'README.md', '.github/workflows/ci.yml', 'scripts/x.mjs', 'src/a.tsx']) {
      assert.deepEqual(rules(path, chatgpt), [], path);
      assert.deepEqual(rules(path, claude), [], path);
    }
  });

  it('does not treat a lone generic key as an export', () => {
    for (const body of ['{"mapping":{"a":1}}', '{"uuid":"x","name":"y"}', '{"chat_messages":[]}', '{"current_node":"x"}']) {
      assert.deepEqual(rules('data/a.json', body), [], body);
    }
  });
});

describe('allow-file parsing: editor artefacts', () => {
  it('ignores a UTF-8 byte-order mark in front of the first entry instead of silently dropping that entry', () => {
    const { entries, findings } = parseAllowFile('﻿fixtures/user.json\ndocs/a.md\n');
    assert.deepEqual([...entries].sort(), ['docs/a.md', 'fixtures/user.json']);
    assert.deepEqual(findings, []);
  });
  it('a BOM does not turn the first line into a comment or a path with an invisible character', () => {
    const { entries } = parseAllowFile('﻿# comment\nx/y.json\n');
    assert.deepEqual([...entries], ['x/y.json']);
  });
});
