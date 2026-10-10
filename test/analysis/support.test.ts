/**
 * Shared helpers for the test/analysis/*.test.ts files. It lives in a `.test.ts` file only because this module's owner may
 * create nothing else under test/; it registers NO tests (node --test runs it as an empty file). Everything here is
 * synthetic: ids, titles and texts are invented.
 *
 * Databases are built through the real Repository.importBatch (no mocks of the code under test).
 */
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../src/db/open.js';
import type { GcrDatabase } from '../../src/db/open.js';
import { Repository } from '../../src/db/repo.js';
import type { ImportBatchMeta, ImportBatchResult } from '../../src/db/repo.js';
import type { ConversationRecord, MessageRecord } from '../../src/domain/types.js';
import { convo, iso, link, msg } from '../helpers/records.js';

export { convo, iso, link, msg };

export interface Fresh {
  handle: GcrDatabase;
  db: DatabaseSync;
  repo: Repository;
}

/** A new in-memory GCR database. Tests close it with `handle.db.close()` (or let the process end). */
export function fresh(): Fresh {
  const handle = openDatabase(':memory:');
  return { handle, db: handle.db, repo: new Repository(handle.db) };
}

export function batchMeta(provider: ConversationRecord['provider'], accountLabel: string, salt: string, over: Partial<ImportBatchMeta> = {}): ImportBatchMeta {
  return {
    provider,
    accountLabel,
    provenance: provider === 'claude' ? 'official_claude_export' : 'official_chatgpt_export',
    completeness: 'exported_tree',
    sourceKind: 'conversations_json',
    sourceLabel: 'synthetic.json',
    contentDigest: `digest:${salt}:${provider}:${accountLabel}`,
    importedAt: '2025-02-01T00:00:00.000Z',
    toolVersion: '0.2.0-dev.0',
    warnings: [],
    ...over,
  };
}

/**
 * Imports records, one batch per (provider, accountLabel) group (a batch can only hold one scope). `salt` makes the
 * batch id distinct, so importing the same conversations with a different salt yields a SECOND snapshot (new batch).
 */
export async function importAll(repo: Repository, records: ConversationRecord[], salt = 'a', over: Partial<ImportBatchMeta> = {}): Promise<ImportBatchResult[]> {
  const groups = new Map<string, ConversationRecord[]>();
  for (const r of records) {
    const key = `${r.provider}\u0000${r.accountLabel}`;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [r]);
    else list.push(r);
  }
  const results: ImportBatchResult[] = [];
  for (const list of groups.values()) {
    const first = list[0] as ConversationRecord;
    results.push(await repo.importBatch({ batch: batchMeta(first.provider, first.accountLabel, salt, over), conversations: list }));
  }
  return results;
}

export interface MsgSpec {
  role?: string;
  text?: string;
  model?: string | null;
  /** ISO string, or null for "no timestamp". Default: iso(index + 1). */
  at?: string | null;
  hidden?: boolean;
  channel?: string | null;
  contentType?: string | null;
}

/**
 * root(structural) -> m0 -> m1 -> ... (a linear chain). Message ids are `<id>-m<i>`, the root is `<id>-root`.
 * currentNodeId = the last message (null for an empty spec list). `over` overrides any conversation field.
 */
export function chat(id: string, specs: MsgSpec[], over: Partial<ConversationRecord> = {}): ConversationRecord {
  const msgs: MessageRecord[] = [msg({ id: `${id}-root`, conversationId: id, nodeKind: 'structural_empty', authorRole: '', contentType: null, ordinal: 0 })];
  let prev = `${id}-root`;
  specs.forEach((s, i) => {
    const mid = `${id}-m${i}`;
    msgs.push(
      msg({
        id: mid,
        conversationId: id,
        parentId: prev,
        authorRole: s.role ?? (i % 2 === 0 ? 'user' : 'assistant'),
        modelSlug: s.model === undefined ? null : s.model,
        channel: s.channel === undefined ? null : s.channel,
        contentType: s.contentType === undefined ? 'text' : s.contentType,
        hidden: s.hidden === true,
        createdAt: s.at === undefined ? iso(i + 1) : s.at,
        text: s.text ?? `text of ${mid}`,
        ordinal: i + 1,
      }),
    );
    prev = mid;
  });
  return {
    provider: 'chatgpt',
    accountLabel: 'default',
    id,
    title: `Title of ${id}`,
    sourceUri: null,
    provenance: 'official_chatgpt_export',
    completeness: 'exported_tree',
    importedAt: '2025-02-01T00:00:00.000Z',
    createdAt: iso(0),
    updatedAt: iso(specs.length + 1),
    currentNodeId: specs.length === 0 ? null : prev,
    defaultModelSlug: null,
    messages: link(msgs),
    warnings: [],
    ...over,
  };
}

/** Same as `chat` but for the Claude provider (different provenance and no content type). */
export function claudeChat(id: string, specs: MsgSpec[], over: Partial<ConversationRecord> = {}): ConversationRecord {
  const base = chat(id, specs.map((s) => ({ contentType: null, ...s })), { provider: 'claude', provenance: 'official_claude_export', ...over });
  return base;
}

/** Row count of a table (static name from the test). */
export function countTable(db: DatabaseSync, table: 'messages' | 'conversations' | 'source_batches' | 'conversation_heads'): number {
  return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.['n']);
}

// ---------------------------------------------------------------------------------------------------------------
// Damaged / branched trees (all synthetic)
// ---------------------------------------------------------------------------------------------------------------

/** A star: structural root with `leaves` children (so `leaves` branches). currentNodeId = the first leaf. */
export function star(id: string, leaves: number, over: Partial<ConversationRecord> = {}): ConversationRecord {
  const msgs: MessageRecord[] = [msg({ id: `${id}-root`, conversationId: id, nodeKind: 'structural_empty', authorRole: '', contentType: null, ordinal: 0 })];
  for (let i = 0; i < leaves; i++) {
    msgs.push(
      msg({ id: `${id}-l${String(i).padStart(5, '0')}`, conversationId: id, parentId: `${id}-root`, authorRole: i % 2 === 0 ? 'user' : 'assistant', createdAt: iso(1), text: `leaf ${i}`, ordinal: i + 1 }),
    );
  }
  return convo(id, link(msgs), { currentNodeId: `${id}-l00000`, ...over });
}

/** root -> a -> b  plus  x <-> y (a parent cycle nobody can reach). currentNodeId = b. */
export function cyclic(id: string, over: Partial<ConversationRecord> = {}): ConversationRecord {
  const c = (s: string): string => `${id}-${s}`;
  const msgs = link([
    msg({ id: c('root'), conversationId: id, nodeKind: 'structural_empty', authorRole: '', contentType: null, ordinal: 0 }),
    msg({ id: c('a'), conversationId: id, parentId: c('root'), authorRole: 'user', createdAt: iso(1), text: 'a', ordinal: 1 }),
    msg({ id: c('b'), conversationId: id, parentId: c('a'), authorRole: 'assistant', createdAt: iso(2), text: 'b', ordinal: 2 }),
    msg({ id: c('x'), conversationId: id, parentId: c('y'), authorRole: 'user', createdAt: iso(3), text: 'x', ordinal: 3 }),
    msg({ id: c('y'), conversationId: id, parentId: c('x'), authorRole: 'assistant', createdAt: iso(4), text: 'y', ordinal: 4 }),
  ]);
  return convo(id, msgs, { currentNodeId: c('b'), ...over });
}

/** root -> a -> b  plus  o1 (parent "ghost", which does not exist) -> o2. */
export function orphaned(id: string, over: Partial<ConversationRecord> = {}): ConversationRecord {
  const c = (s: string): string => `${id}-${s}`;
  const msgs = link([
    msg({ id: c('root'), conversationId: id, nodeKind: 'structural_empty', authorRole: '', contentType: null, ordinal: 0 }),
    msg({ id: c('a'), conversationId: id, parentId: c('root'), authorRole: 'user', createdAt: iso(1), text: 'a', ordinal: 1 }),
    msg({ id: c('b'), conversationId: id, parentId: c('a'), authorRole: 'assistant', createdAt: iso(2), text: 'b', ordinal: 2 }),
    msg({ id: c('o1'), conversationId: id, parentId: 'ghost-node', authorRole: 'user', createdAt: iso(3), text: 'o1', ordinal: 3 }),
    msg({ id: c('o2'), conversationId: id, parentId: c('o1'), authorRole: 'assistant', createdAt: iso(4), text: 'o2', ordinal: 4 }),
  ]);
  return convo(id, msgs, { currentNodeId: c('b'), ...over });
}

export function selfParent(id: string): ConversationRecord {
  const c = (s: string): string => `${id}-${s}`;
  const msgs = link([
    msg({ id: c('root'), conversationId: id, nodeKind: 'structural_empty', authorRole: '', contentType: null, ordinal: 0 }),
    msg({ id: c('a'), conversationId: id, parentId: c('root'), authorRole: 'user', createdAt: iso(1), text: 'a', ordinal: 1 }),
    msg({ id: c('s'), conversationId: id, parentId: c('s'), authorRole: 'assistant', createdAt: iso(2), text: 's', ordinal: 2 }),
  ]);
  return convo(id, msgs, { currentNodeId: c('a') });
}

/** root -> a -> b where a DECLARES children [b, ghost-child] (one of them does not exist). */
export function mismatched(id: string): ConversationRecord {
  const c = (s: string): string => `${id}-${s}`;
  const msgs = link([
    msg({ id: c('root'), conversationId: id, nodeKind: 'structural_empty', authorRole: '', contentType: null, ordinal: 0 }),
    msg({ id: c('a'), conversationId: id, parentId: c('root'), authorRole: 'user', createdAt: iso(1), text: 'a', ordinal: 1 }),
    msg({ id: c('b'), conversationId: id, parentId: c('a'), authorRole: 'assistant', createdAt: iso(2), text: 'b', ordinal: 2 }),
  ]);
  const a = msgs[1];
  if (a === undefined) throw new Error('fixture: node a missing');
  a.childIds = [c('b'), 'ghost-child'];
  return convo(id, msgs, { currentNodeId: c('b') });
}

