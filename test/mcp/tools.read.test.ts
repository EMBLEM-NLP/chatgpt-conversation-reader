/**
 * The read tools through the REAL SDK Client over an in-memory transport: happy path, parity with the SDK facade (the tools
 * are thin adapters, so MCP data must equal the SDK data field for field), every error code reachable through a read tool,
 * input validation, ambiguity and NOT_IN_LOCAL_EXPORT.
 */
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { ResultEnvelope } from '../../src/domain/types.js';
import type { ErrorCode } from '../../src/errors.js';
import type { McpEnvelope } from '../../src/mcp/envelope.js';
import { Gcr } from '../../src/sdk/gcr.js';
import { syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import type { Fixture, MemHarness } from './mcp.helpers.test.js';
import { ID, connectMem, createFixture } from './mcp.helpers.test.js';

const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

/** MCP envelope == SDK envelope, field for field (the adapter adds nothing and drops nothing on a normal result). */
function assertParity(env: McpEnvelope, sdk: ResultEnvelope<unknown>): void {
  assert.equal(env.ok, true, env.error?.message);
  assert.deepEqual(env.data, plain(sdk.data));
  assert.deepEqual(env.source, plain(sdk.source));
  assert.equal(env.completeness, sdk.completeness);
  assert.deepEqual(env.warnings, plain(sdk.warnings));
  assert.deepEqual(env.ids, plain(sdk.ids));
  assert.equal(env.untrustedContent, sdk.untrustedContent);
  assert.equal(env.truncated, false);
}

/** The MCP search result is the SDK's minus the keyset cursor (the tool accepts no cursor: offset is the one continuation). */
function withoutCursor<T extends { data: object }>(env: T): T {
  const { nextCursor: _cursor, ...data } = env.data as { nextCursor?: unknown };
  return { ...env, data };
}

function assertError(env: McpEnvelope, code: ErrorCode): NonNullable<McpEnvelope['error']> {
  assert.equal(env.ok, false);
  assert.ok(env.error, 'an error envelope carries `error`');
  assert.equal(env.error.code, code, `expected ${code}, got ${env.error.code}: ${env.error.message}`);
  assert.equal(env.data, undefined, 'no data on failure');
  assert.deepEqual(env.source, []);
  assert.equal(env.completeness, 'unknown');
  return env.error;
}

function sdkErrorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? 'no-code';
  }
  return 'no-error';
}

describe('read tools over a standard database', () => {
  let fx: Fixture;
  let h: MemHarness;
  let sdk: Gcr;
  const sdkSearch = (o: Parameters<Gcr['search']>[0]): ResultEnvelope<unknown> => withoutCursor(sdk.search(o));
  before(async () => {
    fx = await createFixture();
    h = await connectMem(fx.dbPath);
    sdk = Gcr.open({ dbPath: fx.dbPath, readOnly: true });
  });
  after(async () => {
    await h.close();
    sdk.close();
    await fx.cleanup();
  });

  it('every call left the client with no protocol errors', async () => {
    await h.env('gcr_list');
    assert.deepEqual(h.clientErrors, []);
  });

  describe('gcr_list', () => {
    it('matches the SDK for the default page and carries provenance', async () => {
      const env = await h.env('gcr_list');
      assertParity(env, sdk.list());
      assert.equal((env.data?.['items'] as unknown[]).length, 5);
      // One fixture conversation has no current_node, which lowers ITS completeness to unknown: the mix is reported, never hidden.
      assert.equal(env.completeness, 'mixed');
      assert.equal(env.warnings[0]?.code, 'SOURCE_NOT_FULL_HISTORY');
      const complete = await h.env('gcr_list', { titleQuery: 'alpha' });
      assert.equal(complete.completeness, 'exported_tree');
      assert.deepEqual(complete.warnings, []);
      assert.equal(env.source.length, 1);
      assert.equal(env.source[0]?.sourceLabel, 'conversations.json', 'a basename, never a path');
      assert.equal(env.untrustedContent, true, 'titles are imported text');
    });

    it('passes limit, offset, sort, provider and title filters through', async () => {
      assertParity(await h.env('gcr_list', { limit: 2, offset: 1, sort: 'title_asc' }), sdk.list({ limit: 2, offset: 1, sort: 'title_asc' }));
      assertParity(await h.env('gcr_list', { titleQuery: 'branched' }), sdk.list({ titleQuery: 'branched' }));
      assertParity(await h.env('gcr_list', { provider: 'claude' }), sdk.list({ provider: 'claude' }));
      assertParity(await h.env('gcr_list', { accountLabel: 'default', allBatches: true }), sdk.list({ accountLabel: 'default', allBatches: true }));
    });

    it('pages deterministically: the pages concatenate to the full list', async () => {
      const all = ((await h.env('gcr_list', { limit: 200 })).data?.['items'] as Array<{ conversationId: string }>).map((i) => i.conversationId);
      const seen: string[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const page: McpEnvelope = await h.env('gcr_list', { limit: 2, offset });
        seen.push(...(page.data?.['items'] as Array<{ conversationId: string }>).map((i) => i.conversationId));
        offset = page.data?.['nextOffset'] as number | null;
      }
      assert.deepEqual(seen, all);
    });
  });

  describe('gcr_get', () => {
    it('reads a conversation by UUID, by exact link and by object-style scope, all to the same data', async () => {
      const byUuid = await h.env('gcr_get', { conversation: ID.linear });
      assertParity(byUuid, sdk.get(ID.linear));
      const byUrl = await h.env('gcr_get', { conversation: `https://chatgpt.com/c/${ID.linear}` });
      assert.deepEqual(byUrl.data, byUuid.data);
      const scoped = await h.env('gcr_get', { conversation: ID.linear, provider: 'chatgpt', accountLabel: 'default' });
      assert.deepEqual(scoped.data, byUuid.data);
      const mixedCaseLink = await h.env('gcr_get', { conversation: `HTTPS://CHATGPT.COM/c/${ID.linear.toUpperCase()}/?x=1#frag` });
      assert.deepEqual(mixedCaseLink.data, byUuid.data);
      const thread = (byUuid.data?.['thread'] as { messages: Array<{ authorRole: string }> }).messages;
      assert.deepEqual(thread.map((m) => m.authorRole), ['user', 'assistant', 'user', 'assistant']);
    });

    it('selects branches exactly like the SDK (explicit branch, all branches, hidden messages, heuristic)', async () => {
      const b = fx.branched;
      assertParity(await h.env('gcr_get', { conversation: ID.branched, branch: b.a2 }), sdk.get(ID.branched, { branch: b.a2 }));
      assertParity(await h.env('gcr_get', { conversation: ID.branched, allBranches: true }), sdk.get(ID.branched, { allBranches: true }));
      assertParity(await h.env('gcr_get', { conversation: ID.branched, includeHidden: true }), sdk.get(ID.branched, { includeHidden: true }));
      const heuristic = await h.env('gcr_get', { conversation: ID.noCurrent, branchPolicy: 'last_child' });
      assertParity(heuristic, sdk.get(ID.noCurrent, { branchPolicy: 'last_child' }));
      assert.ok(heuristic.warnings.some((w) => w.code === 'ACTIVE_BRANCH_HEURISTIC'), 'a heuristic choice is always flagged');
    });

    it('never guesses the active branch: ACTIVE_BRANCH_UNKNOWN lists the branches and the remedy', async () => {
      const err = assertError(await h.env('gcr_get', { conversation: ID.noCurrent }), 'ACTIVE_BRANCH_UNKNOWN');
      assert.match(err.remedy ?? '', /branch/);
      assert.equal((err.details?.['branchIds'] as string[]).length, 3);
    });

    it('NOT_IN_LOCAL_EXPORT with the export remedy, for a bare UUID and for the exact link (never fetched)', async () => {
      for (const conversation of [ID.absent, `https://chatgpt.com/c/${ID.absent}`]) {
        const err = assertError(await h.env('gcr_get', { conversation }), 'NOT_IN_LOCAL_EXPORT');
        assert.match(err.remedy ?? '', /official export/i);
        assert.match(err.remedy ?? '', /cannot fetch chatgpt\.com/i);
        assert.equal(err.details?.['conversationId'], ID.absent);
      }
    });

    it('maps reference errors to the domain codes: share links, other hosts, malformed ids, unknown branch', async () => {
      const cases: Array<[string, ErrorCode]> = [
        [`https://chatgpt.com/share/${ID.linear}`, 'UNSUPPORTED_URL'],
        [`https://example.test/c/${ID.linear}`, 'UNSUPPORTED_URL'],
        ['not-a-uuid', 'INVALID_UUID'],
        ['https://chatgpt.com/c/zzzz', 'INVALID_UUID'],
        ['https://', 'INVALID_URL'],
        ['https://chatgpt.com/', 'UNSUPPORTED_URL'],
      ];
      for (const [conversation, code] of cases) {
        assertError(await h.env('gcr_get', { conversation }), code);
        assert.equal(sdkErrorCode(() => sdk.get(conversation)), code, 'the SDK is the oracle');
      }
      assertError(await h.env('gcr_get', { conversation: ID.branched, branch: 'no-such-branch' }), 'BRANCH_NOT_FOUND');
    });

    it('refuses a chatgpt.com link combined with another provider instead of looking it up there', async () => {
      assertError(await h.env('gcr_get', { conversation: `https://chatgpt.com/c/${ID.linear}`, provider: 'claude' }), 'INVALID_ARGUMENT');
    });
  });

  describe('gcr_search', () => {
    it('matches the SDK for message, title and combined scope', async () => {
      assertParity(await h.env('gcr_search', { query: 'quokka' }), sdkSearch({ query: 'quokka' }));
      assertParity(await h.env('gcr_search', { query: 'branched', scope: 'titles' }), sdkSearch({ query: 'branched', scope: 'titles' }));
      assertParity(await h.env('gcr_search', { query: 'quokka', scope: 'all' }), sdkSearch({ query: 'quokka', scope: 'all' }));
      const env = await h.env('gcr_search', { query: 'quokka' });
      assert.ok((env.data?.['items'] as unknown[]).length >= 3);
      assert.equal(env.untrustedContent, true);
    });

    it('finds Unicode text (CJK substrings and accents)', async () => {
      const cjk = await h.env('gcr_search', { query: '日本語' });
      assert.ok((cjk.data?.['items'] as unknown[]).length >= 1);
      assertParity(await h.env('gcr_search', { query: 'cafe' }), sdkSearch({ query: 'cafe' }));
    });

    it('applies the message filters and the conversation filter (UUID or link)', async () => {
      assertParity(await h.env('gcr_search', { query: 'quokka', role: 'assistant', limit: 1 }), sdkSearch({ query: 'quokka', role: 'assistant', limit: 1 }));
      assertParity(await h.env('gcr_search', { query: 'quokka', conversation: `https://chatgpt.com/c/${ID.linear}` }), sdkSearch({ query: 'quokka', conversationId: ID.linear }));
      assertParity(await h.env('gcr_search', { query: 'quokka', hasModel: true, createdAfter: '2020-01-01T00:00:00Z' }), sdkSearch({ query: 'quokka', hasModel: true, createdAfter: '2020-01-01T00:00:00Z' }));
    });

    it('pages with offset: the pages concatenate to the full result and the continuation is nextOffset', async () => {
      const full = (await h.env('gcr_search', { query: 'quokka', limit: 200 })).data?.['items'] as Array<{ messageId: string; conversationId: string }>;
      const seen: string[] = [];
      let offset: number | null = 0;
      let guard = 0;
      while (offset !== null && guard++ < 20) {
        const page: McpEnvelope = await h.env('gcr_search', { query: 'quokka', limit: 2, offset });
        seen.push(...(page.data?.['items'] as Array<{ messageId: string; conversationId: string }>).map((i) => `${i.conversationId}/${i.messageId}`));
        offset = page.data?.['nextOffset'] as number | null;
      }
      assert.deepEqual(seen, full.map((i) => `${i.conversationId}/${i.messageId}`));
    });

    it('never offers a keyset cursor (the tool accepts none): nextOffset is the only continuation', async () => {
      const env = await h.env('gcr_search', { query: 'quokka', limit: 1 });
      assert.equal('nextCursor' in (env.data ?? {}), false);
      assert.equal(env.data?.['nextOffset'], 1);
      assert.equal(sdk.search({ query: 'quokka', limit: 1 }).data.nextCursor !== undefined, true, 'the SDK itself does return one');
    });

    it('raw mode passes FTS5 syntax and maps a syntax error to FTS_SYNTAX_ERROR', async () => {
      assertParity(await h.env('gcr_search', { query: 'quokka OR kangaroo', mode: 'raw' }), sdkSearch({ query: 'quokka OR kangaroo', mode: 'raw' }));
      assertError(await h.env('gcr_search', { query: '"unterminated', mode: 'raw' }), 'FTS_SYNTAX_ERROR');
    });

    it('an empty-after-normalisation query and title-scope-with-message-filter are INVALID_ARGUMENT from the SDK', async () => {
      assertError(await h.env('gcr_search', { query: '***' }), 'INVALID_ARGUMENT');
      assertError(await h.env('gcr_search', { query: 'quokka', scope: 'titles', role: 'user' }), 'INVALID_ARGUMENT');
    });
  });

  describe('gcr_branches and gcr_thread', () => {
    it('lists the branches like the SDK', async () => {
      assertParity(await h.env('gcr_branches', { conversation: ID.branched }), sdk.branches(ID.branched));
      const env = await h.env('gcr_branches', { conversation: ID.branched });
      assert.equal((env.data?.['branches'] as unknown[]).length, 3);
      assert.equal(env.data?.['activeBranchId'], fx.branched.a2b);
    });

    it('reads the active thread, a named branch and a heuristic branch like the SDK', async () => {
      assertParity(await h.env('gcr_thread', { conversation: ID.branched }), sdk.thread(ID.branched));
      assertParity(await h.env('gcr_thread', { conversation: ID.branched, branch: fx.branched.a1e }), sdk.thread(ID.branched, { branch: fx.branched.a1e }));
      assertParity(await h.env('gcr_thread', { conversation: ID.noCurrent, branchPolicy: 'latest_leaf' }), sdk.thread(ID.noCurrent, { branchPolicy: 'latest_leaf' }));
    });

    it('errors: ACTIVE_BRANCH_UNKNOWN, BRANCH_NOT_FOUND, NOT_IN_LOCAL_EXPORT', async () => {
      assertError(await h.env('gcr_thread', { conversation: ID.noCurrent }), 'ACTIVE_BRANCH_UNKNOWN');
      assertError(await h.env('gcr_thread', { conversation: ID.branched, branch: 'x' }), 'BRANCH_NOT_FOUND');
      assertError(await h.env('gcr_branches', { conversation: ID.absent }), 'NOT_IN_LOCAL_EXPORT');
      assertError(await h.env('gcr_thread', { conversation: ID.absent }), 'NOT_IN_LOCAL_EXPORT');
    });

    it('an unknown batch pin is NOT_IN_LOCAL_EXPORT, never a guess', async () => {
      assertError(await h.env('gcr_branches', { conversation: ID.linear, batchId: `b_${'0'.repeat(32)}` }), 'NOT_IN_LOCAL_EXPORT');
    });
  });

  describe('gcr_stats and gcr_audit', () => {
    it('stats match the SDK for every grouping', async () => {
      for (const groupBy of ['role', 'model', 'channel', 'day', 'conversation', 'provider', 'content_type'] as const) {
        assertParity(await h.env('gcr_stats', { groupBy }), sdk.stats({ groupBy }));
      }
      assertParity(await h.env('gcr_stats', { groupBy: 'day', tz: 'Europe/Berlin', limit: 3 }), sdk.stats({ groupBy: 'day', tz: 'Europe/Berlin', limit: 3 }));
    });

    it('never infers a model: messages without a stated model are counted as unknown', async () => {
      const env = await h.env('gcr_stats', { groupBy: 'model' });
      const labels = (env.data?.['rows'] as Array<{ label: string }>).map((r) => r.label);
      assert.ok(labels.some((l) => /unknown/i.test(l)));
    });

    it('a bad time zone is INVALID_ARGUMENT from the SDK', async () => {
      assertError(await h.env('gcr_stats', { groupBy: 'day', tz: 'Not/AZone' }), 'INVALID_ARGUMENT');
    });

    it('audit matches the SDK, with and without a check subset', async () => {
      assertParity(await h.env('gcr_audit'), sdk.audit());
      assertParity(await h.env('gcr_audit', { checks: ['no_current_node', 'tree_integrity'], sampleSize: 2 }), sdk.audit({ checks: ['no_current_node', 'tree_integrity'], sampleSize: 2 }));
      const env = await h.env('gcr_audit', { checks: ['no_current_node'] });
      const finding = (env.data?.['findings'] as Array<{ check: string; count: number }>)[0];
      assert.equal(finding?.check, 'no_current_node');
      assert.equal(finding?.count, 1, 'exactly the conversation exported without a current node');
    });
  });

  describe('gcr_graph_query', () => {
    it('matches the SDK and cites ids', async () => {
      const env = await h.env('gcr_graph_query', { term: 'quokka' });
      assertParity(env, sdk.graphQuery({ term: 'quokka' }));
      assert.ok((env.data?.['nodes'] as unknown[]).length > 0, 'the fixture graph is built');
      assertParity(await h.env('gcr_graph_query', { term: 'quokka', depth: 1, maxNodes: 5, kinds: ['conversation'] }), sdk.graphQuery({ term: 'quokka', depth: 1, maxNodes: 5, kinds: ['conversation'] }));
    });

    it('a term nothing matches is an empty result, not an error', async () => {
      const env = await h.env('gcr_graph_query', { term: 'zzzzqqqq-nothing' });
      assert.equal(env.ok, true);
      assert.deepEqual(env.data?.['nodes'], []);
    });
  });

  describe('gcr_doctor', () => {
    it('reports the environment without paths or values and says it read no conversation', async () => {
      const env = await h.env('gcr_doctor');
      assert.equal(env.ok, true);
      assert.equal(env.untrustedContent, false);
      assert.deepEqual(env.source, []);
      assert.deepEqual(env.warnings, []);
      const report = env.data as { database: { label: string; schemaStatus: string }; env: Array<{ name: string; status: string }>; modes: Array<{ mode: string; status: string }>; network: { used: boolean }; statement: string };
      assert.equal(report.database.label, basename(fx.dbPath));
      assert.equal(report.database.schemaStatus, 'ok');
      assert.ok(report.env.every((k) => k.status === 'present' || k.status === 'absent'), 'presence only');
      assert.equal(report.network.used, false);
      assert.match(report.statement, /never fall back to remote browser access/i);
      assert.deepEqual(report.modes.map((m) => m.mode), ['A', 'B', 'C', 'D', 'E']);
      const text = JSON.stringify(env);
      assert.ok(!text.includes(fx.dir), 'no absolute directory in the report');
    });
  });

  describe('input validation (the schema layer and the SDK layer both answer with an INVALID_ARGUMENT envelope)', () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ['gcr_list', { limt: 5 }],
      ['gcr_list', { limit: 0 }],
      ['gcr_list', { limit: 201 }],
      ['gcr_list', { limit: 1.5 }],
      ['gcr_list', { limit: '5' }],
      ['gcr_list', { offset: -1 }],
      ['gcr_list', { sort: 'random' }],
      ['gcr_list', { provider: 'bing' }],
      ['gcr_list', { accountLabel: '../x' }],
      ['gcr_list', { accountLabel: '' }],
      ['gcr_list', { titleQuery: 'x'.repeat(501) }],
      ['gcr_get', {}],
      ['gcr_get', { conversation: '' }],
      ['gcr_get', { conversation: 'x'.repeat(513) }],
      ['gcr_get', { conversation: ID.linear, extra: true }],
      ['gcr_get', { conversation: ID.linear, branchPolicy: 'first' }],
      ['gcr_get', { conversation: ID.linear, batchId: 'nope' }],
      ['gcr_get', { conversation: ID.linear, allBranches: 'yes' }],
      ['gcr_search', {}],
      ['gcr_search', { query: '' }],
      ['gcr_search', { query: 'x'.repeat(1001) }],
      ['gcr_search', { query: 'x', limit: 201 }],
      ['gcr_search', { query: 'x', cursor: 'abc' }],
      ['gcr_search', { query: 'x', scope: 'everything' }],
      ['gcr_search', { query: 'x', createdAfter: 'y'.repeat(41) }],
      ['gcr_branches', { conversation: ID.linear, batchId: 'b_zz' }],
      ['gcr_thread', { conversation: ID.linear, allBranches: true }],
      ['gcr_stats', {}],
      ['gcr_stats', { groupBy: 'colour' }],
      ['gcr_stats', { groupBy: 'role', limit: 501 }],
      ['gcr_audit', { checks: [] }],
      ['gcr_audit', { checks: ['empty', 'empty'] }],
      ['gcr_audit', { checks: ['nonsense'] }],
      ['gcr_audit', { sampleSize: 51 }],
      ['gcr_graph_query', {}],
      ['gcr_graph_query', { term: 'x', depth: 5 }],
      ['gcr_graph_query', { term: 'x', maxNodes: 201 }],
      ['gcr_graph_query', { term: 'x', kinds: [] }],
      ['gcr_graph_query', { term: 'x', kinds: ['Has Space'] }],
      ['gcr_doctor', { verbose: true }],
    ];
    for (const [tool, args] of bad) {
      it(`${tool} rejects ${JSON.stringify(args).slice(0, 70)}`, async () => {
        const env = await h.env(tool, args);
        const err = assertError(env, 'INVALID_ARGUMENT');
        assert.ok(Array.isArray(err.details?.['issues']), 'the issues list says which field is wrong');
        assert.match(err.message, new RegExp(tool));
      });
    }

    it('a non-object arguments value is rejected too, and a missing one means {}', async () => {
      assert.equal((await h.env('gcr_doctor')).ok, true, 'no arguments at all is fine for a tool without parameters');
      const env = await h.env('gcr_list', undefined);
      assert.equal(env.ok, true);
    });

    it('error text never echoes a long hostile argument', async () => {
      const hostile = `secret-${'Z'.repeat(5000)}`;
      const env = await h.env('gcr_get', { conversation: hostile });
      assert.equal(env.ok, false);
      assert.ok(!JSON.stringify(env).includes('ZZZZZZZZZZ'), 'the value is not echoed');
    });
  });
});

describe('ambiguity across accounts', () => {
  let fx: Fixture;
  let h: MemHarness;
  before(async () => {
    fx = await createFixture({ secondAccount: true });
    h = await connectMem(fx.dbPath);
  });
  after(async () => {
    await h.close();
    await fx.cleanup();
  });

  it('the same id under two accounts is AMBIGUOUS_CONVERSATION with the candidates, for every conversation tool', async () => {
    for (const tool of ['gcr_get', 'gcr_branches', 'gcr_thread']) {
      const err = assertError(await h.env(tool, { conversation: ID.linear }), 'AMBIGUOUS_CONVERSATION');
      assert.deepEqual(err.details?.['candidates'], [
        { provider: 'chatgpt', accountLabel: 'default' },
        { provider: 'chatgpt', accountLabel: 'other' },
      ]);
      assert.match(err.remedy ?? '', /provider/);
    }
  });

  it('naming the account resolves it, and the two accounts hold different data', async () => {
    const def = await h.env('gcr_get', { conversation: ID.linear, accountLabel: 'default' });
    const other = await h.env('gcr_get', { conversation: ID.linear, accountLabel: 'other' });
    assert.equal(def.ok, true);
    assert.equal(other.ok, true);
    assert.notDeepEqual(def.data, other.data);
    const texts = (other.data?.['thread'] as { messages: Array<{ text: string }> }).messages.map((m) => m.text);
    assert.deepEqual(texts, ['same id other account', 'reply']);
    assert.equal((await h.env('gcr_get', { conversation: ID.linear, provider: 'chatgpt', accountLabel: 'other' })).ok, true);
  });

  it('a scope that matches nothing is NOT_IN_LOCAL_EXPORT', async () => {
    assertError(await h.env('gcr_get', { conversation: ID.linear, accountLabel: 'nobody' }), 'NOT_IN_LOCAL_EXPORT');
    assertError(await h.env('gcr_get', { conversation: ID.linear, provider: 'claude' }), 'NOT_IN_LOCAL_EXPORT');
  });

  it('list shows both snapshots of the id under their accounts', async () => {
    const items = (await h.env('gcr_list')).data?.['items'] as Array<{ conversationId: string; accountLabel: string }>;
    assert.deepEqual(items.filter((i) => i.conversationId === ID.linear).map((i) => i.accountLabel).sort(), ['default', 'other']);
  });
});

describe('graph not built / empty database / stored non-UUID ids', () => {
  it('gcr_graph_query on a database whose graph was never built warns GRAPH_EMPTY', async () => {
    const fx = await createFixture({ graph: false });
    const h = await connectMem(fx.dbPath);
    try {
      const env = await h.env('gcr_graph_query', { term: 'quokka' });
      assert.equal(env.ok, true);
      assert.ok(env.warnings.some((w) => w.code === 'GRAPH_EMPTY'));
    } finally {
      await h.close();
      await fx.cleanup();
    }
  });

  it('an empty database lists nothing and says completeness is unknown, not complete', async () => {
    const fx = await createFixture();
    const gcrPath = `${fx.dbPath}.empty.sqlite`;
    const creator = Gcr.open({ dbPath: gcrPath });
    creator.close();
    const h = await connectMem(gcrPath);
    try {
      const env = await h.env('gcr_list');
      assert.deepEqual(env.data?.['items'], []);
      assert.equal(env.completeness, 'unknown');
      assert.equal(env.warnings[0]?.code, 'SOURCE_NOT_FULL_HISTORY');
      assertError(await h.env('gcr_get', { conversation: ID.linear }), 'NOT_IN_LOCAL_EXPORT');
    } finally {
      await h.close();
      await fx.cleanup();
    }
  });

  it('a database handle that was closed under the server is a coded DB_ERROR, never a crash or a raw exception', async () => {
    const fx = await createFixture({ graph: false });
    const h = await connectMem(fx.dbPath);
    try {
      h.gcr.close();
      for (const [tool, args] of [['gcr_list', {}], ['gcr_get', { conversation: ID.linear }], ['gcr_search', { query: 'quokka' }], ['gcr_doctor', {}]] as const) {
        const env = await h.env(tool, args);
        assertError(env, 'DB_ERROR');
        assert.equal(env.error?.details?.['reason'], 'closed', tool);
      }
    } finally {
      await h.close();
      await fx.cleanup();
    }
  });

  it('syntheticUuid ids that are valid UUIDs but unknown stay NOT_IN_LOCAL_EXPORT', async () => {
    const fx = await createFixture({ graph: false });
    const h = await connectMem(fx.dbPath);
    try {
      assertError(await h.env('gcr_get', { conversation: syntheticUuid(0xabcdef) }), 'NOT_IN_LOCAL_EXPORT');
    } finally {
      await h.close();
      await fx.cleanup();
    }
  });
});
