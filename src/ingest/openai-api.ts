/**
 * Mode D contract: the OpenAI DEVELOPER API (SPEC section 3, ARCHITECTURE section 5, docs/ADAPTERS.md).
 *
 * What Mode D is:  a user's OWN conversations that THEIR application created through the OpenAI developer API,
 *                  read with a SEPARATELY AUTHORIZED API key that the operator holds outside GCR.
 * What it is NOT:  ChatGPT consumer history. A `https://chatgpt.com/c/<uuid>` conversation is a private consumer
 *                  resource; the developer API does not expose it and GCR never reaches for it (AGENTS.md, SPEC section 9).
 *
 * This version ships the interface and a DISABLED implementation only. Every method of the disabled adapter throws
 * GcrError NOT_IMPLEMENTED, synchronously (a rejected promise that nobody awaits could be lost; failing fast cannot).
 *
 * SECURITY INVARIANT (asserted by test/ingest/openai-api.test.ts): this module imports NOTHING that can perform I/O.
 * Its only runtime import is the pure error class; everything else is `import type`. Do not add fs/net/http/https/
 * child_process/dns/tls/worker_threads imports, fetch calls, or credential handling here. A real implementation needs a
 * reviewed ADR (docs/DECISIONS.md) and belongs in a different module that the registry opts into explicitly.
 */
import { GcrError } from '../errors.js';
import type { ConversationRecord } from '../domain/types.js';
import type { AdapterContext, AdapterOutcome, ConversationSourceAdapter } from './adapter.js';

/** Paging request for API-owned conversations. There is intentionally NO credential parameter: GCR never holds API keys. */
export interface OwnedConversationListRequest {
  limit?: number;
  cursor?: string;
}

export interface OwnedConversationPage {
  /** Records carry provider 'openai_api', provenance 'openai_developer_api' and completeness 'api_owned_conversation'. */
  conversations: ConversationRecord[];
  nextCursor: string | null;
}

/**
 * Mode D adapter contract. It extends the export-adapter contract only so a future implementation can reuse the
 * provider-neutral record; it is NOT registered as an export adapter (src/ingest/registry.ts lists chatgpt and claude only).
 */
export interface OpenAIAPIOwnedAdapter extends ConversationSourceAdapter {
  readonly provider: 'openai_api';
  readonly provenance: 'openai_developer_api';
  /** SPEC section 3 capability level. */
  readonly mode: 'D';
  /** false for the disabled implementation; a future implementation sets true only after its ADR and tests exist. */
  readonly implemented: boolean;
  listOwnedConversations(request?: OwnedConversationListRequest): Promise<OwnedConversationPage>;
  readOwnedConversation(conversationId: string): Promise<ConversationRecord>;
}

const REMEDY =
  'OpenAI developer-API conversations (Mode D) are conversations your own application created through the API. ' +
  'They are not ChatGPT consumer history, and a chatgpt.com/c/<uuid> conversation cannot be read through the API. ' +
  'Reading API-owned conversations would require a separately authorized API key that you hold outside GCR ' +
  '(GCR never requests, stores or logs credentials), and that capability is not implemented in this version. ' +
  'To work with ChatGPT consumer history, request an official data export from your ChatGPT account and import the ZIP ' +
  'or conversations.json with `gcr import`.';

/** The one error every disabled method throws. Exported so the registry can give the same answer for the id "openai_api". */
export function modeDNotImplemented(method: string): GcrError {
  return new GcrError('NOT_IMPLEMENTED', 'OpenAI API-owned conversation access (Mode D) is not implemented in this version.', {
    remedy: REMEDY,
    details: { mode: 'D', method },
  });
}

export class DisabledOpenAIAPIOwnedAdapter implements OpenAIAPIOwnedAdapter {
  readonly name = 'openai-api-owned (disabled)';
  readonly provider = 'openai_api' as const;
  readonly provenance = 'openai_developer_api' as const;
  readonly mode = 'D' as const;
  readonly implemented = false;

  constructor() {
    // `readonly` is compile-time only. Freezing keeps `implemented` false (and the identity fields intact) for every
    // caller: nobody can switch the disabled adapter on, or attach credentials to it, by assigning properties.
    Object.freeze(this);
  }

  normalizeElementText(_text: string, _ctx: AdapterContext, _elementIndex: number): AdapterOutcome {
    throw modeDNotImplemented('normalizeElementText');
  }

  listOwnedConversations(_request?: OwnedConversationListRequest): never {
    throw modeDNotImplemented('listOwnedConversations');
  }

  readOwnedConversation(_conversationId: string): never {
    throw modeDNotImplemented('readOwnedConversation');
  }
}
