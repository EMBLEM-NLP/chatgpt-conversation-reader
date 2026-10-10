/**
 * Builders for domain-level synthetic records (NOT raw ChatGPT export JSON; see chatgpt-export-builder.ts for that).
 * Everything here is invented test data. Timestamps are deterministic.
 */
import type { ConversationRecord, MessageRecord } from '../../src/domain/types.js';

export const BASE_TIME = Date.UTC(2025, 0, 1, 0, 0, 0);

export function iso(minuteOffset: number): string {
  return new Date(BASE_TIME + minuteOffset * 60_000).toISOString();
}

export function msg(m: Partial<MessageRecord> & { id: string; conversationId: string }): MessageRecord {
  return {
    parentId: null,
    childIds: [],
    nodeKind: 'message',
    authorRole: 'user',
    authorName: null,
    modelSlug: null,
    channel: null,
    recipient: null,
    contentType: 'text',
    status: null,
    hidden: false,
    createdAt: null,
    updatedAt: null,
    text: '',
    blocks: [],
    attachments: [],
    ordinal: 0,
    ...m,
  };
}

export function convo(id: string, messages: MessageRecord[], over: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    provider: 'chatgpt',
    accountLabel: 'default',
    id,
    title: `Synthetic ${id}`,
    sourceUri: null,
    provenance: 'official_chatgpt_export',
    completeness: 'exported_tree',
    importedAt: '2025-02-01T00:00:00.000Z',
    createdAt: iso(0),
    updatedAt: iso(messages.length),
    currentNodeId: null,
    defaultModelSlug: null,
    messages,
    warnings: [],
    ...over,
  };
}

/** Wire parent/child pointers from a list of [id, parentId|null] edges (children in listed order). */
export function link(messages: MessageRecord[]): MessageRecord[] {
  const byId = new Map(messages.map((m) => [m.id, m] as const));
  for (const m of messages) m.childIds = [];
  for (const m of messages) {
    if (m.parentId !== null) byId.get(m.parentId)?.childIds.push(m.id);
  }
  return messages;
}

/** root(structural) -> u0 -> a0 -> u1 -> a1 ... ; currentNodeId = last message. */
export function linearConversation(id: string, pairs: number, opts: { model?: string | null; text?: (i: number, role: string) => string } = {}): ConversationRecord {
  const msgs: MessageRecord[] = [msg({ id: `${id}-root`, conversationId: id, nodeKind: 'structural_empty', authorRole: '', contentType: null, ordinal: 0 })];
  let prev = `${id}-root`;
  let ord = 1;
  for (let i = 0; i < pairs; i++) {
    for (const role of ['user', 'assistant'] as const) {
      const mid = `${id}-${role[0]}${i}`;
      msgs.push(
        msg({
          id: mid,
          conversationId: id,
          parentId: prev,
          authorRole: role,
          modelSlug: role === 'assistant' ? (opts.model === undefined ? 'synthetic-model-1' : opts.model) : null,
          createdAt: iso(ord),
          text: opts.text ? opts.text(i, role) : `${role} message ${i} about topic${i}`,
          ordinal: ord,
        }),
      );
      prev = mid;
      ord++;
    }
  }
  return convo(id, link(msgs), { currentNodeId: prev });
}

/**
 * root -> u0 -> a0 -> u1 -> { a1_old (regenerated away), a1_new }   (two leaves, same parent)
 *            \-> u0_edit -> a0_edit                                 (edited user prompt: third leaf)
 * currentNodeId = a1_new.
 */
export function branchedConversation(id: string): ConversationRecord {
  const c = (suffix: string) => `${id}-${suffix}`;
  const msgs = link([
    msg({ id: c('root'), conversationId: id, nodeKind: 'structural_empty', authorRole: '', contentType: null, ordinal: 0 }),
    msg({ id: c('u0'), conversationId: id, parentId: c('root'), authorRole: 'user', createdAt: iso(1), text: 'first prompt', ordinal: 1 }),
    msg({ id: c('a0'), conversationId: id, parentId: c('u0'), authorRole: 'assistant', modelSlug: 'synthetic-model-1', createdAt: iso(2), text: 'first answer', ordinal: 2 }),
    msg({ id: c('u1'), conversationId: id, parentId: c('a0'), authorRole: 'user', createdAt: iso(3), text: 'follow up', ordinal: 3 }),
    msg({ id: c('a1_old'), conversationId: id, parentId: c('u1'), authorRole: 'assistant', modelSlug: 'synthetic-model-1', createdAt: iso(4), text: 'old regenerated answer', ordinal: 4 }),
    msg({ id: c('a1_new'), conversationId: id, parentId: c('u1'), authorRole: 'assistant', modelSlug: 'synthetic-model-2', createdAt: iso(5), text: 'new regenerated answer', ordinal: 5 }),
    msg({ id: c('u0_edit'), conversationId: id, parentId: c('root'), authorRole: 'user', createdAt: iso(6), text: 'edited first prompt', ordinal: 6 }),
    msg({ id: c('a0_edit'), conversationId: id, parentId: c('u0_edit'), authorRole: 'assistant', modelSlug: null, createdAt: iso(7), text: 'answer to edited prompt', ordinal: 7 }),
  ]);
  return convo(id, msgs, { currentNodeId: c('a1_new') });
}
