/**
 * In-process tests of the CLI's pure parts: the option parser, command routing, text helpers, the warning predicate and the
 * invariants of the command table (the single source of truth for parsing, help and the documentation).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AUDIT_CHECKS } from '../../src/analysis/audit.js';
import { STATS_GROUP_BY } from '../../src/analysis/stats.js';
import { COMMANDS, GROUPS, TOP_LEVEL_NAMES } from '../../src/cli/commands/index.js';
import { AUDIT_FLAGS, STATS_GROUPS } from '../../src/cli/commands/read.js';
import { checkPositionals, effectiveOptions, parseCommandArgs } from '../../src/cli/parse.js';
import { resolveRoute, wantsDebug, wantsHelp, wantsJsonErrors, wantsVersion } from '../../src/cli/route.js';
import type { OptionSpec } from '../../src/cli/spec.js';
import { editDistance, nearest, printable } from '../../src/cli/text.js';
import { ERROR_CODES, EXIT_CODES, GcrError } from '../../src/errors.js';
import { EDGE_KINDS, NODE_KINDS } from '../../src/graph/build.js';
import { isNodeSqliteExperimentalWarning } from '../../src/suppress-warnings.js';
import { isSyntheticId } from './cli.helpers.test.js';

const SAMPLE: OptionSpec[] = [
  { name: 'db', kind: 'string', valueName: 'path', description: 'db' },
  { name: 'format', kind: 'choice', choices: ['json', 'markdown'], description: 'format' },
  { name: 'limit', kind: 'int', min: 1, max: 200, description: 'limit' },
  { name: 'offset', kind: 'int', min: 0, max: 1000, description: 'offset' },
  { name: 'kinds', kind: 'list', choices: ['a', 'b', 'c'], description: 'kinds' },
  { name: 'tags', kind: 'list', description: 'free list' },
  { name: 'quiet', kind: 'boolean', description: 'quiet' },
  { name: 'help', short: 'h', kind: 'boolean', description: 'help' },
];

function usage(fn: () => unknown, pattern?: RegExp): GcrError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof GcrError, `expected a GcrError, got ${String(e)}`);
    assert.equal(e.code, 'INVALID_ARGUMENT');
    assert.equal(typeof e.remedy, 'string', 'every usage error carries a remedy');
    if (pattern !== undefined) assert.match(e.message + ' ' + (e.remedy ?? ''), pattern);
    return e;
  }
  assert.fail('expected INVALID_ARGUMENT');
}

const parse = (args: string[]): ReturnType<typeof parseCommandArgs> => parseCommandArgs(args, SAMPLE, 'gcr sample');

describe('option parsing: forms', () => {
  it('accepts --opt value and --opt=value alike', () => {
    assert.equal(parse(['--db', 'a.sqlite']).string('db'), 'a.sqlite');
    assert.equal(parse(['--db=a.sqlite']).string('db'), 'a.sqlite');
    assert.equal(parse(['--db=with=equals']).string('db'), 'with=equals');
  });

  it('options may come before or after positionals; a lone "-" is a positional', () => {
    const r = parse(['one', '--limit', '5', '-', 'two']);
    assert.deepEqual([...r.positionals], ['one', '-', 'two']);
    assert.equal(r.int('limit'), 5);
  });

  it('"--" ends option parsing: dash-led words become positionals', () => {
    const r = parse(['--quiet', '--', '--db', '-x', '--help']);
    assert.deepEqual([...r.positionals], ['--db', '-x', '--help']);
    assert.equal(r.flag('quiet'), true);
    assert.equal(r.flag('help'), false);
    assert.equal(r.has('db'), false);
  });

  it('a value that starts with a dash needs the "=" form', () => {
    assert.equal(parse(['--db=-weird.sqlite']).string('db'), '-weird.sqlite');
    usage(() => parse(['--db', '-weird.sqlite']), /needs a value/);
    usage(() => parse(['--db', '--quiet']), /needs a value/);
  });

  it('short -h works and unknown short flags are rejected', () => {
    assert.equal(parse(['-h']).flag('help'), true);
    usage(() => parse(['-x']), /Unknown option/);
  });

  it('switches are absent, true, and may repeat', () => {
    assert.equal(parse([]).flag('quiet'), false);
    assert.equal(parse(['--quiet']).flag('quiet'), true);
    assert.equal(parse(['--quiet', '--quiet']).flag('quiet'), true);
    usage(() => parse(['--quiet=yes']), /does not take a value/);
  });
});

describe('option parsing: errors', () => {
  it('a missing value is a usage error with a remedy', () => {
    usage(() => parse(['--db']), /needs a value/);
    usage(() => parse(['--limit']), /needs a value/);
  });

  it('an empty value is refused', () => {
    usage(() => parse(['--db=']), /non-empty/);
    usage(() => parse(['--db', '']), /non-empty/);
  });

  it('a repeated value option is an error, never "last one wins"', () => {
    usage(() => parse(['--db', 'a', '--db', 'b']), /more than once/);
    usage(() => parse(['--limit=1', '--limit=2']), /more than once/);
    usage(() => parse(['--limit=1', '--limit', '1']), /more than once/);
  });

  it('list options accumulate repeats and commas, de-duplicated in first-seen order', () => {
    assert.deepEqual(parse(['--kinds', 'a,b', '--kinds', 'c', '--kinds=a']).list('kinds'), ['a', 'b', 'c']);
    assert.deepEqual(parse(['--tags', ' x , y ']).list('tags'), ['x', 'y']);
    assert.equal(parse([]).list('kinds'), undefined);
  });

  it('list entries must be non-empty and from the allowed set', () => {
    usage(() => parse(['--kinds', 'a,,b']), /without empty entries/);
    usage(() => parse(['--kinds', '']), /without empty entries/);
    usage(() => parse(['--kinds', 'a,z']), /accepts only: a, b, c/);
  });

  it('integers: plain decimal digits within range', () => {
    assert.equal(parse(['--limit', '1']).int('limit'), 1);
    assert.equal(parse(['--limit', '200']).int('limit'), 200);
    assert.equal(parse(['--limit', '007']).int('limit'), 7);
    assert.equal(parse(['--offset', '0']).int('offset'), 0);
    for (const bad of ['1e3', '0x10', ' 5', '5 ', '5.0', '+5', '-1', 'abc', '1,000', '٣', '9'.repeat(16)]) {
      usage(() => parse([`--limit=${bad}`]), /whole number/);
    }
    usage(() => parse(['--limit=0']), /out of range/);
    usage(() => parse(['--limit=201']), /out of range/);
    usage(() => parse(['--limit=99999999999999']), /out of range/);
  });

  it('a negative number is reachable only through "=", and then it is out of range', () => {
    usage(() => parse(['--limit', '-1']), /needs a value/);
    usage(() => parse(['--limit=-1']), /whole number/);
  });

  it('choices name the valid values', () => {
    assert.equal(parse(['--format=json']).choice<'json'>('format'), 'json');
    const e = usage(() => parse(['--format=xml']), /one of: json, markdown/);
    assert.deepEqual(e.details?.['valid'], ['json', 'markdown']);
    usage(() => parse(['--format=JSON']), /one of/);
  });

  it('unknown options are refused with a "did you mean" and never echo control characters', () => {
    usage(() => parse(['--lmit', '5']), /Did you mean "--limit"/);
    usage(() => parse(['--unknown']), /Unknown option "--unknown"/);
    const e = usage(() => parse([`--bad${String.fromCharCode(0x1b)}[31m`]), /Unknown option/);
    assert.equal(e.message.includes(String.fromCharCode(0x1b)), false);
    assert.equal((e.remedy ?? '').includes(String.fromCharCode(0x1b)), false);
  });

  it('option names are case sensitive', () => {
    usage(() => parse(['--DB', 'x']), /Unknown option/);
  });
});

describe('positional arguments', () => {
  const specs = [{ name: 'ref', description: 'r' }, { name: 'more', description: 'm', optional: true }];

  it('missing, extra and empty arguments are usage errors', () => {
    checkPositionals(['a'], specs, 'gcr x');
    checkPositionals(['a', 'b'], specs, 'gcr x');
    usage(() => checkPositionals([], specs, 'gcr x'), /Missing argument <ref>/);
    usage(() => checkPositionals(['a', 'b', 'c'], specs, 'gcr x'), /Too many arguments/);
    usage(() => checkPositionals([''], specs, 'gcr x'), /empty/);
    usage(() => checkPositionals(['a'], [], 'gcr x'), /Too many arguments/);
  });
});

describe('command routing', () => {
  it('finds leaf commands, groups and subcommands; the rest goes to the command parser', () => {
    const list = resolveRoute(['list', '--limit', '5']);
    assert.ok(list.kind === 'run' && list.spec.path.join(' ') === 'list');
    assert.deepEqual(list.kind === 'run' ? list.rest : [], ['--limit', '5']);
    const build = resolveRoute(['graph', 'build', '--min-conversations', '3']);
    assert.ok(build.kind === 'run' && build.spec.path.join(' ') === 'graph build');
    const draft = resolveRoute(['draft', 'create', '--conversation', 'x']);
    assert.ok(draft.kind === 'run' && draft.spec.path.join(' ') === 'draft create');
  });

  it('global options with values may precede the command', () => {
    const r = resolveRoute(['--db', 'x.sqlite', '--format=json', 'list']);
    assert.ok(r.kind === 'run' && r.spec.path[0] === 'list');
    assert.deepEqual(r.kind === 'run' ? r.rest : [], ['--db', 'x.sqlite', '--format=json']);
    const g = resolveRoute(['--tz', 'Europe/Berlin', 'graph', '--db', 'y', 'query', 'term']);
    assert.ok(g.kind === 'run' && g.spec.path.join(' ') === 'graph query');
    assert.deepEqual(g.kind === 'run' ? g.rest : [], ['--tz', 'Europe/Berlin', '--db', 'y', 'term']);
  });

  it('help forms', () => {
    assert.equal(resolveRoute(['--help']).kind, 'help-root');
    assert.equal(resolveRoute(['-h']).kind, 'help-root');
    assert.equal(resolveRoute(['help']).kind, 'help-root');
    assert.equal(resolveRoute(['--version']).kind, 'version');
    assert.equal(resolveRoute(['-V']).kind, 'version');
    assert.equal(resolveRoute(['graph', '--help']).kind, 'help-group');
    assert.equal(resolveRoute(['help', 'graph']).kind, 'help-group');
    const h = resolveRoute(['help', 'graph', 'build']);
    assert.ok(h.kind === 'help-command' && h.spec.path.join(' ') === 'graph build');
    const l = resolveRoute(['help', 'list']);
    assert.ok(l.kind === 'help-command' && l.spec.path[0] === 'list');
    // "list --help" is a normal run: the command parser sees the help switch.
    assert.equal(resolveRoute(['list', '--help']).kind, 'run');
  });

  it('no command, a group without subcommand, and unknown names fail with exit code 2 and never run anything', () => {
    usage(() => resolveRoute([]), /No command given/);
    usage(() => resolveRoute(['--db', 'x']), /No command given/);
    usage(() => resolveRoute(['graph']), /needs a subcommand/);
    usage(() => resolveRoute(['graph', 'bogus']), /Unknown command "bogus" for "gcr graph"/);
    usage(() => resolveRoute(['bogus']), /Unknown command "bogus"/);
    usage(() => resolveRoute(['help', 'bogus']), /Unknown command "bogus"/);
    assert.equal(EXIT_CODES.INVALID_ARGUMENT, 2);
  });

  it('suggests the nearest command by edit distance', () => {
    usage(() => resolveRoute(['lst']), /Did you mean "list"/);
    usage(() => resolveRoute(['serach', 'x']), /Did you mean "search"/);
    usage(() => resolveRoute(['stat']), /Did you mean "stats"/);
    usage(() => resolveRoute(['graph', 'bild']), /Did you mean "graph build"/);
    usage(() => resolveRoute(['draft', 'creat']), /Did you mean "draft create"/);
    const far = usage(() => resolveRoute(['zzzzzzzz']));
    assert.equal(/Did you mean/.test(far.remedy ?? ''), false, 'nothing close: no suggestion');
  });

  it('commands that send, post or open anything do not exist, and are not suggested as aliases of something else', () => {
    for (const word of ['send', 'post', 'open', 'browse', 'fetch', 'sync', 'login', 'upload', 'download', 'publish', 'reply']) {
      usage(() => resolveRoute([word]), /Unknown command/);
    }
    usage(() => resolveRoute(['draft', 'send']), /Unknown command/);
    usage(() => resolveRoute(['draft', 'post']), /Unknown command/);
  });

  it('argument scanners honour the "--" terminator', () => {
    assert.equal(wantsHelp(['list', '--help']), true);
    assert.equal(wantsHelp(['search', '--', '--help']), false);
    assert.equal(wantsVersion(['--version']), true);
    assert.equal(wantsVersion(['x', '--', '-V']), false);
    assert.equal(wantsJsonErrors(['list', '--format', 'json']), true);
    assert.equal(wantsJsonErrors(['list', '--format=json']), true);
    assert.equal(wantsJsonErrors(['list', '--format', 'markdown']), false);
    assert.equal(wantsJsonErrors(['search', '--', '--format=json']), false);
    assert.equal(wantsDebug(['list', '--debug']), true);
    assert.equal(wantsDebug(['search', '--', '--debug']), false);
  });
});

describe('text helpers', () => {
  it('printable replaces control, bidi and invisible characters and bounds the length', () => {
    const dirty = `a${String.fromCharCode(0x1b)}[0m${String.fromCharCode(0x202e)}b${String.fromCodePoint(0xe0041)}c${String.fromCharCode(0xd800)}`;
    assert.equal(printable(dirty), 'a?[0m?b?c?');
    assert.equal(printable('x'.repeat(100), 10), `${'x'.repeat(10)}...`);
    assert.equal(printable('日本語テスト', 3), '日本語...');
  });

  it('edit distance and nearest', () => {
    assert.equal(editDistance('list', 'list'), 0);
    assert.equal(editDistance('lst', 'list'), 1);
    assert.equal(editDistance('kitten', 'sitting', 5), 3);
    assert.ok(editDistance('abcdefgh', 'z', 2) > 2);
    assert.equal(nearest('lst', ['get', 'list']), 'list');
    assert.equal(nearest('LIST', ['list']), 'list');
    assert.equal(nearest('', ['list']), undefined);
    assert.equal(nearest('qqqqqq', ['list', 'get']), undefined);
    assert.equal(nearest('gt', ['get', 'git']), 'get', 'ties go to the earlier entry');
  });
});

describe('suppress-warnings: the predicate', () => {
  const MSG = 'SQLite is an experimental feature and might change at any time';

  it('matches the node:sqlite ExperimentalWarning in every shape emitWarning accepts', () => {
    assert.equal(isNodeSqliteExperimentalWarning(MSG, 'ExperimentalWarning'), true);
    assert.equal(isNodeSqliteExperimentalWarning(MSG, { type: 'ExperimentalWarning' }), true);
    const err = new Error(MSG);
    err.name = 'ExperimentalWarning';
    assert.equal(isNodeSqliteExperimentalWarning(err), true);
    assert.equal(isNodeSqliteExperimentalWarning('SQLite is an experimental feature', 'ExperimentalWarning'), true);
  });

  it('matches by name AND message: everything else passes through', () => {
    assert.equal(isNodeSqliteExperimentalWarning(MSG), false, 'a plain Warning with that text is not the experimental notice');
    assert.equal(isNodeSqliteExperimentalWarning(MSG, 'DeprecationWarning'), false);
    assert.equal(isNodeSqliteExperimentalWarning(MSG, { type: 'Warning' }), false);
    assert.equal(isNodeSqliteExperimentalWarning('Type Stripping is an experimental feature and might change at any time', 'ExperimentalWarning'), false);
    assert.equal(isNodeSqliteExperimentalWarning(`${MSG}; also something else`, 'ExperimentalWarning'), false);
    assert.equal(isNodeSqliteExperimentalWarning(`prefix ${MSG}`, 'ExperimentalWarning'), false);
    const other = new Error(MSG);
    other.name = 'DeprecationWarning';
    assert.equal(isNodeSqliteExperimentalWarning(other), false);
    for (const junk of [undefined, null, 42, {}, [], Symbol('x')]) assert.equal(isNodeSqliteExperimentalWarning(junk, 'ExperimentalWarning'), false);
  });
});

describe('the command table is the single source of truth', () => {
  it('has the documented commands', () => {
    const paths = COMMANDS.map((c) => c.path.join(' ')).sort();
    assert.deepEqual(paths, [
      'annotate create', 'annotate list', 'annotate show', 'annotate update',
      'audit', 'batches', 'branches', 'doctor',
      'draft archive', 'draft create', 'draft list', 'draft show',
      'get', 'graph build', 'graph explain', 'graph export', 'graph god-nodes', 'graph neighbors', 'graph path', 'graph query',
      'import', 'import-copy', 'list', 'mcp', 'search', 'stats', 'thread',
    ].sort());
    assert.deepEqual([...TOP_LEVEL_NAMES].sort(), ['annotate', 'audit', 'batches', 'branches', 'doctor', 'draft', 'get', 'graph', 'help', 'import', 'import-copy', 'list', 'mcp', 'search', 'stats', 'thread']);
    assert.equal(GROUPS.length, 3);
  });

  it('every command has a summary, at least two examples, valid option specs and known error codes', () => {
    for (const spec of COMMANDS) {
      const name = spec.path.join(' ');
      assert.ok(spec.summary.length > 10 && spec.summary.length < 130, `${name}: one-line purpose`);
      assert.ok(spec.examples.length >= 2, `${name}: at least two examples`);
      for (const ex of spec.examples) {
        assert.ok(ex.command.startsWith(`${spec.path.join(' ')} ` ) || ex.command === spec.path.join(' '), `${name}: example "${ex.command}" starts with the command`);
        assert.ok(ex.note.length > 5, `${name}: examples are explained`);
      }
      const options = effectiveOptions(spec);
      const names = options.map((o) => o.name);
      assert.equal(new Set(names).size, names.length, `${name}: option names are unique (command options must not shadow global ones)`);
      const shorts = options.flatMap((o) => (o.short === undefined ? [] : [o.short]));
      assert.equal(new Set(shorts).size, shorts.length, `${name}: short names are unique`);
      for (const o of options) {
        assert.ok(o.description.length > 5, `${name} --${o.name}: described`);
        if (o.kind === 'choice') assert.ok((o.choices ?? []).length > 0, `${name} --${o.name}: choices`);
        if (o.kind === 'int') assert.ok(o.min !== undefined && o.max !== undefined && o.min <= o.max, `${name} --${o.name}: integer bounds`);
        if (o.kind !== 'boolean') assert.ok(o.valueName !== undefined || o.kind === 'int' || o.kind === 'choice' || o.kind === 'list', `${name} --${o.name}: value placeholder`);
      }
      for (const code of spec.errors) assert.ok((ERROR_CODES as readonly string[]).includes(code), `${name}: ${code} is an error code`);
    }
  });

  it('example command lines use synthetic ids only and never a real-looking conversation link', () => {
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    for (const spec of COMMANDS) {
      const texts = [spec.summary, ...(spec.details ?? []), ...spec.examples.flatMap((e) => [e.command, e.note]), ...spec.options.map((o) => o.description)];
      for (const t of texts) for (const id of t.match(uuid) ?? []) assert.ok(isSyntheticId(id.toLowerCase()), `${spec.path.join(' ')}: "${id}" is not a synthetic id`);
    }
  });

  it('no command or option can send, post, fetch or open a browser', () => {
    const banned = /(^|-)(send|sent|post|publish|upload|download|fetch|sync|browser|open|login|cookie|token|proxy|reply|submit)(-|$)/i;
    for (const spec of COMMANDS) {
      for (const part of spec.path) assert.equal(banned.test(part), false, `command word "${part}"`);
      for (const o of effectiveOptions(spec)) assert.equal(banned.test(o.name), false, `${spec.path.join(' ')} --${o.name}`);
    }
  });

  it('pins the documented value lists to the SDK constants', () => {
    assert.deepEqual([...STATS_GROUPS], [...STATS_GROUP_BY]);
    assert.deepEqual(AUDIT_FLAGS.map((f) => f.check).sort(), [...AUDIT_CHECKS].sort());
    const graphCmds = COMMANDS.filter((c) => c.path[0] === 'graph');
    const kinds = graphCmds.flatMap((c) => c.options).find((o) => o.name === 'kinds' && o.choices?.includes('conversation') === true);
    assert.ok(kinds?.choices !== undefined);
    for (const k of NODE_KINDS) assert.ok(kinds.choices.includes(k), `node kind ${k}`);
    const edgeKinds = graphCmds.flatMap((c) => c.options).find((o) => o.name === 'edge-kinds');
    assert.deepEqual([...(edgeKinds?.choices ?? [])].sort(), [...EDGE_KINDS].sort());
  });

  it('only the documented global options exist', () => {
    const globals = new Set(['db', 'format', 'tz', 'quiet', 'debug', 'help']);
    for (const spec of COMMANDS) {
      for (const o of spec.options) assert.equal(globals.has(o.name), false, `${spec.path.join(' ')}: --${o.name} would shadow a global option`);
    }
  });
});
