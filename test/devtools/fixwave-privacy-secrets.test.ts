/**
 * ATK-09: credential shapes the privacy scanner used to miss, and keys hidden with invisible characters.
 *
 * Added shapes: Google API keys, npm tokens, Stripe live keys, GitLab and Hugging Face tokens, credentials embedded in a URL
 * (`scheme://user:password@host`), `aws_secret_access_key` assignments, netrc password lines and HTTP Basic credentials. Zero-width
 * and other invisible format characters are removed before matching. The false-positive side matters as much: placeholders,
 * documentation hosts and the exact URL forms this repository's own tests use must stay clean (the scanner scans its own repository).
 *
 * Every secret-shaped string is assembled at run time from fragments (`join_`, `rnd`), so this file contains none; in particular
 * no contiguous `scheme://user:password@host` literal that a scanner could mistake for a credential.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CONTENT_RULE_SOURCES, scanContent, scanPaths } from '../../src/devtools/privacy-scan.js';
import { B62, B64URL, join_, rnd } from './fixwave-privacy-helpers.js';

const B64 = `${B62}+/`;
const rules = (path: string, content: string): string[] => scanContent(path, content).map((f) => f.rule);
const details = (path: string, content: string): string[] => scanContent(path, content).map((f) => f.detail);

// ---- the missing shapes --------------------------------------------------------------------------------------------------------------

interface Shape {
  label: string;
  rule: string;
  /** Builds a line that carries a secret of this shape. */
  make: (seed: number) => string;
  /** The secret body that must never appear beyond its first 4 characters in any output. */
  body: (seed: number) => string;
}

const google = (seed: number): string => join_('AI', 'za', rnd(35, seed, B64URL));
const npm = (seed: number): string => join_('np', 'm_', rnd(36, seed));
const stripe = (kind: string) => (seed: number): string => join_(kind, '_li', 've_', rnd(24, seed));
const gitlab = (seed: number): string => join_('glp', 'at-', rnd(20, seed, B64URL));
const hf = (seed: number): string => join_('h', 'f_', rnd(34, seed));
const urlPassword = (seed: number): string => rnd(16, seed);
const awsValue = (seed: number): string => rnd(40, seed, B64);
const basicValue = (seed: number): string => Buffer.from(join_('deploy', ':', rnd(14, seed))).toString('base64');

const SHAPES: Shape[] = [
  { label: 'Google API key', rule: 'google-api-key', make: (s) => `const key = '${google(s)}';`, body: google },
  { label: 'npm token', rule: 'npm-token', make: (s) => `//registry.example.org/:_authToken=${npm(s)}`, body: npm },
  { label: 'Stripe live secret key', rule: 'stripe-key', make: (s) => `STRIPE=${stripe('sk')(s)}`, body: stripe('sk') },
  { label: 'Stripe live restricted key', rule: 'stripe-key', make: (s) => `STRIPE=${stripe('rk')(s)}`, body: stripe('rk') },
  { label: 'Stripe live publishable key', rule: 'stripe-key', make: (s) => `STRIPE_PUBLIC=${stripe('pk')(s)}`, body: stripe('pk') },
  { label: 'GitLab personal access token', rule: 'gitlab-token', make: (s) => `token: ${gitlab(s)}`, body: gitlab },
  { label: 'Hugging Face token', rule: 'huggingface-token', make: (s) => `HF_TOKEN=${hf(s)}`, body: hf },
  {
    label: 'password in a URL with a real-looking host',
    rule: 'url-credentials',
    make: (s) => join_('git clone https', '://', 'deploy', ':', urlPassword(s), '@', 'git.corp-internal-name.io', '/repo.git'),
    body: urlPassword,
  },
  {
    label: 'reviewer evidence: a short password in a database URL',
    rule: 'url-credentials',
    make: () => join_('postgres', '://', 'user', ':', 'pw', '@', 'host', '/db'),
    body: () => 'pw',
  },
  {
    label: 'database URL on a real-looking host, mixed-case password',
    rule: 'url-credentials',
    make: (s) => join_('redis', '://', 'default', ':', urlPassword(s), '@', 'cache.corp-internal-name.io', ':6379'),
    body: urlPassword,
  },
  {
    label: 'mongodb+srv connection string',
    rule: 'url-credentials',
    make: (s) => join_('mongodb+srv', '://', 'app', ':', urlPassword(s), '@', 'cluster0.corp-internal-name.io', '/db?retryWrites=true'),
    body: urlPassword,
  },
  {
    label: 'aws_secret_access_key assignment',
    rule: 'aws-secret-access-key',
    make: (s) => join_('aws_secret', '_access_key', ' = ', awsValue(s)),
    body: awsValue,
  },
  {
    label: 'AWS_SECRET_ACCESS_KEY, quoted',
    rule: 'aws-secret-access-key',
    make: (s) => join_('export AWS_', 'SECRET_ACCESS_KEY="', awsValue(s), '"'),
    body: awsValue,
  },
  {
    label: 'JSON SecretAccessKey member (aws cli output)',
    rule: 'aws-secret-access-key',
    make: (s) => join_('  "Secret', 'AccessKey": "', awsValue(s), '",'),
    body: awsValue,
  },
  {
    label: 'one-line netrc entry',
    rule: 'netrc-password',
    make: (s) => join_('machine ', 'api.corp-internal-name.io', ' login ', 'bob', ' password ', rnd(14, s)),
    body: (s) => rnd(14, s),
  },
  {
    label: 'default netrc entry',
    rule: 'netrc-password',
    make: (s) => join_('default', ' login ', 'bob', ' password ', rnd(14, s)),
    body: (s) => rnd(14, s),
  },
  {
    label: 'HTTP Basic Authorization header',
    rule: 'basic-auth-header',
    make: (s) => `Authorization: Basic ${basicValue(s)}`,
    body: basicValue,
  },
  {
    label: 'HTTP Basic header in a JSON header map',
    rule: 'basic-auth-header',
    make: (s) => `{"Authorization": "Basic ${basicValue(s)}"}`,
    body: basicValue,
  },
];

describe('ATK-09: credential shapes that were missed are found', () => {
  for (const [i, shape] of SHAPES.entries()) {
    it(`flags: ${shape.label}`, () => {
      const seed = 100 + i;
      for (const path of ['src/a.ts', 'docs/notes.md', 'config.yml', 'data.json']) {
        const content = `first line\n${shape.make(seed)}\nlast line`;
        assert.deepEqual(
          scanContent(path, content).map((f) => [f.rule, f.line]),
          [[shape.rule, 2]],
          `${path}: ${shape.make(seed).slice(0, 12)}`,
        );
        // Masking: at most 4 leading characters of the secret, never its body, in any detail.
        const body = shape.body(seed);
        for (const detail of details(path, content)) {
          assert.ok(body.length < 9 || !detail.includes(body.slice(4, 12)), detail);
          assert.ok(!detail.includes(shape.make(seed)), detail);
        }
      }
    });
  }

  it('reports every member of a pasted key set, one finding each', () => {
    const text = [stripe('sk')(1), stripe('rk')(2), stripe('pk')(3)].join('\n');
    assert.deepEqual(rules('a.txt', text), ['stripe-key', 'stripe-key', 'stripe-key']);
  });

  it('the vendor prefixes must start a token: glued to a word or identifier they are not secrets', () => {
    for (const text of [
      `x${google(1)}`,
      `my${npm(2)}`,
      `task_${stripe('sk')(3)}`,
      `s${hf(4)}`,
      `pre-${gitlab(5)}`,
      `${gitlab(6)}`.replace('glpat', 'glpax'),
    ]) {
      assert.deepEqual(rules('a.txt', text), [], text.slice(0, 14));
    }
  });

  it('too-short bodies and test-mode Stripe keys are not reported', () => {
    for (const text of [
      join_('AI', 'za', rnd(34, 7, B64URL)),
      join_('np', 'm_', rnd(35, 8)),
      join_('sk', '_li', 've_', rnd(15, 9)),
      join_('glp', 'at-', rnd(19, 10, B64URL)),
      join_('h', 'f_', rnd(29, 11)),
      join_('sk', '_te', 'st_', rnd(24, 12)),
      join_('np', 'm_config_', 'registry'),
      join_('np', 'm_', 'config_user_agent'),
    ]) {
      assert.deepEqual(rules('a.txt', text), [], text.slice(0, 14));
    }
  });
});

// ---- URL credentials: what is a credential and what is documentation ----------------------------------------------------------------

describe('ATK-09: scheme://user:password@host', () => {
  const url = (scheme: string, user: string, password: string, host: string, rest = ''): string => join_(scheme, '://', user, ':', password, '@', host, rest);

  it('flags a password in a connection string even when it is short, unless the host is a documentation host', () => {
    for (const scheme of ['postgres', 'postgresql', 'mysql', 'redis', 'rediss', 'amqp', 'mongodb', 'mongodb+srv', 'ftp', 'sftp', 'ldap', 'smtp']) {
      assert.deepEqual(rules('a.txt', url(scheme, 'svc', 'hunter', 'db.corp-internal-name.io', '/x')), ['url-credentials'], scheme);
    }
  });

  it('flags a real-looking password (8+ characters, two or more character classes) on http(s) URLs on any non-documentation host', () => {
    const strong = rnd(16, 31);
    for (const scheme of ['https', 'http', 'git+https', 'ws']) assert.deepEqual(rules('a.txt', url(scheme, 'deploy', strong, 'git.corp-internal-name.io', '/r.git')), ['url-credentials'], scheme);
  });

  it('leaves a short or single-class password on an http(s) URL alone (this is how URL parsing is documented and tested)', () => {
    for (const password of ['pw', 'pass', 'hunter2', 'zqxpassone', 'secretonly', 'ABCDEFGHIJKL']) {
      assert.deepEqual(rules('a.txt', url('https', 'alice', password, 'files.corp-internal-name.io', '/doc')), [], password);
    }
  });

  it('never reports placeholders, templates, masks and the sample words', () => {
    const hosts = 'db.corp-internal-name.io';
    for (const password of ['pass', 'password', 'Password', 'passwd', 'pwd', 'secret', 'token', 'changeme', 'xxxxxxxx', '********', '........', '${PASSWORD}', '$PASSWORD', '{{ pw }}', '%s', '[redacted]', 'REDACTED']) {
      assert.deepEqual(rules('a.txt', url('postgres', 'svc', password, hosts)), [], password);
    }
    assert.deepEqual(rules('a.txt', url('postgres', '${USER}', rnd(16, 32), hosts)), []);
    assert.deepEqual(rules('a.txt', url('postgres', 'svc', '<password>', hosts)), []);
    assert.deepEqual(rules('a.txt', url('postgres', 'svc', rnd(16, 33), '${HOST}')), []); // host is a template
  });

  it('never reports a weak password on documentation, reserved and loopback hosts, with or without a port, in any case', () => {
    for (const host of ['example.com', 'files.example.com', 'EXAMPLE.ORG', 'a.b.example.net:8443', 'host.example', 'x.invalid', 'a.test', 'localhost', 'localhost:5432', '127.0.0.1:6379', '[::1]:5432', '0.0.0.0', 'db.internal', 'host.docker.internal', 'db.localhost']) {
      assert.deepEqual(rules('a.txt', url('postgres', 'svc', 'hunter2', host)), [], host);
      assert.deepEqual(rules('a.txt', url('https', 'svc', 'zqxpassone', host)), [], host);
    }
  });

  it('reports a real-looking password wherever it points, documentation and loopback hosts included (people reuse passwords)', () => {
    const strong = rnd(16, 34);
    for (const host of ['example.com', 'files.example.com:8443', 'localhost:5432', '127.0.0.1', 'db.internal']) {
      assert.deepEqual(rules('a.txt', url('postgres', 'svc', strong, host)), ['url-credentials'], host);
      assert.deepEqual(rules('a.txt', url('https', 'svc', strong, host)), ['url-credentials'], host);
    }
  });

  it('never reports a single-character user name with a short password (the u:pw@h form of the URL-sanitizing code and its comments)', () => {
    for (const text of [url('ftp', 'u', 'pw', 'h', '/'), url('postgres', 'u', 'pw', 'db', '/x?y'), url('https', 'U', 'P', 'Example.com', '/p?q=1#f'), url('redis', '', 'zqxpassfour', 'cache.example.com', ':6379/0')]) {
      assert.deepEqual(rules('a.txt', text), [], text);
    }
  });

  it('leaves the URL forms this repository tests with alone (alice/hunter2, zqx* sentinels, userinfo in front of the ChatGPT host)', () => {
    for (const text of [
      url('https', 'alice', 'hunter2', 'files.example.com:8443', '/a/b?token=SECRETTOKEN&sig=ZZZ#access_frag'),
      url('ftp', 'alice', 'zqxpassone', 'ftp.example.com', '/pub?zqxquerytwo=1'),
      url('postgres', 'admin', 'zqxpassthree', 'db.internal:5432', '/prod?sslmode=zqxquerytwo#zqxfragfour'),
      url('mongodb+srv', 'user', 'zqxpasssix', 'cluster0.example.net', '/db?retryWrites=true'),
      url('https', 'user', 'pw', join_('chat', 'gpt.com'), '/c/00000000-0000-4000-8000-000000000001'),
      url('HTTP', 'User', 'zqxthree', 'Host.Example.org:8080', '/q'),
      join_('https', '://:@', 'chat', 'gpt.com/c/00000000-0000-4000-8000-000000000001'),
    ]) {
      assert.deepEqual(rules('a.txt', text), [], text.slice(0, 40));
    }
  });

  it('does not mistake other colon-and-at text for credentials', () => {
    for (const text of ['mailto:someone@host.com', 'https://github.com/org/repo', 'see https://host.com/path:with@sign', 'git@github.com:org/repo.git', 'http://localhost:8080/@user', 'ssh://git@host/x.git', 'a://b:c', 'time 10:30 at home@work']) {
      assert.deepEqual(rules('a.txt', text), [], text);
    }
  });

  it('finds the credential inside a longer line and only once', () => {
    const line = `DATABASE_URL=${url('postgres', 'svc', rnd(16, 35), 'db.corp-internal-name.io:5432', '/app')}?sslmode=require # primary`;
    assert.deepEqual(rules('.env.sample.txt', line), ['url-credentials']);
  });
});

// ---- AWS secret keys, netrc, Basic: what they do not match -----------------------------------------------------------------------

describe('ATK-09: aws_secret_access_key, netrc and Basic credentials', () => {
  const assign = (value: string): string => join_('aws_secret', '_access_key', '=', value);

  it('only a 40-character base64 value counts, and not a mask or a template; the AWS documentation sample is NOT exempt', () => {
    assert.deepEqual(rules('a.ini', assign(rnd(40, 41, B64))), ['aws-secret-access-key']);
    for (const value of [rnd(39, 42, B64), `${rnd(41, 43, B64)}`, '${AWS_SECRET}', '<your-secret-key>', 'x'.repeat(40), '*'.repeat(40)]) {
      assert.deepEqual(rules('a.ini', assign(value)), [], value);
    }
    // The documentation sample (it ends in EXAMPLEKEY) looks like a key and is reported: nothing here has a reason to quote it.
    assert.deepEqual(rules('a.ini', assign(join_('wJalrXUtnFEMI/K7MDENG/', 'bPxRfiCY', 'EXAMPLEKEY'))), ['aws-secret-access-key']);
    assert.deepEqual(rules('a.ini', assign(join_(rnd(20, 44, B64), 'EXAMPLE', rnd(13, 45, B64)))), ['aws-secret-access-key']);
    assert.deepEqual(rules('a.ini', rnd(40, 46, B64)), []); // 40 characters with no assignment have no distinctive shape
    assert.deepEqual(rules('a.ini', 'the aws_secret_access_key setting is documented elsewhere'), []);
  });

  it('netrc: the one-line form is reported in any file, the multi-line form only in a netrc file, placeholders never', () => {
    const entry = join_('machine ', 'api.corp-internal-name.io', ' login ', 'bob', ' password ', rnd(12, 47));
    for (const path of ['a.txt', 'docs/x.md', '.netrc', 'curl.netrc']) assert.deepEqual(rules(path, entry), ['netrc-password'], path);
    const multi = `machine api.corp-internal-name.io\n  login bob\n  password ${rnd(12, 48)}\n`;
    assert.deepEqual(scanContent('config/curl.netrc', multi).map((f) => [f.rule, f.line]), [['netrc-password', 3]]);
    assert.deepEqual(rules('notes.md', multi), []); // "password <word>" on a line of its own is ordinary prose elsewhere
    assert.deepEqual(rules('notes.md', 'password policy\npassword reset\n'), []);
    for (const value of ['<password>', '${PASS}', '...', '*****', 'pass', 'password']) {
      assert.deepEqual(rules('a.txt', join_('machine ', 'h.corp-internal-name.io', ' login ', 'u', ' password ', value)), [], value);
    }
    assert.deepEqual(rules('a.txt', join_('machine ', 'h.corp-internal-name.io', ' login ', 'bob', ' password ', 'xyzzy-12345', ').')), ['netrc-password']);
    assert.deepEqual(rules('a.txt', join_('machine ', 'h.corp-internal-name.io', ' login ', 'bob', ' password ', '...`)')), []);
  });

  it('netrc-style file names are forbidden outright, as are private-key and credential-store file names', () => {
    const forbidden = ['.netrc', '_netrc', 'home/.netrc', 'curl.netrc', 'id_rsa', 'keys/id_ed25519', 'a/id_ecdsa', 'id_dsa', '.pgpass', '.git-credentials', 'srv/.htpasswd', '.netrc.bak', 'DOT/.NETRC'];
    for (const p of forbidden) assert.deepEqual(scanPaths([p]).map((f) => f.rule), ['forbidden-filename'], p);
    for (const p of ['id_rsa.pub', 'netrc.md', 'docs/netrc-notes.txt', 'snetrc', 'src/netrc.ts', 'id_rsa_notes.md', 'my_id_rsa.txt']) assert.deepEqual(scanPaths([p]), [], p);
  });

  it('Basic: only a credential that decodes to user:password with a non-empty password counts (sample passwords are not exempt)', () => {
    const good = Buffer.from(join_('deploy', ':', rnd(14, 49))).toString('base64');
    assert.deepEqual(rules('a.txt', `Authorization: Basic ${good}`), ['basic-auth-header']);
    assert.deepEqual(rules('a.txt', `authorization:basic ${good}`), ['basic-auth-header']);
    assert.deepEqual(rules('a.txt', `headers = { 'Authorization': 'Basic ${good}' }`), ['basic-auth-header']);
    // The classic documentation examples decode to user:password pairs and are reported like any other captured header.
    for (const pair of ['Aladdin:open sesame', 'user:password', 'admin:admin', 'user:pass']) {
      assert.deepEqual(rules('a.txt', `Authorization: Basic ${Buffer.from(pair).toString('base64')}`), ['basic-auth-header'], pair);
    }
    const notCredentials = [Buffer.from('user:').toString('base64'), Buffer.from('no colon here').toString('base64'), 'abcdefghijkl', '<credentials>', '${TOKEN}', 'short'];
    for (const token of notCredentials) assert.deepEqual(rules('a.txt', `Authorization: Basic ${token}`), [], token);
    assert.deepEqual(rules('a.txt', `Basic ${good}`), []); // without the Authorization header name it is just a word
    assert.deepEqual(rules('a.txt', `Authorization: Bearer ${rnd(30, 50)}`), ['bearer-token']);
  });
});

describe('ATK-09: password parameters in a query string or connection string', () => {
  it('flags ?password=, &pwd= and ;Password= with a real-looking value, in any case', () => {
    const value = rnd(12, 80);
    for (const text of [
      join_('https://host.example/api?user=bob&password=', value),
      join_('https://host.example/api?passwd=', value, '&x=1'),
      join_('Server=db;User Id=sa;Password=', value, ';Encrypt=true'),
      join_('jdbc:postgresql://db.corp.io/app?user=bob&PASSWORD=', value),
      join_('x?pwd=', value),
    ]) {
      assert.deepEqual(rules('a.txt', text), ['password-parameter'], text.slice(0, 30));
      assert.ok(!details('a.txt', text).some((d) => d.includes(value.slice(4, 10))));
    }
  });

  it('does not report placeholders, templates, short values, or a bare assignment without a query-string delimiter', () => {
    for (const text of [
      'https://host.example/api?password=${PASSWORD}',
      'https://host.example/api?password=<password>',
      'https://host.example/api?password=%s',
      'https://host.example/api?password=********',
      'https://host.example/api?password=changeme',
      'https://host.example/api?password=pw',
      'https://host.example/api?password=',
      'Server=db;Password=;',
      'password=hunter2example', // a bare assignment: .env lines and shell variables have no distinctive shape (documented gap)
      'DB_PASSWORD=hunter2example',
      'const password = args.password;',
      'the password=policy page',
    ]) {
      assert.deepEqual(rules('a.txt', text), [], text);
    }
  });
});

// ---- invisible characters --------------------------------------------------------------------------------------------------------------

describe('ATK-09: invisible characters cannot split a credential', () => {
  const INVISIBLE: Array<[string, number]> = [
    ['ZERO WIDTH SPACE', 0x200b],
    ['ZERO WIDTH NON-JOINER', 0x200c],
    ['ZERO WIDTH JOINER', 0x200d],
    ['WORD JOINER', 0x2060],
    ['BYTE ORDER MARK / ZERO WIDTH NO-BREAK SPACE', 0xfeff],
    ['SOFT HYPHEN', 0x00ad],
    ['LEFT-TO-RIGHT MARK', 0x200e],
    ['RIGHT-TO-LEFT MARK', 0x200f],
    ['RIGHT-TO-LEFT OVERRIDE', 0x202e],
    ['INVISIBLE SEPARATOR', 0x2063],
    ['VARIATION SELECTOR-16', 0xfe0f],
    ['MONGOLIAN VOWEL SEPARATOR', 0x180e],
    ['COMBINING GRAPHEME JOINER', 0x034f],
    ['TAG LATIN SMALL LETTER A', 0xe0061],
  ];
  const apiKey = join_('sk-', 'proj-', rnd(40, 61, B64URL));

  for (const [name, cp] of INVISIBLE) {
    it(`finds a key with ${name} (U+${cp.toString(16).toUpperCase().padStart(4, '0')}) inserted at several places`, () => {
      const ch = String.fromCodePoint(cp);
      const plain = scanContent('a.txt', `one\ntwo\n${apiKey}`);
      assert.deepEqual(plain.map((f) => [f.rule, f.line]), [['openai-api-key', 3]]);
      for (const at of [3, 4, 8, 20, apiKey.length - 1]) {
        const hidden = `${apiKey.slice(0, at)}${ch}${apiKey.slice(at)}`;
        const found = scanContent('a.txt', `one\ntwo\n${hidden}`);
        assert.deepEqual(found.map((f) => [f.rule, f.line]), [['openai-api-key', 3]], `insert at ${at}`);
        assert.equal(found[0]?.detail, plain[0]?.detail); // the same masked description as the clean key: nothing extra is revealed
      }
      // several at once, and in front of every other prefix family
      const many = [...apiKey].join(ch);
      assert.deepEqual(rules('a.txt', many), ['openai-api-key']);
      for (const secret of [join_('gh', 'p_', rnd(36, 62)), join_('AK', 'IA', 'Q'.repeat(16)), google(63), stripe('sk')(64), join_('xox', 'b-', rnd(12, 65), '-', rnd(12, 66))]) {
        assert.equal(rules('a.txt', `${secret.slice(0, 4)}${ch}${secret.slice(4)}`).length, 1, secret.slice(0, 4));
      }
    });
  }

  it('the reviewer evidence: sk-<U+200B>proj-... is found', () => {
    assert.deepEqual(rules('a.txt', `sk-\u200bproj-${rnd(40, 67, B64URL)}`), ['openai-api-key']);
  });

  it('removes them for the other rules too (a header split by an invisible character, a URL credential, a cookie assignment)', () => {
    const zw = '\u200b';
    assert.deepEqual(rules('a.txt', `Author${zw}ization: Bea${zw}rer ${rnd(30, 68)}`), ['bearer-token']);
    assert.deepEqual(rules('a.txt', join_('postgres', ':/', zw, '/', 'user', ':', 'pw', '@', 'host', '/db')), ['url-credentials']);
    assert.deepEqual(rules('a.txt', join_('cf_', 'clea', zw, 'rance=', rnd(30, 69))), ['cloudflare-clearance-cookie']);
  });

  it('does not change line numbers or invent findings in ordinary text that contains such characters', () => {
    const text = `caf\u00e9 \u200b\u200c\u200d\u2060\ufeff text\n\u200b\u200b\n${join_('sk-', rnd(40, 70))}`;
    assert.deepEqual(scanContent('a.txt', text).map((f) => [f.rule, f.line]), [['openai-api-key', 3]]);
    assert.deepEqual(rules('a.txt', 'zero\u200bwidth \ufeffand a soft\u00adhyphen, emoji \u2764\ufe0f and joiners \u200d\u200d'), []);
  });
});

// ---- the documented, intentional gaps -------------------------------------------------------------------------------------------

describe('ATK-09: the intentional remaining gaps (listed in the header and in SECURITY_AND_BOUNDARIES.md section 9)', () => {
  it('a key split over two quoted fragments or two lines, an encoded key and a bare password= are NOT found', () => {
    const rest = rnd(40, 71, B64URL);
    assert.deepEqual(rules('a.ts', `const k = '${join_('sk-', 'proj-')}' + '${rest}';`), []);
    assert.deepEqual(rules('a.ts', `const k = "${join_('sk-', 'pr')}" "${join_('oj-', rest)}";`), []);
    assert.deepEqual(rules('a.txt', `${join_('sk-', 'proj-', rest.slice(0, 5))}\n${rest.slice(5)}`), []);
    assert.deepEqual(rules('a.txt', `key (base64): ${Buffer.from(join_('sk-', 'proj-', rest)).toString('base64')}`), []);
    assert.deepEqual(rules('a.txt', 'password=hunter2 and curl -u user:pass https://host.example/x'), []);
    assert.deepEqual(rules('a.env', join_('DB_PASS', 'WORD=', rnd(12, 72))), []);
  });
});

// ---- linear time -----------------------------------------------------------------------------------------------------------------

describe('ATK-09: the new rules are linear-time (ReDoS) and pass the static nested-quantifier audit', () => {
  const N = 200_000;
  const hostile: Record<string, string> = {
    'many Google prefixes': join_('AI', 'za').repeat(N / 4),
    'Google prefix then a long run': join_('AI', 'za', 'A'.repeat(N)),
    'many npm prefixes': join_('np', 'm_').repeat(N / 4),
    'npm prefix then a long run': join_('np', 'm_', 'A'.repeat(N)),
    'Stripe prefix repeated': join_('sk', '_li', 've_').repeat(N / 8),
    'GitLab prefix then a long run': join_('glp', 'at-', 'A'.repeat(N)),
    'Hugging Face prefix repeated': join_('h', 'f_').repeat(N / 3),
    'scheme-like runs with no separator': 'a+.-'.repeat(N / 4),
    'repeated scheme heads': 'ab://'.repeat(N / 5),
    'scheme, user and colon, no at sign': join_('postgres', '://', 'a:'.repeat(N / 2)),
    'many userinfo starts': join_('x', '://', 'u', ':').repeat(N / 6),
    'long password then no host': join_('https', '://', 'u', ':', 'p'.repeat(N)),
    'at signs only': join_('https', '://', 'u:p', '@'.repeat(N)),
    'repeated password parameters': '?password=a'.repeat(N / 11),
    'password parameter then a long value': join_('?password=', 'A'.repeat(N)),
    'aws key name repeated': join_('aws_secret', '_access_key', '=').repeat(N / 21),
    'aws key name then whitespace': join_('aws_secret', '_access_key', ' '.repeat(N), '='),
    'aws key then a long base64 run': join_('aws_secret', '_access_key', '=', 'A'.repeat(N)),
    'netrc machine repeated': 'machine '.repeat(N / 8),
    'netrc machine and a very long token': join_('machine ', 'a'.repeat(N), ' login x password y'),
    'netrc default repeated': 'default login a '.repeat(N / 16),
    'password word repeated on one line': '  password '.repeat(N / 11),
    'Basic header then a long base64 run': join_('Authorization: Basic ', 'A'.repeat(N)),
    'Basic header repeated': 'authorization: basic '.repeat(N / 21),
    'only invisible characters': '\u200b'.repeat(N),
    'invisible characters between key characters': [...join_('sk-', 'A'.repeat(1000))].join('\u200b').repeat(N / 2000),
    'alternating invisible characters and prefix': join_('sk-', '\u200b').repeat(N / 4),
  };
  for (const [label, input] of Object.entries(hostile)) {
    it(`stays fast on: ${label}`, () => {
      const start = process.hrtime.bigint();
      scanContent('src/hostile.txt', input);
      scanContent('.netrc', input);
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      assert.ok(ms < 4000, `${label} took ${ms.toFixed(0)} ms for ${input.length} characters`);
    });
  }

  it('contains no nested quantifiers in any rule pattern, new ones included', () => {
    const nested = /\((?:\?:)?(?:[^()\\]|\\.)*(?:[+*]|\{\d+,\d*\})(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+,\d*\})/;
    for (const { id, source } of CONTENT_RULE_SOURCES) assert.ok(!nested.test(source), `${id}: ${source}`);
  });
});
