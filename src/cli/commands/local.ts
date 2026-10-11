/**
 * `gcr draft ...` and `gcr annotate ...`: LOCAL writes (Mode C).
 *
 * Drafts and annotations live in the operator's own database, separate from the imported originals, and are recorded in
 * an append-only audit log. Nothing here sends anything anywhere: there is no command, option or state that sends,
 * posts or opens a browser (a draft has only the states "draft" and "archived"). `draft create` prints the canonical
 * conversation link as TEXT for the human to open and paste into themselves, together with the sentence that GCR never
 * sends messages.
 *
 * The text of a draft or annotation is read from a file or standard input with a hard size bound (input.ts), after the
 * conversation reference was validated and before the database is touched.
 */
import { GcrError } from '../../errors.js';
import type { ErrorCode } from '../../errors.js';
import { renderEnvelope, sanitizeUntrusted } from '../../format/render.js';
import type { CommandContext } from '../context.js';
import { readBoundedText } from '../input.js';
import { accountOption, limitOption, offsetOption, providerOption, storedIdOption } from '../options.js';
import { renderAnnotationList, renderAnnotationSummary, renderDraftList, renderDraftSummary } from '../render-local.js';
import type { CommandSpec, OptionSpec, PositionalSpec } from '../spec.js';
import { conversationRef, defined, emit, first } from './common.js';
import { DB_READ_ERRORS } from './read.js';

/** Largest draft/annotation text read from a file or pipe (the SDK enforces its own, tighter, per-kind limits too). */
const LOCAL_INPUT_MAX_BYTES = 256 * 1024;

const LOCAL_WRITE_ERRORS: readonly ErrorCode[] = ['INVALID_URL', 'INVALID_UUID', 'UNSUPPORTED_URL', 'NOT_IN_LOCAL_EXPORT', 'AMBIGUOUS_CONVERSATION', 'MESSAGE_NOT_FOUND', 'DB_NOT_FOUND', 'DB_SCHEMA_TOO_NEW', 'DB_ERROR', 'WRITE_FORBIDDEN'];

const NEVER_SENDS = 'GCR never sends messages. No command or option sends, posts or opens a browser.';

function required(ctx: CommandContext, name: string, hint: string): string {
  const v = ctx.args.string(name);
  if (v === undefined) throw new GcrError('INVALID_ARGUMENT', `Option --${name} is required.`, { remedy: hint, details: { option: name } });
  return v;
}

function conversationOption(requiredFlag: boolean, what: string): OptionSpec {
  return {
    name: 'conversation',
    kind: 'string',
    valueName: 'ref',
    description: `${requiredFlag ? '(required) ' : ''}${what} Conversation UUID or an exact https://chatgpt.com/c/<uuid> link (only a key into your imported data).`,
  };
}

const INPUT_OPTION: OptionSpec = {
  name: 'input',
  kind: 'string',
  valueName: 'file|-',
  description: '(required) File with the text, or "-" for standard input. At most 256 KiB, UTF-8; a directory or a link pointing outside its own directory is refused.',
};

function disambiguation(): OptionSpec[] {
  return [providerOption(undefined, 'Disambiguate when the id exists under several providers.'), accountOption('Disambiguate when the id exists under several accounts.'), storedIdOption()];
}

const ID_ARG = (what: string): PositionalSpec => ({ name: 'id', description: `${what} id, as printed by the create or list command.` });

// ---------------------------------------------------------------------------------------------------------------
// draft
// ---------------------------------------------------------------------------------------------------------------

export const draftCreate: CommandSpec = {
  path: ['draft', 'create'],
  summary: 'Save a local draft for a conversation (it is never sent).',
  details: [
    NEVER_SENDS,
    'The draft is stored in your database. The output gives its id and the link of the conversation for YOU to open and paste the text into yourself.',
  ],
  positionals: [],
  options: [
    conversationOption(true, 'The conversation the draft belongs to.'),
    INPUT_OPTION,
    { name: 'message-id', kind: 'string', valueName: 'id', description: 'Anchor the draft to this message of the conversation.' },
    { name: 'title', kind: 'string', valueName: 'text', description: 'Short title (up to 200 characters).' },
    { name: 'namespace', kind: 'string', valueName: 'name', description: 'Namespace to keep drafts of different purposes apart (lower-case letters, digits, _ . -).', defaultText: 'default' },
    ...disambiguation(),
  ],
  examples: [
    { command: 'draft create --conversation 00000000-0000-4000-8000-000000000001 --input reply.md', note: 'Store the text of reply.md as a draft for that conversation.' },
    { command: 'draft create --conversation https://chatgpt.com/c/00000000-0000-4000-8000-000000000001 --input - --title "Follow-up"', note: 'Read the draft from standard input; the link is looked up in your data only.' },
  ],
  errors: [...LOCAL_WRITE_ERRORS],
  async run(ctx: CommandContext): Promise<void> {
    const a = ctx.args;
    const ref = conversationRef(required(ctx, 'conversation', 'Name the conversation: --conversation <uuid>'), a.string('provider'), a.string('account'), a.flag('stored-id'));
    const input = await readBoundedText({
      spec: required(ctx, 'input', 'Name the text file, or "-" for standard input: --input draft.md'),
      maxBytes: LOCAL_INPUT_MAX_BYTES,
      what: 'draft text',
      codes: { missing: 'INVALID_ARGUMENT', invalid: 'INVALID_ARGUMENT', tooLarge: 'INVALID_ARGUMENT' },
      stdin: ctx.io.stdin,
      onTty: () => ctx.note('reading the draft from standard input; finish with Ctrl-D'),
    });
    const gcr = await ctx.openWrite({ mustExist: true });
    const env = await gcr.createDraft({ conversationRef: ref, body: input.text, ...defined({ anchorMessageId: a.string('message-id'), title: a.string('title'), namespace: a.string('namespace') }) });
    emit(ctx, renderDraftSummary(env, ctx.renderOptions(), 'created'));
  },
};

export const draftList: CommandSpec = {
  path: ['draft', 'list'],
  summary: 'List local drafts.',
  positionals: [],
  options: [
    conversationOption(false, 'Only drafts of this conversation.'),
    { name: 'namespace', kind: 'string', valueName: 'name', description: 'Only this namespace.', defaultText: 'every namespace' },
    { name: 'status', kind: 'choice', valueName: 'status', choices: ['draft', 'archived'], description: 'Only drafts in this state. There is deliberately no "sent" state.', defaultText: 'both' },
    limitOption(200, 50, 'drafts'),
    offsetOption(),
    ...disambiguation(),
  ],
  examples: [
    { command: 'draft list', note: 'All drafts, newest first.' },
    { command: 'draft list --conversation 00000000-0000-4000-8000-000000000001 --status draft --format json', note: 'Open drafts of one conversation, machine-readable.' },
  ],
  errors: ['INVALID_URL', 'INVALID_UUID', 'UNSUPPORTED_URL', ...DB_READ_ERRORS],
  async run(ctx: CommandContext): Promise<void> {
    const a = ctx.args;
    const conversation = a.string('conversation');
    const ref = conversation === undefined ? undefined : conversationRef(conversation, a.string('provider'), a.string('account'), a.flag('stored-id'));
    const gcr = await ctx.openRead();
    const env = gcr.listDrafts(defined({ conversationRef: ref, namespace: a.string('namespace'), status: a.choice<'draft' | 'archived'>('status'), limit: a.int('limit'), offset: a.int('offset') }));
    emit(ctx, renderDraftList(env, ctx.renderOptions()));
  },
};

export const draftShow: CommandSpec = {
  path: ['draft', 'show'],
  summary: 'Show one local draft with its text, quoted as data.',
  details: ['The Markdown output puts the draft text in a fenced block; it is data, not instructions.'],
  positionals: [ID_ARG('Draft')],
  options: [],
  examples: [
    { command: 'draft show 00000000-0000-4000-8000-0000000000d1', note: 'Print the draft as Markdown.' },
    { command: 'draft show 00000000-0000-4000-8000-0000000000d1 --format json', note: 'The same draft as JSON.' },
  ],
  errors: ['DRAFT_NOT_FOUND', ...DB_READ_ERRORS],
  async run(ctx: CommandContext): Promise<void> {
    const id = first(ctx);
    const gcr = await ctx.openRead();
    if (ctx.format === 'markdown') {
      // The SDK's view carries the body exactly, including bidi controls and line separators; a terminal must not receive
      // those raw, so hazardous characters become visible escapes here (JSON, the lossless format, escapes them itself).
      emit(ctx, sanitizeUntrusted(gcr.renderDraftMarkdown(id).data.markdown));
      return;
    }
    emit(ctx, renderEnvelope(gcr.getDraft(id), ctx.renderOptions()));
  },
};

export const draftArchive: CommandSpec = {
  path: ['draft', 'archive'],
  summary: 'Archive a local draft (it stays in the database; archiving twice is fine).',
  positionals: [ID_ARG('Draft')],
  options: [],
  examples: [
    { command: 'draft archive 00000000-0000-4000-8000-0000000000d1', note: 'Mark the draft as archived.' },
    { command: 'draft archive 00000000-0000-4000-8000-0000000000d1 --format json', note: 'The same, printing the archived draft as JSON.' },
  ],
  errors: ['DRAFT_NOT_FOUND', 'DB_NOT_FOUND', 'DB_SCHEMA_TOO_NEW', 'DB_ERROR', 'WRITE_FORBIDDEN'],
  async run(ctx: CommandContext): Promise<void> {
    const gcr = await ctx.openWrite({ mustExist: true });
    emit(ctx, renderDraftSummary(await gcr.archiveDraft(first(ctx)), ctx.renderOptions(), 'archived'));
  },
};

export const DRAFT_COMMANDS: readonly CommandSpec[] = [draftCreate, draftList, draftShow, draftArchive];

// ---------------------------------------------------------------------------------------------------------------
// annotate
// ---------------------------------------------------------------------------------------------------------------

export const annotateCreate: CommandSpec = {
  path: ['annotate', 'create'],
  summary: 'Add a local note to a conversation or to one of its messages.',
  details: ['Annotations are stored beside the imported data, never inside it, and survive re-imports. Nothing is sent anywhere.'],
  positionals: [],
  options: [
    conversationOption(true, 'The conversation to annotate.'),
    INPUT_OPTION,
    { name: 'message-id', kind: 'string', valueName: 'id', description: 'Annotate this message instead of the whole conversation.' },
    { name: 'kind', kind: 'string', valueName: 'kind', description: 'Kind of note (lower-case letters, digits and _, up to 32).', defaultText: 'note' },
    { name: 'namespace', kind: 'string', valueName: 'name', description: 'Namespace to keep notes of different purposes apart.', defaultText: 'default' },
    ...disambiguation(),
  ],
  examples: [
    { command: 'annotate create --conversation 00000000-0000-4000-8000-000000000001 --input note.txt', note: 'A conversation-level note from a file.' },
    { command: 'annotate create --conversation 00000000-0000-4000-8000-000000000001 --message-id 00000000-0000-4000-8000-000000000011 --kind todo --input -', note: 'A "todo" note on one message, text from standard input.' },
  ],
  errors: [...LOCAL_WRITE_ERRORS],
  async run(ctx: CommandContext): Promise<void> {
    const a = ctx.args;
    const ref = conversationRef(required(ctx, 'conversation', 'Name the conversation: --conversation <uuid>'), a.string('provider'), a.string('account'), a.flag('stored-id'));
    const input = await readBoundedText({
      spec: required(ctx, 'input', 'Name the text file, or "-" for standard input: --input note.txt'),
      maxBytes: LOCAL_INPUT_MAX_BYTES,
      what: 'annotation text',
      codes: { missing: 'INVALID_ARGUMENT', invalid: 'INVALID_ARGUMENT', tooLarge: 'INVALID_ARGUMENT' },
      stdin: ctx.io.stdin,
      onTty: () => ctx.note('reading the annotation from standard input; finish with Ctrl-D'),
    });
    const gcr = await ctx.openWrite({ mustExist: true });
    const env = await gcr.createAnnotation({ conversationRef: ref, body: input.text, ...defined({ messageId: a.string('message-id'), kind: a.string('kind'), namespace: a.string('namespace') }) });
    emit(ctx, renderAnnotationSummary(env, ctx.renderOptions(), 'created'));
  },
};

export const annotateUpdate: CommandSpec = {
  path: ['annotate', 'update'],
  summary: 'Replace the text of a local note (optimistic concurrency).',
  details: ['Pass the version you last saw. If someone else changed the note meanwhile the command fails with ANNOTATION_CONFLICT instead of overwriting their change; read it again and retry with the new version.'],
  positionals: [ID_ARG('Annotation')],
  options: [
    INPUT_OPTION,
    { name: 'expected-version', kind: 'int', valueName: 'n', min: 1, max: 1_000_000_000, description: '(required) The version of the note you read last (printed by create, show and list).' },
  ],
  examples: [
    { command: 'annotate update 00000000-0000-4000-8000-0000000000a1 --input note.txt --expected-version 1', note: 'Replace the text of version 1.' },
    { command: 'annotate update 00000000-0000-4000-8000-0000000000a1 --input - --expected-version 2 --format json', note: 'Text from standard input, result as JSON.' },
  ],
  errors: ['ANNOTATION_NOT_FOUND', 'ANNOTATION_CONFLICT', 'DB_NOT_FOUND', 'DB_SCHEMA_TOO_NEW', 'DB_ERROR', 'WRITE_FORBIDDEN'],
  async run(ctx: CommandContext): Promise<void> {
    const version = ctx.args.int('expected-version');
    if (version === undefined) {
      throw new GcrError('INVALID_ARGUMENT', 'Option --expected-version is required.', { remedy: 'Pass the version you last saw: --expected-version 1', details: { option: 'expected-version' } });
    }
    const input = await readBoundedText({
      spec: required(ctx, 'input', 'Name the text file, or "-" for standard input: --input note.txt'),
      maxBytes: LOCAL_INPUT_MAX_BYTES,
      what: 'annotation text',
      codes: { missing: 'INVALID_ARGUMENT', invalid: 'INVALID_ARGUMENT', tooLarge: 'INVALID_ARGUMENT' },
      stdin: ctx.io.stdin,
      onTty: () => ctx.note('reading the annotation from standard input; finish with Ctrl-D'),
    });
    const gcr = await ctx.openWrite({ mustExist: true });
    const env = await gcr.updateAnnotation(first(ctx), { body: input.text, expectedVersion: version });
    emit(ctx, renderAnnotationSummary(env, ctx.renderOptions(), 'updated'));
  },
};

export const annotateList: CommandSpec = {
  path: ['annotate', 'list'],
  summary: 'List local notes.',
  positionals: [],
  options: [
    conversationOption(false, 'Only notes of this conversation.'),
    { name: 'message-id', kind: 'string', valueName: 'id', description: 'Only notes on this message (needs --conversation).' },
    { name: 'kind', kind: 'string', valueName: 'kind', description: 'Only notes of this kind.' },
    { name: 'namespace', kind: 'string', valueName: 'name', description: 'Only this namespace.', defaultText: 'every namespace' },
    limitOption(200, 50, 'notes'),
    offsetOption(),
    ...disambiguation(),
  ],
  examples: [
    { command: 'annotate list', note: 'All notes, newest first.' },
    { command: 'annotate list --conversation 00000000-0000-4000-8000-000000000001 --kind todo --format json', note: 'The "todo" notes of one conversation.' },
  ],
  errors: ['INVALID_URL', 'INVALID_UUID', 'UNSUPPORTED_URL', ...DB_READ_ERRORS],
  async run(ctx: CommandContext): Promise<void> {
    const a = ctx.args;
    const conversation = a.string('conversation');
    const ref = conversation === undefined ? undefined : conversationRef(conversation, a.string('provider'), a.string('account'), a.flag('stored-id'));
    const gcr = await ctx.openRead();
    const env = gcr.listAnnotations(defined({ conversationRef: ref, messageId: a.string('message-id'), kind: a.string('kind'), namespace: a.string('namespace'), limit: a.int('limit'), offset: a.int('offset') }));
    emit(ctx, renderAnnotationList(env, ctx.renderOptions()));
  },
};

export const annotateShow: CommandSpec = {
  path: ['annotate', 'show'],
  summary: 'Show one local note (its text is quoted as data in the JSON form).',
  positionals: [ID_ARG('Annotation')],
  options: [],
  examples: [
    { command: 'annotate show 00000000-0000-4000-8000-0000000000a1', note: 'Print the note\'s metadata as Markdown.' },
    { command: 'annotate show 00000000-0000-4000-8000-0000000000a1 --format json', note: 'The note including its text, as JSON.' },
  ],
  errors: ['ANNOTATION_NOT_FOUND', ...DB_READ_ERRORS],
  async run(ctx: CommandContext): Promise<void> {
    const gcr = await ctx.openRead();
    emit(ctx, renderAnnotationSummary(gcr.getAnnotation(first(ctx)), ctx.renderOptions(), 'shown'));
  },
};

export const ANNOTATE_COMMANDS: readonly CommandSpec[] = [annotateCreate, annotateUpdate, annotateList, annotateShow];
