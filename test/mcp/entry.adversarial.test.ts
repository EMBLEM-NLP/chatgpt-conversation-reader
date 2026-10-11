/**
 * Adversarial review of how the entry file is started and of the alias table it is built from.
 *
 * Defects pinned here:
 *  1. `node dist/mcp/entry` (no `.js`) is a legal way to start a script: Node resolves the extension itself. The entry decided
 *     "am I the process entry?" by comparing `process.argv[1]` with its own file name, which for that spelling has no
 *     extension, so it concluded that it had been imported by another program and silently did NOTHING: no server, no
 *     message, exit code 0. An MCP client configured that way saw a server that "started and immediately exited".
 *  2. The alias table is the one place where code (not an LLM) hands the registry names, but a table that is not exactly
 *     `Record<string, string[]>` was not rejected with the documented GcrError(INVALID_ARGUMENT): a string instead of a list was
 *     iterated character by character (registering one-letter tools), a non-string name crashed with a TypeError, and names
 *     such as `constructor` or `__proto__` (own properties of every plain object) escaped as the SDK's untyped Error.
 */
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { describe, it } from 'node:test';
import { GcrError } from '../../src/errors.js';
import { createGcrMcpServer } from '../../src/mcp/server.js';
import type { AliasTable } from '../../src/mcp/aliases.js';
import { Gcr } from '../../src/sdk/gcr.js';
import { TOOL_VERSION } from '../../src/version.js';
import { ENTRY_JS } from './mcp.helpers.test.js';

const ENV = { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' };

describe('the entry starts however Node was told to find it', () => {
  const expected = `gcr-mcp ${TOOL_VERSION}\n`;

  it('with the .js extension (control)', () => {
    const r = spawnSync(process.execPath, [ENTRY_JS, '--version'], { env: ENV, encoding: 'utf8' });
    assert.equal(r.stdout, expected);
    assert.equal(r.status, 0);
  });

  it('without the extension: node dist/mcp/entry', () => {
    const r = spawnSync(process.execPath, [ENTRY_JS.slice(0, -'.js'.length), '--version'], { env: ENV, encoding: 'utf8' });
    assert.equal(r.stdout, expected, `stdout: ${JSON.stringify(r.stdout)} stderr: ${JSON.stringify(r.stderr.slice(0, 200))}`);
    assert.equal(r.status, 0);
  });

  it('without the extension and with a relative path', () => {
    const r = spawnSync(process.execPath, ['./entry', '--version'], { env: ENV, encoding: 'utf8', cwd: dirname(ENTRY_JS) });
    assert.equal(r.stdout, expected, `stdout: ${JSON.stringify(r.stdout)}`);
    assert.equal(r.status, 0);
  });

  it('a usage error is reported the same way (not swallowed) without the extension', () => {
    const r = spawnSync(process.execPath, [ENTRY_JS.slice(0, -'.js'.length), '--no-such-flag'], { env: ENV, encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /Unknown argument/);
  });
});

describe('a malformed alias table stops the build with GcrError(INVALID_ARGUMENT), whatever its shape', () => {
  const build = (table: unknown): unknown => {
    const gcr = Gcr.open({ dbPath: ':memory:' });
    try {
      return createGcrMcpServer(gcr, { aliases: table as AliasTable });
    } finally {
      gcr.close();
    }
  };
  const invalid = (e: unknown): boolean => e instanceof GcrError && e.code === 'INVALID_ARGUMENT';

  it('a string where a list belongs is not iterated character by character', () => {
    assert.throws(() => build({ gcr_list: 'abc' }), invalid);
    assert.throws(() => build({ gcr_list: 'chatgpt_list' }), invalid);
  });

  it('a name that is not a string', () => {
    assert.throws(() => build({ gcr_list: [123] }), invalid);
    assert.throws(() => build({ gcr_list: [{ toString: () => 'sneaky_name' }] }), invalid);
    assert.throws(() => build({ gcr_list: [null] }), invalid);
  });

  it('names that every plain object already owns (they would clash with the SDK\'s own bookkeeping)', () => {
    for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf']) {
      assert.throws(() => build({ gcr_list: [name] }), invalid, name);
    }
  });

  it('a list value that is not an array of names', () => {
    assert.throws(() => build({ gcr_list: { 0: 'a_name' } }), invalid);
    assert.throws(() => build({ gcr_list: null }), invalid);
    assert.throws(() => build({ gcr_list: 5 }), invalid);
  });

  it('a well-formed table still works (control)', () => {
    const server = build({ gcr_list: ['legacy_list'] }) as { server: unknown };
    assert.ok(server.server !== undefined);
  });
});
