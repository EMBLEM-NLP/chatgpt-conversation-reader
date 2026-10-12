/**
 * Round-2 review, product race A: `PRAGMA journal_mode = WAL` answers SQLITE_BUSY (errcode 5) without ever calling the busy handler
 * when several processes create the same new database at once, so `busy_timeout` cannot help and all but one opener used to fail
 * with DB_ERROR "busy". switchToWal retries a busy/locked answer a bounded number of times and nothing else. (Race B, a
 * concurrent opener's schema looking like a foreign file, is covered by the six-processes test in fixwave-open-symlink.test.ts.)
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { switchToWal } from '../../src/db/open.js';

function fakeDb(failures: Array<unknown>): { db: DatabaseSync; calls: () => number } {
  let calls = 0;
  const db = {
    prepare: (sql: string) => {
      assert.equal(sql, 'PRAGMA journal_mode = WAL');
      return {
        get: () => {
          const failure = failures[calls];
          calls++;
          if (failure !== undefined) throw failure;
          return { journal_mode: 'wal' };
        },
      };
    },
  } as unknown as DatabaseSync;
  return { db, calls: () => calls };
}

const sqliteError = (errcode: number): Error => Object.assign(new Error('database is locked'), { errcode, code: 'ERR_SQLITE_ERROR' });

describe('switchToWal', () => {
  it('returns the answer at once when there is no contention', () => {
    const { db, calls } = fakeDb([]);
    assert.deepEqual(switchToWal(db, 5, 1), { journal_mode: 'wal' });
    assert.equal(calls(), 1);
  });

  it('retries a busy answer (SQLITE_BUSY 5, SQLITE_LOCKED 6 and their extended codes) until it works', () => {
    for (const code of [5, 6, 5 | (1 << 8), 6 | (1 << 8)]) {
      const { db, calls } = fakeDb([sqliteError(code), sqliteError(code), sqliteError(code)]);
      assert.deepEqual(switchToWal(db, 10, 1), { journal_mode: 'wal' }, `errcode ${code}`);
      assert.equal(calls(), 4);
    }
  });

  it('gives up after the last attempt and throws the busy error itself', () => {
    const busy = sqliteError(5);
    const { db, calls } = fakeDb([busy, busy, busy, busy, busy, busy]);
    assert.throws(() => switchToWal(db, 3, 1), (e: unknown) => e === busy);
    assert.equal(calls(), 3);
  });

  it('does not retry any other failure (a read-only file, a corrupt header, a plain error)', () => {
    for (const failure of [sqliteError(8), sqliteError(11), sqliteError(26), new Error('boom'), 'not an error object']) {
      const { db, calls } = fakeDb([failure]);
      assert.throws(() => switchToWal(db, 10, 1), (e: unknown) => e === failure);
      assert.equal(calls(), 1);
    }
  });
});
