/**
 * Adversarial review of conversation-reference handling (reference-resolution confusion):
 *  - a chatgpt.com link handed over as the `conversationId` of an OBJECT reference must be read as a link (it names a ChatGPT
 *    conversation) and must never be echoed back with its query string, whatever happens next;
 *  - a link used as a search filter must not match another provider's conversation that happens to share the id.
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { describe, it } from 'node:test';
import { Gcr } from '../../src/sdk/gcr.js';
import { ID, assertCode, chat, emptyDb, expectGcr, importBuilders, importClaude, standardDb, thrown } from './sdk.helpers.test.js';

const MISSING = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const REMEDY =
  'This conversation is not in the data you imported. GCR cannot fetch chatgpt.com conversations. Request your official export (ChatGPT Settings > Data controls > Export data), then run: gcr import <export.zip>';

describe('a chatgpt.com link inside an object reference', () => {
  it('resolves exactly like the string form: it names the ChatGPT conversation that was imported', async () => {
    const t = await standardDb();
    try {
      const byObject = t.gcr.get({ conversationId: `https://chatgpt.com/c/${ID.linear}` });
      const byString = t.gcr.get(`https://chatgpt.com/c/${ID.linear}`);
      assert.equal(byObject.data.conversation.conversationId, ID.linear);
      assert.equal(byObject.data.conversation.provider, 'chatgpt');
      assert.deepEqual(byObject.data.thread?.messages.map((m) => m.id), byString.data.thread?.messages.map((m) => m.id));
      // the other reading methods share the resolution
      assert.equal(t.gcr.branches({ conversationId: `https://chatgpt.com/c/${ID.linear}/` }).data.conversation.conversationId, ID.linear);
      assert.equal(t.gcr.thread({ conversationId: `  https://CHATGPT.com/c/${ID.linear.toUpperCase()}?utm=1#x` }).data.conversation.conversationId, ID.linear);
    } finally {
      await t.cleanup();
    }
  });

  it('a link to a conversation that is not imported is NOT_IN_LOCAL_EXPORT with the bare id: no query string, no fragment, no URL', async () => {
    const t = await standardDb();
    try {
      const e = expectGcr(thrown(() => t.gcr.get({ conversationId: `https://chatgpt.com/c/${MISSING}?token=SECRET-VALUE#fragment-secret` })), 'NOT_IN_LOCAL_EXPORT');
      assert.deepEqual(e.details, { conversationId: MISSING, provider: 'chatgpt' });
      assert.equal(e.remedy, REMEDY);
      const wire = JSON.stringify(e.toEnvelope());
      for (const leak of ['SECRET-VALUE', 'fragment-secret', 'token', 'https://', '?']) assert.ok(!wire.includes(leak), `the error envelope must not contain ${leak}`);
    } finally {
      await t.cleanup();
    }
  });

  it('share links, other hosts and malformed links keep their URL error codes in object form too', async () => {
    const t = await standardDb();
    try {
      const share = `https://chatgpt.com/share/${ID.linear}`;
      assertCode(() => t.gcr.get({ conversationId: share }), 'UNSUPPORTED_URL');
      assertCode(() => t.gcr.get({ conversationId: `https://evil.example/c/${ID.linear}` }), 'UNSUPPORTED_URL');
      assertCode(() => t.gcr.get({ conversationId: `https://chat.openai.com/c/${ID.linear}` }), 'UNSUPPORTED_URL');
      assertCode(() => t.gcr.get({ conversationId: `http://chatgpt.com/c/${ID.linear}` }), 'UNSUPPORTED_URL');
      assertCode(() => t.gcr.get({ conversationId: 'https://chatgpt.com/c/not-a-uuid' }), 'INVALID_UUID');
      assertCode(() => t.gcr.get({ conversationId: 'https://' }), 'INVALID_URL');
      for (const bad of [share, 'https://chatgpt.com/c/not-a-uuid?secret=1']) {
        const e = thrown(() => t.gcr.get({ conversationId: bad }));
        assert.ok(!JSON.stringify((e as { toEnvelope(): unknown }).toEnvelope()).includes('secret'), 'a refused link is never echoed');
      }
    } finally {
      await t.cleanup();
    }
  });

  it('a link cannot be combined with another provider: that contradiction is INVALID_ARGUMENT, not a silent pick', async () => {
    const t = await standardDb();
    try {
      const e = assertCode(() => t.gcr.get({ conversationId: `https://chatgpt.com/c/${ID.linear}`, provider: 'claude' }), 'INVALID_ARGUMENT');
      assert.ok(!e.message.includes('https://'));
      // the same provider is fine
      assert.equal(t.gcr.get({ conversationId: `https://chatgpt.com/c/${ID.linear}`, provider: 'chatgpt' }).data.conversation.provider, 'chatgpt');
    } finally {
      await t.cleanup();
    }
  });

  it('text that merely contains a colon is still a RAW stored id (only http(s) text is read as a link)', async () => {
    const t = await standardDb();
    try {
      const e = expectGcr(thrown(() => t.gcr.get({ conversationId: 'col:quokka' })), 'NOT_IN_LOCAL_EXPORT');
      assert.deepEqual(e.details, { conversationId: 'col:quokka' });
    } finally {
      await t.cleanup();
    }
  });

  it('local writes anchor through the same rule: a draft created with an object-form link lands on the ChatGPT conversation', async () => {
    const t = await standardDb();
    try {
      const d = await t.gcr.createDraft({ conversationRef: { conversationId: `https://chatgpt.com/c/${ID.linear}` }, body: 'a local draft' });
      assert.equal(d.data.draft.conversationId, ID.linear);
      assert.equal(d.data.draft.provider, 'chatgpt');
      const missing = await t.gcr.createAnnotation({ conversationRef: { conversationId: `https://chatgpt.com/c/${MISSING}?q=SECRET` }, body: 'x' }).then(
        () => null,
        (e: unknown) => e,
      );
      const err = expectGcr(missing, 'NOT_IN_LOCAL_EXPORT');
      assert.ok(!JSON.stringify(err.toEnvelope()).includes('SECRET'));
    } finally {
      await t.cleanup();
    }
  });
});

describe('a bare UUID string reference is only trimmed of ASCII whitespace (TQ-03)', () => {
  it('NBSP, BOM and U+2003 padding is INVALID_UUID on every reading method; ASCII padding resolves the conversation', async () => {
    const t = await standardDb();
    try {
      for (const ch of [' ', '﻿', ' ']) {
        for (const padded of [`${ch}${ID.linear}`, `${ID.linear}${ch}`, `${ch}${ID.linear}${ch}`]) {
          for (const [name, call] of [
            ['get', () => t.gcr.get(padded)],
            ['branches', () => t.gcr.branches(padded)],
            ['thread', () => t.gcr.thread(padded)],
          ] as const) {
            const e = assertCode(call, 'INVALID_UUID');
            assert.equal(e.details?.['reason'], 'not_a_uuid', `${name} ${JSON.stringify(padded)}`);
          }
        }
      }
      assert.equal(t.gcr.get(` \t${ID.linear.toUpperCase()}\n`).data.conversation.conversationId, ID.linear);
    } finally {
      await t.cleanup();
    }
  });
});

describe('object-form links never reach the network either', () => {
  it('looking up links (imported, missing, refused) through object references opens no socket and calls no fetch', async () => {
    const t = await standardDb();
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    const originalConnect = net.Socket.prototype.connect;
    (globalThis as { fetch: unknown }).fetch = (): never => {
      calls.push('fetch');
      throw new Error('network is forbidden in this test');
    };
    net.Socket.prototype.connect = function connect(): never {
      calls.push('socket');
      throw new Error('network is forbidden in this test');
    } as unknown as typeof net.Socket.prototype.connect;
    try {
      for (const id of [ID.linear, MISSING]) {
        try {
          t.gcr.get({ conversationId: `https://chatgpt.com/c/${id}?x=1` });
        } catch (e) {
          expectGcr(e, 'NOT_IN_LOCAL_EXPORT');
        }
      }
      assertCode(() => t.gcr.get({ conversationId: `https://chatgpt.com/share/${ID.linear}` }), 'UNSUPPORTED_URL');
      await t.gcr.createDraft({ conversationRef: { conversationId: `https://chatgpt.com/c/${ID.linear}` }, body: 'local only' });
      assert.deepEqual(calls, []);
    } finally {
      (globalThis as { fetch: unknown }).fetch = originalFetch;
      net.Socket.prototype.connect = originalConnect;
      await t.cleanup();
    }
  });
});

describe('search: a chatgpt.com link as conversationId filter is scoped to the chatgpt provider', () => {
  async function twoProviders(): Promise<{ gcr: Gcr; cleanup: () => Promise<void> }> {
    const t = await emptyDb();
    await importBuilders(t.gcr, t.dir, [chat(ID.linear, 'chatgpt side', [['quokka asked on chatgpt', 'quokka answered on chatgpt']])]);
    await importClaude(t.gcr, t.dir, [ID.linear]); // the SAME id under provider "claude"
    return t;
  }

  it('the link filter returns only chatgpt hits; a bare UUID (which names no provider) still returns both, each hit labelled with its provider', async () => {
    const t = await twoProviders();
    try {
      const all =t.gcr.search({ query: 'a*', mode: 'raw', conversationId: ID.linear, limit: 100 }).data.items;
      assert.deepEqual([...new Set(all.map((h) => h.provider))].sort(), ['chatgpt', 'claude'], 'a bare UUID matches under both providers');

      const viaLink = t.gcr.search({ query: 'a*', mode: 'raw', conversationId: `https://chatgpt.com/c/${ID.linear}`, limit: 100 });
      assert.ok(viaLink.data.items.length > 0);
      assert.deepEqual([...new Set(viaLink.data.items.map((h) => h.provider))], ['chatgpt'], 'a chatgpt.com link can only name a ChatGPT conversation');
      // the envelope agrees: nothing from the Claude batch contributed
      assert.deepEqual([...new Set(viaLink.source.map((s) => s.provider))], ['chatgpt']);
      assert.equal(viaLink.completeness, 'exported_tree');
    } finally {
      await t.cleanup();
    }
  });

  it('a link together with a different provider filter is a contradiction: INVALID_ARGUMENT', async () => {
    const t = await twoProviders();
    try {
      const e = assertCode(() => t.gcr.search({ query: 'quokka', conversationId: `https://chatgpt.com/c/${ID.linear}`, provider: 'claude' }), 'INVALID_ARGUMENT');
      assert.equal(e.details?.['field'], 'provider');
      assert.equal(t.gcr.search({ query: 'quokka', conversationId: `https://chatgpt.com/c/${ID.linear}`, provider: 'chatgpt' }).data.items.length > 0, true);
    } finally {
      await t.cleanup();
    }
  });
});
