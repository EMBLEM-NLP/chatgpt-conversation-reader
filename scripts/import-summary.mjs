#!/usr/bin/env node
// Turns the JSON report of `gcr import ... --format json` into a short summary that is safe to paste into an issue or a chat: counts, the
// observed format profile and warning codes with counts, and nothing else (docs/FIRST_REAL_EXPORT.md).
//
//   gcr import export.zip --db private.sqlite --format json > report.json
//   node scripts/import-summary.mjs report.json            (or: ... | node scripts/import-summary.mjs -)
//
// What it prints is an ALLOW-LIST built field by field: tool version, provider, source kind, per-file name + counts, conversation and
// message counts, the `formatProfile` booleans/counters, and warning CODES with their counts. It never copies the batch id, the source or
// account label, a conversation or message id (`sampleIds`), a title, a warning message or any text. File names are base names of
// conversation files inside the export; a name with unusual characters or an excessive length is replaced by "<redacted>".
// Exit status: 0 on success, 2 when the input is not an import report. Nothing here reads a database or touches the network.
import { readFileSync } from 'node:fs';

const NAME = /^[A-Za-z0-9._-]{1,80}$/;
const num = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const bool = (v) => (typeof v === 'boolean' ? v : null);
const word = (v) => (typeof v === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(v) ? v : null);

function fail(message) {
  process.stderr.write(`import-summary: ${message}\n`);
  process.exit(2);
}

function summarize(report) {
  const d = report?.data;
  if (report?.ok !== true || d === null || typeof d !== 'object' || !Array.isArray(d.files) || d.formatProfile === undefined && d.alreadyImported !== true) {
    fail('the input is not the JSON report of a fresh `gcr import --format json` (it needs "ok": true, "data.files" and "data.formatProfile")');
  }
  const fp = d.formatProfile ?? {};
  const roleCounts = {};
  for (const [role, n] of Object.entries(fp.roleCounts ?? {})) if (word(role) !== null && num(n) !== null) roleCounts[role] = n;
  const codes = {};
  for (const w of Array.isArray(d.warnings) ? d.warnings : []) {
    const code = typeof w?.code === 'string' && /^[A-Z][A-Z0-9_]{1,60}$/.test(w.code) ? w.code : null;
    if (code !== null) codes[code] = (codes[code] ?? 0) + (num(w.count) ?? 1);
  }
  return {
    summarySchema: 'gcr-import-summary/1',
    toolVersion: word(report?.tool?.version),
    provider: word(d.provider),
    sourceKind: word(d.sourceKind),
    files: d.files.map((f) => ({ name: typeof f?.name === 'string' && NAME.test(f.name.split('/').pop() ?? '') ? f.name.split('/').pop() : '<redacted>', conversations: num(f?.conversations), failed: num(f?.failed) })),
    conversations: { read: num(d.conversations?.read), stored: num(d.conversations?.stored), failed: num(d.conversations?.failed) },
    messages: { stored: num(d.messages?.stored), structural: num(d.messages?.structural) },
    formatProfile: {
      layout: word(fp.layout),
      manifest: word(fp.manifest),
      wrapperObject: bool(fp.wrapperObject),
      conversations: num(fp.conversations),
      conversationsWithCurrentNode: num(fp.conversationsWithCurrentNode),
      nodesWithChildrenDeclared: num(fp.nodesWithChildrenDeclared),
      nodesWithChildrenAbsent: num(fp.nodesWithChildrenAbsent),
      roleCounts,
      messagesWithRecipient: num(fp.messagesWithRecipient),
      messagesWithStatus: num(fp.messagesWithStatus),
      messagesWithModelSlug: num(fp.messagesWithModelSlug),
      hiddenMessages: num(fp.hiddenMessages),
      rootIsLiteralClientCreatedRoot: bool(fp.rootIsLiteralClientCreatedRoot),
      auxiliaryFilesIgnored: num(fp.auxiliaryFilesIgnored),
      assetsExtensionless: bool(fp.assetsExtensionless),
    },
    warningCodes: Object.fromEntries(Object.entries(codes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    alreadyImported: d.alreadyImported === true,
  };
}

const arg = process.argv[2];
if (arg === undefined || process.argv.length > 3 || arg === '--help' || arg === '-h') {
  process.stderr.write('usage: node scripts/import-summary.mjs <report.json | ->\n');
  process.exit(arg === '--help' || arg === '-h' ? 0 : 2);
}
let text;
try {
  text = readFileSync(arg === '-' ? 0 : arg, 'utf8');
} catch {
  fail('cannot read the input');
}
let report;
try {
  report = JSON.parse(text);
} catch {
  fail('the input is not JSON');
}
process.stdout.write(`${JSON.stringify(summarize(report), null, 2)}\n`);
