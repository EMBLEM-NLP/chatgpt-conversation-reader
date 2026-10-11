/**
 * Help output: every command is documented, in the same words the parser enforces; examples are synthetic; the text is
 * deterministic and free of terminal control characters; docs/CLI_HELP.txt (captured by scripts/capture-cli-help.mjs)
 * and docs/CLI_REFERENCE.md agree with the live CLI.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { COMMANDS, GROUPS, TOP_LEVEL_NAMES } from '../../src/cli/commands/index.js';
import { GLOBAL_OPTIONS } from '../../src/cli/options.js';
import { effectiveOptions } from '../../src/cli/parse.js';
import { ERROR_CODES, EXIT_CODES } from '../../src/errors.js';
import { TOOL_VERSION } from '../../src/version.js';
import { CLI_MAIN, REPO_ROOT, assertClean, assertOk, assertTextError, collect, gcr, isSyntheticId } from './cli.helpers.test.js';

async function helpOf(args: string[], env: Record<string, string | undefined> = {}): Promise<string> {
  const r = await gcr(args, { env });
  assertOk(r, `gcr ${args.join(' ')}`);
  assert.ok(r.stdout.length > 200, 'help is not empty');
  return r.stdout;
}

describe('help routing', () => {
  it('every spelling of "help for X" prints the same text, to stdout, with exit 0 and an empty stderr', async () => {
    const root = await helpOf(['--help']);
    assert.equal(await helpOf(['-h']), root);
    assert.equal(await helpOf(['help']), root);
    const list = await helpOf(['list', '--help']);
    assert.equal(await helpOf(['help', 'list']), list);
    assert.equal(await helpOf(['list', '-h']), list);
    assert.equal(await helpOf(['--help', 'list']), list, 'the switch may come before the command name');
    const build = await helpOf(['graph', 'build', '--help']);
    assert.equal(await helpOf(['help', 'graph', 'build']), build);
    assert.equal(await helpOf(['graph', '--db', 'x.sqlite', 'build', '-h']), build, 'options before the subcommand do not matter');
    const group = await helpOf(['graph', '--help']);
    assert.equal(await helpOf(['help', 'graph']), group);
    assert.match(group, /Commands:\n\s+build /);
  });

  it('--help wins over everything else on the line, even over errors in it', async () => {
    const withBad = await helpOf(['list', '--bogus', '--limit', 'nonsense', '--help']);
    assert.equal(withBad, await helpOf(['list', '--help']));
    assert.equal(await helpOf(['get', '--help']), await helpOf(['help', 'get']));
    assertTextError(await gcr(['search', '--', '--help']), 'DB_NOT_FOUND'); // after "--" it is the query, not a request for help
  });

  it('--version and -V print the tool name and version', async () => {
    for (const flag of ['--version', '-V']) {
      const r = await gcr([flag]);
      assert.equal(r.stdout, `gcr ${TOOL_VERSION}\n`);
      assert.equal(r.code, 0);
      assert.equal(r.stderr, '');
    }
    assertTextError(await gcr(['list', '--version']), 'INVALID_ARGUMENT');
  });

  it('asking for help on something that does not exist is a usage error with a suggestion', async () => {
    assertTextError(await gcr(['help', 'lst']), 'INVALID_ARGUMENT', { remedy: /Did you mean "list"/ });
    assertTextError(await gcr(['help', 'graph', 'bild']), 'INVALID_ARGUMENT', { remedy: /Did you mean "graph build"/ });
  });
});

describe('every command is documented', () => {
  it('the root help lists every top-level command and the global options', async () => {
    const root = await helpOf(['--help']);
    for (const name of TOP_LEVEL_NAMES) assert.match(root, new RegExp(`^  ${name}[ <]`, 'm'), `root help lists ${name}`);
    for (const option of Object.values(GLOBAL_OPTIONS)) assert.ok(root.includes(`--${option.name}`), `root help mentions --${option.name}`);
    assert.ok(root.includes('--version'));
    assert.ok(root.includes('Exit codes:'));
    assert.match(root, /never\s+contacts\s+chatgpt\.com/);
  });

  for (const spec of COMMANDS) {
    const name = spec.path.join(' ');
    it(`gcr ${name} --help: purpose, usage, every option with its default, examples, exit codes`, async () => {
      const text = await helpOf([...spec.path, '--help']);
      assert.ok(text.startsWith(`gcr ${name} - ${spec.summary}\n`), 'first line: name and one-line purpose');
      assert.match(text, /\nUsage:\n  gcr /);
      for (const o of effectiveOptions(spec)) {
        assert.ok(text.includes(`--${o.name}`), `${name}: --${o.name} is documented`);
        if (o.short !== undefined) assert.ok(text.includes(`-${o.short}, --${o.name}`));
        if (o.defaultText !== undefined) assert.ok(text.replace(/\s+/g, ' ').includes(`(default: ${o.defaultText.replace(/\s+/g, ' ')})`), `${name}: --${o.name} shows its default`);
        if (o.kind === 'choice') for (const c of o.choices ?? []) assert.ok(text.includes(c), `${name}: --${o.name} lists the value ${c}`);
      }
      for (const p of spec.positionals) assert.ok(text.includes(`<${p.name}>`), `${name}: argument <${p.name}>`);
      assert.match(text, /\nExamples:\n/);
      assert.ok(spec.examples.length >= 2, `${name}: at least two examples`);
      for (const ex of spec.examples) assert.ok(text.includes(`  gcr ${ex.command}\n`), `${name}: example "${ex.command}"`);
      assert.match(text, /\nExit codes:\n  0   success\n/);

      // Parse the exit-code section: "  N   CODE, CODE" lines with 6-space continuation lines; "  *" lines are notes.
      const byExit = new Map<number, string[]>();
      let current: number | undefined;
      for (const line of text.slice(text.indexOf('Exit codes:')).split('\n').slice(1)) {
        if (line === '') break;
        const head = /^  (\d+)\s+(.*)$/.exec(line);
        if (head !== null) {
          current = Number(head[1]);
          byExit.set(current, [...(byExit.get(current) ?? []), ...(head[2] ?? '').match(/[A-Z][A-Z_]+[A-Z]/g) ?? []]);
        } else if (/^  \*/.test(line)) current = undefined;
        else if (current !== undefined) byExit.set(current, [...(byExit.get(current) ?? []), ...line.match(/[A-Z][A-Z_]+[A-Z]/g) ?? []]);
      }
      const expected = new Set<string>([...spec.errors, 'INVALID_ARGUMENT', 'INTERNAL_ERROR']);
      const listed = new Set([...byExit.values()].flat().filter((w) => w !== 'OK'));
      for (const code of expected) {
        const n = EXIT_CODES[code as (typeof ERROR_CODES)[number]];
        assert.ok(byExit.get(n)?.includes(code) === true, `${name}: ${code} is listed under exit code ${n}`);
      }
      for (const code of listed) assert.ok(expected.has(code), `${name}: ${code} is listed but is not one of its error codes`);
    });
  }

  it('group pages list their subcommands', async () => {
    for (const g of GROUPS) {
      const text = await helpOf([g.name, '--help']);
      for (const c of g.children) assert.match(text, new RegExp(`^  ${c.path[1]} `, 'm'), `gcr ${g.name} lists ${c.path[1]}`);
    }
  });
});

describe('help text hygiene', () => {
  const all = async (): Promise<Map<string, string>> => {
    const pages = new Map<string, string>();
    pages.set('', await helpOf(['--help']));
    for (const g of GROUPS) pages.set(g.name, await helpOf([g.name, '--help']));
    for (const spec of COMMANDS) pages.set(spec.path.join(' '), await helpOf([...spec.path, '--help']));
    return pages;
  };

  it('uses only synthetic ids, no real-looking links, no personal paths, no addresses or secrets', async () => {
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    for (const [name, text] of await all()) {
      for (const id of text.match(uuid) ?? []) assert.ok(isSyntheticId(id.toLowerCase()), `gcr ${name}: "${id}" is not a synthetic id`);
      assert.equal(/\/home\/|\/Users\/|C:\\|@[a-z0-9-]+\.(com|org|net)\b/i.test(text), false, `gcr ${name}: personal path or address`);
      assert.equal(/\bsk-[A-Za-z0-9]{10,}|api[_-]?key|password|cookie\s*[:=]|bearer\s+\S{8,}/i.test(text), false, `gcr ${name}: secret-looking text`);
      for (const m of text.matchAll(/chatgpt\.com\/c\/([^\s"')]+)/g)) {
        const id = m[1] ?? '';
        assert.ok(id === '<uuid>' || isSyntheticId(id), `gcr ${name}: link with id "${id}"`);
      }
    }
  });

  it('has no control characters and no overlong lines (prose wraps at 80 columns; only example command lines may run longer)', async () => {
    for (const [name, text] of await all()) {
      assertClean(text, `help of gcr ${name}`);
      for (const line of text.split('\n')) {
        if (line.startsWith('  gcr ')) continue; // an example command line cannot be wrapped
        assert.ok(line.length <= 84, `gcr ${name}: line of ${line.length} columns: ${line}`);
      }
    }
  });

  it('is deterministic: the same text whatever the terminal, locale, time zone or directory', async () => {
    const a = await helpOf(['stats', '--help']);
    const b = await helpOf(['stats', '--help'], { COLUMNS: '20', LINES: '5', LANG: 'tr_TR.UTF-8', LC_ALL: 'de_DE.UTF-8', TZ: 'Asia/Tokyo', TERM: 'dumb', HOME: '/nonexistent', GCR_DB: '/nonexistent/db.sqlite' });
    assert.equal(a, b);
  });

  it('never advertises a way to send, post, browse or log in', async () => {
    for (const [name, text] of await all()) {
      const lowered = text.toLowerCase();
      for (const word of ['--send', '--post', '--open', '--browser', '--login', '--cookie', '--token', '--proxy', '--url ', '--endpoint']) {
        assert.equal(lowered.includes(word), false, `gcr ${name} mentions ${word}`);
      }
    }
    const draft = await helpOf(['draft', 'create', '--help']);
    assert.match(draft, /GCR never sends messages/);
    assert.match(draft, /No command or option sends, posts or opens a browser/);
  });
});

describe('documentation files agree with the CLI', () => {
  it('docs/CLI_HELP.txt is exactly what scripts/capture-cli-help.mjs captures from this build', async () => {
    const script = join(REPO_ROOT, 'scripts', 'capture-cli-help.mjs');
    assert.ok(existsSync(script), 'scripts/capture-cli-help.mjs exists');
    assert.ok(existsSync(join(REPO_ROOT, 'docs', 'CLI_HELP.txt')), 'docs/CLI_HELP.txt exists (run: npm run capture:cli-help)');
    const r = await collect(spawn(process.execPath, [script, '--check', '--cli', CLI_MAIN, '--out', join(REPO_ROOT, 'docs', 'CLI_HELP.txt')], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env['PATH'] ?? '' } }), { timeoutMs: 120_000 });
    assert.equal(r.code, 0, `docs/CLI_HELP.txt is out of date: ${r.stderr}`);
  });

  const reference = (): string => readFileSync(join(REPO_ROOT, 'docs', 'CLI_REFERENCE.md'), 'utf8');

  it('docs/CLI_REFERENCE.md has a section for every command listing all of its options', () => {
    const text = reference();
    for (const spec of COMMANDS) {
      const name = spec.path.join(' ');
      const heading = `### \`gcr ${name}\``;
      const start = text.indexOf(heading);
      assert.ok(start >= 0, `CLI_REFERENCE.md has the heading ${heading}`);
      const next = text.indexOf('\n### ', start + heading.length);
      const section = text.slice(start, next === -1 ? undefined : next);
      for (const o of spec.options) assert.ok(section.includes(`--${o.name}`), `${name}: --${o.name} is in its section of CLI_REFERENCE.md`);
      assert.ok(section.includes(spec.summary.replace(/\.$/, '')) || section.length > 200, `${name}: the section is not empty`);
    }
  });

  it('docs/CLI_REFERENCE.md has the exit code table of EXIT_CODES, every code, and the global options', () => {
    const text = reference();
    for (const [code, n] of Object.entries(EXIT_CODES)) {
      assert.match(text, new RegExp(`\\|\\s*\`${code}\`\\s*\\|\\s*${n}\\s*\\|`), `exit table row for ${code} = ${n}`);
    }
    for (const option of Object.values(GLOBAL_OPTIONS)) assert.ok(text.includes(`--${option.name}`), `global option --${option.name}`);
    for (const word of ['GCR_DB', 'GCR_DEBUG', 'NOT_IN_LOCAL_EXPORT', 'jq', 'EPIPE', 'SIGINT', 'SIGTERM']) assert.ok(text.includes(word), `mentions ${word}`);
    assert.match(text, /What the CLI deliberately cannot do/i);
  });

  it('docs use synthetic ids only', () => {
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    for (const file of ['CLI_REFERENCE.md', 'CLI_HELP.txt']) {
      const text = readFileSync(join(REPO_ROOT, 'docs', file), 'utf8');
      for (const id of text.match(uuid) ?? []) assert.ok(isSyntheticId(id.toLowerCase()), `${file}: "${id}"`);
    }
  });
});
