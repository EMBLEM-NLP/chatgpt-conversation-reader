/**
 * Privacy scanner: ADVERSARIAL review against THROWAWAY git repositories (git init in a temp dir, no network, no
 * hooks, no global config).
 *
 * Each case below was a leak the scanner missed, a crash, or a hang when the review began: content hidden from the
 * patch-based passes by .gitattributes / diff configuration, renamed databases and archives, UTF-16 text, finding
 * explosions, and fixtures that are not actually synthetic. All secret-shaped text is assembled at run time from
 * fragments, so this file contains none.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { devNull } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import { GcrError } from '../../src/errors.js';
import { MAX_FINDINGS_PER_FILE, SYNTHETIC_MARKER, main, scanRepo } from '../../src/devtools/privacy-scan.js';
import type { Finding } from '../../src/devtools/privacy-scan.js';
import { withTempDir } from '../helpers/tmp.js';

// Same hermetic setup as the other repository tests: no inherited repository location, no user/system git config.
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];
process.env['GIT_CONFIG_GLOBAL'] = devNull;
process.env['GIT_CONFIG_NOSYSTEM'] = '1';
process.env['GIT_AUTHOR_NAME'] = 'GCR Test';
process.env['GIT_AUTHOR_EMAIL'] = 'test@example.invalid';
process.env['GIT_COMMITTER_NAME'] = 'GCR Test';
process.env['GIT_COMMITTER_EMAIL'] = 'test@example.invalid';

const execFileAsync = promisify(execFile);

async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  return stdout;
}

async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, 'init', '-q', '--template=', '-b', 'main');
  await git(dir, 'config', 'user.name', 'GCR Test');
  await git(dir, 'config', 'user.email', 'test@example.invalid');
  await git(dir, 'config', 'commit.gpgsign', 'false');
  await git(dir, 'config', 'core.hooksPath', devNull);
}

async function inRepo<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  return withTempDir(async (dir) => {
    await initRepo(dir);
    return fn(dir);
  });
}

async function put(dir: string, rel: string, content: string | Buffer): Promise<void> {
  const abs = join(dir, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

async function commitAll(dir: string, message: string): Promise<string> {
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '--no-verify', '-m', message);
  return (await git(dir, 'rev-parse', 'HEAD')).trim();
}

const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function rnd(length: number, seed: number, alphabet: string = B62): string {
  let s = (seed * 2654435761) >>> 0;
  let out = '';
  for (let i = 0; i < length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out += alphabet[(s >>> 16) % alphabet.length] ?? '';
  }
  return out;
}
const join_ = (...parts: string[]): string => parts.join('');
const summarize = (findings: readonly Finding[]): Array<[string, string, number | undefined]> => findings.map((f) => [f.rule, f.path, f.line]);
const key = (seed: number): string => join_('sk-', rnd(48, seed));

// ---- git attributes and diff configuration -------------------------------------------------------------------------

describe('attributes and diff configuration cannot hide added lines from the patch-based passes', () => {
  it('sees a staged secret in a file marked -diff or binary even after the work tree copy is cleaned', async () => {
    await inRepo(async (dir) => {
      await put(dir, '.gitattributes', '*.txt -diff\n*.dat binary\n');
      await put(dir, 'a.txt', `ok\n${key(1)}\n`);
      await put(dir, 'b.dat', `${key(2)}\n`);
      await git(dir, 'add', '-A');
      await put(dir, 'a.txt', 'ok\nredacted\n');
      await put(dir, 'b.dat', 'redacted\n');
      const result = await scanRepo(dir);
      assert.deepEqual(summarize(result.findings), [
        ['openai-api-key', 'a.txt', 2],
        ['openai-api-key', 'b.dat', 1],
      ]);
      assert.ok(result.findings.every((f) => f.detail.endsWith(' [staged]')));
    });
  });

  it('sees a historical secret in a file marked -diff, binary, or bound to a driver that declares it binary', async () => {
    await inRepo(async (dir) => {
      await git(dir, 'config', 'diff.zz.binary', 'true');
      await put(dir, '.gitattributes', '*.txt -diff\n*.dat binary\n*.drv diff=zz\n');
      await put(dir, 'a.txt', `${key(3)}\n`);
      await put(dir, 'b.dat', `${key(4)}\n`);
      await put(dir, 'c.drv', `${key(5)}\n`);
      await commitAll(dir, 'add');
      await git(dir, 'rm', '-q', 'a.txt', 'b.dat', 'c.drv');
      await commitAll(dir, 'remove');
      const result = await scanRepo(dir, { history: true });
      assert.deepEqual(summarize(result.findings), [
        ['openai-api-key', 'a.txt', 1],
        ['openai-api-key', 'b.dat', 1],
        ['openai-api-key', 'c.drv', 1],
      ]);
    });
  });

  it('is not confused by a diff.interHunkContext setting that merges nearby hunks', async () => {
    await inRepo(async (dir) => {
      const base = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
      await put(dir, 'f.txt', `${base.join('\n')}\n`);
      await commitAll(dir, 'base');
      await git(dir, 'config', 'diff.interHunkContext', '20');
      await put(dir, 'f.txt', `${[key(6), 'b', 'c', 'd', 'e', 'f', 'g', 'h', key(7), 'j'].join('\n')}\n`);
      await git(dir, 'add', '-A');
      await put(dir, 'f.txt', `${base.join('\n')}\n`); // work tree cleaned, index still holds both secrets
      assert.deepEqual(summarize((await scanRepo(dir)).findings), [
        ['openai-api-key', 'f.txt', 1],
        ['openai-api-key', 'f.txt', 9],
      ]);
      await git(dir, 'commit', '-q', '--no-verify', '-m', 'second'); // commits the INDEX (both secrets)
      await put(dir, 'f.txt', 'clean\n');
      await commitAll(dir, 'third');
      assert.deepEqual(
        summarize((await scanRepo(dir, { history: true })).findings),
        [
          ['openai-api-key', 'f.txt', 1],
          ['openai-api-key', 'f.txt', 9],
        ],
      );
    });
  });

  it('scans binary-looking staged content without crashing or inventing findings', async () => {
    await inRepo(async (dir) => {
      const bytes = Buffer.alloc(300_000);
      let s = 12345;
      for (let i = 0; i < bytes.length; i++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        bytes[i] = s >>> 24;
      }
      await put(dir, 'blob.bin', bytes);
      await git(dir, 'add', '-A');
      await commitAll(dir, 'binary');
      const result = await scanRepo(dir, { history: true });
      assert.deepEqual(result.findings, []);
      assert.equal(result.skippedBinary, 1);
    });
  });
});

// ---- volume ------------------------------------------------------------------------------------------------------------------

describe('a file with a huge number of matches', () => {
  const puid = join_('_pu', 'id=');

  it('is reported with a bounded number of findings instead of crashing the scan', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'noisy.txt', `${puid}\n`.repeat(Math.floor((2 * 1024 * 1024) / (puid.length + 1))));
      await put(dir, 'quiet.sqlite', 'x');
      const result = await scanRepo(dir);
      const noisy = result.findings.filter((f) => f.path === 'noisy.txt');
      assert.equal(noisy.length, MAX_FINDINGS_PER_FILE + 1);
      assert.equal(noisy.filter((f) => f.rule === 'too-many-findings').length, 1);
      assert.ok(result.findings.some((f) => f.rule === 'forbidden-extension'), 'other findings are still reported');
    });
  });

  it('survives more total findings than a spread argument list can carry (many noisy files, work tree and history)', async () => {
    await inRepo(async (dir) => {
      const noisy = `${puid}\n`.repeat(MAX_FINDINGS_PER_FILE + 5);
      for (let i = 0; i < 140; i++) await put(dir, `noisy/${String(i).padStart(3, '0')}.txt`, noisy);
      await commitAll(dir, 'noise');
      const result = await scanRepo(dir, { history: true });
      assert.ok(result.findings.length >= 140 * (MAX_FINDINGS_PER_FILE + 1), String(result.findings.length));
      assert.equal(result.findings.filter((f) => f.rule === 'too-many-findings').length, 280);
    });
  });

  it('keeps the CLI exit status at 1 (findings), not 2 (internal error), and stays bounded in history mode too', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'noisy.txt', `${puid}\n`.repeat(200_000));
      await commitAll(dir, 'noise');
      const out = await main(['--root', dir, '--history']);
      assert.equal(out.exitCode, 1);
      assert.ok(out.stdout.split('\n').length < 4 * MAX_FINDINGS_PER_FILE, 'output stays small');
      assert.equal(out.stderr, '');
    });
  });
});

// ---- renamed databases and archives --------------------------------------------------------------------------------

describe('renamed private data is recognised by its content signature', () => {
  const sqliteHeader = Buffer.from('SQLite format 3\0');
  const cases: Array<[label: string, head: Buffer]> = [
    ['SQLite database', sqliteHeader],
    ['ZIP archive', Buffer.from([0x50, 0x4b, 0x03, 0x04])],
    ['empty ZIP archive', Buffer.from([0x50, 0x4b, 0x05, 0x06])],
    ['gzip stream', Buffer.from([0x1f, 0x8b, 0x08, 0x00])],
    ['7-Zip archive', Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04])],
    ['RAR archive', Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])],
    ['xz stream', Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])],
    ['zstd frame', Buffer.from([0x28, 0xb5, 0x2f, 0xfd])],
    ['bzip2 stream', Buffer.from('BZh91AY&SY', 'latin1')],
  ];
  const withBody = (head: Buffer, extra = 4000): Buffer => Buffer.concat([head, Buffer.alloc(extra, 7)]);

  for (const [label, head] of cases) {
    it(`flags a ${label} under an innocuous name`, async () => {
      await inRepo(async (dir) => {
        await put(dir, 'data/notes.dat', withBody(head));
        await put(dir, 'README', withBody(head));
        const result = await scanRepo(dir);
        assert.deepEqual(summarize(result.findings), [
          ['forbidden-file-signature', 'README', undefined],
          ['forbidden-file-signature', 'data/notes.dat', undefined],
        ]);
      });
    });
  }

  it('also recognises it when the file is too large to be read (the large files are the interesting ones)', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'dump', withBody(sqliteHeader, 3 * 1024 * 1024));
      const result = await scanRepo(dir);
      assert.equal(result.skippedLarge, 1);
      assert.deepEqual(summarize(result.findings), [['forbidden-file-signature', 'dump', undefined]]);
    });
  });

  it('reports only the extension when the name already gives it away', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'chats.sqlite', withBody(sqliteHeader));
      await put(dir, 'x.ZIP', withBody(cases[1]?.[1] ?? Buffer.alloc(0)));
      assert.deepEqual(summarize((await scanRepo(dir)).findings), [
        ['forbidden-extension', 'chats.sqlite', undefined],
        ['forbidden-extension', 'x.ZIP', undefined],
      ]);
    });
  });

  it('does not flag legitimate ZIP-based document and package formats, or other binary and text files', async () => {
    await inRepo(async (dir) => {
      const zip = withBody(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      for (const name of ['a.docx', 'b.XLSX', 'c.pptx', 'd.jar', 'e.vsix', 'f.nupkg', 'g.whl', 'h.epub', 'i.apk', 'j.odt']) await put(dir, name, zip);
      await put(dir, 'logo.png', withBody(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
      await put(dir, 'doc.txt', 'SQLite format 3 is the file header of a SQLite database; PK is the ZIP signature.\n');
      await put(dir, 'offset.bin', Buffer.concat([Buffer.from('x'), sqliteHeader, Buffer.alloc(100)]));
      await put(dir, 'tiny.bin', Buffer.from([0x50]));
      await put(dir, 'empty.bin', Buffer.alloc(0));
      assert.deepEqual((await scanRepo(dir)).findings, []);
    });
  });

  it('honours the allow-file for a signature finding, for that exact path only', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'data/ok.dat', withBody(sqliteHeader));
      await put(dir, 'data/other.dat', withBody(sqliteHeader));
      await put(dir, '.privacy-scan-allow', '# synthetic empty database used by a test\ndata/ok.dat\n');
      assert.deepEqual(summarize((await scanRepo(dir)).findings), [['forbidden-file-signature', 'data/other.dat', undefined]]);
    });
  });

  it('never prints file bytes in the finding', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'data/notes.dat', withBody(sqliteHeader));
      const out = await main(['--root', dir, '--json']);
      assert.equal(out.exitCode, 1);
      assert.ok(!out.stdout.includes('SQLite format'));
    });
  });
});

// ---- text encodings ---------------------------------------------------------------------------------------------------

describe('UTF-16 text (PowerShell redirection, Windows editors)', () => {
  const body = `first line\r\nAPI_KEY=${key(10)}\r\nlast line\r\n`;
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, 'utf16le')]);
  const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(le.subarray(2)).swap16()]);

  it('is decoded and scanned instead of being skipped as binary', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'notes/le.txt', le);
      await put(dir, 'notes/be.txt', be);
      const result = await scanRepo(dir);
      assert.deepEqual(summarize(result.findings), [
        ['openai-api-key', 'notes/be.txt', 2],
        ['openai-api-key', 'notes/le.txt', 2],
      ]);
      assert.equal(result.scannedFiles, 2);
      assert.equal(result.skippedBinary, 0);
    });
  });

  it('still treats NUL-bearing data without a byte-order mark as binary, and tolerates a truncated mark', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'raw.bin', Buffer.from(body, 'utf16le'));
      await put(dir, 'cut.bin', Buffer.from([0xff, 0xfe, 0x41]));
      await put(dir, 'one.bin', Buffer.from([0xff]));
      const result = await scanRepo(dir);
      assert.deepEqual(result.findings, []);
      assert.equal(result.skippedBinary, 1);
    });
  });
});

// ---- fixtures that are not actually synthetic ---------------------------------------------------------------------------

describe('fixtures must prove they are synthetic', () => {
  const chatgpt = '[{"title":"TITLE","mapping":{"a":{"id":"a","message":null,"parent":null,"children":[]}},"current_node":"a","create_time":1.5}]';
  const claude = '[{"uuid":"u","name":"TITLE","chat_messages":[{"uuid":"m","text":"hi","sender":"human"}]}]';

  it('rejects export-shaped fixtures whose file name does not look like an export', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'fixtures/chatgpt/real-history.json', chatgpt.replace('TITLE', 'my private plans'));
      await put(dir, 'fixtures/claude/me.json', claude.replace('TITLE', 'my private plans'));
      await put(dir, 'fixtures/chatgpt/synthetic.json', chatgpt.replace('TITLE', `${SYNTHETIC_MARKER} F99`));
      await put(dir, 'fixtures/claude/synthetic.json', claude.replace('TITLE', `${SYNTHETIC_MARKER} F98`));
      assert.deepEqual(summarize((await scanRepo(dir)).findings), [
        ['synthetic-marker-missing', 'fixtures/chatgpt/real-history.json', undefined],
        ['synthetic-marker-missing', 'fixtures/claude/me.json', undefined],
      ]);
    });
  });

  it('rejects an export-shaped file left outside fixtures/ under a harmless name', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'notes/history.json', chatgpt.replace('TITLE', 'my private plans'));
      await put(dir, 'notes/history.json.bak', claude.replace('TITLE', 'my private plans'));
      assert.deepEqual(summarize((await scanRepo(dir)).findings), [
        ['synthetic-marker-missing', 'notes/history.json', undefined],
        ['synthetic-marker-missing', 'notes/history.json.bak', undefined],
      ]);
    });
  });

  it('cannot verify the marker of a raw-export-named fixture that exceeds the scan limit, so it fails closed', async () => {
    await inRepo(async (dir) => {
      const text = chatgpt.replace('TITLE', `${SYNTHETIC_MARKER} F97`).padEnd(5000, ' ');
      await put(dir, 'fixtures/chatgpt/conversations.json', text);
      assert.deepEqual((await scanRepo(dir)).findings, []);
      const limited = await scanRepo(dir, { maxFileBytes: 1024 });
      assert.deepEqual(summarize(limited.findings), [['synthetic-marker-missing', 'fixtures/chatgpt/conversations.json', undefined]]);
      assert.match(limited.findings[0]?.detail ?? '', /scan limit/);
      assert.equal(limited.skippedLarge, 1);
    });
  });
});

// ---- local data directory and logs -----------------------------------------------------------------------------------------

describe('local data directories and logs', () => {
  it('flags a force-added file below .gcr/ and a log file', async () => {
    await inRepo(async (dir) => {
      await put(dir, '.gitignore', '.gcr/\n*.log\n');
      await put(dir, '.gcr/state.dat', 'x');
      await put(dir, 'run.log', 'x');
      await put(dir, 'src/ok.ts', 'export const x = 1;\n');
      assert.deepEqual((await scanRepo(dir)).findings, []); // ignored: never listed
      await git(dir, 'add', '-f', '.gcr/state.dat', 'run.log');
      assert.deepEqual(summarize((await scanRepo(dir)).findings), [
        ['private-data-directory', '.gcr/state.dat', undefined],
        ['forbidden-extension', 'run.log', undefined],
      ]);
    });
  });
});

// ---- the scanner never reaches the network -------------------------------------------------------------------------------------

describe('a partial clone is never completed over the network', () => {
  /** Number of objects in the object database (a lazy fetch would add the missing blobs). */
  async function objectCount(dir: string): Promise<number> {
    return (await git(dir, 'cat-file', '--batch-all-objects', '--batch-check')).split('\n').filter((l) => l !== '').length;
  }

  it('fails closed with a path-free message instead of fetching blobs from the promisor remote, in every mode', async () => {
    await withTempDir(async (base) => {
      const source = join(base, 'source');
      await initRepo(source);
      await git(source, 'config', 'uploadpack.allowFilter', 'true');
      await git(source, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
      await put(source, 'a.txt', `${key(40)}\n`);
      await commitAll(source, 'one');
      await put(source, 'b.txt', 'ok\n');
      await commitAll(source, 'two');
      const clone = join(base, 'clone');
      await execFileAsync('git', ['clone', '-q', '--no-checkout', '--filter=blob:none', `file://${source}`, clone], { encoding: 'utf8' });
      const before = await objectCount(clone);
      for (const history of [false, true]) {
        await assert.rejects(
          scanRepo(clone, { history }),
          (e) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT' && /partial clone/.test(e.message) && !e.message.includes(base),
          `history=${history}`,
        );
      }
      const out = await main(['--root', clone, '--history']);
      assert.equal(out.exitCode, 2);
      assert.match(out.stderr, /partial clone/);
      assert.ok(!out.stderr.includes(base));
      assert.equal(await objectCount(clone), before, 'the scan must not write objects into the repository it scans');
    });
  });
});

// ---- allow-file edge cases through the whole pipeline --------------------------------------------------------------------

describe('.privacy-scan-allow saved by a Windows editor', () => {
  it('honours the first entry even with a UTF-8 byte-order mark', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'a.sqlite', 'x');
      await put(dir, '.privacy-scan-allow', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a.sqlite\r\n')]));
      const result = await scanRepo(dir);
      assert.deepEqual(result.findings, []);
      assert.equal(result.allowListedFiles, 1);
    });
  });
});

// ---- cookie jars through the whole pipeline ----------------------------------------------------------------------------------

describe('cookie jar exports', () => {
  it('flags a renamed Playwright storage state and never prints a cookie value', async () => {
    await inRepo(async (dir) => {
      const value = rnd(60, 30);
      const state = JSON.stringify({ cookies: [{ name: join_('cf_', 'clearance'), value, domain: `.${join_('chat', 'gpt.com')}`, httpOnly: true }], origins: [] }, null, 2);
      await put(dir, 'auth/browser-state.json', state);
      const result = await scanRepo(dir);
      assert.deepEqual(summarize(result.findings), [['cookie-jar-entry', 'auth/browser-state.json', 4]]);
      const out = await main(['--root', dir, '--json']);
      assert.ok(!out.stdout.includes(value.slice(0, 5)));
    });
  });
});
