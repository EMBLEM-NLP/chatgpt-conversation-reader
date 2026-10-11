/**
 * Gcr read methods against real databases built through the production import path: list, get, branches, thread,
 * search (all scopes, pagination, filters), stats, audit, listBatches. Positive and negative cases for each.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Gcr } from '../../src/sdk/gcr.js';
import type { SearchItem } from '../../src/sdk/gcr.js';
import { syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import type { TestDb } from './sdk.helpers.test.js';
import {
  ID,
  assertCode,
  assertEnvelopeShape,
  branched,
  chat,
  emptyDb,
  expectGcr,
  fixedClock,
  importBuilders,
  importClaude,
  makeTempDir,
  removeDir,
  standardDb,
  thrown,
  warningCodes,
} from './sdk.helpers.test.js';

describe('list', () => {
  let t: TestDb;
  before(async () => {
    t = await standardDb();
  });
  after(async () => {
    await t.cleanup();
  });

  it('returns a page of conversation summaries with the envelope fields', () => {
    const env = t.gcr.list();
    assertEnvelopeShape(env);
    assert.equal(env.data.total, 9);
    assert.equal(env.data.items.length, 9);
    assert.equal(env.data.nextOffset, null);
    assert.equal(env.source.length, 1, 'one import batch contributed');
    assert.equal(env.source[0]?.sourceLabel, 'conversations.json');
    assert.equal(env.untrustedContent, true, 'titles are imported text');
    assert.deepEqual([...(env.ids.conversationIds ?? [])].sort(), Object.values(ID).filter((id) => id !== ID.empty).sort());
    const s = env.data.items.find((i) => i.conversationId === ID.linear);
    assert.ok(s);
    assert.equal(s.provider, 'chatgpt');
    assert.equal(s.accountLabel, 'default');
    assert.equal(s.messageCount, 4);
    assert.equal(s.completeness, 'exported_tree');
  });

  it('paginates deterministically: limit/offset pages concatenate to the full list', () => {
    const all = t.gcr.list({ limit: 500 }).data.items.map((i) => i.conversationId);
    const seen: string[] = [];
    let offset: number | null = 0;
    let pages = 0;
    while (offset !== null) {
      const page: ReturnType<Gcr['list']>['data'] = t.gcr.list({ limit: 4, offset }).data;
      seen.push(...page.items.map((i) => i.conversationId));
      offset = page.nextOffset;
      pages++;
    }
    assert.equal(pages, 3);
    assert.deepEqual(seen, all);
  });

  it('sorts by title', () => {
    const titles = t.gcr.list({ sort: 'title_asc' }).data.items.map((i) => i.title ?? '');
    assert.deepEqual(titles, [...titles].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })));
  });

  it('filters by provider, account and title text', () => {
    assert.equal(t.gcr.list({ provider: 'chatgpt' }).data.total, 9);
    assert.equal(t.gcr.list({ provider: 'claude' }).data.total, 0);
    assert.equal(t.gcr.list({ accountLabel: 'nobody' }).data.total, 0);
    const hits = t.gcr.list({ titleQuery: 'branched' }).data.items.map((i) => i.conversationId).sort();
    assert.deepEqual(hits, [ID.branched, ID.noCurrent].sort());
  });

  it('accepts allBatches and its alias includeAllBatches, and refuses contradictory spellings', () => {
    assert.equal(t.gcr.list({ allBatches: true }).data.total, 9);
    assert.equal(t.gcr.list({ includeAllBatches: true }).data.total, 9);
    assert.equal(t.gcr.list({ allBatches: true, includeAllBatches: true }).data.total, 9);
    assertCode(() => t.gcr.list({ allBatches: true, includeAllBatches: false }), 'INVALID_ARGUMENT');
  });

  it('rejects bad values and unknown options with INVALID_ARGUMENT', () => {
    for (const bad of [{ limit: 0 }, { limit: 501 }, { limit: 1.5 }, { offset: -1 }, { sort: 'newest' }, { provider: 7 }, { allBatches: 'yes' }, { unknownOption: 1 }, { titleQuery: '   ' }]) {
      assertCode(() => t.gcr.list(bad as never), 'INVALID_ARGUMENT');
    }
    assertCode(() => t.gcr.list(null as never), 'INVALID_ARGUMENT');
  });

  it('an empty database lists nothing and says that nothing is known about completeness', async () => {
    const e = await emptyDb();
    try {
      const env = e.gcr.list();
      assert.equal(env.data.total, 0);
      assert.deepEqual(env.source, []);
      assert.equal(env.completeness, 'unknown');
      assert.equal(env.warnings[0]?.code, 'SOURCE_NOT_FULL_HISTORY');
    } finally {
      await e.cleanup();
    }
  });
});

describe('get: references', () => {
  let t: TestDb;
  before(async () => {
    t = await standardDb();
  });
  after(async () => {
    await t.cleanup();
  });

  it('by bare UUID', () => {
    const env = t.gcr.get(ID.linear);
    assertEnvelopeShape(env);
    assert.equal(env.data.conversation.conversationId, ID.linear);
    assert.equal(env.data.thread?.messages.length, 4);
    assert.equal(env.data.thread?.messages[0]?.text, 'tell me about the quokka habitat');
    assert.equal(env.data.thread?.selectionPolicy, 'source_current_node');
    assert.equal(env.completeness, 'exported_tree');
    assert.deepEqual(env.warnings, []);
  });

  it('by exact chatgpt.com link, with trailing slash, query string and fragment, and by upper-case UUID: same conversation', () => {
    const base = t.gcr.get(ID.linear).data.conversation;
    for (const ref of [
      `https://chatgpt.com/c/${ID.linear}`,
      `https://chatgpt.com/c/${ID.linear}/`,
      `https://chatgpt.com/c/${ID.linear}?utm_source=x#top`,
      ID.linear.toUpperCase(),
      { conversationId: ID.linear },
      { conversationId: ID.linear, provider: 'chatgpt' as const, accountLabel: 'default' },
    ]) {
      assert.deepEqual(t.gcr.get(ref).data.conversation, base);
    }
  });

  it('by object reference with a raw (non-UUID) conversation id', async () => {
    const dir = await makeTempDir();
    const gcr = Gcr.open({ dbPath: ':memory:', clock: fixedClock });
    try {
      await importBuilders(gcr, dir, [chat('raw-conversation-id-1', 'raw id', [['question', 'answer']])]);
      const env = gcr.get({ conversationId: 'raw-conversation-id-1' });
      assert.equal(env.data.conversation.conversationId, 'raw-conversation-id-1');
      // as a plain string it is not a UUID, so it is refused up front (the domain layer's INVALID_UUID)
      assertCode(() => gcr.get('raw-conversation-id-1'), 'INVALID_UUID');
    } finally {
      gcr.close();
      await removeDir(dir);
    }
  });

  it('invalid, share, other-host and wrong-scheme references keep their exact domain error codes', () => {
    const cases: Array<[string, string]> = [
      [`https://chatgpt.com/share/${ID.linear}`, 'UNSUPPORTED_URL'],
      [`https://evil.example/c/${ID.linear}`, 'UNSUPPORTED_URL'],
      [`http://chatgpt.com/c/${ID.linear}`, 'UNSUPPORTED_URL'],
      ['https://chatgpt.com/c/not-a-uuid', 'INVALID_UUID'],
      ['https://', 'INVALID_URL'],
      ['not a uuid', 'INVALID_UUID'],
      ['', 'INVALID_UUID'],
    ];
    for (const [ref, code] of cases) assertCode(() => t.gcr.get(ref), code as 'INVALID_URL');
    assertCode(() => t.gcr.get(42 as never), 'INVALID_ARGUMENT');
    assertCode(() => t.gcr.get(null as never), 'INVALID_ARGUMENT');
    assertCode(() => t.gcr.get({} as never), 'INVALID_ARGUMENT');
  });

  it('a UUID that is not in the local database is NOT_IN_LOCAL_EXPORT: no guessed content, exact remedy, no URL query string kept', () => {
    const missing = syntheticUuid(0x55);
    const e = expectGcr(thrown(() => t.gcr.get(`https://chatgpt.com/c/${missing}?token=SECRET-QUERY#SECRET-FRAGMENT`)), 'NOT_IN_LOCAL_EXPORT');
    assert.equal(
      e.remedy,
      'This conversation is not in the data you imported. GCR cannot fetch chatgpt.com conversations. Request your official export (ChatGPT Settings > Data controls > Export data), then run: gcr import <export.zip>',
    );
    assert.deepEqual(e.details, { conversationId: missing, provider: 'chatgpt' });
    assert.equal(e.exitCode, 3);
    const wire = JSON.stringify(e.toEnvelope());
    assert.ok(!wire.includes('SECRET'), 'no part of the URL beyond the id is echoed');
    assert.ok(!wire.includes('token'));
    // a bare UUID carries no provider hint
    assert.deepEqual(expectGcr(thrown(() => t.gcr.get(missing)), 'NOT_IN_LOCAL_EXPORT').details, { conversationId: missing });
  });

  it('getByUrl accepts ONLY an exact chatgpt.com link, answers like get, and refuses everything else with the domain error codes', () => {
    const viaUrl = t.gcr.getByUrl(`https://chatgpt.com/c/${ID.linear}/?x=1#y`);
    assertEnvelopeShape(viaUrl);
    assert.deepEqual(viaUrl.data, t.gcr.get(ID.linear).data);
    assert.equal(t.gcr.getByUrl(`https://chatgpt.com/c/${ID.branched}`, { branch: t.fx.branched.a2 }).data.thread?.selectionPolicy, 'explicit_branch');
    assertCode(() => t.gcr.getByUrl(ID.linear), 'INVALID_URL');
    assertCode(() => t.gcr.getByUrl(`https://chatgpt.com/share/${ID.linear}`), 'UNSUPPORTED_URL');
    assertCode(() => t.gcr.getByUrl(`https://chat.openai.com/c/${ID.linear}`), 'UNSUPPORTED_URL');
    assertCode(() => t.gcr.getByUrl('https://chatgpt.com/c/not-a-uuid'), 'INVALID_UUID');
    assertCode(() => t.gcr.getByUrl(7 as never), 'INVALID_ARGUMENT');
    const e = expectGcr(thrown(() => t.gcr.getByUrl(`https://chatgpt.com/c/${syntheticUuid(0x57)}?token=SECRET`)), 'NOT_IN_LOCAL_EXPORT');
    assert.deepEqual(e.details, { conversationId: syntheticUuid(0x57), provider: 'chatgpt' });
    assert.ok(!JSON.stringify(e.toEnvelope()).includes('SECRET'));
  });

  it('every read that takes a reference reports NOT_IN_LOCAL_EXPORT the same way', () => {
    const missing = syntheticUuid(0x56);
    assertCode(() => t.gcr.branches(missing), 'NOT_IN_LOCAL_EXPORT');
    assertCode(() => t.gcr.thread(missing), 'NOT_IN_LOCAL_EXPORT');
  });
});

describe('get: ambiguity, snapshots and shaping', () => {
  it('the same id under several accounts or providers is AMBIGUOUS_CONVERSATION until one is named', async () => {
    const dir = await makeTempDir();
    const gcr = Gcr.open({ dbPath: ':memory:', clock: fixedClock });
    try {
      await importBuilders(gcr, dir, [chat(ID.linear, 'work copy', [['work question', 'work answer']])], { accountLabel: 'work' });
      await importBuilders(gcr, dir, [chat(ID.linear, 'home copy', [['home question', 'home answer']])], { accountLabel: 'home' });
      await importClaude(gcr, dir, [ID.linear], { accountLabel: 'work' });

      const e = expectGcr(thrown(() => gcr.get(ID.linear)), 'AMBIGUOUS_CONVERSATION');
      assert.deepEqual(e.details?.['candidates'], [
        { provider: 'chatgpt', accountLabel: 'home' },
        { provider: 'chatgpt', accountLabel: 'work' },
        { provider: 'claude', accountLabel: 'work' },
      ]);
      // a link implies chatgpt but still two chatgpt accounts hold it
      assertCode(() => gcr.get(`https://chatgpt.com/c/${ID.linear}`), 'AMBIGUOUS_CONVERSATION');
      assertCode(() => gcr.thread(ID.linear), 'AMBIGUOUS_CONVERSATION');
      assertCode(() => gcr.branches(ID.linear), 'AMBIGUOUS_CONVERSATION');

      assert.equal(gcr.get({ conversationId: ID.linear, provider: 'chatgpt', accountLabel: 'work' }).data.thread?.messages[0]?.text, 'work question');
      assert.equal(gcr.get({ conversationId: ID.linear, provider: 'chatgpt', accountLabel: 'home' }).data.thread?.messages[0]?.text, 'home question');
      const claude = gcr.get({ conversationId: ID.linear, provider: 'claude' });
      assert.equal(claude.data.conversation.provider, 'claude');
      assert.equal(claude.completeness, 'rendered_active_view_only');
      assert.equal(claude.warnings[0]?.code, 'SOURCE_NOT_FULL_HISTORY');
    } finally {
      gcr.close();
      await removeDir(dir);
    }
  });

  it('a newer second export becomes the default; batchId pins the older snapshot; list(allBatches) shows both', async () => {
    const dir = await makeTempDir();
    const gcr = Gcr.open({ dbPath: ':memory:', clock: fixedClock });
    try {
      const first = await importBuilders(gcr, dir, [chat(ID.linear, 'v1', [['original question', 'original answer']])]);
      // identical id, later update_time and a changed answer
      const second = await importBuilders(gcr, dir, [chat(ID.linear, 'v2', [['original question', 'revised answer']], { updateTime: 1_760_900_000 })]);
      assert.notEqual(first.data.batchId, second.data.batchId);

      assert.equal(gcr.get(ID.linear).data.thread?.messages[1]?.text, 'revised answer', 'the head is the snapshot with the newest update time');
      const pinned = gcr.get(ID.linear, { batchId: first.data.batchId });
      assert.equal(pinned.data.thread?.messages[1]?.text, 'original answer');
      assert.equal(pinned.source[0]?.batchId, first.data.batchId);
      assert.equal(gcr.thread(ID.linear, { batchId: first.data.batchId }).data.messages[1]?.text, 'original answer');
      assert.equal(gcr.branches({ conversationId: ID.linear, batchId: first.data.batchId }).source[0]?.batchId, first.data.batchId);

      assert.equal(gcr.list().data.total, 1);
      const all = gcr.list({ allBatches: true });
      assert.equal(all.data.total, 2);
      assert.equal(all.source.length, 2);
      assert.deepEqual(gcr.listBatches().map((b) => b.batchId), [first.data.batchId, second.data.batchId]);

      assertCode(() => gcr.get(ID.linear, { batchId: 'b_unknown' }), 'NOT_IN_LOCAL_EXPORT');
      assertCode(() => gcr.get({ conversationId: ID.linear, batchId: first.data.batchId }, { batchId: second.data.batchId }), 'INVALID_ARGUMENT');
    } finally {
      gcr.close();
      await removeDir(dir);
    }

  });

  it('hidden messages are omitted by default and counted; includeHidden brings them back', async () => {
    const t = await standardDb();
    try {
      const plain = t.gcr.get(ID.hidden);
      assert.equal(plain.data.thread?.messages.length, 2);
      assert.equal(plain.data.thread?.omittedHidden, 1);
      const all = t.gcr.get(ID.hidden, { includeHidden: true });
      assert.equal(all.data.thread?.messages.length, 3);
      assert.equal(all.data.thread?.omittedHidden, 0);
      assert.equal(all.data.thread?.messages[0]?.authorRole, 'system');
      assert.equal(all.data.thread?.messages[0]?.hidden, true);
      // structural placeholder nodes are never part of a thread
      assert.ok(all.data.thread?.messages.every((m) => m.nodeKind === 'message'));
    } finally {
      await t.cleanup();
    }
  });

  it('rawSource is stripped by default and kept with includeRaw', async () => {
    const t = await standardDb();
    try {
      const plain = t.gcr.get(ID.linear).data.thread?.messages ?? [];
      assert.ok(plain.length > 0 && plain.every((m) => m.rawSource === undefined));
      const raw = t.gcr.get(ID.linear, { includeRaw: true }).data.thread?.messages ?? [];
      assert.ok(raw.length > 0 && raw.every((m) => m.rawSource !== undefined));
      // stripping copies: the second call is unaffected by the first
      assert.ok(t.gcr.get(ID.linear, { includeRaw: true }).data.thread?.messages.every((m) => m.rawSource !== undefined));
    } finally {
      await t.cleanup();
    }
  });

  it('rejects bad option values and unknown options', async () => {
    const t = await standardDb();
    try {
      for (const bad of [{ branch: '' }, { branch: 5 }, { branchPolicy: 'newest' }, { allBranches: 'yes' }, { includeHidden: 1 }, { batchId: '' }, { includeRaw: 'x' }, { typo: true }]) {
        assertCode(() => t.gcr.get(ID.linear, bad as never), 'INVALID_ARGUMENT');
      }
      // allBranches belongs to get(), not thread()
      assertCode(() => t.gcr.thread(ID.linear, { allBranches: true } as never), 'INVALID_ARGUMENT');
    } finally {
      await t.cleanup();
    }
  });
});

describe('branches', () => {
  let t: TestDb;
  before(async () => {
    t = await standardDb();
  });
  after(async () => {
    await t.cleanup();
  });

  it('lists every branch with activeness in deterministic branch order and the tree warnings', () => {
    const env = t.gcr.branches(ID.branched);
    assertEnvelopeShape(env);
    const { branches, activeBranchId, conversation } = env.data;
    assert.equal(conversation.conversationId, ID.branched);
    assert.equal(branches.length, 3);
    assert.deepEqual(branches.map((b) => b.index), [0, 1, 2]);
    assert.equal(branches.filter((b) => b.activeness === 'active').length, 1);
    assert.equal(branches.find((b) => b.activeness === 'active')?.branchId, activeBranchId);
    assert.equal(branches.filter((b) => b.activeness === 'inactive').length, 2);
    assert.deepEqual(env.ids.branchIds, branches.map((b) => b.branchId));
    assert.deepEqual(env.data.warnings, []);
    assert.deepEqual(env.data, t.gcr.branches(ID.branched).data, 'deterministic');
  });

  it('without a source current_node every branch is "unknown" and no active branch is invented', () => {
    const env = t.gcr.branches(ID.noCurrent);
    assert.equal(env.data.activeBranchId, null);
    assert.ok(env.data.branches.every((b) => b.activeness === 'unknown'));
    assert.ok(warningCodes(env).includes('NO_CURRENT_NODE'));
    assert.deepEqual(env.data.warnings.map((w) => w.code), ['NO_CURRENT_NODE']);
    // the import-time duplicate of NO_CURRENT_NODE is not repeated
    assert.equal(warningCodes(env).filter((c) => c === 'NO_CURRENT_NODE').length, 1);
  });

  it('a children-absent export derives its children: same three branches, with the importer\'s CHILDREN_ABSENT note', () => {
    const env = t.gcr.branches(ID.childrenAbsent);
    assert.equal(env.data.branches.length, 3);
    assert.ok(warningCodes(env).includes('CHILDREN_ABSENT'));
    assert.equal(env.data.activeBranchId, t.gcr.branches(ID.branched).data.activeBranchId);
  });

  it('a linear conversation has exactly one branch', () => {
    const env = t.gcr.branches(ID.linear);
    assert.equal(env.data.branches.length, 1);
    assert.equal(env.data.branches[0]?.activeness, 'active');
  });

  it('rejects bad options', () => {
    assertCode(() => t.gcr.branches(ID.linear, { batchId: 5 } as never), 'INVALID_ARGUMENT');
    assertCode(() => t.gcr.branches(ID.linear, { branch: 'x' } as never), 'INVALID_ARGUMENT');
  });
});

describe('search', () => {
  let t: TestDb;
  before(async () => {
    t = await standardDb();
  });
  after(async () => {
    await t.cleanup();
  });

  it('finds messages; every item is kind "message" and keeps the SearchHit fields', () => {
    const env = t.gcr.search({ query: 'quokka' });
    assertEnvelopeShape(env);
    assert.equal(env.data.items.length, 8);
    for (const item of env.data.items) {
      assert.equal(item.kind, 'message');
      assert.equal(typeof item.messageId, 'string');
      assert.equal(typeof item.snippet, 'string');
      assert.equal(item.provider, 'chatgpt');
    }
    // message ids are only unique within a conversation (the builder reuses 0x10, 0x11, ... in each), so they de-duplicate
    assert.deepEqual([...(env.ids.messageIds ?? [])].sort(), [...new Set(env.data.items.map((i) => (i.kind === 'message' ? i.messageId : '')))].sort());
    assert.equal(env.untrustedContent, true);
    assert.ok(env.ids.conversationIds?.includes(ID.linear));
  });

  it('is case- and diacritic-insensitive and matches CJK substrings', () => {
    assert.equal(t.gcr.search({ query: 'cafe' }).data.items.length, 1);
    assert.equal(t.gcr.search({ query: 'CAFÉ' }).data.items.length, 1);
    assert.equal(t.gcr.search({ query: '日本' }).data.items[0]?.conversationId, ID.unicode);
    assert.equal(t.gcr.search({ query: 'quokka*' }).data.items.length >= 9, true, 'prefix queries');
  });

  it('paginates by offset and by cursor to the same sequence with no repeat or skip', () => {
    const keyOf = (i: SearchItem): string => (i.kind === 'message' ? `${i.conversationId}/${i.messageId}/${i.batchId}` : '');
    const everything = t.gcr.search({ query: 'quokka', limit: 200 }).data.items.map(keyOf);
    const byOffset: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page: ReturnType<typeof t.gcr.search>['data'] = t.gcr.search({ query: 'quokka', limit: 3, offset }).data;
      byOffset.push(...page.items.map(keyOf));
      offset = page.nextOffset;
    }
    const byCursor: string[] = [];
    let cursor: string | null | undefined;
    do {
      const page: ReturnType<typeof t.gcr.search>['data'] = t.gcr.search({ query: 'quokka', limit: 3, ...(cursor === undefined || cursor === null ? {} : { cursor }) }).data;
      byCursor.push(...page.items.map(keyOf));
      cursor = page.nextCursor;
    } while (cursor !== null && cursor !== undefined);
    assert.deepEqual(byOffset, everything);
    assert.deepEqual(byCursor, everything);
    assert.equal(everything.length, 8);
    assert.equal(new Set(everything).size, 8, 'no repeats');
  });

  it('filters by provider, role, model presence, conversation (UUID or link) and time', () => {
    assert.equal(t.gcr.search({ query: 'quokka', provider: 'claude' }).data.items.length, 0);
    assert.equal(t.gcr.search({ query: 'quokka', role: 'assistant' }).data.items.length, 4);
    assert.equal(t.gcr.search({ query: 'quokka', hasModel: false }).data.items.length >= 4, true);
    assert.equal(t.gcr.search({ query: 'quokka', conversationId: ID.linear }).data.items.length, 2);
    assert.equal(t.gcr.search({ query: 'quokka', conversationId: `https://chatgpt.com/c/${ID.linear}` }).data.items.length, 2);
    assert.equal(t.gcr.search({ query: 'quokka', conversationId: ID.linear.toUpperCase() }).data.items.length, 2);
    assert.equal(t.gcr.search({ query: 'quokka', createdAfter: '2999-01-01T00:00:00Z' }).data.items.length, 0);
    assert.equal(t.gcr.search({ query: 'quokka', createdBefore: '2000-01-01T00:00:00Z' }).data.items.length, 0);
  });

  it('a conversationId filter is a raw id unless it is an http(s) link: ids with a colon filter (to nothing), bad links keep their URL errors', () => {
    assert.deepEqual(t.gcr.search({ query: 'quokka', conversationId: 'col:quokka' }).data.items, []);
    assert.deepEqual(t.gcr.search({ query: 'quokka', conversationId: 'urn:uuid:not-stored' }).data.items, []);
    assertCode(() => t.gcr.search({ query: 'quokka', conversationId: `https://chatgpt.com/share/${ID.linear}` }), 'UNSUPPORTED_URL');
    assertCode(() => t.gcr.search({ query: 'quokka', conversationId: `http://chatgpt.com/c/${ID.linear}` }), 'UNSUPPORTED_URL');
    assertCode(() => t.gcr.search({ query: 'quokka', conversationId: 'https://chatgpt.com/c/not-a-uuid' }), 'INVALID_UUID');
  });

  it('hidden messages are excluded unless includeHidden', () => {
    assert.equal(t.gcr.search({ query: 'scaffolding' }).data.items.length, 0);
    assert.equal(t.gcr.search({ query: 'scaffolding', includeHidden: true }).data.items.length, 1);
  });

  it('negative cases: empty or punctuation-only query, bad filters, raw FTS syntax errors', () => {
    for (const bad of [{ query: '' }, { query: '   ' }, { query: '"*^' }, { query: 5 }, {}, { query: 'x', limit: 0 }, { query: 'x', limit: 201 }, { query: 'x', offset: -1 }, { query: 'x', createdAfter: 'yesterday' }, { query: 'x', hasModel: 'yes' }, { query: 'x', mode: 'fuzzy' }, { query: 'x', scope: 'everything' }, { query: 'x', typo: 1 }]) {
      assertCode(() => t.gcr.search(bad as never), 'INVALID_ARGUMENT');
    }
    assertCode(() => t.gcr.search({ query: '"unterminated', mode: 'raw' }), 'FTS_SYNTAX_ERROR');
    assertCode(() => t.gcr.search({ query: 'quokka', cursor: 'not-a-cursor' }), 'INVALID_ARGUMENT');
    assertCode(() => t.gcr.search({ query: 'quokka', cursor: 'AAAA', offset: 3 }), 'INVALID_ARGUMENT');
  });

  it('scope "titles" lists conversations whose title matched, with kind "title"', () => {
    const env = t.gcr.search({ query: 'branched', scope: 'titles' });
    assert.deepEqual(env.data.items.map((i) => i.kind), ['title', 'title']);
    assert.deepEqual(env.data.items.map((i) => i.conversationId).sort(), [ID.branched, ID.noCurrent].sort());
    assert.equal(env.ids.messageIds, undefined);
    assert.equal(env.data.nextCursor, null);
  });

  it('message-only filters are refused for the title scopes instead of being ignored', () => {
    for (const scope of ['titles', 'all'] as const) {
      for (const f of [{ role: 'user' }, { channel: 'final' }, { hasModel: true }, { conversationId: ID.linear }, { createdAfter: '2020-01-01T00:00:00Z' }, { createdBefore: '2030-01-01T00:00:00Z' }, { cursor: 'abc' }, { includeHidden: true }]) {
        const e = expectGcr(thrown(() => t.gcr.search({ query: 'quokka', scope, ...f } as never)), 'INVALID_ARGUMENT');
        assert.equal(e.details?.['scope'], scope);
      }
      // the neutral default is fine
      t.gcr.search({ query: 'quokka', scope, includeHidden: false });
    }
  });
});

describe('search: scope "all" merges titles and messages deterministically', () => {
  let dir: string;
  let gcr: Gcr;
  before(async () => {
    dir = await makeTempDir();
    gcr = Gcr.open({ dbPath: ':memory:', clock: fixedClock });
    // two conversations with "quokka" in the TITLE, three with it in a message body
    await importBuilders(gcr, dir, [
      chat(syntheticUuid(1), 'quokka field notes', [['unrelated opening', 'unrelated reply']]),
      chat(syntheticUuid(2), 'quokka habitat', [['more unrelated text', 'still unrelated']]),
      chat(syntheticUuid(3), 'zebra notes', [['all about the quokka', 'a quokka is a marsupial'], ['and another quokka line', 'ok']]),
    ]);
  });
  after(async () => {
    gcr.close();
    await removeDir(dir);
  });

  it('lists every title hit first, then the message hits, each labelled with its kind', () => {
    const env = gcr.search({ query: 'quokka', scope: 'all' });
    assertEnvelopeShape(env);
    assert.deepEqual(env.data.items.map((i) => i.kind), ['title', 'title', 'message', 'message', 'message']);
    assert.equal(env.data.nextOffset, null);
    const titles = env.data.items.filter((i) => i.kind === 'title');
    assert.deepEqual(titles.map((i) => i.conversationId).sort(), [syntheticUuid(1), syntheticUuid(2)]);
    assert.deepEqual(env.ids.messageIds?.length, 3);
    assert.deepEqual(env.ids.conversationIds?.sort(), [syntheticUuid(1), syntheticUuid(2), syntheticUuid(3)]);
  });

  it('is deterministic and every page size gives the same concatenation', () => {
    const full = gcr.search({ query: 'quokka', scope: 'all', limit: 200 }).data.items.map(key);
    assert.equal(full.length, 5);
    for (const size of [1, 2, 3, 4, 5, 6]) {
      const seen: string[] = [];
      let offset: number | null = 0;
      let guard = 0;
      while (offset !== null && guard++ < 20) {
        const page: ReturnType<typeof gcr.search>['data'] = gcr.search({ query: 'quokka', scope: 'all', limit: size, offset }).data;
        seen.push(...page.items.map(key));
        offset = page.nextOffset;
      }
      assert.deepEqual(seen, full, `page size ${size}`);
    }
    assert.deepEqual(gcr.search({ query: 'quokka', scope: 'all' }).data, gcr.search({ query: 'quokka', scope: 'all' }).data);
  });

  it('a page that ends exactly where the titles end still reports the messages that follow', () => {
    const page = gcr.search({ query: 'quokka', scope: 'all', limit: 2 }).data;
    assert.deepEqual(page.items.map((i) => i.kind), ['title', 'title']);
    assert.equal(page.nextOffset, 2);
    const rest = gcr.search({ query: 'quokka', scope: 'all', limit: 2, offset: 2 }).data;
    assert.deepEqual(rest.items.map((i) => i.kind), ['message', 'message']);
    assert.equal(rest.nextOffset, 4);
  });

  it('an offset beyond the titles skips into the messages; far beyond everything is an empty last page', () => {
    assert.deepEqual(gcr.search({ query: 'quokka', scope: 'all', offset: 3 }).data.items.map((i) => i.kind), ['message', 'message']);
    const empty = gcr.search({ query: 'quokka', scope: 'all', offset: 50 }).data;
    assert.deepEqual(empty.items, []);
    assert.equal(empty.nextOffset, null);
  });

  it('refuses a window larger than the documented bound and an empty query', () => {
    assertCode(() => gcr.search({ query: 'quokka', scope: 'all', offset: 10_000, limit: 1 }), 'INVALID_ARGUMENT');
    assertCode(() => gcr.search({ query: '', scope: 'all' }), 'INVALID_ARGUMENT');
    assertCode(() => gcr.search({ query: 'quokka', scope: 'all', limit: 0 }), 'INVALID_ARGUMENT');
  });

  function key(i: SearchItem): string {
    return i.kind === 'message' ? `m:${i.messageId}` : `t:${i.conversationId}`;
  }
});

describe('thread', () => {
  let t: TestDb;
  before(async () => {
    t = await standardDb();
  });
  after(async () => {
    await t.cleanup();
  });

  it('returns the active thread as a ThreadResult envelope', () => {
    const env = t.gcr.thread(`https://chatgpt.com/c/${ID.branched}`);
    assertEnvelopeShape(env);
    assert.equal(env.data.selectionPolicy, 'source_current_node');
    assert.equal(env.data.activeness, 'active');
    assert.equal(env.data.conversation.conversationId, ID.branched);
    assert.deepEqual(env.data.messages.map((m) => m.text), ['first prompt about quokka', 'first answer about quokka', 'follow up question', 'answer two regenerated']);
    assert.equal(env.data.omittedHidden, 0);
    assert.deepEqual(env.ids.branchIds, [env.data.branchId]);
    assert.deepEqual(env.ids.messageIds, env.data.messages.map((m) => m.id));
  });

  it('an explicit branch id returns that branch', () => {
    const other = t.gcr.branches(ID.branched).data.branches.find((b) => b.activeness === 'inactive');
    assert.ok(other);
    const env = t.gcr.thread(ID.branched, { branch: other.branchId });
    assert.equal(env.data.branchId, other.branchId);
    assert.equal(env.data.selectionPolicy, 'explicit_branch');
    assert.equal(env.data.activeness, 'inactive');
  });

  it('the messages of every thread are root-to-leaf in order, with no structural nodes', () => {
    for (const b of t.gcr.branches(ID.branched).data.branches) {
      const th = t.gcr.thread(ID.branched, { branch: b.branchId }).data;
      assert.equal(th.messages.at(-1)?.id, b.branchId);
      assert.ok(th.messages.every((m) => m.nodeKind === 'message'));
      assert.equal(th.messages.length, b.visibleMessageCount);
    }
  });
});

describe('stats, audit and listBatches', () => {
  let t: TestDb;
  before(async () => {
    t = await standardDb();
  });
  after(async () => {
    await t.cleanup();
  });

  it('stats by role: totals add up, the envelope names the contributing batch, imported strings flag untrustedContent', () => {
    const env = t.gcr.stats({ groupBy: 'role' });
    assertEnvelopeShape(env);
    assert.equal(env.data.groupBy, 'role');
    const sum = env.data.rows.reduce((n, r) => n + r.messages, 0);
    assert.equal(sum, env.data.totals.messages);
    assert.ok(env.data.totals.messages > 0);
    assert.equal(env.source.length, 1);
    assert.equal(env.untrustedContent, true);
    assert.ok(Array.isArray(env.data.formatProfiles));
    // the standard export had one conversation without current_node, so the pooled completeness is not "exported_tree"
    assert.equal(env.completeness, 'mixed');
    assert.equal(env.warnings[0]?.code, 'SOURCE_NOT_FULL_HISTORY');
  });

  it('stats grouped by provider or day holds no imported strings, so untrustedContent is false (when no warning cites ids and no FormatProfile is attached)', async () => {
    const dir = await makeTempDir();
    const dbPath = `${dir}/stats.sqlite`;
    const gcr = Gcr.open({ dbPath, clock: fixedClock });
    let reopened: Gcr | undefined;
    try {
      await importBuilders(gcr, dir, [chat(ID.linear, 'one', [['alpha', 'beta']]), branched(ID.branched, 'two').builder]);
      // The handle that did the import also attaches the batch's FormatProfile, whose role counts are keyed by the export's own
      // role names (imported text): the flag is true there (see provenance.adversarial.test.ts for a hostile role name).
      assert.equal(gcr.stats({ groupBy: 'provider' }).data.formatProfiles.length, 1);
      assert.equal(gcr.stats({ groupBy: 'provider' }).untrustedContent, true);
      assert.equal(gcr.stats({ groupBy: 'day' }).untrustedContent, true);
      gcr.close();
      reopened = Gcr.open({ dbPath, readOnly: true });
      const byProvider = reopened.stats({ groupBy: 'provider' });
      assert.deepEqual(byProvider.data.rows.map((r) => r.key), ['chatgpt']);
      assert.deepEqual(byProvider.data.formatProfiles, []);
      assert.equal(byProvider.completeness, 'exported_tree');
      assert.equal(byProvider.untrustedContent, false);
      assert.equal(reopened.stats({ groupBy: 'day' }).untrustedContent, false);
      assert.equal(reopened.stats({ groupBy: 'model' }).untrustedContent, true, 'model slugs are imported strings');
      assert.equal(reopened.stats({ groupBy: 'conversation' }).untrustedContent, true, 'titles are imported text');
    } finally {
      reopened?.close();
      gcr.close();
      await removeDir(dir);
    }
    // with the standard export two conversations are not complete trees; the module's own INCOMPLETE_SOURCE warning cites their ids
    const t = await standardDb();
    try {
      const env = t.gcr.stats({ groupBy: 'provider' });
      assert.ok(warningCodes(env).includes('INCOMPLETE_SOURCE'));
      assert.equal(env.untrustedContent, true);
    } finally {
      await t.cleanup();
    }
  });

  it('stats never infers a model: messages without one are counted as unknown', () => {
    const env = t.gcr.stats({ groupBy: 'model' });
    const unknown = env.data.rows.find((r) => r.key === null);
    assert.ok(unknown, 'a bucket for messages whose source gave no model');
    assert.ok(unknown.label.startsWith('unknown'));
  });

  it('stats filters by provider and rejects bad arguments', () => {
    assert.equal(t.gcr.stats({ groupBy: 'role', provider: 'claude' }).data.totals.messages, 0);
    assert.deepEqual(t.gcr.stats({ groupBy: 'role', provider: 'claude' }).source, []);
    for (const bad of [{}, { groupBy: 'colour' }, { groupBy: 'role', limit: 0 }, { groupBy: 'role', tz: 'Not/AZone' }, { groupBy: 'role', createdAfter: 'x' }]) {
      assertCode(() => t.gcr.stats(bad as never), 'INVALID_ARGUMENT');
    }
    assertCode(() => t.gcr.stats(null as never), 'INVALID_ARGUMENT');
  });

  it('audit reports counts and ids only, with the contributing sources', () => {
    const env = t.gcr.audit();
    assertEnvelopeShape(env);
    assert.equal(env.data.scanned.conversations, 9);
    assert.ok(env.data.findings.length > 0);
    const noPointer = env.data.findings.find((f) => f.check === 'no_current_node');
    assert.ok(noPointer && noPointer.count >= 2, 'the fixtures without current_node are found');
    assert.ok(noPointer.sampleConversationIds.includes(ID.noCurrent));
    assert.equal(env.source.length, 1);
    assert.ok(!JSON.stringify(env.data).includes('quokka'), 'no message text in an audit');
    assert.equal(env.untrustedContent, true);
  });

  it('audit checks can be selected; bad checks are INVALID_ARGUMENT', () => {
    const env = t.gcr.audit({ checks: ['untitled'] });
    assert.deepEqual(env.data.findings.map((f) => f.check), ['untitled']);
    assertCode(() => t.gcr.audit({ checks: ['nonsense'] } as never), 'INVALID_ARGUMENT');
    assertCode(() => t.gcr.audit({ checks: [] }), 'INVALID_ARGUMENT');
    assertCode(() => t.gcr.audit({ sampleSize: 0 }), 'INVALID_ARGUMENT');
  });

  it('stats and audit include the FormatProfile of batches imported through this handle, and only those', async () => {
    const env = t.gcr.stats({ groupBy: 'role' });
    assert.equal(env.data.formatProfiles.length, 1);
    const fp = env.data.formatProfiles[0];
    assert.equal(fp?.batchId, env.source[0]?.batchId);
    assert.equal(fp?.formatProfile.conversations, 9);
    assert.equal(t.gcr.audit().data.formatProfiles[0]?.batchId, env.source[0]?.batchId);
    // a fresh handle over the same file did not run the import: nothing is invented
    const again = Gcr.open({ dbPath: t.dbPath, readOnly: true });
    try {
      assert.deepEqual(again.stats({ groupBy: 'role' }).data.formatProfiles, []);
      assert.deepEqual(again.audit().data.formatProfiles, []);
    } finally {
      again.close();
    }
  });

  it('listBatches returns plain BatchInfo records in import order with basename labels', () => {
    const batches = t.gcr.listBatches();
    assert.equal(batches.length, 1);
    const b = batches[0];
    assert.equal(b?.sourceLabel, 'conversations.json');
    assert.equal(b?.provenance, 'official_chatgpt_export');
    assert.equal(b?.completeness, 'exported_tree');
    assert.equal(b?.conversationCount, 9);
    assert.equal(b?.provider, 'chatgpt');
    assert.ok(b?.seq === 1);
  });
});
