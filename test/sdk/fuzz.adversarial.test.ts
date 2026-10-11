/**
 * Adversarial sweep: every public method of Gcr, called with junk arguments of every JS type (hostile getters and Proxies
 * included), may only ever throw / reject with a GcrError. Reads throw synchronously, mutators reject; neither lets a raw
 * TypeError, SQLite error or the hostile object's own error text through (SPEC: "Every wrapped call normalizes thrown values").
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GcrError } from '../../src/errors.js';
import type { Gcr } from '../../src/sdk/gcr.js';
import { standardDb } from './sdk.helpers.test.js';

const HOSTILE_TEXT = 'hostile object says: /abs/private/place';

const JUNK: ReadonlyArray<readonly [string, unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['zero', 0],
  ['negative', -1],
  ['fraction', 1.5],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['bigint', 10n],
  ['symbol', Symbol('s')],
  ['empty string', ''],
  ['blank string', ' '],
  ['long string', 'x'.repeat(5000)],
  ['NUL string', 'a\0b'],
  ['true', true],
  ['empty array', []],
  ['array', [1, 'a', null]],
  ['empty object', {}],
  ['unknown option', { definitelyNotAnOption: 1 }],
  ['wrong-typed ref', { conversationId: 5 }],
  ['wrong-typed source', { source: 5 }],
  ['wrong-typed query', { query: 5 }],
  ['wrong-typed limit', { limit: '5' }],
  ['function', () => 1],
  ['date', new Date(0)],
  ['map', new Map()],
  ['null-prototype object', Object.create(null) as object],
  [
    'throwing getter',
    Object.defineProperty({}, 'x', {
      enumerable: true,
      get() {
        throw new Error(HOSTILE_TEXT);
      },
    }),
  ],
  [
    'getter on a known option',
    Object.defineProperty({}, 'source', {
      enumerable: true,
      get() {
        throw new Error(HOSTILE_TEXT);
      },
    }),
  ],
  [
    'throwing proxy',
    new Proxy(
      {},
      {
        ownKeys() {
          throw new Error(HOSTILE_TEXT);
        },
        get() {
          throw new Error(HOSTILE_TEXT);
        },
        getOwnPropertyDescriptor() {
          throw new Error(HOSTILE_TEXT);
        },
        getPrototypeOf() {
          throw new Error(HOSTILE_TEXT);
        },
      },
    ),
  ],
];

/** Every public method except close() (which takes no argument and is covered by the lifecycle tests). */
const METHODS = [
  'doctor', 'importExport', 'importManualCopy', 'list', 'get', 'getByUrl', 'branches', 'thread', 'search', 'stats', 'audit', 'listBatches',
  'buildGraph', 'graphQuery', 'graphPath', 'graphNeighbors', 'graphGodNodes', 'graphExplain', 'graphExportHtml', 'graphExport',
  'createDraft', 'getDraft', 'listDrafts', 'archiveDraft', 'renderDraftMarkdown', 'createAnnotation', 'updateAnnotation', 'getAnnotation', 'listAnnotations',
] as const;

async function outcome(call: () => unknown): Promise<unknown> {
  try {
    const r = call();
    if (typeof r === 'object' && r !== null && typeof (r as { then?: unknown }).then === 'function') await (r as Promise<unknown>);
    return null;
  } catch (e) {
    return e;
  }
}

describe('junk arguments never produce anything but a GcrError', () => {
  it('every public method x every junk value (one argument, two arguments, none)', async () => {
    const t = await standardDb();
    try {
      await t.gcr.buildGraph({ minEntityConversations: 1 }); // graph methods reach their own validation
      const g = t.gcr as unknown as Record<string, (...a: unknown[]) => unknown>;
      let calls = 0;
      const failures: string[] = [];
      for (const m of METHODS) {
        const argLists: unknown[][] = [[]];
        for (const [, v] of JUNK) argLists.push([v], [v, v]);
        for (const args of argLists) {
          calls++;
          const e = await outcome(() => (g[m] as (...a: unknown[]) => unknown).apply(t.gcr, args));
          if (e === null) continue;
          if (!(e instanceof GcrError)) failures.push(`${m}(${args.length} args): ${e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e)}`);
          else if (JSON.stringify(e.toEnvelope()).includes('/abs/private')) failures.push(`${m}(${args.length} args): hostile text forwarded`);
        }
      }
      assert.ok(calls > 1500, `swept ${calls} calls`);
      assert.deepEqual(failures, []);
      // the handle is still healthy afterwards
      assert.equal((t.gcr as Gcr).list().data.total, 9);
    } finally {
      await t.cleanup();
    }
  });
});
