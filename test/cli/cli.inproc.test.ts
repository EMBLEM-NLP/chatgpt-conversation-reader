/**
 * In-process tests: `runCli` with a fake environment (progress lines on a terminal, the scrubbing output layer), and
 * property tests (fast-check, FIXED seed) of the parts that take arbitrary text from the command line.
 *
 * The real executable is covered by the child-process tests; these reach what a pipe cannot (a terminal-like stderr) and
 * what is easier to hammer in a loop.
 */
import '../../src/suppress-warnings.js';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { Lifecycle } from '../../src/cli/context.js';
import type { CliEnvironment, StdinLike } from '../../src/cli/context.js';
import { createBufferOutput, scrub } from '../../src/cli/output.js';
import type { BufferOutput } from '../../src/cli/output.js';
import { checkPositionals, effectiveOptions, parseCommandArgs } from '../../src/cli/parse.js';
import { errorJson, errorText, reportError } from '../../src/cli/report-error.js';
import { resolveRoute } from '../../src/cli/route.js';
import type { OptionSpec } from '../../src/cli/spec.js';
import { runCli } from '../../src/cli/run.js';
import { COMMANDS } from '../../src/cli/commands/index.js';
import { EXIT_CODES, ERROR_CODES, GcrError } from '../../src/errors.js';
import { ConversationBuilder, syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import { assertClean, tempDir, writeFile } from './cli.helpers.test.js';

/** C0 controls except TAB/LF, DEL and C1 controls: exactly what the output layer promises never to emit. */
const CONTROL_ONLY = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

const SEED = 20261011;

function property<Ts extends unknown[]>(prop: fc.IPropertyWithHooks<Ts>, numRuns = 300): void {
  try {
    fc.assert(prop, { seed: SEED, numRuns });
  } catch (e) {
    throw new Error(`property failed (fast-check seed=${SEED}): ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

const emptyStdin: StdinLike = {
  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
    /* no data */
  },
};

function environment(argv: string[], out: BufferOutput, cwd: string, extra: Partial<CliEnvironment> = {}): CliEnvironment {
  return { argv, env: {}, cwd, out, stdin: emptyStdin, lifecycle: new Lifecycle(), ...extra };
}

describe('the output layer', () => {
  it('turns control characters into visible escapes and keeps LF and TAB', () => {
    assert.equal(scrub('a\tb\nc'), 'a\tb\nc');
    assert.equal(scrub(`x${String.fromCharCode(0x1b)}[31my`), 'x\\u001B[31my');
    assert.equal(scrub(`cr${String.fromCharCode(0x0d)}lf`), 'cr\\u000Dlf');
    assert.equal(scrub(`${String.fromCharCode(0x9b)}0m${String.fromCharCode(0x7f)}${String.fromCharCode(0x07)}`), '\\u009B0m\\u007F\\u0007');
    assert.equal(scrub('plain 日本語 émoji 😀'), 'plain 日本語 émoji 😀');
  });

  it('never lets a control character through, whatever the input', () => {
    property(fc.property(fc.string({ unit: 'binary' }), (text) => assert.equal(CONTROL_ONLY.test(scrub(text)), false)));
  });

  it('the in-memory output applies the same scrubbing', () => {
    const out = createBufferOutput();
    out.stdout(`a${String.fromCharCode(0x1b)}b`);
    out.stderr(`c${String.fromCharCode(0x07)}d`);
    assert.deepEqual(out.out, ['a\\u001Bb']);
    assert.deepEqual(out.err, ['c\\u0007d']);
  });
});

describe('runCli in-process', () => {
  it('returns exit codes instead of throwing, and prints the documented things', async () => {
    const dir = tempDir();
    for (const [argv, code] of [
      [['--version'], 0],
      [['--help'], 0],
      [['help', 'list'], 0],
      [[], 2],
      [['nope'], 2],
      [['list', '--limit', 'x'], 2],
      [['get', 'not-a-uuid'], 2],
      [['list', '--db', join(dir, 'missing.sqlite')], 5],
    ] as Array<[string[], number]>) {
      const out = createBufferOutput();
      assert.equal(await runCli(environment(argv, out, dir)), code, argv.join(' '));
      if (code === 0) assert.equal(out.err.join(''), '');
      else {
        assert.equal(out.out.join(''), '');
        assert.match(out.err.join(''), /^error\[[A-Z_]+\]: /);
      }
    }
  });

  it('json errors: one line of the ErrorEnvelope on stderr, nothing on stdout', async () => {
    const out = createBufferOutput();
    const code = await runCli(environment(['get', 'nope', '--format', 'json'], out, tempDir()));
    assert.equal(code, EXIT_CODES.INVALID_UUID);
    assert.equal(out.out.join(''), '');
    const env = JSON.parse(out.err.join('')) as { ok: boolean; error: { code: string } };
    assert.equal(env.ok, false);
    assert.equal(env.error.code, 'INVALID_UUID');
  });

  it('closes what it opened, also when the command fails', async () => {
    const lifecycle = new Lifecycle();
    let closed = 0;
    lifecycle.add(() => {
      closed++;
    });
    const out = createBufferOutput();
    await runCli(environment(['nope'], out, tempDir(), { lifecycle }));
    assert.equal(closed, 1);
  });

  it('prints import progress lines only on a terminal, never with --quiet', async () => {
    const dir = tempDir();
    const convs = [];
    for (let i = 1; i <= 2100; i++) {
      const b = new ConversationBuilder({ id: syntheticUuid(i), title: `GCR-SYNTHETIC-FIXTURE tiny ${i}`, minimal: true });
      b.user(b.root(), `tiny ${i}`);
      convs.push(b.text());
    }
    const file = writeFile(dir, 'conversations.json', `[${convs.join(',')}]`);
    const run = async (extra: string[], tty: boolean): Promise<{ code: number; out: BufferOutput }> => {
      const out = createBufferOutput({ stderrIsTty: tty });
      const code = await runCli(environment(['import', file, '--db', join(dir, `p${extra.join('')}${String(tty)}.sqlite`), '--format', 'json', ...extra], out, dir));
      return { code, out };
    };

    const terminal = await run([], true);
    assert.equal(terminal.code, 0, terminal.out.err.join(''));
    const lines = terminal.out.err.join('').trimEnd().split('\n');
    assert.ok(lines.length >= 3, `progress lines: ${lines.join(' | ')}`);
    for (const line of lines) assert.match(line, /^(scan|import) conversations\.json: \d+ conversations$/);
    assert.equal(JSON.parse(terminal.out.out.join('')).ok, true, 'stdout is only the report');

    assert.equal((await run([], false)).out.err.join(''), '', 'a pipe or log gets no progress lines');
    assert.equal((await run(['--quiet'], true)).out.err.join(''), '', '--quiet silences them');
  });
});

describe('property tests: arbitrary command lines never crash the parser', () => {
  const word = fc.oneof(
    fc.string({ maxLength: 12 }),
    fc.constantFrom('--', '-', '--db', '--db=', '--format', '--format=json', '--limit', '--limit=5', '--kinds', '-h', '--help', '-V', '--quiet', '--debug', '--tz', 'list', 'get', 'graph', 'draft', 'help'),
    fc.string({ unit: 'binary', maxLength: 6 }),
  );
  const argv = fc.array(word, { maxLength: 8 });

  it('resolveRoute returns a route or a GcrError(INVALID_ARGUMENT), nothing else', () => {
    property(
      fc.property(argv, (args) => {
        try {
          const route = resolveRoute(args);
          assert.ok(['version', 'help-root', 'help-group', 'help-command', 'run'].includes(route.kind));
        } catch (e) {
          assert.ok(e instanceof GcrError, `a non-GcrError escaped: ${String(e)}`);
          assert.equal(e.code, 'INVALID_ARGUMENT');
          assert.ok(e.remedy !== undefined && e.remedy.length > 0);
          assertClean(`${e.message}${e.remedy}`, 'route error text');
        }
      }),
    );
  });

  it('parseCommandArgs returns values or a GcrError(INVALID_ARGUMENT) for every command, nothing else', () => {
    property(
      fc.property(fc.constantFrom(...COMMANDS), argv, (spec, args) => {
        try {
          const parsed = parseCommandArgs(args, effectiveOptions(spec), `gcr ${spec.path.join(' ')}`);
          checkPositionals(parsed.positionals, spec.positionals, `gcr ${spec.path.join(' ')}`);
          for (const o of effectiveOptions(spec)) {
            if (o.kind === 'int' && parsed.int(o.name) !== undefined) {
              const v = parsed.int(o.name) as number;
              assert.ok(Number.isSafeInteger(v) && v >= (o.min ?? 0) && v <= (o.max ?? Infinity));
            }
            if (o.kind === 'choice' && parsed.string(o.name) !== undefined) assert.ok((o.choices ?? []).includes(parsed.string(o.name) as string));
          }
        } catch (e) {
          assert.ok(e instanceof GcrError, `a non-GcrError escaped: ${String(e)}`);
          assert.equal(e.code, 'INVALID_ARGUMENT');
          assert.ok(e.remedy !== undefined);
          assertClean(`${e.message}${e.remedy}`, 'parse error text');
        }
      }),
      500,
    );
  });

  it('integers are accepted exactly when they are plain digits within the range', () => {
    const limit: OptionSpec = { name: 'limit', kind: 'int', min: 1, max: 500, description: 'limit' };
    property(
      fc.property(fc.oneof(fc.integer({ min: -50, max: 700 }).map(String), fc.string({ maxLength: 6 })), (text) => {
        const expected = /^[0-9]{1,15}$/.test(text) && Number(text) >= 1 && Number(text) <= 500;
        let result: number | undefined;
        try {
          result = parseCommandArgs([`--limit=${text}`], [limit], 'gcr list').int('limit');
        } catch (e) {
          assert.ok(e instanceof GcrError, `a non-GcrError escaped: ${String(e)}`);
        }
        assert.equal(result !== undefined, expected, `--limit=${JSON.stringify(text)}`);
        if (result !== undefined) assert.equal(result, Number(text));
      }),
    );
  });
});

describe('property tests: error output', () => {
  it('error text and JSON never contain control characters, for any message, remedy or code', () => {
    property(
      fc.property(fc.constantFrom(...ERROR_CODES), fc.string({ unit: 'binary', maxLength: 40 }), fc.option(fc.string({ unit: 'binary', maxLength: 40 }), { nil: undefined }), fc.boolean(), (code, message, remedy, debug) => {
        const err = new GcrError(code, message, remedy === undefined ? {} : { remedy });
        const text = errorText(err, err, debug);
        assertClean(text, 'error text');
        assert.ok(text.startsWith(`error[${code}]: `));
        const json = errorJson(err, err, debug);
        assert.equal(json.trimEnd().includes('\n'), false, 'the JSON error is one line');
        assertClean(json, 'error json');
        const parsed = JSON.parse(json) as { ok: boolean; error: { code: string; message: string } };
        assert.equal(parsed.ok, false);
        assert.equal(parsed.error.code, code);
        assert.equal(parsed.error.message, message, 'JSON is lossless: the message round-trips');
      }),
    );
  });

  it('anything that is not a GcrError becomes INTERNAL_ERROR with the generic message and exit code 1', () => {
    property(
      fc.property(fc.anything(), (thrown) => {
        const out = createBufferOutput();
        const code = reportError(out, thrown, { json: false, debug: false });
        assert.equal(code, EXIT_CODES.INTERNAL_ERROR);
        const text = out.err.join('');
        assert.ok(text.startsWith('error[INTERNAL_ERROR]: An unexpected internal error occurred.\n'));
        assert.equal(text.includes('\n    at '), false);
      }),
    );
  });
});
