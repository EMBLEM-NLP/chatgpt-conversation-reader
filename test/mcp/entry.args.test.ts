/**
 * Argument parsing of the server entry (pure; the process behaviour is covered by stdio.e2e.test.ts).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GcrError } from '../../src/errors.js';
import { MCP_USAGE, parseMcpArgs } from '../../src/mcp/entry.js';

function invalid(argv: string[]): void {
  assert.throws(() => parseMcpArgs(argv), (e: unknown) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT', JSON.stringify(argv));
}

describe('parseMcpArgs', () => {
  it('no arguments: no database, read-only, not help', () => {
    assert.deepEqual(parseMcpArgs([]), { dbPath: undefined, allowLocalWrites: false, help: false, version: false });
  });

  it('--db in both spellings, and --allow-local-writes', () => {
    assert.equal(parseMcpArgs(['--db', '/data/gcr.sqlite']).dbPath, '/data/gcr.sqlite');
    assert.equal(parseMcpArgs(['--db=/data/gcr.sqlite']).dbPath, '/data/gcr.sqlite');
    assert.equal(parseMcpArgs(['--db=with=equals.sqlite']).dbPath, 'with=equals.sqlite');
    assert.equal(parseMcpArgs(['--allow-local-writes']).allowLocalWrites, true);
    assert.deepEqual(parseMcpArgs(['--allow-local-writes', '--db', 'x.sqlite']), { dbPath: 'x.sqlite', allowLocalWrites: true, help: false, version: false });
  });

  it('help and version flags', () => {
    assert.equal(parseMcpArgs(['--help']).help, true);
    assert.equal(parseMcpArgs(['-h']).help, true);
    assert.equal(parseMcpArgs(['--version']).version, true);
    assert.equal(parseMcpArgs(['-v']).version, true);
  });

  it('a missing, empty or flag-like database value is refused', () => {
    invalid(['--db']);
    invalid(['--db=']);
    invalid(['--db', '']);
    invalid(['--db', '--allow-local-writes']);
  });

  it('a repeated --db is refused rather than silently taking one', () => {
    invalid(['--db', 'a.sqlite', '--db', 'b.sqlite']);
    invalid(['--db=a.sqlite', '--db', 'b.sqlite']);
  });

  it('unknown arguments are refused, and not echoed', () => {
    for (const argv of [['--allow-writes'], ['--write'], ['positional'], ['--db', 'x', 'extra'], ['--ALLOW-LOCAL-WRITES'], ['-x']]) invalid(argv);
    try {
      parseMcpArgs(['--secret-token=abc123']);
      assert.fail('expected a throw');
    } catch (e) {
      assert.ok(!(e as Error).message.includes('abc123'));
    }
  });

  it('the usage text names every flag and environment variable', () => {
    for (const word of ['--db', '--allow-local-writes', '--help', '--version', 'GCR_DB', 'GCR_MCP_ALLOW_WRITES', 'GCR_APPROVED_IMPORT_ROOTS', 'GCR_MCP_MAX_RESULT_BYTES']) assert.ok(MCP_USAGE.includes(word), word);
  });
});
