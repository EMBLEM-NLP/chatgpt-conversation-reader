/**
 * Helpers shared by the command handlers.
 */
import { isUuid, parseConversationRef } from '../../domain/ids.js';
import type { ConversationRef, Provider } from '../../domain/types.js';
import { GcrError } from '../../errors.js';
import type { CommandContext } from '../context.js';

/** A copy of `o` without the keys whose value is undefined (the SDK treats absent and undefined alike; this keeps it explicit). */
export function defined<T extends Record<string, unknown>>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(o)) {
    const value = o[key];
    if (value !== undefined) out[key] = value;
  }
  return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}

/**
 * A conversation reference from the command line.
 *
 * The text is validated HERE, before the database is opened: a malformed UUID, a share link or another host fails with
 * exit code 2 whatever the state of the database (and without any I/O). A chatgpt.com link is only ever a lookup key.
 * With --provider / --account the reference becomes an object so the SDK resolves exactly that provider and account.
 */
export function conversationRef(raw: string, provider: string | undefined, account: string | undefined): string | ConversationRef {
  const parsed = parseConversationRef(raw);
  if (provider === undefined && account === undefined) return raw;
  const ref: ConversationRef = { conversationId: parsed.conversationId };
  if (provider !== undefined) ref.provider = provider as Provider;
  else if (parsed.viaUrl) ref.provider = 'chatgpt';
  if (account !== undefined) ref.accountLabel = account;
  return ref;
}

/** The `ref` positional of a command plus the --provider / --account disambiguation options. */
export function refFromArgs(ctx: CommandContext, positional: string): string | ConversationRef {
  return conversationRef(positional, ctx.args.string('provider'), ctx.args.string('account'));
}

/**
 * `search --conversation`: the SDK accepts a UUID, a link or any stored id. A UUID or something that looks like a URL is
 * validated here (same reason as conversationRef); other text is passed through as a raw stored id.
 */
export function conversationFilterValue(raw: string): string {
  if (isUuid(raw)) return raw.toLowerCase();
  if (/^[\t\n\f\r ]*[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) return parseConversationRef(raw).conversationId;
  return raw;
}

/** Exactly one positional (the spec's required one), as a string. */
export function first(ctx: CommandContext): string {
  const v = ctx.args.positionals[0];
  if (v === undefined) throw new GcrError('INVALID_ARGUMENT', 'A required argument is missing.', { remedy: `Run "gcr ${ctx.spec.path.join(' ')} --help" for usage.` });
  return v;
}

/** Print a rendered document (or part of one) on stdout. */
export function emit(ctx: CommandContext, text: string): void {
  ctx.out.stdout(text);
}
