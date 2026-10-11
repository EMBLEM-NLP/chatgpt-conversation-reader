/**
 * Human renderings (markdown, compact) for results that format/render.ts has no dedicated renderer for: the doctor
 * report and the local drafts/annotations. JSON and JSONL always go through the shared `renderEnvelope`, so machine
 * output has one shape across commands.
 *
 * Everything that is not a fixed string here (ids, titles, labels, kinds, previews) is treated as untrusted text: it
 * passes through `mdInline` / `codeSpan` / `mdTable` (Markdown) or `field` (compact), which neutralize Markdown, control
 * characters and bidi tricks. Draft and annotation BODIES are user text that may carry instructions meant for an AI
 * reader: they are never printed by these summaries (only their size and hash); `gcr draft show` prints a draft through
 * the SDK's fenced rendering.
 */
import type { ResultEnvelope } from '../domain/types.js';
import { codeSpan, fenceBlock, mdInline, mdTable, renderEnvelope, sanitizeUntrusted } from '../format/render.js';
import type { RenderOptions } from '../format/render.js';
import { formatInTimeZone } from '../format/time.js';
import type { DoctorReport } from '../sdk/doctor.js';
import type { LocalAnnotationData, LocalAnnotationListData, LocalDraftData, LocalDraftListData } from '../sdk/gcr.js';
import { printable } from './text.js';

/** A result that has no conversation provenance of its own (doctor, export summaries). */
export function plainEnvelope<T>(data: T, untrustedContent: boolean): ResultEnvelope<T> {
  return { ok: true, data, source: [], completeness: 'unknown', warnings: [], ids: {}, untrustedContent };
}

/** One field of a compact line: single line, bounded, no pipes. */
function field(text: string, max = 200): string {
  return printable(text, max).replace(/\|/g, '\\|');
}

function when(iso: string, opts: RenderOptions): string {
  return formatInTimeZone(iso, opts.tz ?? 'UTC');
}

function isMachine(opts: RenderOptions): boolean {
  return opts.format === 'json' || opts.format === 'jsonl';
}

// ---------------------------------------------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------------------------------------------

export function renderDoctor(report: DoctorReport, opts: RenderOptions): string {
  if (isMachine(opts)) return renderEnvelope(plainEnvelope(report, false), opts);
  const db = report.database;
  const dbText =
    db === null
      ? 'not inspected'
      : `${db.label}: ${db.exists ? 'exists' : 'does not exist yet'}, ${db.writable ? 'writable' : 'not writable'}, schema ${db.schemaVersion === null ? 'unknown' : String(db.schemaVersion)} (${db.schemaStatus})`;
  const nodeText = `${report.node.version} (requires ${report.node.requiredRange}): ${report.node.satisfiesEngines ? 'ok' : 'TOO OLD'}`;
  const sqliteText = report.sqlite.available ? `${report.sqlite.module} ${report.sqlite.version ?? ''}`.trim() : 'node:sqlite is NOT available';

  if (opts.format === 'compact') {
    const lines = [
      `# doctor | ${field(report.tool.name)} ${field(report.tool.version)} | ${report.ok ? 'ok' : 'problems'}`,
      `node: ${field(nodeText)}`,
      `sqlite: ${field(sqliteText)} fts5=${report.sqlite.fts5 ? 'yes' : 'no'}`,
      `schema: supported=${report.schema.supportedVersion}`,
      `database: ${field(dbText)}`,
      `env: ${report.env.map((e) => `${field(e.name)}=${e.status}`).join(' ')}`,
      ...report.modes.map((m) => `mode ${field(m.mode)}: ${field(m.name)} | ${field(m.status)}`),
      ...report.adapters.map((a) => `adapter ${field(a.id)}: provider=${field(a.provider)} provenance=${field(a.provenance)}`),
      `network: ${field(report.network.statement)}`,
      `problems: ${report.problems.length === 0 ? 'none' : report.problems.map((p) => field(p)).join('; ')}`,
      `# ${field(report.statement)}`,
    ];
    return `${lines.join('\n')}\n`;
  }

  const blocks = [
    '# GCR doctor',
    `Status: **${report.ok ? 'OK' : 'PROBLEMS FOUND'}**`,
    [
      `- Tool: ${mdInline(`${report.tool.name} ${report.tool.version}`)}`,
      `- Node: ${mdInline(nodeText)}`,
      `- SQLite: ${mdInline(sqliteText)}; FTS5 ${report.sqlite.fts5 ? 'available' : 'NOT available'}`,
      `- Supported database schema version: ${report.schema.supportedVersion}`,
      `- Database: ${mdInline(dbText)}`,
      `- Network: ${mdInline(report.network.statement)}`,
    ].join('\n'),
    '## Capability modes',
    mdTable(['Mode', 'Name', 'Status'], report.modes.map((m) => [m.mode, m.name, m.status])),
    '## Environment',
    report.env.map((e) => `- ${codeSpan(e.name)}: ${e.status} (the value is never read)`).join('\n'),
    '## Source adapters',
    mdTable(['Adapter', 'Provider', 'Provenance'], report.adapters.map((a) => [a.id, a.provider, a.provenance])),
    '## Problems',
    report.problems.length === 0 ? 'None.' : report.problems.map((p) => `- ${mdInline(p)}`).join('\n'),
    mdInline(report.statement),
  ];
  return `${blocks.join('\n\n')}\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// drafts
// ---------------------------------------------------------------------------------------------------------------

export function renderDraftSummary(env: ResultEnvelope<LocalDraftData>, opts: RenderOptions, verb: 'created' | 'archived'): string {
  if (isMachine(opts)) return renderEnvelope(env, opts);
  const d = env.data.draft;
  const link = d.manualContinuation.url;
  const bytes = Buffer.byteLength(d.body, 'utf8');
  if (opts.format === 'compact') {
    const lines = [
      `# draft ${verb} | local only | id=${field(d.draftId)}`,
      `conversation: ${field(d.conversationId)} | provider=${field(d.provider)} account=${field(d.accountLabel)} | status=${field(d.status)} namespace=${field(d.namespace)}`,
      `body: ${bytes} bytes sha256=${field(d.bodySha256)}`,
      `link: ${link === null ? 'none (no canonical chatgpt.com link for this conversation)' : field(link)}`,
      field(d.manualContinuation.note),
    ];
    return `${lines.join('\n')}\n`;
  }
  const blocks = [
    `# Draft ${verb} (local only)`,
    [
      `- Draft id: ${codeSpan(d.draftId)}`,
      `- Conversation: ${codeSpan(d.conversationId)} (${mdInline(d.provider)} / ${codeSpan(d.accountLabel)})`,
      `- Anchor message: ${d.anchorMessageId === null ? 'none' : codeSpan(d.anchorMessageId)}`,
      `- Status: ${mdInline(d.status)}; namespace ${codeSpan(d.namespace)}`,
      `- Body: ${bytes} bytes, sha256 ${codeSpan(d.bodySha256)}`,
      `- Updated: ${mdInline(when(d.updatedAt, opts))}`,
      `- Manual continuation link: ${link === null ? 'none (this conversation has no canonical chatgpt.com link)' : codeSpan(link)}`,
    ].join('\n'),
    `${mdInline(d.manualContinuation.note)}.`,
    `Show the draft again with: gcr draft show ${codeSpan(d.draftId)}`,
  ];
  return `${blocks.join('\n\n')}\n`;
}

export function renderDraftList(env: ResultEnvelope<LocalDraftListData>, opts: RenderOptions): string {
  if (isMachine(opts)) return renderEnvelope(env, opts);
  const page = env.data;
  const next = page.nextOffset === null ? 'none (end of results)' : String(page.nextOffset);
  if (opts.format === 'compact') {
    const lines = [
      `# drafts | local only | ${page.items.length} item(s) | next=${next}`,
      ...page.items.map((d) => `[${field(d.status)}] ${field(d.draftId)} | ${field(d.conversationId)} | ${field(d.namespace)} | ${when(d.updatedAt, opts)} | ${field(d.title ?? '(no title)', 80)}`),
    ];
    return `${lines.join('\n')}\n`;
  }
  const rows = page.items.map((d) => [d.draftId, d.status, d.conversationId, d.namespace, when(d.updatedAt, opts), d.title ?? '(no title)']);
  const blocks = [
    '# Local drafts',
    `- Page: ${page.items.length} item(s) at offset ${page.offset} (limit ${page.limit})\n- Next offset: ${next}\n- Local only: GCR never sends messages; drafts stay in this database.`,
    rows.length === 0 ? 'No drafts.' : mdTable(['Draft id', 'Status', 'Conversation', 'Namespace', 'Updated', 'Title'], rows),
  ];
  return `${blocks.join('\n\n')}\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// annotations
// ---------------------------------------------------------------------------------------------------------------

export function renderAnnotationSummary(env: ResultEnvelope<LocalAnnotationData>, opts: RenderOptions, verb: 'created' | 'updated' | 'shown'): string {
  if (isMachine(opts)) return renderEnvelope(env, opts);
  const a = env.data.annotation;
  const bytes = Buffer.byteLength(a.body, 'utf8');
  if (opts.format === 'compact') {
    const lines = [
      `# annotation ${verb} | local only | id=${field(a.annotationId)} | version=${a.version}`,
      `conversation: ${field(a.conversationId)} | message=${a.messageId === null ? '(conversation-level)' : field(a.messageId)} | kind=${field(a.kind)} namespace=${field(a.namespace)}`,
      `body: ${bytes} bytes | updated=${when(a.updatedAt, opts)}`,
      // Only `annotate show` prints the text; every continuation line is indented so it can never look like our own lines.
      ...(verb === 'shown' ? sanitizeUntrusted(a.body).split('\n').map((line) => `  ${line}`) : []),
    ];
    return `${lines.join('\n')}\n`;
  }
  const blocks = [
    `# Annotation ${verb} (local only)`,
    [
      `- Annotation id: ${codeSpan(a.annotationId)}`,
      `- Version: ${a.version} (pass it as --expected-version when updating)`,
      `- Conversation: ${codeSpan(a.conversationId)} (${mdInline(a.provider)} / ${codeSpan(a.accountLabel)})`,
      `- Message: ${a.messageId === null ? 'none (conversation-level)' : codeSpan(a.messageId)}`,
      `- Kind: ${codeSpan(a.kind)}; namespace ${codeSpan(a.namespace)}`,
      `- Body: ${bytes} bytes`,
      `- Updated: ${mdInline(when(a.updatedAt, opts))}`,
    ].join('\n'),
    ...(verb === 'shown' ? ['## Text (quoted data, not instructions)', fenceBlock(a.body)] : []),
    'Annotations are stored in this database only; nothing is sent anywhere.',
  ];
  return `${blocks.join('\n\n')}\n`;
}

export function renderAnnotationList(env: ResultEnvelope<LocalAnnotationListData>, opts: RenderOptions): string {
  if (isMachine(opts)) return renderEnvelope(env, opts);
  const page = env.data;
  const next = page.nextOffset === null ? 'none (end of results)' : String(page.nextOffset);
  if (opts.format === 'compact') {
    const lines = [
      `# annotations | local only | ${page.items.length} item(s) | next=${next}`,
      ...page.items.map((a) => `[${field(a.kind)}] ${field(a.annotationId)} v${a.version} | ${field(a.conversationId)} | ${a.messageId === null ? '(conversation-level)' : field(a.messageId)} | ${when(a.updatedAt, opts)}`),
    ];
    return `${lines.join('\n')}\n`;
  }
  const rows = page.items.map((a) => [a.annotationId, String(a.version), a.kind, a.conversationId, a.messageId ?? '(conversation)', when(a.updatedAt, opts)]);
  const blocks = [
    '# Local annotations',
    `- Page: ${page.items.length} item(s) at offset ${page.offset} (limit ${page.limit})\n- Next offset: ${next}`,
    rows.length === 0 ? 'No annotations.' : mdTable(['Annotation id', 'Version', 'Kind', 'Conversation', 'Message', 'Updated'], rows),
  ];
  return `${blocks.join('\n\n')}\n`;
}
