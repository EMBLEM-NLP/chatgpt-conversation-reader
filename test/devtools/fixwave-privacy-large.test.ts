/**
 * ATK-02: the privacy scanner must not wave a file through because it is large.
 *
 * Before the fix a file above the 2 MiB cap was skipped (path rules and a 16-byte signature only), so a real-sized export under
 * any name except `conversations*.json` scanned "clean" in the work tree and in history, and the skip never changed the exit
 * status. These tests generate SYNTHETIC export-shaped files at test time (no marker, nothing committed to this repository)
 * inside throwaway git repositories and check that: the head and tail of a large file are judged by every rule, whatever the file
 * is called; the unjudged remainder is a FAILING `unscanned-large-file` finding unless the path is allow-listed or lives below an
 * excluded directory; `--allow-large-unscanned` downgrades it for local use only; and history mode judges the shape of every
 * added file and fails closed when it had to stop reading.
 *
 * All secret-shaped text is assembled at run time from fragments so this file contains none.
 */
import assert from 'node:assert/strict';
import { open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  DEFAULT_MAX_FILE_BYTES,
  LARGE_FILE_HEAD_BYTES,
  LARGE_FILE_TAIL_BYTES,
  SYNTHETIC_MARKER,
  main,
  scanRepo,
} from '../../src/devtools/privacy-scan.js';
import { chatgptExportOfAtLeast, chatgptExportText, claudeExportText, commitAll, git, inRepo, join_, put, putAll, rnd, rulesOf, summarize } from './fixwave-privacy-helpers.js';

const key = (seed: number): string => join_('sk-', rnd(40, seed));
/** Bigger than the head and tail windows together, so the middle of the file is never read. */
const BIG = LARGE_FILE_HEAD_BYTES + LARGE_FILE_TAIL_BYTES + 5000;
const filler = (bytes: number): string => 'filler line of ordinary text\n'.repeat(Math.ceil(bytes / 29)).slice(0, bytes);

describe('ATK-02: export-shaped files above the size cap are judged by shape, whatever they are called', () => {
  // The reproduction of the finding: an 8 MB-class export under names other than conversations*.json scanned clean.
  const NAMES = [
    'my-chats.json',
    'data/chats.json',
    'export-2026.json',
    'conversations.jsonl',
    'my-conversations.json',
    'chatgpt-conversations.json',
    'conversation.json',
    'conversations/part1.json',
    'chatgpt/2026/convs.json',
    'chat-gpt-export-2026-10-01.json',
    'chatgpt-export/part1.json',
    'dump.txt',
    'backup',
    'chats.json.bak',
    'report.md',
  ];

  it(`reports every one of ${NAMES.length} names for a ChatGPT export above the default ${DEFAULT_MAX_FILE_BYTES}-byte cap (default options)`, async () => {
    await inRepo(async (dir) => {
      const text = chatgptExportOfAtLeast(DEFAULT_MAX_FILE_BYTES + 50_000);
      assert.ok(text.length > DEFAULT_MAX_FILE_BYTES);
      assert.ok(!text.includes(SYNTHETIC_MARKER));
      for (const name of NAMES) await put(dir, name, text);
      const result = await scanRepo(dir);
      assert.equal(result.skippedLarge, NAMES.length);
      for (const name of NAMES) {
        const mine = result.findings.filter((f) => f.path === name).map((f) => f.rule);
        assert.ok(mine.includes('synthetic-marker-missing'), `${name}: ${mine.join(',')}`);
        assert.ok(mine.includes('unscanned-large-file'), `${name}: ${mine.join(',')}`);
      }
      const cli = await main(['--root', dir]);
      assert.equal(cli.exitCode, 1);
    });
  });

  it('the same holds in history mode (the file was committed, then deleted)', async () => {
    await inRepo(async (dir) => {
      const text = chatgptExportOfAtLeast(DEFAULT_MAX_FILE_BYTES + 50_000);
      for (const name of NAMES.slice(0, 5)) await put(dir, name, text);
      await commitAll(dir, 'add');
      await git(dir, 'rm', '-q', '-r', '--', '.');
      await commitAll(dir, 'remove');
      const result = await scanRepo(dir, { history: true });
      for (const name of NAMES.slice(0, 5)) {
        const mine = result.findings.filter((f) => f.path === name);
        assert.ok(
          mine.some((f) => f.rule === 'synthetic-marker-missing' && /\[in history, commit [0-9a-f]{12}\]$/.test(f.detail)),
          `${name}: ${summarize(mine).join(' ')}`,
        );
      }
      assert.equal((await main(['--root', dir, '--history'])).exitCode, 1);
    });
  });

  it('recognises a ChatGPT export from its head alone even when current_node and conversation_id come after a huge mapping, and a Claude export', async () => {
    await inRepo(async (dir) => {
      // One conversation with a long mapping, as in a real archive: `mapping` and `create_time` are in the first bytes, `current_node` and
      // `conversation_id` only after the mapping. Non-JSON filler after it keeps them out of the tail window, so only the head can decide.
      const huge = chatgptExportText(1, 900);
      assert.ok(huge.slice(0, LARGE_FILE_HEAD_BYTES).includes('"mapping"') && !huge.slice(0, LARGE_FILE_HEAD_BYTES).includes('"current_node"'));
      await put(dir, 'a/one-huge-conversation.json', `${huge}\n${filler(BIG)}`);
      await put(dir, 'b/claude.json', claudeExportText(300, 20));
      const result = await scanRepo(dir, { maxFileBytes: 100_000 });
      assert.equal(result.skippedLarge, 2);
      assert.deepEqual(
        summarize(result.findings.filter((f) => f.rule === 'synthetic-marker-missing')),
        [
          ['synthetic-marker-missing', 'a/one-huge-conversation.json', undefined],
          ['synthetic-marker-missing', 'b/claude.json', undefined],
        ],
      );
    });
  });

  it('finds the shape keys in the TAIL window when the head holds none of them', async () => {
    await inRepo(async (dir) => {
      const tail = '"create_time":1.5,"mapping":{},"current_node":"a","conversation_id":"b"}]';
      await put(dir, 'x/late.json', `[{"padding":"${'x'.repeat(BIG)}",${tail}`);
      const result = await scanRepo(dir, { maxFileBytes: 100_000 });
      assert.deepEqual(rulesOf(result.findings.filter((f) => f.path === 'x/late.json')), ['synthetic-marker-missing', 'unscanned-large-file']);
    });
  });

  it('accepts a large file that carries the marker in its head window (and still flags the unjudged remainder)', async () => {
    await inRepo(async (dir) => {
      const text = chatgptExportOfAtLeast(BIG).replace('invented chat 0', `${SYNTHETIC_MARKER} chat 0`);
      await put(dir, 'fixtures/chatgpt/large-synthetic.json', text);
      const result = await scanRepo(dir, { maxFileBytes: 100_000 });
      assert.deepEqual(summarize(result.findings), [['unscanned-large-file', 'fixtures/chatgpt/large-synthetic.json', undefined]]);
    });
  });
});

describe('ATK-02: secrets in the head and tail windows of a large file are found', () => {
  it('finds a key on line 1 of a large Markdown file (it used to be skipped in work-tree mode)', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'docs/key10.md', `${key(1)}\n${filler(3 * 1024 * 1024)}`);
      const result = await scanRepo(dir);
      assert.deepEqual(summarize(result.findings), [
        ['unscanned-large-file', 'docs/key10.md', undefined],
        ['openai-api-key', 'docs/key10.md', 1],
      ]);
    });
  });

  it('finds a key in the last bytes of a large file, without inventing a line number, and masks it', async () => {
    await inRepo(async (dir) => {
      const secret = key(2);
      await put(dir, 'logs-notes.md', `${filler(BIG)}\nlast line ${secret}\n`);
      const result = await scanRepo(dir, { maxFileBytes: 100_000 });
      const hit = result.findings.find((f) => f.rule === 'openai-api-key');
      assert.ok(hit !== undefined);
      assert.equal(hit.line, undefined);
      assert.match(hit.detail, /\[in the last bytes of a large file\]$/);
      assert.ok(!hit.detail.includes(secret.slice(4, 12)));
      assert.ok(result.findings.some((f) => f.rule === 'unscanned-large-file'));
    });
  });

  it('judges the window boundaries exactly: the last head byte is read, the first byte after it is not', async () => {
    await inRepo(async (dir) => {
      const secret = key(3);
      // head window = bytes [0, HEAD): a key that ends exactly at HEAD is inside it, one that starts at HEAD is not.
      const inside = `${filler(LARGE_FILE_HEAD_BYTES - secret.length - 1)}\n${secret}`;
      assert.equal(inside.length, LARGE_FILE_HEAD_BYTES);
      await put(dir, 'inside.txt', `${inside}${filler(BIG)}`);
      await put(dir, 'outside.txt', `${filler(LARGE_FILE_HEAD_BYTES)}${secret}${filler(BIG)}`);
      const result = await scanRepo(dir, { maxFileBytes: 100_000 });
      assert.deepEqual(rulesOf(result.findings.filter((f) => f.path === 'inside.txt')).sort(), ['openai-api-key', 'unscanned-large-file']);
      // Not found, but NOT silent either: the unjudged middle is itself the failing finding.
      assert.deepEqual(rulesOf(result.findings.filter((f) => f.path === 'outside.txt')), ['unscanned-large-file']);
    });
  });

  it('reads files that fit inside head + tail in full, and goes partial one byte later', async () => {
    await inRepo(async (dir) => {
      const secret = key(4);
      const window = LARGE_FILE_HEAD_BYTES + LARGE_FILE_TAIL_BYTES;
      const mid = (total: number): string => `${filler(LARGE_FILE_HEAD_BYTES + 100)}\n${secret}\n${filler(total - LARGE_FILE_HEAD_BYTES - 100 - secret.length - 2)}`;
      await put(dir, 'exactly.txt', mid(window));
      await put(dir, 'onemore.txt', mid(window + 1));
      const result = await scanRepo(dir, { maxFileBytes: 1024 });
      assert.deepEqual(rulesOf(result.findings.filter((f) => f.path === 'exactly.txt')), ['openai-api-key']); // read in full: the key past the head window is found
      // One byte more and the two windows leave a 1-byte gap: the key (inside the tail window) is still found, and the gap is a finding.
      assert.deepEqual(rulesOf(result.findings.filter((f) => f.path === 'onemore.txt')), ['openai-api-key', 'unscanned-large-file']);
      assert.equal(result.skippedLarge, 1);
    });
  });
});

describe('ATK-02: what cannot be classified fails closed (unscanned-large-file)', () => {
  it('a large file of ordinary text is a failing finding with exit status 1, naming what was and was not judged', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'notes/big.md', filler(BIG));
      const result = await scanRepo(dir, { maxFileBytes: 100_000 });
      assert.deepEqual(summarize(result.findings), [['unscanned-large-file', 'notes/big.md', undefined]]);
      assert.match(result.findings[0]?.detail ?? '', new RegExp(`^file is ${BIG} bytes and above the scan limit: only its first ${LARGE_FILE_HEAD_BYTES} and last ${LARGE_FILE_TAIL_BYTES} bytes were scanned, the other ${BIG - LARGE_FILE_HEAD_BYTES - LARGE_FILE_TAIL_BYTES} bytes were NOT judged`));
      const out = await main(['--root', dir, '--max-file-bytes', '100000']);
      assert.equal(out.exitCode, 1);
      assert.match(out.stdout, /^notes\/big\.md: \[unscanned-large-file\] /m);
    });
  });

  it('a large binary-looking file (NUL bytes) is reported too, and is counted as large, not binary', async () => {
    await inRepo(async (dir) => {
      const bytes = Buffer.alloc(BIG, 7);
      bytes[10] = 0;
      await put(dir, 'blob.bin', bytes);
      const result = await scanRepo(dir, { maxFileBytes: 100_000 });
      assert.deepEqual(summarize(result.findings), [['unscanned-large-file', 'blob.bin', undefined]]);
      assert.match(result.findings[0]?.detail ?? '', /looks binary/);
      assert.equal(result.skippedLarge, 1);
      assert.equal(result.skippedBinary, 0);
    });
  });

  it('a small binary file stays a binary file (path and signature rules only), not an unscanned-large-file', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'blob.bin', Buffer.from([0, 1, 2, 3]));
      const result = await scanRepo(dir);
      assert.deepEqual(result.findings, []);
      assert.equal(result.skippedBinary, 1);
    });
  });

  it('text whose TAIL holds NUL bytes cannot be judged in the tail, which is reported as binary content', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'mixed.dat', Buffer.concat([Buffer.from(filler(BIG)), Buffer.alloc(100)]));
      const result = await scanRepo(dir, { maxFileBytes: 100_000 });
      assert.deepEqual(summarize(result.findings), [['unscanned-large-file', 'mixed.dat', undefined]]);
      assert.match(result.findings[0]?.detail ?? '', /looks binary/);
    });
  });

  it('a renamed database is reported by signature and as unjudged', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'data/dump', Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(BIG, 1)]));
      const result = await scanRepo(dir, { maxFileBytes: 100_000 });
      assert.deepEqual(rulesOf(result.findings), ['forbidden-file-signature', 'unscanned-large-file']);
    });
  });

  it('reads a very large sparse file through its windows only (no whole-file read), and fails closed', async () => {
    await inRepo(async (dir) => {
      const size = 512 * 1024 * 1024;
      const handle = await open(join(dir, 'huge.dat'), 'w');
      try {
        await handle.truncate(size);
      } finally {
        await handle.close();
      }
      const started = Date.now();
      const result = await scanRepo(dir);
      assert.ok(Date.now() - started < 20_000, `took ${Date.now() - started} ms`);
      assert.deepEqual(rulesOf(result.findings), ['unscanned-large-file']);
      assert.match(result.findings[0]?.detail ?? '', new RegExp(`^file is ${size} bytes`));
    });
  });
});

describe('ATK-02: an export inside a binary container is still recognised by its keys', () => {
  it('flags the JSON of an export stored verbatim in a tar-like or container file (NUL bytes around it), small or large, and spares ordinary binaries', async () => {
    await inRepo(async (dir) => {
      const json = Buffer.from(chatgptExportOfAtLeast(1));
      const container = (body: Buffer): Buffer => Buffer.concat([Buffer.alloc(512), body, Buffer.alloc(1024)]);
      await put(dir, 'backup.dat', container(json));
      await put(dir, 'backup-large.dat', container(Buffer.concat([json, Buffer.alloc(BIG)])));
      await put(dir, 'fixtures/marked.dat', container(Buffer.from(`${SYNTHETIC_MARKER} ${json.toString()}`)));
      await put(dir, 'image.bin', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]), Buffer.from('"mapping" alone is not an export')]));
      const result = await scanRepo(dir, { maxFileBytes: 100_000 });
      assert.deepEqual(summarize(result.findings), [
        ['synthetic-marker-missing', 'backup-large.dat', undefined],
        ['unscanned-large-file', 'backup-large.dat', undefined],
        ['synthetic-marker-missing', 'backup.dat', undefined],
      ]);
      assert.match(result.findings[0]?.detail ?? '', /^binary file contains the keys of a raw conversation export/);
      assert.equal(result.skippedBinary, 3); // backup.dat, fixtures/marked.dat, image.bin
    });
  });
});

describe('ATK-02: what is exempt, and the local-use flag', () => {
  it('a path listed in .privacy-scan-allow is exempt (it is not even read)', async () => {
    await inRepo(async (dir) => {
      await putAll(dir, { 'vendor/big.txt': filler(BIG), 'other/big.txt': filler(BIG), '.privacy-scan-allow': '# a known-safe large file\nvendor/big.txt\n' });
      const result = await scanRepo(dir, { maxFileBytes: 100_000 });
      assert.deepEqual(summarize(result.findings), [['unscanned-large-file', 'other/big.txt', undefined]]);
      assert.equal(result.allowListedFiles, 1);
    });
  });

  it('files below node_modules, dist, dist-test* and coverage are not reported as unscanned, but are counted and noted', async () => {
    await inRepo(async (dir) => {
      const exempt = ['node_modules/pkg/big.js', 'packages/a/node_modules/pkg/big.js', 'dist/big.js', 'dist-test-x/big.js', 'coverage/big.txt'];
      for (const p of exempt) await put(dir, p, filler(BIG));
      const result = await scanRepo(dir, { maxFileBytes: 100_000 });
      assert.deepEqual(result.findings, []);
      assert.equal(result.skippedLarge, exempt.length);
      assert.equal(result.unscannedLarge, exempt.length);
      assert.match(result.notes.join('\n'), /5 large file\(s\) were judged only in part and not reported/);
    });
  });

  it('look-alike directories are NOT exempt (only the exact names, and dist/coverage only at the root)', async () => {
    await inRepo(async (dir) => {
      const notExempt = ['src/dist/big.js', 'distiller/big.js', 'Node_Modules/pkg/big.js', 'my_node_modules/big.js', 'docs/coverage/big.txt', 'big-dist/x.js'];
      for (const p of notExempt) await put(dir, p, filler(BIG));
      const result = await scanRepo(dir, { maxFileBytes: 100_000 });
      assert.deepEqual(
        summarize(result.findings),
        [...notExempt].sort().map((p): [string, string, undefined] => ['unscanned-large-file', p, undefined]),
      );
    });
  });

  it('an excluded directory does not exempt what the windows DO show (shape, secrets)', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'node_modules/pkg/export.json', chatgptExportOfAtLeast(BIG));
      await put(dir, 'dist/notes.txt', `${key(5)}\n${filler(BIG)}`);
      const result = await scanRepo(dir, { maxFileBytes: 100_000 });
      assert.deepEqual(summarize(result.findings), [
        ['openai-api-key', 'dist/notes.txt', 1],
        ['synthetic-marker-missing', 'node_modules/pkg/export.json', undefined],
      ]);
    });
  });

  it('--allow-large-unscanned downgrades the finding to a note (exit 0) and says how many files were affected', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'notes/big.md', filler(BIG));
      const strict = await main(['--root', dir, '--max-file-bytes', '100000']);
      assert.equal(strict.exitCode, 1);
      const local = await main(['--root', dir, '--max-file-bytes', '100000', '--allow-large-unscanned']);
      assert.equal(local.exitCode, 0);
      assert.match(local.stderr, /^privacy-scan: note: 1 large file\(s\) were judged only in part and not reported .*: notes\/big\.md\n$/);
      const viaApi = await scanRepo(dir, { maxFileBytes: 100_000, allowLargeUnscanned: true });
      assert.deepEqual(viaApi.findings, []);
      assert.equal(viaApi.unscannedLarge, 1);
    });
  });

  it('the flag never hides what the windows show: shape and secrets still fail', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'my-chats.json', chatgptExportOfAtLeast(BIG));
      await put(dir, 'k.md', `${key(6)}\n${filler(BIG)}`);
      const out = await main(['--root', dir, '--max-file-bytes', '100000', '--allow-large-unscanned']);
      assert.equal(out.exitCode, 1);
      assert.match(out.stdout, /^my-chats\.json: \[synthetic-marker-missing\]/m);
      assert.match(out.stdout, /^k\.md:1: \[openai-api-key\]/m);
      assert.ok(!out.stdout.includes('unscanned-large-file'));
    });
  });

  it('the help text documents the flag as local use only', async () => {
    const help = (await main(['--help'])).stdout;
    assert.match(help, /--allow-large-unscanned {2}LOCAL USE ONLY/);
    assert.match(help, /--staged /);
  });
});

describe('ATK-02: history mode', () => {
  it('judges the shape of a small added export too (history used to check only fixtures/conversations*.json)', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'notes/history.json', chatgptExportOfAtLeast(1));
      await put(dir, 'notes/claude.txt', claudeExportText(2, 3));
      await commitAll(dir, 'add');
      await git(dir, 'rm', '-q', '-r', '--', '.');
      await commitAll(dir, 'remove');
      const result = await scanRepo(dir, { history: true });
      assert.deepEqual(summarize(result.findings), [
        ['synthetic-marker-missing', 'notes/claude.txt', undefined],
        ['synthetic-marker-missing', 'notes/history.json', undefined],
      ]);
      assert.match(result.findings[0]?.detail ?? '', /\[in history, commit [0-9a-f]{12}\]$/);
    });
  });

  it('does not flag a marked synthetic export in history (no false positive), nor a mention of the keys in source or docs', async () => {
    await inRepo(async (dir) => {
      await putAll(dir, {
        'fixtures/chatgpt/x.json': chatgptExportOfAtLeast(1).replace('invented chat 0', `${SYNTHETIC_MARKER} chat 0`),
        'src/mention.ts': 'export const keys = ["mapping", "current_node", "create_time", "conversation_id", "chat_messages", "uuid", "sender"];\n',
        'docs/mention.md': 'The export has "mapping", "current_node", "create_time" and "conversation_id" keys.\n',
      });
      await commitAll(dir, 'add');
      assert.deepEqual((await scanRepo(dir, { history: true })).findings, []);
    });
  });

  it('finds a secret anywhere in a large added file (history reads all added lines up to its cap) and has no unscanned-large-file', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'docs/big.md', `${filler(BIG)}\n${key(7)}\n${filler(BIG)}`);
      await commitAll(dir, 'add');
      await git(dir, 'rm', '-q', '--', 'docs/big.md');
      await commitAll(dir, 'remove');
      const result = await scanRepo(dir, { history: true, maxFileBytes: 100_000 });
      assert.deepEqual(summarize(result.findings).map((f) => f[0]), ['openai-api-key']);
      assert.match(result.findings[0]?.detail ?? '', /\[in history, commit [0-9a-f]{12}\]$/);
    });
  });

  it('a history cut by the byte cap fails closed (scan-truncated) but still shape-judges the part it did read', async () => {
    await inRepo(async (dir) => {
      // `git log` lists the newest commit first, so the big file is read last; the cap cuts it after its first ~100 KB.
      await put(dir, 'my-chats.json', chatgptExportOfAtLeast(BIG * 2));
      await commitAll(dir, 'add the export-shaped file');
      await put(dir, 'later.txt', 'a later commit\n');
      await commitAll(dir, 'later');
      const result = await scanRepo(dir, { history: true, maxHistoryBytes: 100_000 });
      assert.equal(result.history?.truncated, true);
      assert.ok(rulesOf(result.findings).includes('scan-truncated'));
      assert.ok(result.findings.some((f) => f.rule === 'synthetic-marker-missing' && f.path === 'my-chats.json' && /\[in history, commit [0-9a-f]{12}\]$/.test(f.detail)));
      const local = await scanRepo(dir, { history: true, maxHistoryBytes: 100_000, allowLargeUnscanned: true });
      assert.ok(!rulesOf(local.findings).includes('scan-truncated'));
      assert.match(local.notes.join('\n'), /history scan truncated/);
    });
  });

  it('the staged-diff pass of a normal scan fails closed when it was cut short, too', async () => {
    await inRepo(async (dir) => {
      await put(dir, 'big.txt', filler(200_000));
      await git(dir, 'add', 'big.txt');
      const result = await scanRepo(dir, { maxHistoryBytes: 5000 });
      assert.deepEqual(summarize(result.findings), [['scan-truncated', '(staged diff)', undefined]]);
      assert.deepEqual(await scanRepo(dir, { maxHistoryBytes: 5000, allowLargeUnscanned: true }).then((r) => r.findings), []);
    });
  });
});

describe('ATK-02: the scan stays quick on a large tree', () => {
  it('judges a 6 MiB export through its windows quickly', async () => {
    await inRepo(async (dir) => {
      const text = chatgptExportOfAtLeast(6 * 1024 * 1024);
      await writeFile(join(dir, 'export.json'), text);
      const started = Date.now();
      const result = await scanRepo(dir);
      assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
      assert.deepEqual(rulesOf(result.findings), ['synthetic-marker-missing', 'unscanned-large-file']);
    });
  });
});
