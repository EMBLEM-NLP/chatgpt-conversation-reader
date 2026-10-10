/**
 * Privacy scanner, CONTENT rules (scanContent), masking and linear-time behaviour.
 *
 * Everything that looks like a secret is assembled at run time from fragments (see `rnd`, `join`), so this file
 * itself contains no secret-shaped literal and passes the scanner it tests.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { CONTENT_RULE_IDS, CONTENT_RULE_SOURCES, FIXTURE_MAX_BYTES, SYNTHETIC_MARKER, maskSecret, scanContent } from '../../src/devtools/privacy-scan.js';
import type { Finding } from '../../src/devtools/privacy-scan.js';

// Fixed seed so a failure reproduces; fast-check prints the counterexample and this seed.
const PROPERTY_SEED = 20261015;

const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const B64 = `${B62}+/`;
const HEX = '0123456789abcdef';

/** Deterministic pseudo-random string over `alphabet` (LCG); different seeds give unrelated strings. */
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
const only = (path: string, content: string): Finding[] => scanContent(path, content);

function uuid(seed: number): string {
  const h = rnd(32, seed, HEX);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const CHATGPT = join('chat', 'gpt.com');
const OPENAI_CHAT = join('chat.open', 'ai.com');
const REFERENCE_ID = join('6ac95b6e', '-9fa0-83e8-', 'bbb0-8107079a8720');

describe('pem-private-key', () => {
  const header = (kind: string): string => join('-----', 'BEGIN ', kind, 'PRIVATE KEY', '-----');
  it('flags every common private-key header, with its line number', () => {
    for (const kind of ['', 'RSA ', 'EC ', 'DSA ', 'OPENSSH ', 'ENCRYPTED ']) {
      const found = only('src/k.txt', `line one\nline two\n${header(kind)}\nMIIE...\n`);
      assert.deepEqual(found.map((f) => [f.rule, f.line]), [['pem-private-key', 3]], kind);
    }
    assert.deepEqual(rules('x.txt', join('-----', 'BEGIN PGP ', 'PRIVATE KEY', ' BLOCK-----')), ['pem-private-key']);
  });
  it('ignores public material and prose', () => {
    for (const text of [join('-----', 'BEGIN CERTIFICATE', '-----'), join('-----', 'BEGIN PUBLIC KEY', '-----'), 'a private key is stored elsewhere', join('-----', 'BEGIN PRIVATE KEYS', '-----')]) {
      assert.deepEqual(rules('x.txt', text), [], text);
    }
  });
});

describe('openai-api-key', () => {
  it('flags sk- and sk-proj- keys with at least 20 key characters', () => {
    assert.deepEqual(rules('a.ts', `const k = '${join('sk-', rnd(48, 1))}';`), ['openai-api-key']);
    assert.deepEqual(rules('a.ts', join('sk-proj-', rnd(60, 2, `${B62}_-`))), ['openai-api-key']);
    assert.deepEqual(rules('a.ts', join('sk-', 'A'.repeat(20))), ['openai-api-key']);
    assert.deepEqual(rules('a.ts', `OPENAI_API_KEY=${join('sk-', rnd(40, 3))}`), ['openai-api-key']);
  });
  it('ignores short keys and words that merely end in "sk-"', () => {
    assert.deepEqual(rules('a.ts', join('sk-', 'A'.repeat(19))), []);
    assert.deepEqual(rules('a.ts', join('sk-proj-', 'A'.repeat(12))), []);
    assert.deepEqual(rules('a.ts', join('ta', 'sk-', rnd(40, 4))), []);
    assert.deepEqual(rules('a.ts', join('ri', 'sk-', rnd(40, 5))), []);
    assert.deepEqual(rules('a.ts', 'sk-learn is a library'), []);
  });
});

describe('github-token', () => {
  it('flags ghp_/gho_/ghu_/ghs_/ghr_ and github_pat_', () => {
    for (const p of ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_']) {
      assert.deepEqual(rules('a.md', `token ${p}${rnd(36, 6)}`), ['github-token'], p);
    }
    assert.deepEqual(rules('a.md', join('github', '_pat_', rnd(22, 7), '_', rnd(59, 8))), ['github-token']);
  });
  it('ignores short, unknown-prefix and embedded look-alikes', () => {
    assert.deepEqual(rules('a.md', join('ghp_', rnd(10, 9))), []);
    assert.deepEqual(rules('a.md', join('ghx_', rnd(40, 10))), []);
    assert.deepEqual(rules('a.md', join('xghp_', rnd(40, 11))), []);
    assert.deepEqual(rules('a.md', join('github', '_pat_', rnd(8, 12))), []);
  });
});

describe('aws-access-key-id', () => {
  it('flags AKIA and ASIA ids of exactly 20 characters', () => {
    assert.deepEqual(rules('a.env.md', join('AKIA', rnd(16, 13, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'))), ['aws-access-key-id']);
    assert.deepEqual(rules('a.md', `id: ${join('ASIA', 'B'.repeat(16))}, next`), ['aws-access-key-id']);
  });
  it('ignores wrong lengths, lower case and embedded ids', () => {
    assert.deepEqual(rules('a.md', join('AKIA', 'B'.repeat(15))), []);
    assert.deepEqual(rules('a.md', join('AKIA', 'B'.repeat(17))), []);
    assert.deepEqual(rules('a.md', join('akia', 'b'.repeat(16))), []);
    assert.deepEqual(rules('a.md', join('X', 'AKIA', 'B'.repeat(16))), []);
  });
});

describe('slack-token', () => {
  it('flags xox[baprs]- tokens', () => {
    for (const k of 'baprs') assert.deepEqual(rules('a.md', join('xox', k, '-', rnd(12, 14), '-', rnd(12, 15))), ['slack-token'], k);
  });
  it('ignores other letters and short tokens', () => {
    assert.deepEqual(rules('a.md', join('xox', 'z-', rnd(20, 16))), []);
    assert.deepEqual(rules('a.md', join('xox', 'b-', 'abc')), []);
  });
});

describe('jwt', () => {
  const seg = (seed: number, n = 24): string => join('eyJ', rnd(n, seed, `${B62}_-`));
  it('flags three base64url segments starting with eyJ', () => {
    assert.deepEqual(rules('a.md', `${seg(17)}.${seg(18)}.${rnd(43, 19, `${B62}_-`)}`), ['jwt']);
    assert.deepEqual(rules('a.md', `Bearer-less: "${seg(20)}.${seg(21)}.${rnd(10, 22)}"`), ['jwt']);
  });
  it('ignores two-segment strings, short segments and non-eyJ payloads', () => {
    assert.deepEqual(rules('a.md', `${seg(23)}.${seg(24)}`), []);
    assert.deepEqual(rules('a.md', `${seg(25, 2)}.${seg(26, 2)}.abc`), []);
    assert.deepEqual(rules('a.md', `${seg(27)}.${rnd(24, 28)}.${rnd(24, 29)}`), []);
  });
});

describe('bearer-token', () => {
  it('flags Authorization: Bearer headers in several spellings', () => {
    const token = rnd(40, 30, `${B62}._-`);
    for (const line of [
      `Authorization: Bearer ${token}`,
      `authorization:bearer ${token}`,
      `"Authorization": "Bearer ${token}"`,
      `headers = { 'Authorization': 'Bearer ${token}' }`,
      `AUTHORIZATION = Bearer ${token}`,
    ]) {
      assert.deepEqual(rules('a.md', line), ['bearer-token'], line);
    }
  });
  it('ignores placeholders, other schemes, short tokens and bare Bearer words', () => {
    const token = rnd(40, 31);
    for (const line of [
      'Authorization: Bearer <token>',
      'Authorization: Bearer ${token}',
      `Authorization: Basic ${token}`,
      `Authorization: Bearer ${token.slice(0, 19)}`,
      `Bearer ${token}`,
      'the Authorization header carries a Bearer credential',
    ]) {
      assert.deepEqual(rules('a.md', line), [], line);
    }
  });
});

describe('cookie-header', () => {
  it('flags Cookie and Set-Cookie lines that carry a name=value pair', () => {
    for (const line of [
      `Cookie: session=${rnd(24, 32)}; theme=dark`,
      `Set-Cookie: sid=${rnd(24, 33)}; HttpOnly; Secure`,
      `"cookie": "a=${rnd(10, 34)}"`,
      `set-cookie:x=${rnd(10, 35)}`,
    ]) {
      assert.deepEqual(rules('a.txt', line), ['cookie-header'], line);
    }
  });
  it('ignores header names without values and unrelated words', () => {
    for (const line of ['Cookie: ', 'Cookie: <value>', 'Cookie: sid=${token}', 'Set-Cookie: sid=<value>', 'Cookie: a={{ value }}', 'cookies.json is ignored', 'cookie: true', 'Cookie handling is out of scope', 'x-cookie: a=bcdefg']) {
      assert.deepEqual(rules('a.txt', line), [], line);
    }
  });
});

describe('ChatGPT session identifiers', () => {
  const sessionName = join('__Secure-next-', 'auth.session-', 'token');
  const clearance = join('cf_', 'clearance');
  const deviceId = join('oai-device', '-id');
  const did = join('oai-', 'did');
  const puid = join('_pu', 'id');

  it('flags the web-session cookie name, with or without the __Secure- prefix', () => {
    assert.deepEqual(rules('a.md', `cookie named ${sessionName} is secret`), ['session-cookie-name']);
    assert.deepEqual(rules('a.md', join('next-', 'auth.session-', 'token')), ['session-cookie-name']);
    assert.deepEqual(rules('a.md', join('NEXT-', 'AUTH.SESSION-', 'TOKEN')), ['session-cookie-name']);
    assert.deepEqual(rules('a.md', 'next-auth is a library; session-token alone is fine'), []);
  });
  it('flags clearance cookie assignments only', () => {
    assert.deepEqual(rules('a.md', `${clearance}=${rnd(30, 36)}`), ['cloudflare-clearance-cookie']);
    assert.deepEqual(rules('a.md', `${clearance} is mentioned in prose`), []);
    assert.deepEqual(rules('a.md', `x${clearance}=${rnd(30, 37)}`), []);
  });
  it('flags device id values, not the bare names or short values', () => {
    assert.deepEqual(rules('a.md', `${deviceId}: ${uuid(38)}`), ['device-id']);
    assert.deepEqual(rules('a.md', `${did}=${uuid(39)}`), ['device-id']);
    assert.deepEqual(rules('a.md', `"${deviceId}": "${uuid(40)}"`), ['device-id']);
    assert.deepEqual(rules('a.md', `the ${did} cookie`), []);
    assert.deepEqual(rules('a.md', `${did}=short`), []);
  });
  it('flags user-id cookie assignments only at a token boundary', () => {
    assert.deepEqual(rules('a.md', `${puid}=user-${rnd(20, 41)}`), ['user-id-cookie']);
    assert.deepEqual(rules('a.md', `${puid} is a cookie name`), []);
    assert.deepEqual(rules('a.md', `my${puid}=${rnd(20, 42)}`), []);
  });
});

describe('chatgpt-conversation-url', () => {
  const url = (host: string, id: string, scheme = 'https'): string => `${scheme}://${host}/c/${id}`;
  it('flags private conversation URLs on both hosts, any scheme, case and optional www/GPT prefix', () => {
    assert.deepEqual(rules('a.md', url(CHATGPT, uuid(43))), ['chatgpt-conversation-url']);
    assert.deepEqual(rules('a.md', url(OPENAI_CHAT, uuid(44))), ['chatgpt-conversation-url']);
    assert.deepEqual(rules('a.md', url(CHATGPT, uuid(45), 'http')), ['chatgpt-conversation-url']);
    assert.deepEqual(rules('a.md', url(`www.${CHATGPT}`, uuid(46))), ['chatgpt-conversation-url']);
    assert.deepEqual(rules('a.md', url(CHATGPT, uuid(47).toUpperCase())), ['chatgpt-conversation-url']);
    assert.deepEqual(rules('a.md', url(CHATGPT.toUpperCase(), uuid(48))), ['chatgpt-conversation-url']);
    assert.deepEqual(rules('a.md', `https://${CHATGPT}/g/g-${rnd(9, 49)}/c/${uuid(50)}`), ['chatgpt-conversation-url']);
    assert.deepEqual(rules('a.md', `[link](${url(CHATGPT, uuid(51))}).`), ['chatgpt-conversation-url']);
  });
  it('allows the SPEC reference id, the synthetic form and the nil id', () => {
    assert.deepEqual(rules('a.md', url(CHATGPT, REFERENCE_ID)), []);
    assert.deepEqual(rules('a.md', url(CHATGPT, REFERENCE_ID.toUpperCase())), []);
    assert.deepEqual(rules('a.md', url(OPENAI_CHAT, REFERENCE_ID)), []);
    assert.deepEqual(rules('a.md', url(CHATGPT, '00000000-0000-4000-8000-0123456789ab')), []);
    assert.deepEqual(rules('a.md', url(CHATGPT, '00000000-0000-4000-8000-0123456789AB')), []);
    assert.deepEqual(rules('a.md', url(CHATGPT, '00000000-0000-0000-0000-000000000000')), []);
  });
  it('is not fooled by near-synthetic ids', () => {
    // wrong version nibble, wrong variant nibble and a non-zero lead are all treated as real ids
    for (const id of ['00000000-0000-1000-8000-0123456789ab', '00000000-0000-4000-c000-0123456789ab', '00000001-0000-4000-8000-0123456789ab']) {
      assert.deepEqual(rules('a.md', url(CHATGPT, id)), ['chatgpt-conversation-url'], id);
    }
  });
  it('ignores placeholders, malformed ids, other paths and other hosts', () => {
    for (const line of [
      `https://${CHATGPT}/c/<uuid>`,
      `https://${CHATGPT}/c/{id}`,
      `https://${CHATGPT}/c/${uuid(52).slice(0, -1)}`,
      `https://${CHATGPT}/c/${uuid(53)}0`,
      `https://${CHATGPT}/share/${uuid(54)}`,
      `https://example.com/c/${uuid(55)}`,
      `https://${CHATGPT}.example.org/c/${uuid(56)}`,
      `${CHATGPT}/c/${uuid(57)}`,
    ]) {
      assert.deepEqual(rules('a.md', line), [], line);
    }
  });
});

describe('asset-pointer', () => {
  const pointers = [join('file-serv', 'ice://file-', rnd(24, 58)), join('sedi', 'ment://file_', rnd(32, 59, HEX).replace(/^0+/, 'a'))];
  it('flags real-looking pointers outside fixtures/ and docs/', () => {
    for (const pointer of pointers) {
      for (const path of ['src/a.ts', 'test/a.test.ts', 'README.md', 'Fixtures/a.json', 'docs-extra/a.md', 'a/docs/b.md', 'a/fixtures/b.json']) {
        assert.deepEqual(rules(path, `pointer: "${pointer}"`), ['asset-pointer'], `${path} ${pointer.slice(0, 12)}`);
      }
    }
  });
  it('exempts the root fixtures/ and docs/ directories', () => {
    for (const pointer of pointers) {
      for (const path of ['fixtures/a.json', 'fixtures/x/y.json', 'docs/a.md', 'docs/x/y.md']) assert.deepEqual(rules(path, pointer), [], path);
    }
  });
  it('ignores bare schemes, short placeholders and synthetic all-zero ids', () => {
    for (const text of [join('file-serv', 'ice://'), join('file-serv', 'ice://file-abc'), join('sedi', 'ment://file_X'), join('sedi', 'ment://', '${id}'), join('sedi', 'ment://file_', '0'.repeat(31), '1'), join('file-serv', 'ice://file-', '0'.repeat(20), rnd(8, 60))]) {
      assert.deepEqual(rules('src/a.ts', text), [], text);
    }
  });
  it('still flags a real id that only begins with an 8-digit zero prefix', () => {
    assert.deepEqual(rules('src/a.ts', join('sedi', 'ment://file_', '00000000', rnd(24, 61, HEX).replace(/0/g, '7'))), ['asset-pointer']);
  });
});

describe('high-entropy-blob', () => {
  const b64 = rnd(100, 62, B64);
  const hex = rnd(96, 63, HEX);
  it('flags long random base64 and hex runs', () => {
    assert.deepEqual(rules('src/a.ts', `const blob = '${b64}';`), ['high-entropy-blob']);
    assert.deepEqual(rules('src/a.ts', `digest ${hex}`), ['high-entropy-blob']);
    assert.deepEqual(rules('src/a.ts', `id_${hex}`), ['high-entropy-blob']);
    assert.deepEqual(rules('src/a.ts', rnd(80, 64, `${B62}-_`)), ['high-entropy-blob']);
    assert.deepEqual(rules('src/a.ts', rnd(300, 65, B64)), ['high-entropy-blob']);
  });
  it('ignores short runs and low-entropy or word-like text', () => {
    const cases: Record<string, string> = {
      'random but 79 characters': rnd(79, 66, B62),
      'random hex but 79 characters': rnd(79, 67, HEX),
      dashes: '-'.repeat(120),
      'one repeated letter': 'A'.repeat(120),
      'repeated hex pattern': 'deadbeef'.repeat(15),
      'kebab-case slug': 'this-is-a-very-long-kebab-case-identifier-that-keeps-going-and-going-for-more-than-eighty-chars',
      'camel-case identifier': 'ImportLimitsDefaultValuesForTheZipReaderAndJsonStreamingParserWithExplicitBoundsAndMoreWords',
      'url path': 'org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat/prototype/formatRange',
      'zero-filled number': '0'.repeat(100),
    };
    for (const [label, text] of Object.entries(cases)) assert.deepEqual(rules('src/a.ts', text), [], label);
  });
  it('is exempt under fixtures/ and for package-lock.json at any depth, but nowhere else', () => {
    for (const path of ['fixtures/a.json', 'fixtures/x/b.txt', 'package-lock.json', 'pkg/package-lock.json']) {
      assert.deepEqual(rules(path, `${b64}\n${hex}`), [], path);
    }
    for (const path of ['other-lock.json', 'docs/a.md', 'test/fixtures/a.json', 'src/package-lock.json.ts']) {
      assert.deepEqual(rules(path, b64), ['high-entropy-blob'], path);
    }
  });
  it('reports a JWT once, not again as a blob', () => {
    const jwt = `eyJ${rnd(90, 68, `${B62}_-`)}.eyJ${rnd(90, 69, `${B62}_-`)}.${rnd(86, 70, `${B62}_-`)}`;
    assert.deepEqual(rules('src/a.ts', jwt), ['jwt']);
  });
  it('does not flag email-like strings', () => {
    for (const text of ['someone.name+tag@example.com', 'first.last@sub.example.co.uk wrote: hi', `${rnd(30, 71)}@${rnd(30, 72, 'abcdefghij')}.example.org`]) {
      assert.deepEqual(rules('src/a.ts', text), [], text);
    }
  });
});

describe('synthetic fixture marker and fixture size', () => {
  it('requires the marker in conversation exports under fixtures/', () => {
    for (const path of ['fixtures/conversations.json', 'fixtures/chatgpt/conversations-001.json', 'fixtures/x/CONVERSATIONS.JSON']) {
      assert.deepEqual(only(path, '[]\n').map((f) => [f.rule, f.line]), [['synthetic-marker-missing', undefined]], path);
      assert.deepEqual(only(path, `[{"title":"${SYNTHETIC_MARKER}"}]`), [], path);
    }
  });
  it('requires nothing of other fixtures or of files elsewhere', () => {
    assert.deepEqual(only('fixtures/other.json', '[]'), []);
    assert.deepEqual(only('fixtures/chatgpt/notes.txt', 'no marker here'), []);
    assert.deepEqual(only('src/conversations.json', '[]'), []); // the path rule, not the content rule, handles this
  });
  it('flags fixtures larger than 1 MiB and nothing at exactly 1 MiB', () => {
    const big = 'x'.repeat(FIXTURE_MAX_BYTES + 1);
    assert.deepEqual(only('fixtures/big.txt', big).map((f) => f.rule), ['fixture-too-large']);
    assert.deepEqual(only('fixtures/ok.txt', 'x'.repeat(FIXTURE_MAX_BYTES)), []);
    assert.deepEqual(only('docs/big.txt', big), []);
    // size is measured in bytes, not characters
    assert.deepEqual(only('fixtures/wide.txt', 'é'.repeat(FIXTURE_MAX_BYTES / 2 + 1)).map((f) => f.rule), ['fixture-too-large']);
  });
});

describe('scanContent behaviour', () => {
  it('reports 1-based line numbers for LF, CRLF and a final line without newline', () => {
    const secret = join('sk-', rnd(40, 73));
    assert.equal(only('a.txt', `a\nb\n${secret}`)[0]?.line, 3);
    assert.equal(only('a.txt', `a\r\nb\r\n${secret}\r\n`)[0]?.line, 3);
    assert.equal(only('a.txt', `${secret}`)[0]?.line, 1);
    assert.deepEqual(only('a.txt', ''), []);
  });
  it('reports several secrets on one line and one finding per distinct (rule, line, detail)', () => {
    const a = join('sk-', rnd(40, 74));
    const b = join('ghp_', rnd(36, 75));
    assert.deepEqual(rules('a.txt', `${a} ${b}`), ['github-token', 'openai-api-key']);
    assert.equal(only('a.txt', `${a}\n${a}`).length, 2); // same detail, different lines
  });
  it('orders findings by line, then rule', () => {
    const text = [join('ghp_', rnd(36, 76)), 'clean', `${join('sk-', rnd(40, 77))} ${join('AKIA', 'B'.repeat(16))}`].join('\n');
    assert.deepEqual(only('a.txt', text).map((f) => `${f.line}:${f.rule}`), ['1:github-token', '3:aws-access-key-id', '3:openai-api-key']);
  });
  it('honours the allow option for the exact path only', () => {
    const text = join('sk-', rnd(40, 78));
    assert.deepEqual(scanContent('a/b.txt', text, { allow: ['a/b.txt'] }), []);
    assert.equal(scanContent('a/b.txt', text, { allow: ['a/c.txt', 'a/*'] }).length, 1);
  });
  it('lists its rule ids', () => {
    assert.deepEqual(
      [...CONTENT_RULE_IDS].sort(),
      [
        'asset-pointer', 'aws-access-key-id', 'bearer-token', 'chatgpt-conversation-url', 'cloudflare-clearance-cookie', 'cookie-header',
        'device-id', 'github-token', 'high-entropy-blob', 'jwt', 'openai-api-key', 'pem-private-key', 'session-cookie-name', 'slack-token', 'user-id-cookie',
      ],
    );
  });
});

describe('masking', () => {
  it('maskSecret shows at most 4 leading characters, never more than 1/8 of the value, and the length', () => {
    assert.equal(maskSecret(''), '*** (len 0)');
    assert.equal(maskSecret('abcdefg'), '*** (len 7)');
    assert.equal(maskSecret('abcdefgh'), 'a*** (len 8)');
    assert.equal(maskSecret('abcdefghijklmnopqrstuvwxyz0123456789'), 'abcd*** (len 36)');
    assert.equal(maskSecret('ab\ncdefghijklmnopqrstuvwxyz01234567'), 'ab?c*** (len 35)'); // control characters are never echoed
  });

  it('never puts more than 4 characters of any secret into a finding (property)', () => {
    const makers: Array<(body: string) => string> = [
      (b) => join('sk-', b),
      (b) => join('ghp_', b),
      (b) => `Authorization: Bearer ${b}`,
      (b) => `Cookie: sid=${b}`,
      (b) => join('cf_', 'clearance=', b),
      (b) => join('_pu', 'id=', b),
      (b) => `eyJ${b}.eyJ${b}.${b}`,
      (b) => b.repeat(4),
    ];
    fc.assert(
      fc.property(fc.integer({ min: 0, max: makers.length - 1 }), fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 40, max: 120 }), (which, seed, length) => {
        const body = rnd(length, seed, B62);
        const content = `x\n${makers[which]?.(body) ?? ''}\ny`;
        for (const f of scanContent('src/a.ts', content)) {
          assert.ok(!f.detail.includes(body.slice(4, 9)), `${f.rule}: ${f.detail}`);
          assert.ok(!f.detail.includes(body), f.rule);
        }
      }),
      { numRuns: 300, seed: PROPERTY_SEED },
    );
  });
});

describe('linear-time matching (ReDoS)', () => {
  const N = 200_000;
  // Inputs shaped to maximize backtracking for every rule family. A quadratic regex needs tens of seconds at this
  // size; the linear ones finish in milliseconds, so the generous bound only fails on a real complexity bug.
  const hostile: Record<string, string> = {
    'one huge key-like run': join('sk-', 'A'.repeat(N)),
    'many sk- starts': 'sk-'.repeat(N / 3),
    'all a': 'a'.repeat(N),
    'repeated PEM prefix': '-----BEGIN '.repeat(N / 11),
    'PEM prefix then spaces': join('-----BEGIN ', 'A '.repeat(N / 2)),
    'Authorization then whitespace': join('Authorization', ':', ' '.repeat(N), 'x'),
    'Authorization quote whitespace': join('Authorization', '"', ' '.repeat(N), '"'),
    'Authorization Bearer then whitespace': join('Authorization: Bearer', ' '.repeat(N)),
    'repeated authorization': 'authorization: '.repeat(N / 15),
    'Cookie then whitespace': join('Cookie:', ' '.repeat(N), 'a=b'),
    'cookie then long name': join('cookie: ', 'a'.repeat(N)),
    'repeated cookie starts': 'cookie:a'.repeat(N / 8),
    'long jwt-like first segment': join('eyJ', 'a'.repeat(N)),
    'many jwt-like heads': 'eyJaaaaaaaaa.'.repeat(N / 13),
    'dots only': '.'.repeat(N),
    'AKIA then long run': join('AKIA', 'A'.repeat(N)),
    'oai-did then whitespace': join('oai-', 'did', ' '.repeat(N), '='),
    'repeated oai-did': join('oai-', 'did=').repeat(N / 8),
    'repeated puid': join('_pu', 'id=').repeat(N / 6),
    'chat url with huge id': join('https://', CHATGPT, '/c/', '0'.repeat(N)),
    'repeated chat url heads': join('https://', CHATGPT, '/g/a').repeat(N / 20),
    'asset scheme and long id': join('file-serv', 'ice://', 'a'.repeat(N)),
    'alternating blob alphabet': 'A1'.repeat(N / 2),
    'many near-blob runs': `${'a'.repeat(79)} `.repeat(N / 80),
    'long hex then letter': join('0123456789abcdef'.repeat(N / 16), 'g'),
    'slashes': '/'.repeat(N),
    'long single line of tokens': `${join('sk-', rnd(30, 79))} `.repeat(N / 34),
  };
  for (const [label, input] of Object.entries(hostile)) {
    it(`stays fast on: ${label}`, () => {
      const start = process.hrtime.bigint();
      scanContent('src/hostile.txt', input);
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      assert.ok(ms < 3000, `${label} took ${ms.toFixed(0)} ms for ${input.length} characters`);
    });
  }

  it('contains no nested quantifiers in any rule pattern (static audit)', () => {
    // A group whose body contains a quantifier and which is itself quantified by + * or {n,}. Bounded {0,k} repeats of
    // a delimiter-led group and optional (?:...)? groups are fine.
    const nested = /\((?:\?:)?(?:[^()\\]|\\.)*(?:[+*]|\{\d+,\d*\})(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+,\d*\})/;
    for (const { id, source } of CONTENT_RULE_SOURCES) assert.ok(!nested.test(source), `${id}: ${source}`);
  });
});
