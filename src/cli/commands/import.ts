/**
 * Write commands that bring data in: `import` (official exports) and `import-copy` (Mode B manual copies).
 *
 * Neither prints message text: the output is the import report (counts, batch id, warnings by code, provenance and
 * completeness). Inputs that do not exist are rejected BEFORE the database is opened, so a typo never creates an empty
 * database (or the default ./.gcr directory).
 */
import { statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { GcrError } from '../../errors.js';
import { renderEnvelope } from '../../format/render.js';
import type { InputSource } from '../../ingest/layout.js';
import type { ImportLimits } from '../../ingest/limits.js';
import type { CommandContext } from '../context.js';
import { readBoundedText } from '../input.js';
import { IMPORT_PROVIDERS, accountOption } from '../options.js';
import type { CommandSpec, OptionSpec } from '../spec.js';
import { printable } from '../text.js';
import { defined, emit, first } from './common.js';

/** `gcr import-copy` reads at most this much (the SDK's own bound for a manual-copy document is the same). */
const MANUAL_COPY_MAX_INPUT_BYTES = 64 * 1024 * 1024;
const LIMIT_MAX = 999_999_999_999_999;

const WRITE_ERRORS = ['DB_SCHEMA_TOO_NEW', 'DB_MIGRATION_FAILED', 'DB_ERROR', 'WRITE_FORBIDDEN'] as const;

function limitOptions(): OptionSpec[] {
  const limit = (name: string, valueName: string, description: string, max = LIMIT_MAX): OptionSpec => ({ name, kind: 'int', valueName, min: 1, max, description });
  return [
    limit('max-entries', 'n', 'Safety limit: most entries a ZIP may hold.', 100_000_000),
    limit('max-entry-bytes', 'bytes', 'Safety limit: largest uncompressed size of one ZIP entry.'),
    limit('max-total-bytes', 'bytes', 'Safety limit: total uncompressed bytes read from one import.'),
    limit('max-ratio', 'n', 'Safety limit: largest compression ratio of an entry (a decompression-bomb guard).', 1_000_000),
    limit('max-element-bytes', 'bytes', 'Safety limit: largest single conversation in bytes (also bounds standard input).'),
  ];
}

function inputNotFound(path: string): GcrError {
  return new GcrError('IMPORT_INPUT_NOT_FOUND', `The import path "${printable(basename(path), 60)}" does not exist or cannot be read.`, {
    remedy: 'Check the path. GCR never downloads anything: pass the export ZIP, the extracted folder or conversations.json that you downloaded yourself.',
    details: { reason: 'NOT_FOUND' },
  });
}

export const importCommand: CommandSpec = {
  path: ['import'],
  summary: 'Import an official ChatGPT (or Claude) export into the local database.',
  details: [
    'The input is the ZIP you downloaded from ChatGPT (Settings > Data controls > Export data), an extracted folder, a conversations*.json file, or "-" for JSON on standard input. GCR never fetches an export and reads no browser data.',
    'Importing is atomic and idempotent: the same input twice changes nothing, a newer export of the same conversations becomes the default snapshot and older ones are kept. The report shows counts and warning codes, never message text.',
    'The database is created on first use (mode 0600). With no --db and no GCR_DB the default ./.gcr/gcr.sqlite is used and ./.gcr is created with mode 0700.',
  ],
  positionals: [{ name: 'path', description: 'Export ZIP, extracted folder, conversations*.json file, or "-" for standard input (a file named "-" is written ./-).' }],
  options: [
    accountOption('Label that keeps exports of different accounts apart (letters, digits, _ . @ - and spaces, up to 64).'),
    { name: 'provider', kind: 'choice', valueName: 'provider', choices: IMPORT_PROVIDERS, description: 'Force the provider instead of detecting it from the file.', defaultText: 'detected from the file' },
    { name: 'strict', kind: 'boolean', description: 'Abort and store NOTHING if any conversation or manifest problem is found (default: record it as a warning and continue).' },
    ...limitOptions(),
  ],
  examples: [
    { command: 'import ~/Downloads/chatgpt-export.zip', note: 'Import the ZIP into the default database.' },
    { command: 'import ./export-folder --db ./work.sqlite --account work', note: 'Import an extracted folder into a chosen database under the account label "work".' },
    { command: 'import - --strict < conversations.json', note: 'Read conversations.json from standard input; fail instead of skipping damaged conversations.' },
    { command: 'import export.zip --max-element-bytes 67108864 --format json', note: 'Tighten the per-conversation size limit to 64 MiB and print the report as JSON.' },
  ],
  errors: ['IMPORT_INPUT_NOT_FOUND', 'IMPORT_UNSUPPORTED_FORMAT', 'IMPORT_ZIP_UNSAFE', 'IMPORT_LIMIT_EXCEEDED', 'IMPORT_PARSE_ERROR', ...WRITE_ERRORS],
  async run(ctx: CommandContext): Promise<void> {
    const a = ctx.args;
    const target = first(ctx);
    let source: InputSource;
    if (target === '-') {
      if (ctx.io.stdin.isTTY === true) ctx.note('reading the export from standard input; finish with Ctrl-D');
      source = { kind: 'stream', stream: ctx.io.stdin, label: 'stdin' };
    } else {
      const absolute = resolve(ctx.io.cwd, target);
      let found = false;
      try {
        found = statSync(absolute, { throwIfNoEntry: false }) !== undefined;
      } catch {
        found = false; // no permission to look: reported the same way, the message already says "or cannot be read"
      }
      if (!found) throw inputNotFound(absolute);
      source = { kind: 'path', path: absolute };
    }

    const limits: Partial<ImportLimits> = defined({
      maxEntries: a.int('max-entries'),
      maxEntryUncompressedBytes: a.int('max-entry-bytes'),
      maxTotalInflatedBytes: a.int('max-total-bytes'),
      maxCompressionRatio: a.int('max-ratio'),
      maxElementBytes: a.int('max-element-bytes'),
    });
    const showProgress = ctx.io.out.stderrIsTty && !ctx.quiet;

    const gcr = await ctx.openWrite();
    const env = await gcr.importExport({
      source,
      ...defined({
        accountLabel: a.string('account'),
        provider: a.choice<'chatgpt' | 'claude'>('provider'),
        strict: a.flag('strict') ? true : undefined,
      }),
      ...(Object.keys(limits).length > 0 ? { limits } : {}),
      // Progress is for a person watching a terminal; in a pipe or a log it would only be noise on stderr.
      ...(showProgress ? { onProgress: (p: { phase: string; file: string; elements: number }): void => ctx.io.out.stderr(`${p.phase} ${printable(p.file, 80)}: ${p.elements} conversations\n`) } : {}),
    });
    emit(ctx, renderEnvelope(env, ctx.renderOptions()));
  },
};

export const importCopyCommand: CommandSpec = {
  path: ['import-copy'],
  summary: 'Index a manual copy of a conversation (Mode B). Always marked partial.',
  details: [
    'For text you copied out of a conversation yourself. The input is one JSON document: {"conversationId"?, "title"?, "sourceUri"?: "https://chatgpt.com/c/<uuid>", "messages": [{"role", "text", "createdAt"?, "modelSlug"?}]} with 1 to 10000 messages.',
    'The result is always labelled partial_user_supplied: only the copied messages exist, no branch is invented and the active branch stays unknown. sourceUri is stored as a label and never opened.',
  ],
  positionals: [{ name: 'file', description: 'JSON file with the copied messages, or "-" for standard input.' }],
  options: [accountOption('Label that keeps copies of different accounts apart.')],
  examples: [
    { command: 'import-copy copied-messages.json', note: 'Index a copy; the output says completeness is partial_user_supplied.' },
    { command: 'import-copy - --account work --format json < copied-messages.json', note: 'Read the copy from standard input under the account label "work".' },
  ],
  errors: ['IMPORT_INPUT_NOT_FOUND', 'IMPORT_UNSUPPORTED_FORMAT', 'IMPORT_LIMIT_EXCEEDED', 'IMPORT_PARSE_ERROR', 'INVALID_URL', 'INVALID_UUID', ...WRITE_ERRORS],
  async run(ctx: CommandContext): Promise<void> {
    const text = await readBoundedText({
      spec: first(ctx),
      maxBytes: MANUAL_COPY_MAX_INPUT_BYTES,
      what: 'manual copy',
      codes: { missing: 'IMPORT_INPUT_NOT_FOUND', invalid: 'IMPORT_UNSUPPORTED_FORMAT', tooLarge: 'IMPORT_LIMIT_EXCEEDED' },
      stdin: ctx.io.stdin,
      onTty: () => ctx.note('reading the manual copy from standard input; finish with Ctrl-D'),
    });
    const gcr = await ctx.openWrite();
    const env = await gcr.importManualCopy(text.text, { ...defined({ accountLabel: ctx.args.string('account') }), sourceLabel: text.label });
    emit(ctx, renderEnvelope(env, ctx.renderOptions()));
  },
};
