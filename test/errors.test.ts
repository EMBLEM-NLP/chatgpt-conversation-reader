/**
 * src/errors.ts: the complete error code -> process exit code mapping, pinned as LITERALS (TQ-08).
 *
 * The behavioural CLI tests compare a command's exit status with `EXIT_CODES[code]`, the table of the code under test, so they
 * cannot notice a changed number; the docs-consistency tests only compare the document with that same table, so a code change
 * and a matching documentation regeneration would re-baseline both silently. Exit codes are a public contract for scripts
 * (docs/CLI_REFERENCE.md, "Exit code table"): changing one is a breaking change that must show up here, in a diff of literals.
 *
 * The literal table below was written from the exit code table of docs/CLI_REFERENCE.md and checked against src/errors.ts; both
 * are asserted to equal it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ERROR_CODES, EXIT_CODES, GcrError, toGcrError } from '../src/errors.js';
import type { ErrorCode } from '../src/errors.js';

/** The contract. `satisfies` makes a code that is added to (or dropped from) ErrorCode a compile error here. */
const PINNED_EXIT_CODES = {
  // 2: the caller's input is wrong
  INVALID_ARGUMENT: 2,
  INVALID_URL: 2,
  INVALID_UUID: 2,
  UNSUPPORTED_URL: 2,
  FTS_SYNTAX_ERROR: 2,
  // 3: the thing asked for is not in the local data
  NOT_IN_LOCAL_EXPORT: 3,
  BRANCH_NOT_FOUND: 3,
  MESSAGE_NOT_FOUND: 3,
  AMBIGUOUS_CONVERSATION: 3,
  ACTIVE_BRANCH_UNKNOWN: 3,
  DRAFT_NOT_FOUND: 3,
  ANNOTATION_NOT_FOUND: 3,
  // 4: import
  IMPORT_INPUT_NOT_FOUND: 4,
  IMPORT_UNSUPPORTED_FORMAT: 4,
  IMPORT_ZIP_UNSAFE: 4,
  IMPORT_LIMIT_EXCEEDED: 4,
  IMPORT_PARSE_ERROR: 4,
  IMPORT_PATH_NOT_ALLOWED: 4,
  // 5: storage
  DB_NOT_FOUND: 5,
  DB_SCHEMA_TOO_NEW: 5,
  DB_MIGRATION_FAILED: 5,
  DB_ERROR: 5,
  // 6: refused write
  WRITE_FORBIDDEN: 6,
  ANNOTATION_CONFLICT: 6,
  // 7: disabled or forbidden capability
  NOT_IMPLEMENTED: 7,
  FEATURE_GATED: 7,
  REMOTE_ACCESS_FORBIDDEN: 7,
  // 1: a bug
  INTERNAL_ERROR: 1,
} as const satisfies Record<ErrorCode, number>;

const sorted = (o: Record<string, number>): Array<[string, number]> => Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** Rows `| \`CODE\` | N | ...` of the "Exit code table" section of the CLI reference. Throws when the document or the section is missing. */
function documentedExitCodes(): Record<string, number> {
  const text = readFileSync(fileURLToPath(new URL('../../docs/CLI_REFERENCE.md', import.meta.url)), 'utf8');
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^#{2,4}\s+Exit code table\s*$/.test(l));
  assert.ok(start >= 0, 'docs/CLI_REFERENCE.md has an "Exit code table" heading');
  const out: Record<string, number> = {};
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,4}\s/.test(line)) break; // the next heading ends the section
    const m = /^\|\s*`([A-Z][A-Z_]+)`\s*\|\s*(\d+)\s*\|/.exec(line);
    if (m === null) continue;
    const code = m[1] as string;
    assert.equal(code in out, false, `${code} appears twice in the documented table`);
    out[code] = Number(m[2]);
  }
  return out;
}

describe('the error code -> exit code mapping is a pinned contract', () => {
  it('the pinned table has 28 codes and uses exactly the exit codes 1 to 7', () => {
    assert.equal(Object.keys(PINNED_EXIT_CODES).length, 28);
    assert.deepEqual([...new Set(Object.values(PINNED_EXIT_CODES))].sort(), [1, 2, 3, 4, 5, 6, 7]);
  });

  it('src/errors.ts EXIT_CODES is exactly the pinned table, code for code', () => {
    assert.deepEqual(sorted({ ...EXIT_CODES }), sorted(PINNED_EXIT_CODES));
  });

  it('ERROR_CODES lists exactly the pinned codes (none added or dropped without updating the contract)', () => {
    assert.deepEqual([...ERROR_CODES].sort(), Object.keys(PINNED_EXIT_CODES).sort());
    assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length, 'no code is listed twice');
  });

  it('docs/CLI_REFERENCE.md documents exactly the pinned table: every code once, with the pinned number, and no other row', () => {
    assert.deepEqual(sorted(documentedExitCodes()), sorted(PINNED_EXIT_CODES));
  });

  it('GcrError#exitCode follows the pinned table for every code, and an unknown thrown value is INTERNAL_ERROR with exit 1', () => {
    for (const [code, exit] of Object.entries(PINNED_EXIT_CODES)) {
      assert.equal(new GcrError(code as ErrorCode, 'x').exitCode, exit, code);
      assert.equal(new GcrError(code as ErrorCode, 'x').toEnvelope().error.code, code);
    }
    for (const thrown of [new Error('boom'), 'a string', 42, null, undefined]) {
      const e = toGcrError(thrown);
      assert.equal(e.code, 'INTERNAL_ERROR');
      assert.equal(e.exitCode, 1);
    }
  });

  it('the exit code groups are what scripts rely on: usage 2, not found 3, import 4, storage 5, refused write 6, disabled 7, bug 1', () => {
    const group = (exit: number): string[] => Object.entries(PINNED_EXIT_CODES).filter(([, n]) => n === exit).map(([c]) => c).sort();
    assert.deepEqual(group(1), ['INTERNAL_ERROR']);
    assert.deepEqual(group(2), ['FTS_SYNTAX_ERROR', 'INVALID_ARGUMENT', 'INVALID_URL', 'INVALID_UUID', 'UNSUPPORTED_URL']);
    assert.equal(group(3).length, 7);
    assert.equal(group(4).length, 6);
    assert.deepEqual(group(5), ['DB_ERROR', 'DB_MIGRATION_FAILED', 'DB_NOT_FOUND', 'DB_SCHEMA_TOO_NEW']);
    assert.deepEqual(group(6), ['ANNOTATION_CONFLICT', 'WRITE_FORBIDDEN']);
    assert.deepEqual(group(7), ['FEATURE_GATED', 'NOT_IMPLEMENTED', 'REMOTE_ACCESS_FORBIDDEN']);
  });
});
