/**
 * Privacy scanner, PATH rules (scanPaths) and the allow-file parser. Pure functions: no git, no file system.
 * Every rule has positive and negative cases; matching is case-insensitive and depth-independent.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { parseAllowFile, scanPaths } from '../../src/devtools/privacy-scan.js';

const rulesFor = (path: string, allow?: string[]): string[] => scanPaths([path], allow === undefined ? {} : { allow }).map((f) => f.rule);

describe('forbidden extensions', () => {
  const extensions = [
    '.sqlite', '.sqlite3', '.db', '.db-wal', '.db-shm', '.zip', '.tar', '.tgz', '.gz', '.7z', '.rar', '.har',
    '.pem', '.key', '.p12', '.pfx', '.jks', '.kdbx',
  ];
  for (const ext of extensions) {
    it(`flags ${ext} at any depth and in any case`, () => {
      assert.deepEqual(rulesFor(`data${ext}`), ['forbidden-extension']);
      assert.deepEqual(rulesFor(`a/b/c/data${ext}`), ['forbidden-extension']);
      assert.deepEqual(rulesFor(`A/B/DATA${ext.toUpperCase()}`), ['forbidden-extension']);
    });
  }

  it('flags dot-only database names and archives with compound extensions', () => {
    assert.deepEqual(rulesFor('.db'), ['forbidden-extension']);
    assert.deepEqual(rulesFor('backup.tar.gz'), ['forbidden-extension']);
  });

  it('does not flag look-alikes', () => {
    for (const p of ['README.md', 'src/dbutil.ts', 'docs/keyboard.md', 'notes.sqlite.md', 'key.txt', 'src/zipper.ts', 'a/monkey.keys', 'db/schema.ts', 'x.gzip.md', 'tar']) {
      assert.deepEqual(rulesFor(p), [], p);
    }
  });
});

describe('forbidden basenames', () => {
  const names = [
    'cookies.json', 'cookie.json', 'session.json', 'storage_state.json', 'auth.json', 'user.json', 'user_settings.json',
    'message_feedback.json', 'shared_conversations.json', 'model_comparisons.json', 'group_chats.json',
    'conversation_asset_file_names.json', 'library_files.json', 'export_manifest.json', 'chat.html',
  ];
  for (const name of names) {
    it(`flags ${name} at any depth and in any case`, () => {
      assert.deepEqual(rulesFor(name), ['forbidden-filename']);
      assert.deepEqual(rulesFor(`x/y/${name}`), ['forbidden-filename']);
      assert.deepEqual(rulesFor(`x/${name.toUpperCase()}`), ['forbidden-filename']);
    });
  }

  it('flags .env and .env.* but not .env.example', () => {
    for (const p of ['.env', 'sub/.env', '.env.local', 'a/.ENV.production', '.env.example.bak', '.Env']) {
      assert.deepEqual(rulesFor(p), ['forbidden-filename'], p);
    }
    for (const p of ['.env.example', 'pkg/.env.example', 'pkg/.ENV.EXAMPLE', 'foo.env', '.envrc', 'env', 'environment.ts']) {
      assert.deepEqual(rulesFor(p), [], p);
    }
  });

  it('does not flag names that merely contain a forbidden name', () => {
    for (const p of ['users.json', 'my-session.json', 'user.json.md', 'chat.html.md', 'auth.js', 'src/cookies.ts', 'docs/auth.json.md']) {
      assert.deepEqual(rulesFor(p), [], p);
    }
  });
});

describe('conversation export files', () => {
  it('flags conversations.json and conversations-<digits>.json outside fixtures/', () => {
    for (const p of ['conversations.json', 'src/conversations-001.json', 'a/b/CONVERSATIONS-12.JSON', 'docs/conversations.json']) {
      assert.deepEqual(rulesFor(p), ['export-file-outside-fixtures'], p);
    }
  });

  it('does not flag near-miss names', () => {
    for (const p of ['conversations-abc.json', 'conversations.json.md', 'my-conversations.json', 'conversations-.json', 'conversation.json']) {
      assert.deepEqual(rulesFor(p), [], p);
    }
  });

  it('tolerates them under the ROOT fixtures/ directory (the marker is a content rule)', () => {
    for (const p of ['fixtures/conversations.json', 'fixtures/chatgpt/conversations-000.json', 'fixtures/a/b/CONVERSATIONS.JSON']) {
      assert.deepEqual(rulesFor(p), [], p);
    }
  });

  it('does not extend the fixtures exemption to look-alike or nested directories', () => {
    for (const p of ['Fixtures/conversations.json', 'test/fixtures/conversations.json', 'fixtures2/conversations.json', 'xfixtures/conversations.json']) {
      assert.deepEqual(rulesFor(p), ['export-file-outside-fixtures'], p);
    }
  });

  it('folds . and .. segments before judging the location', () => {
    assert.deepEqual(rulesFor('fixtures/../conversations.json'), ['export-file-outside-fixtures']);
    assert.deepEqual(rulesFor('./fixtures/conversations.json'), []);
  });

  it('keeps forbidden file names forbidden inside fixtures/', () => {
    assert.deepEqual(rulesFor('fixtures/user.json'), ['forbidden-filename']);
    assert.deepEqual(rulesFor('fixtures/export.zip'), ['forbidden-extension']);
  });
});

describe('export / exports / private directories', () => {
  it('flags json and zip files below such a directory at any depth, case-insensitively', () => {
    for (const p of ['export/data.json', 'a/Exports/x.json', 'private/notes.json', 'x/PRIVATE/y/z.json', 'deep/er/export/sub/thing.JSON']) {
      assert.deepEqual(rulesFor(p), ['export-directory'], p);
    }
    // a zip is reported for both reasons
    assert.deepEqual(rulesFor('exports/a.zip'), ['export-directory', 'forbidden-extension']);
  });

  it('does not flag other files in those directories or look-alike directories', () => {
    for (const p of ['export/readme.md', 'src/export.json', 'exporter/data.json', 'private-notes/data.json', 'docs/private.md', 'export', 'src/exports.ts', 'a/exported/x.json']) {
      assert.deepEqual(rulesFor(p), [], p);
    }
  });

  it('treats backslashes as separators so Windows-style paths cannot dodge the rule', () => {
    assert.deepEqual(rulesFor('export\\data.json'), ['export-directory']);
  });
});

describe('allow list mechanics on scanPaths', () => {
  it('exempts only the exact path', () => {
    assert.deepEqual(rulesFor('fixtures/user.json', ['fixtures/user.json']), []);
    assert.deepEqual(rulesFor('fixtures/other/user.json', ['fixtures/user.json']), ['forbidden-filename']);
    assert.deepEqual(rulesFor('x/fixtures/user.json', ['fixtures/user.json']), ['forbidden-filename']);
    assert.deepEqual(rulesFor('fixtures/user.json.bak', ['fixtures/user.json']), []); // different, harmless name
  });

  it('is case-sensitive and does not match prefixes', () => {
    assert.deepEqual(rulesFor('Fixtures/User.json', ['fixtures/user.json']), ['forbidden-filename']);
    assert.deepEqual(rulesFor('a/b.sqlite', ['a']), ['forbidden-extension']);
    assert.deepEqual(rulesFor('a/b.sqlite', ['a/']), ['forbidden-extension']);
  });

  it('never treats an entry as a glob', () => {
    for (const entry of ['fixtures/*.sqlite', 'fixtures/**', '*', 'fixtures/?.sqlite', 'fixtures/[a].sqlite', '**/*.sqlite']) {
      assert.deepEqual(rulesFor('fixtures/a.sqlite', [entry]), ['forbidden-extension'], entry);
    }
  });
});

describe('parseAllowFile', () => {
  it('reads exact paths, skips blank lines and comment lines, tolerates CRLF and surrounding spaces', () => {
    const { entries, findings } = parseAllowFile('# why: synthetic export\r\nfixtures/user.json\r\n\r\n  docs/a b.md  \r\n   # indented comment\r\n');
    assert.deepEqual([...entries].sort(), ['docs/a b.md', 'fixtures/user.json']);
    assert.deepEqual(findings, []);
  });

  it('reports invalid entries with line numbers and never adds them', () => {
    const text = [
      '# header',
      'fixtures/*.json', // 2 glob
      '/abs/path.json', // 3 absolute
      'dir/', // 4 directory
      'a/../b.json', // 5 traversal
      './x.json', // 6 non-normalized
      'a\\b.json', // 7 backslash
      'ok/path.json', // 8 valid
      'ok2/path.json # reason', // 9 inline comment
      'C:/x.json', // 10 drive
      'a//b.json', // 11 empty segment
    ].join('\n');
    const { entries, findings } = parseAllowFile(text);
    assert.deepEqual([...entries], ['ok/path.json']);
    assert.deepEqual(
      findings.map((f) => [f.rule, f.path, f.line]),
      [2, 3, 4, 5, 6, 7, 9, 10, 11].map((n) => ['allow-file-invalid', '.privacy-scan-allow', n]),
    );
    for (const f of findings) assert.match(f.detail, /^entry ignored: /);
  });

  it('keeps square brackets and parentheses that are legal in real file names', () => {
    const { entries, findings } = parseAllowFile('app/[id]/page.tsx\nweird (copy).md\n');
    assert.deepEqual([...entries].sort(), ['app/[id]/page.tsx', 'weird (copy).md']);
    assert.deepEqual(findings, []);
  });
});

describe('determinism', () => {
  const corpus = [
    'b.sqlite', 'a/.env', 'conversations.json', 'export/x.json', 'fixtures/conversations.json', 'z/chat.html', 'src/ok.ts',
    'A.ZIP', 'a/auth.json', 'private/p.zip', 'm/n/o.pem',
  ];

  it('sorts findings by path, then rule, regardless of input order', () => {
    const sorted = scanPaths(corpus);
    const paths = sorted.map((f) => f.path);
    assert.deepEqual(paths, [...paths].sort());
    assert.ok(sorted.length >= 9);
  });

  it('is independent of input order and duplicates (property)', () => {
    const expected = scanPaths(corpus);
    fc.assert(
      fc.property(fc.shuffledSubarray(corpus, { minLength: corpus.length }), fc.boolean(), (shuffled, dup) => {
        const input = dup ? [...shuffled, ...shuffled] : shuffled;
        assert.deepEqual(scanPaths(input), expected);
      }),
      { numRuns: 100 },
    );
  });

  it('matches case-insensitively for every forbidden extension (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('.sqlite', '.db', '.pem', '.zip', '.har', '.kdbx'),
        fc.array(fc.constantFrom('src', 'a', 'B', 'x y', 'üñí'), { maxLength: 4 }),
        fc.string({ minLength: 1, maxLength: 8 }).filter((s) => !/[/\\]/.test(s) && s !== '.' && s !== '..'),
        fc.boolean(),
        (ext, dirs, stem, upper) => {
          const name = `${stem}${upper ? ext.toUpperCase() : ext}`;
          const rules = rulesFor([...dirs, name].join('/'));
          assert.ok(rules.includes('forbidden-extension'), rules.join());
        },
      ),
      { numRuns: 200 },
    );
  });
});
