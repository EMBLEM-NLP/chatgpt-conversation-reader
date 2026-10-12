# GCR warning-code catalogue

Status: generated from the source tree on 2026-10-11 with Node 22.22.0 (repository state of that day, package version 0.2.0-dev.0).
Every code below is emitted somewhere in `src/`, and every warning code in `src/` is below: Section 2 shows how that is checked and the result of the last run.
The **Meaning** and **Operator action** columns are written by hand from reading the source; they are NOT mechanically checked and describe code paths that were exercised only with synthetic data. Nothing here describes behaviour against a real ChatGPT or Claude export (none was ever available).

## 1. What a warning code is

A warning is the object `Warning { code: string; message: string; ids?: string[] }` (`src/errors.ts`). It records a non-fatal observation that must not be dropped silently (SPEC FR-09). Rules that hold for every code in this catalogue:

* The `message` is fixed text plus counts; `ids` are conversation, message, branch, batch or file identifiers. A warning never carries conversation text, titles or absolute paths.
* There is **no severity field**. The only convention is a message prefix: a message that starts with `[info] ` is purely informational. The codes that use it are marked `info` in the Severity column (`-` means no severity is defined). Audit findings have their own severity (Section 5).
* Warnings are namespace-separate from error codes (`ERROR_CODES` in `src/errors.ts`, documented in `docs/SDK.md` and `docs/CLI_REFERENCE.md`). One string is in both namespaces: `ACTIVE_BRANCH_UNKNOWN`. As a warning it never fails a call; as an error code it does (exit code 3).
* The importer aggregates warnings per code (a count plus up to 5 sample ids) so that a 50,000-message export with one recurring anomaly yields one warning, not 50,000.

Evidence that a code can actually be emitted. The catalogue is derived from the source text, so it shows that a code is written in `src/`, not that it is reachable. The only per-code runtime evidence found in the repository is for the 35 ChatGPT adapter codes: `test/ingest/chatgpt-export.warnings.test.ts` ("warning codes: each is triggered by a positive case and absent from its negative control") builds a synthetic element that triggers each declared code and a control that does not. For the Claude adapter, `test/ingest/claude-export.lens.adversarial.test.ts` compares `CLAUDE_WARNING_CODES` with `docs/ADAPTERS.md` section 3.5 and checks that the committed fixtures and a hostile corpus emit only known codes; that does not prove each of the 31 Claude codes is triggered. Whether a test triggers each of the remaining codes was **not checked** in this review (NOT VERIFIED). Nothing here was observed against a real ChatGPT or Claude export.

Where a warning can be seen:

| Surface | What carries it |
| --- | --- |
| Import report | `ImportReport.warnings`: one `{ code, count, sampleIds }` per code (`src/domain/results.ts`). |
| Database | `source_batches.warnings_json` (batch-level, the count rides in the message as `(count=N)`) and `conversations.warnings_json` (adapter warnings of that conversation). |
| SDK | `ResultEnvelope.warnings` (`src/sdk/envelope.ts`): de-duplicated by (code, message, ids), first-occurrence order; `SOURCE_NOT_FULL_HISTORY` is first whenever completeness is not `exported_tree`. Stored conversation warnings are merged with the read-time tree analysis; a stored warning whose code the analysis reports again (for example `NO_CURRENT_NODE`) is dropped in favour of the analysis. |
| MCP | The same array in the flat envelope (`src/mcp/envelope.ts`), plus `RESULT_TRUNCATED` and `DEPRECATED_TOOL_ALIAS`. |
| CLI | `get` and `thread` print the same warnings as the SDK in every format, `SOURCE_NOT_FULL_HISTORY` first (`mergeWarningsByCode` in `src/cli/warnings.ts` puts the envelope's warnings first, then the thread's own that are not already listed, one entry per code; markdown shows the `## Warnings` section, compact the `# warnings:` line). For `list` and `search`, `--format json` and `jsonl` carry the envelope warnings (`withEnvelopeWarnings` merges those the dedicated renderers do not print); Markdown and compact print a completeness notice there, and `SUPERSEDED_SNAPSHOTS_INCLUDED` of a message search is additionally printed as a note on stderr (suppressed by `--quiet`). The other commands render their envelope, warnings included. |

Counts by section: ChatGPT export adapter: 35; Claude export adapter: 21; Manual copy (Mode B): 4; Container discovery (ZIP, folder, stdin): 9; Import runner: 11; Repository (storage layer): 2; Tree analysis (read time): 6; SDK facade and envelope: 9; Statistics: 5; Audit: 3; Graph build: 4; Graph queries: 7; Renderers: 2; MCP envelope: 2. Total: 120 distinct codes. A code that several layers emit is catalogued once, in the first section that applies, and every emitting file is in its **Emitted by** cell.

## 2. Regenerating and checking this catalogue

The warning codes of this product are the union of five syntactic forms in `src/**/*.ts`. Run these from the repository root (ripgrep 14.1.0 was used); the sorted, de-duplicated union of their output is the code set:

```bash
# 1. object literals:            { code: 'X', ... }
rg -o --no-filename "(?:^|[{,])\s*code: '([A-Z][A-Z0-9_]+)'" -r '$1' src
# 2. helper calls, also across a line break:   idsWarning('X' / .add('X' / .addBounded('X' / .note('X' / skipped('X'
rg -U -o --no-filename "(?:idsWarning|\.addBounded|\.add|\.note|skipped)\(\s*'([A-Z][A-Z0-9_]+)'" -r '$1' src
# 3. conditional (the import runner): .add(known ? 'A' : 'B', ...)
rg -U -o --no-filename "\.add\(\s*\w+ \? '([A-Z_]+)' : '([A-Z_]+)'" -r '$1
$2' src
# 4. a named constant:           export const SOURCE_NOT_FULL_HISTORY = 'X';
rg -o --no-filename "^export const \w+ = '([A-Z][A-Z0-9_]+)';" -r '$1' src
# 5. the declared lists of the two adapters
sed -n '/CHATGPT_ADAPTER_WARNING_CODES = \[/,/\] as const/p' src/ingest/chatgpt-export.ts | rg -o "'([A-Z_]+)'" -r '$1'
sed -n '/CLAUDE_WARNING_CODES = {/,/} as const/p' src/ingest/claude-export.ts | rg -o "^\s+([A-Z_]+):" -r '$1'
```

The grep forms alone could miss a code written in a new style, so the check below also classifies **every** upper-case string literal of `src/`: it must be a warning code (found by the forms above), an error code, a ZIP or JSON-parse reason, an environment-variable name, or be listed in Section 4. A new literal that is none of these makes the check fail, which forces a decision.

Save the following as `check-warning-codes.mjs` anywhere and run `node check-warning-codes.mjs` from the repository root. It reads only; it compares code set **and** emitter paths in both directions.

```js
// check-warning-codes.mjs - consistency check between src/ and docs/WARNING_CODES.md.
// Run from the repository root:  node check-warning-codes.mjs [docs/WARNING_CODES.md]
// Reads files only (no network, no writes). Exit code 0 = consistent, 1 = differences (listed), 2 = usage error.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const docPath = process.argv[2] ?? 'docs/WARNING_CODES.md';
const walk = (dir) => readdirSync(dir).flatMap((name) => { const p = join(dir, name); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []; });
const src = new Map(walk(join(root, 'src')).map((p) => [relative(root, p).split('\\').join('/'), readFileSync(p, 'utf8')]));
if (src.size === 0) { console.error('no src/**/*.ts found: run from the repository root'); process.exit(2); }

// 1. Warning codes in the source: five syntactic forms (the same ones as the rg commands in the document).
const TOKEN = "'([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)'";
const forms = [
  new RegExp(`(?:^|[{,])\\s*code: ${TOKEN}`, 'gm'),                                           // { code: 'X', ... }
  new RegExp(`(?:idsWarning|\\.addBounded|\\.add|\\.note|skipped)\\(\\s*${TOKEN}`, 'g'),      // helper calls, also across a line break
  new RegExp(`\\.add\\(\\s*\\w+ \\? ${TOKEN} : ${TOKEN}`, 'g'),                               // cond ? 'A' : 'B'
  new RegExp(`^export const \\w+ = ${TOKEN};`, 'gm'),                                         // named constant (SOURCE_NOT_FULL_HISTORY)
];
const emitters = new Map(); // code -> Set(file)
const note = (code, file) => { if (!emitters.has(code)) emitters.set(code, new Set()); emitters.get(code).add(file); };
for (const [file, text] of src) for (const re of forms) for (const m of text.matchAll(re)) for (const code of m.slice(1)) if (code) note(code, file);
const slice = (text, open, close) => { const a = text.indexOf(open); return a < 0 ? '' : text.slice(a, text.indexOf(close, a)); };
for (const m of slice(src.get('src/ingest/chatgpt-export.ts') ?? '', 'CHATGPT_ADAPTER_WARNING_CODES = [', '] as const').matchAll(/'([A-Z_]+)'/g)) note(m[1], 'src/ingest/chatgpt-export.ts');
for (const m of slice(src.get('src/ingest/claude-export.ts') ?? '', 'CLAUDE_WARNING_CODES = {', '} as const').matchAll(/^\s+([A-Z_]+):/gm)) note(m[1], 'src/ingest/claude-export.ts');

// 2. The document: catalogue rows (section 3) and the classified non-warning literals (section 4).
const doc = readFileSync(join(root, docPath), 'utf8');
const section = (n) => { const a = doc.search(new RegExp(`^## ${n}\\. `, 'm')); const b = doc.slice(a + 3).search(/^## \d+\. /m); return b < 0 ? doc.slice(a) : doc.slice(a, a + 3 + b); };
const rows = new Map(); // code -> Set(paths)
const problems = [];
for (const line of section(3).split('\n')) {
  const cells = line.split('|').map((c) => c.trim());
  const code = /^`([A-Z][A-Z0-9_]+)`$/.exec(cells[1] ?? '')?.[1];
  if (code === undefined) continue;
  if (rows.has(code)) problems.push(`duplicate row: ${code}`);
  rows.set(code, new Set([...(cells[4] ?? '').matchAll(/`(src\/[^`]+)`/g)].map((m) => m[1])));
}
const classified = new Set(section(4).split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Category') && !l.startsWith('| ---')).flatMap((l) => [...l.matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g)].map((m) => m[1])));

// 3. Compare. Direction A: every code in src is in the document, with exactly its emitter paths. Direction B: every documented code exists in src.
for (const [code, files] of emitters) {
  const row = rows.get(code);
  if (row === undefined) { problems.push(`in source, missing from the document: ${code}`); continue; }
  const a = [...files].sort().join(', '), b = [...row].sort().join(', ');
  if (a !== b) problems.push(`emitter paths differ for ${code}: source [${a}] document [${b}]`);
}
for (const code of rows.keys()) if (!emitters.has(code)) problems.push(`in the document, not emitted anywhere in src: ${code}`);

// 4. Every other upper-case literal in src must be classified: error code, ZIP / JSON reason, environment name, or listed in section 4.
const list = (text, open, close) => new Set([...slice(text, open, close).matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]));
const errorCodes = list(src.get('src/errors.ts') ?? '', 'ERROR_CODES = [', '] as const');
const zipReasons = list(src.get('src/ingest/zip.ts') ?? '', 'ZIP_REASONS = [', '] as const');
const jsonReasons = list(src.get('src/ingest/json-stream.ts') ?? '', 'JSON_PARSE_REASONS = [', '] as const');
const literals = new Set();
for (const text of src.values()) for (const m of text.matchAll(new RegExp(TOKEN, 'g'))) literals.add(m[1]);
const residual = [...literals].filter((t) => !emitters.has(t) && !errorCodes.has(t) && !zipReasons.has(t) && !jsonReasons.has(t) && !/^(GCR_|GIT_|ERR_)/.test(t) && !classified.has(t));
for (const t of residual.sort()) problems.push(`unclassified upper-case literal (warning code or new vocabulary?): ${t}`);
for (const t of [...classified].sort()) {
  if (!literals.has(t)) problems.push(`section 4 lists a literal that no longer exists in src: ${t}`);
  if (emitters.has(t)) problems.push(`section 4 lists ${t}, but it is a warning code`);
}

const shared = [...emitters.keys()].filter((c) => errorCodes.has(c));
console.log(`source: ${emitters.size} warning codes in ${new Set([...emitters.values()].flatMap((s) => [...s])).size} files; shared with ERROR_CODES: ${shared.join(', ') || 'none'}`);
console.log(`document: ${rows.size} catalogue rows, ${classified.size} classified non-warning literals`);
console.log(`other literals: ${errorCodes.size} error codes, ${zipReasons.size} ZIP reasons, ${jsonReasons.size} JSON reasons (not warnings)`);
if (problems.length > 0) { console.log(`INCONSISTENT (${problems.length}):`); for (const p of problems) console.log(`  ${p}`); process.exit(1); }
console.log('CONSISTENT: every warning code in src is in the document and every documented code is emitted in src, with identical emitter paths.');
```

Result of the last run (2026-10-12, Node 22.22.0, after the spec-conformance fixes that added `ATTACHMENTS_NOT_SEARCHED`, `ATTACHMENTS_PARTLY_SEARCHED`, `NO_MATCHING_NODE` and `TERM_SPLIT`):

```text
source: 120 warning codes in 16 files; shared with ERROR_CODES: ACTIVE_BRANCH_UNKNOWN
document: 120 catalogue rows, 74 classified non-warning literals
other literals: 28 error codes, 53 ZIP reasons, 13 JSON reasons (not warnings)
CONSISTENT: every warning code in src is in the document and every documented code is emitted in src, with identical emitter paths.
```

Sensitivity check (2026-10-11): the script was also run against a temporary copy of `src/` and this file with one deliberate change at a time: a catalogue row deleted; a row for a code that does not exist added; the emitter path of one row changed; a new `{ code: 'BRAND_NEW_WARNING' }` literal added to a source file; a new upper-case literal that is none of the known kinds added to a source file. Each change made it print `INCONSISTENT` with the specific difference and exit with status 1; the unmodified tree printed `CONSISTENT`. The temporary copies were deleted. The script is not part of the repository's test suite.

Independent re-run (fact check, 2026-10-11, Node 22.22.0): the script above, extracted from this file and run unchanged from the repository root, printed the four result lines shown, and the five `rg` forms plus the two `sed | rg` extractions, run exactly as written in this section, produced 116 distinct codes that equal the 116 catalogue rows (`diff` of the two sorted lists is empty); the three codes added on 2026-10-12 were checked by the script above only.

Blind spots of the check (stated so nobody over-trusts it). It sees codes that are written as string literals of the shapes above and upper-case literals that contain an underscore. It cannot see a code assembled at run time. Three places pass a code through a variable, and in each the possible values are literals that are in the catalogue: `src/ingest/chatgpt-export.ts` and `src/ingest/claude-export.ts` build `{ code: reason }` for a skipped element from the three literals `EMPTY_CONVERSATION_ENTRY`, `NON_OBJECT_ENTRY` and `NOT_A_CONVERSATION`; `src/ingest/import-runner.ts` adds the same code to the import summary with `agg.add(outcome.reason, ...)`; and `src/ingest/manual-copy.ts` copies the `code` and `message` of an input object's own `warnings` array into the stored record (`ManualCopyInput.warnings`, filled by its parser with the Mode B codes above; the SDK and CLI entry points take document text, so a user document cannot supply it). The check also cannot tell whether a documented code is reachable (see Section 1).

## 3. Catalogue

### 3.1 ChatGPT export adapter

src/ingest/chatgpt-export.ts. Stored per conversation (`conversations.warnings_json`), counted in the batch row and in the `ImportReport.warnings` summary, and shown again by `get`, `thread` and `branches` unless the read-time tree analysis reports the same code itself.

| Code | Severity | Meaning | Emitted by | Operator action |
| --- | --- | --- | --- | --- |
| `CHILDREN_ABSENT` | - | Some nodes have no `children` list, or every list is empty although `parent` pointers define edges. Child lists were derived from the parent pointers (createdAt ascending with unknown last, then file ordinal, then id). One warning per conversation. The Claude adapter emits it for every non-empty conversation because that export never has child lists. | `src/ingest/chatgpt-export.ts`, `src/ingest/claude-export.ts` | None. Parent pointers are authoritative; `childIds` is only an ordering hint. The adapter source says exports since mid-2026 omit `children` (NOT VERIFIED here). |
| `CHILD_NOT_FOUND` | - | A declared `children` list names a node that is not in the mapping. The phantom edge is ignored by the tree analysis. | `src/ingest/chatgpt-export.ts` | Usually a trimmed or damaged export. Check the conversation completeness; obtain a fresh export if the missing branch matters. |
| `COMPLETENESS_LOWERED` | - | The conversation completeness was lowered from `exported_tree` to `unknown`. The message lists the reasons: `mapping_invalid`, `node_limit`, `empty_mapping`, `duplicate_node_id`, `duplicate_structural_key`, `cycle`, `missing_parent`, `malformed_parent`, `no_current_node`, `invalid_current_node`. | `src/ingest/chatgpt-export.ts` | Treat the thread as possibly incomplete. Read the reasons; request a fresh export if the conversation matters. |
| `CONTENT_MALFORMED` | - | A message has no content object, a content value that is not an object, or a content object without `content_type`. It is kept with no blocks, or raw in an `unknown` block. | `src/ingest/chatgpt-export.ts` | None. The original is in `rawSource` (SDK option `includeRaw`). |
| `CONTENT_SHAPE_UNEXPECTED` | - | A known `content_type` has an unexpected field shape (for example a non-string `text`). The unexpected value is kept raw in the block metadata. | `src/ingest/chatgpt-export.ts` | None; report a drift in the export format (without private data) if it is frequent. |
| `CONVERSATION_ID_MISSING` | - | No usable `conversation_id` or `id` (Claude: `uuid`). A deterministic id derived from the element hash and its position was assigned (ChatGPT form `gcr-synth-<hash>-<index>`). Also emitted by the Claude adapter. | `src/ingest/chatgpt-export.ts`, `src/ingest/claude-export.ts` | Address the conversation by its stored id (CLI `--stored-id`); it has no chatgpt.com link. |
| `CURRENT_NODE_NOT_LEAF` | info | The `current_node` names a node that has children, so the active branch passes through it. At import it is informational (`[info]` prefix). At read time `analyzeTree` emits a variant when several branches pass through the node, and the SDK emits one when it cuts the thread at that node. | `src/domain/branches.ts`, `src/ingest/chatgpt-export.ts`, `src/sdk/gcr.ts` | None. The thread ends at the current node; messages below it exist in the tree but were not on the active path. |
| `DUPLICATE_CHILD_ENTRY` | - | A `children` list names the same child more than once; the repeats were dropped. | `src/ingest/chatgpt-export.ts` | None. |
| `DUPLICATE_KEY` | - | A JSON object contains the same key more than once. Like `JSON.parse`, the last value was kept. Detected by a raw-text pre-pass. ChatGPT: the exact bytes are identified by `rawMetadata._gcr.sourceElementSha256`. Also emitted by the Claude adapter, whose message says the element SHA-256 covers the exact bytes, but that hash is not stored in the database (`docs/ARCHITECTURE.md` section 3, row "Raw columns"). A duplicated structural key (`mapping`, `current_node`, `parent`, `children`, `message`) additionally lowers completeness (`COMPLETENESS_LOWERED`). | `src/ingest/chatgpt-export.ts`, `src/ingest/claude-export.ts` | Damaged or hostile input. For an ordinary key the last value is used. A duplicated structural key makes the tree ambiguous, so the conversation is marked `unknown` completeness. |
| `DUPLICATE_MESSAGE_ID` | - | ChatGPT: the same `message.id` appears in more than one node. Claude: a message `uuid` occurs more than once; later occurrences received a deterministic `~dupN` suffix and the original uuid stays in `rawSource`. | `src/ingest/chatgpt-export.ts`, `src/ingest/claude-export.ts` | None; the stored ids are unique. The raw ids remain in `rawSource`. |
| `DUPLICATE_NODE_ID` | - | ChatGPT adapter: a node id occurs more than once in the mapping; the last body was kept and every body is hashed in `rawMetadata._gcr.duplicateNodeBodySha256`. `analyzeTree` (read time): several message records share an id; one was chosen deterministically. | `src/domain/branches.ts`, `src/ingest/chatgpt-export.ts` | Damaged or hostile input. The conversation is marked `unknown` completeness (adapter case). |
| `ID_ALIAS_MISMATCH` | - | `id` and `conversation_id` differ (after UUID lower-casing). `conversation_id` was used; both are kept in `rawMetadata`. | `src/ingest/chatgpt-export.ts` | None; address the conversation by the id GCR reports. |
| `ID_CASE_NORMALIZED` | info | An upper-case UUID conversation id was lower-cased; the raw spelling is kept in `rawMetadata`. Also emitted by the Claude adapter. | `src/ingest/chatgpt-export.ts`, `src/ingest/claude-export.ts` | None. |
| `INVALID_CURRENT_NODE` | - | `current_node` does not name a node of the conversation (adapter), or names a node no root can reach (`analyzeTree`). The active branch is unknown and is not guessed. | `src/domain/branches.ts`, `src/ingest/chatgpt-export.ts` | Pass `--branch <id>` or opt in to `--branch-policy`; otherwise reads fail with `ACTIVE_BRANCH_UNKNOWN` when several branches exist. |
| `INVALID_NODE_ID` | - | A mapping key cannot be used as an identifier (empty, longer than 512 characters, control characters, lone surrogate). A deterministic `gcr-node-<hash>` stand-in was used. | `src/ingest/chatgpt-export.ts` | None; the original key is in `rawSource`. |
| `KEY_ORDER_FALLBACK` | - | The file order of the mapping keys could not be established by the pre-pass; the JSON engine order was used for node ordinals. | `src/ingest/chatgpt-export.ts` | None. Tie-breaks between siblings without timestamps may differ from the file order. |
| `LEGACY_ROLE_FIELD` | - | The role was read from a flat `role` field because `author.role` is missing. | `src/ingest/chatgpt-export.ts` | None. |
| `LONE_SURROGATE` | - | Unpaired UTF-16 surrogates in a text field were replaced by U+FFFD. Also emitted by the Claude adapter and for manual copies. | `src/ingest/chatgpt-export.ts`, `src/ingest/claude-export.ts`, `src/ingest/manual-copy.ts` | None; the original is in `rawSource` / `rawMetadata`. |
| `MAPPING_INVALID` | - | The conversation `mapping` is not an object. The conversation was stored with no messages and the raw value kept in `rawMetadata`. | `src/ingest/chatgpt-export.ts` | Damaged element; completeness is `unknown`. Obtain a fresh export. |
| `MESSAGE_ID_MISMATCH` | - | A message has an `id` field that differs from its node key. The node key is the identity. | `src/ingest/chatgpt-export.ts` | None. |
| `MESSAGE_NOT_OBJECT` | - | A node has a `message` value that is neither null nor an object; it was kept as a structural node. | `src/ingest/chatgpt-export.ts` | None. |
| `NESTING_TOO_DEEP` | - | A structure nested deeper than `MAX_RAW_NESTING_DEPTH` (256) levels was cut and replaced by a marker so the record stays serializable (ADR-0013). The SHA-256 of the whole element still identifies the original. | `src/ingest/chatgpt-export.ts` | Hostile or damaged input; real exports nest about 10 levels. The cut part is not available from the database. |
| `NODE_ID_MISMATCH` | - | A node has an `id` field that differs from its mapping key. The mapping key is the identity. | `src/ingest/chatgpt-export.ts` | None. |
| `NODE_NOT_OBJECT` | - | A mapping value is not an object; it was kept as a structural node with no parent. | `src/ingest/chatgpt-export.ts` | None. |
| `NO_CURRENT_NODE` | - | The source gives no `current_node` (adapter), or `analyzeTree` received none. The active branch is unknown and is not guessed (ADR-0009). | `src/domain/branches.ts`, `src/ingest/chatgpt-export.ts` | Pass `--branch <id>` or opt in to `--branch-policy last_child` or `latest_leaf` (the result is then flagged `ACTIVE_BRANCH_HEURISTIC`). |
| `NUL_STRIPPED` | - | NUL characters were removed from text. Also emitted by the Claude adapter and for manual copies. | `src/ingest/chatgpt-export.ts`, `src/ingest/claude-export.ts`, `src/ingest/manual-copy.ts` | None; the original is in `rawSource` / `rawMetadata`. |
| `PARTS_TRUNCATED` | - | A message has more `parts`, thoughts items, attachment entries or real-time frame pointers than the per-message limit (`maxPartsPerMessage` 50,000, frame pointers 1,000). The extra items were not converted; they remain in `rawSource`. | `src/ingest/chatgpt-export.ts` | Hostile or very unusual input. Read `rawSource` for the rest. |
| `TEXT_TRUNCATED` | - | A text field exceeded its size limit and was truncated (message text: `maxTextBytesPerMessage`, default 64 MiB; title: 8,192 characters). Also emitted by the Claude adapter, which appends an explicit truncation marker to the text. | `src/ingest/chatgpt-export.ts`, `src/ingest/claude-export.ts` | The full value is in `rawSource` / `rawMetadata`. The limits are adapter/domain constants, not settable through `ImportOptions` or the CLI. |
| `TIMESTAMP_FORMAT` | info | A timestamp was given as a string instead of unix seconds and was converted. | `src/ingest/chatgpt-export.ts` | None. |
| `TIMESTAMP_OUT_OF_RANGE` | - | A timestamp is not a plausible unix-seconds value (0, negative, non-finite, millisecond scale, or outside 2015 to 2100). It was set to null; the raw value stays in `rawSource`. | `src/ingest/chatgpt-export.ts` | None. Unknown stays unknown; date filters never match such messages. |
| `TIMESTAMP_UNPARSEABLE` | - | A timestamp has an unsupported type or format. It was set to null; the raw value stays in `rawSource`. | `src/ingest/chatgpt-export.ts` | None. |
| `TOO_MANY_NODES` | - | The mapping has more nodes than `maxNodesPerConversation` (default 500,000); only the first nodes in file order were kept. Lowers completeness to `unknown`. | `src/ingest/chatgpt-export.ts` | The conversation is truncated. Split or re-export; the limit is not configurable from the CLI. |
| `UNEXPECTED_FIELD_TYPE` | - | An optional field is absent or has an unexpected type and was treated as absent. | `src/ingest/chatgpt-export.ts` | None. |
| `UNKNOWN_CONTENT_TYPE` | - | A `content_type` without an explicit handler (or, in Claude data, a block type the adapter does not know) was kept as a raw `unknown` block and contributes no text. ChatGPT adapter: at most 100 distinct types per conversation get their own warning; the rest share one summary. | `src/ingest/chatgpt-export.ts`, `src/ingest/claude-export.ts` | Format drift. The data is preserved raw; searching does not index it. Report the new type (without private data). |
| `UNKNOWN_PART_TYPE` | - | A `parts` entry with no recognised type was kept as a raw `unknown` block and contributes no text. | `src/ingest/chatgpt-export.ts` | As for `UNKNOWN_CONTENT_TYPE`. |

### 3.2 Claude export adapter

src/ingest/claude-export.ts (codes also listed in `CLAUDE_WARNING_CODES`). Same storage and reporting path as the ChatGPT adapter. Codes shared with the ChatGPT adapter are in section 1.

| Code | Severity | Meaning | Emitted by | Operator action |
| --- | --- | --- | --- | --- |
| `ATTACHMENTS_TRUNCATED` | - | A message has more attachments than the per-message (5,000) or per-conversation (2,000,000 items) limit; the rest is only in `rawSource`. | `src/ingest/claude-export.ts` | Hostile or unusual input. |
| `BLOCKS_TRUNCATED` | - | A message has more content blocks than the per-message (50,000) or per-conversation (2,000,000 items) limit; the rest is only in `rawSource`. | `src/ingest/claude-export.ts` | Hostile or unusual input. |
| `CONVERSATION_ID_INVALID` | - | The conversation `uuid` is not a usable identifier; an id derived from the element hash and position was assigned. | `src/ingest/claude-export.ts` | Address the conversation by its stored id (`--stored-id`). |
| `FIELD_TRUNCATED` | - | A short free-form field (role, model, mime type, title, file name) was longer than its limit and was truncated. | `src/ingest/claude-export.ts` | The original is in `rawSource` / `rawMetadata`. |
| `FOREIGN_PROVIDER_MARKER` | - | The element also has a ChatGPT-style object `mapping`. Only `chat_messages` was converted; the mapping was not read (it stays in `rawMetadata`). | `src/ingest/claude-export.ts` | The file mixes two formats; import the ChatGPT part with `--provider chatgpt`. |
| `INVALID_ATTACHMENT` | - | An attachments/files value is not an array, or an entry is not an object; it is kept only in `rawSource`. | `src/ingest/claude-export.ts` | None. |
| `INVALID_ATTACHMENT_FIELD` | - | An attachment field had an unusable value and was recorded as null. | `src/ingest/claude-export.ts` | None. |
| `INVALID_CONTENT` | - | A message `content` value is not an array; it is kept only in `rawSource`. | `src/ingest/claude-export.ts` | None. |
| `INVALID_MODEL_SLUG` | - | A `model` value is not a string and was ignored. A model is recorded only when the source states one. | `src/ingest/claude-export.ts` | None. |
| `INVALID_PARENT_POINTER` | - | A `parent_message_uuid` is not a usable identifier; the message is treated as a root. | `src/ingest/claude-export.ts` | None. Several roots make the active branch unknown (`ACTIVE_BRANCH_UNKNOWN`). |
| `INVALID_TEXT_FIELD` | - | A message `text` value is not a string and was ignored. | `src/ingest/claude-export.ts` | None. |
| `INVALID_TIMESTAMP` | - | A timestamp is not a valid zone-qualified ISO-8601 instant in the supported range and was recorded as null. A zone-less time is rejected rather than read as UTC. | `src/ingest/claude-export.ts` | None. |
| `INVALID_TITLE` | - | The conversation `name` is not a string and was recorded as null. | `src/ingest/claude-export.ts` | None. |
| `LINEAR_EXPORT_ACTIVE_BRANCH_ONLY` | - | Always the first warning of a Claude conversation: the export holds one linear thread per conversation (the branch rendered at export time). Alternate branches, edits and regenerations are not part of it (completeness `rendered_active_view_only`, ADR-0015). | `src/ingest/claude-export.ts` | None. Do not read the thread as the full conversation tree. |
| `MALFORMED_CONTENT_BLOCK` | - | A content block is not usable as its declared type; it is kept as an `unknown` block with the raw value. | `src/ingest/claude-export.ts` | None. |
| `MESSAGE_ID_INVALID` | - | A message `uuid` is not a usable identifier; a positional id (`synthetic-msg-<ordinal>`) was assigned. | `src/ingest/claude-export.ts` | None. |
| `MESSAGE_ID_MISSING` | - | A message has no `uuid`; a positional id (`synthetic-msg-<ordinal>`) was assigned. | `src/ingest/claude-export.ts` | None. |
| `NON_OBJECT_MESSAGE` | - | A `chat_messages` entry is not an object, so it is not a message. Its raw value is kept (at most the first 1,000) in `rawMetadata._gcr.nonObjectChatMessages`. | `src/ingest/claude-export.ts` | None. |
| `PARENT_POINTER_ABSENT` | - | Some messages carry `parent_message_uuid` but this one does not; it is treated as a root (no parent is inferred). | `src/ingest/claude-export.ts` | None. |
| `SENDER_MISSING` | - | A message has no usable `sender` string; its role is recorded as `unknown`. | `src/ingest/claude-export.ts` | None. |
| `TEXT_FIELD_MISMATCH` | - | A message `text` field differs from its text blocks. `text` was used for `message.text`; both are kept. | `src/ingest/claude-export.ts` | None. |

### 3.3 Manual copy (Mode B)

src/ingest/manual-copy.ts. `PARTIAL_USER_SUPPLIED` is always present on a manual copy.

| Code | Severity | Meaning | Emitted by | Operator action |
| --- | --- | --- | --- | --- |
| `CONVERSATION_ID_SYNTHESIZED` | - | No `conversationId` was given; a deterministic UUID-shaped id was derived from the content hash. | `src/ingest/manual-copy.ts` | Give `conversationId` (or `sourceUri`) in the document to attach the copy to a known conversation id. |
| `PARTIAL_USER_SUPPLIED` | - | The conversation is a partial copy supplied by the user: only the messages given were indexed, nothing was read from ChatGPT, and the active branch is unknown. Always present (completeness `partial_user_supplied`). | `src/ingest/manual-copy.ts` | None. Never present the copy as the full history. |
| `SOURCE_URI_ID_MISMATCH` | - | `sourceUri` names a different conversation id than `conversationId`; both were kept as given. | `src/ingest/manual-copy.ts` | Fix the document if the two should agree. |
| `UNKNOWN_KEY_IGNORED` | - | Unknown keys in the document (top level or in a message) were ignored. Key names are not echoed. | `src/ingest/manual-copy.ts` | Check the document against the format in `docs/IMPORT_GUIDE.md`. |

### 3.4 Container discovery (ZIP, folder, stdin)

src/ingest/layout.ts. Import-level: stored in the batch row and reported in the `ImportReport`, never per conversation.

| Code | Severity | Meaning | Emitted by | Operator action |
| --- | --- | --- | --- | --- |
| `DIRECTORY_DEPTH_LIMIT` | - | Folders deeper than 4 levels below the chosen folder were not searched. | `src/ingest/layout.ts` | Pass the folder that actually holds `conversations*.json`, or the export ZIP. |
| `MANIFEST_ABSENT` | info | The input has more than one conversation file, or a numbered one (`conversations-N.json`), but no `export_manifest.json`; the files found were used as they are. | `src/ingest/layout.ts` | None. |
| `MANIFEST_AMBIGUOUS` | info | More than one `export_manifest.json` was found; the outermost one was used. | `src/ingest/layout.ts` | None. |
| `MANIFEST_COUNT_MISMATCH` | - | The manifest is internally inconsistent: `logical_files_count` or `export_files_count` differs from the list it counts. Only this count check compares the manifest with itself; the comparison of the listed files with the files found in the input is done by `MANIFEST_SHARD_MISSING` and `SHARD_NOT_IN_MANIFEST` (the reason, in the layout source comment: the first manifest of a multipart export legitimately lists files of other parts). | `src/ingest/layout.ts` | The export may be damaged; obtain a fresh one. Under `--strict` the import aborts. |
| `MANIFEST_INVALID` | - | The manifest was ignored (reasons in `ids`: `not_json`, `not_object`, `unknown_version` (`version` is not 1), `logical_files_not_object`, `conversations_entry_not_object`, `files_not_string_array`, `too_large` (over 16 MiB)). With the reason `unsafe_paths_ignored` the manifest is **not** ignored: only the listed paths that leave the container or are malformed are dropped and the rest is used. | `src/ingest/layout.ts` | The conversation files are still imported. Under `--strict` the import aborts. |
| `MANIFEST_SHARD_MISSING` | - | Conversation files listed in the manifest are not in the input. | `src/ingest/layout.ts` | Obtain and import the missing parts. Under `--strict` the import aborts. |
| `SHARD_GAP` | - | The numbers of the `conversations-<N>.json` files are not contiguous. The missing numbers are in `ids` (at most 50). | `src/ingest/layout.ts` | A part of the export may be missing; check the export parts. |
| `SHARD_NOT_IN_MANIFEST` | - | Conversation files in the input are not listed in the manifest. | `src/ingest/layout.ts` | Check that the input is one export. Under `--strict` the import aborts. |
| `SYMLINK_SKIPPED` | - | Symbolic links inside the chosen folder were skipped (GCR never follows links inside an import). | `src/ingest/layout.ts` | Copy the real files next to the others. |

### 3.5 Import runner

src/ingest/import-runner.ts. Import-level; some of these abort the import under `--strict` (the list is `STRICT_FATAL_CODES` in the source).

| Code | Severity | Meaning | Emitted by | Operator action |
| --- | --- | --- | --- | --- |
| `COMPLETENESS_BELOW_BATCH_LEVEL` | - | The batch row records the adapter nominal completeness (the value is fixed before any adapter runs); some conversations turned out weaker. `ids` lists a few. Each conversation own `completeness` is authoritative. | `src/ingest/import-runner.ts` | Read per-conversation completeness (`gcr list`, `gcr audit`). Known limitation, see ADR-0015 and `docs/IMPORT_GUIDE.md`. |
| `DUPLICATE_CONVERSATION` | - | A conversation id occurs more than once in the input (for example in two shards). The winner is the element with the greatest update time, then the largest size, then the earliest file order and index (rule: `docs/ARCHITECTURE.md` section 5); the losers were skipped. | `src/ingest/import-runner.ts` | None, unless it is unexpected; under `--strict` the import aborts. |
| `ELEMENT_INTERNAL_ERROR` | - | An unexpected (non-GcrError) failure while normalizing a conversation element; it was skipped. Only the element position is reported. | `src/ingest/import-runner.ts` | Report the issue without private data (re-run with `--debug` for a stack trace on stderr). |
| `ELEMENT_PARSE_FAILED` | - | A conversation element could not be normalized (invalid JSON, a limit such as nesting depth, or a validation failure) and was skipped. The import continues. | `src/ingest/import-runner.ts` | Obtain a fresh export if many elements fail. Under `--strict` the import aborts with the precise error. |
| `EMPTY_CONVERSATION_ENTRY` | - | An element is an empty object and was skipped. The adapter returns the code as the reason of a `skipped` outcome; the user-visible warning (count and sample ids) is added by the runner (`agg.add(outcome.reason, ...)`), which is why the runner is not in the next column. | `src/ingest/chatgpt-export.ts`, `src/ingest/claude-export.ts` | None. |
| `FILE_PARSE_FAILED` | - | A conversation file stops being well-formed JSON at some point (truncated, trailing data, too-deep nesting). The elements before that point were kept and the rest of the file was not imported (ADR-0013). | `src/ingest/import-runner.ts` | The export is truncated or damaged: download it again. If nothing at all was readable the import fails with `IMPORT_PARSE_ERROR`. |
| `INVALID_UTF8` | - | Some elements contained bytes that are not valid UTF-8; the decoder replaced them by U+FFFD. The file hash still covers the original bytes. Best effort: only under-reports. | `src/ingest/import-runner.ts` | Re-save or re-download the file as UTF-8. |
| `NON_OBJECT_ENTRY` | - | An element is not a JSON object and was skipped. The adapter returns the code as the reason of a `skipped` outcome; the user-visible warning (count and sample ids) is added by the runner (`agg.add(outcome.reason, ...)`), which is why the runner is not in the next column. | `src/ingest/chatgpt-export.ts`, `src/ingest/claude-export.ts` | None. |
| `NOT_A_CONVERSATION` | - | An object that is not a conversation of the selected provider (no `mapping` / no `chat_messages` array, or a wrapper object) was skipped. Also an element that has both a `mapping` and a `conversations` array: the runner does not unwrap it and the ChatGPT adapter skips it (reproduced on 2026-10-11 with a synthetic file; whether this is the intended rule is not confirmed by an owner). Reported by the runner in the same way as the two codes above. | `src/ingest/chatgpt-export.ts`, `src/ingest/claude-export.ts` | Check that the file is a conversations file. Under `--strict` the import aborts. |
| `PROVIDER_MISMATCH` | - | The provider was forced (`--provider`) but a file looks like another provider export; its elements are normalized as the forced provider and will most likely be skipped. | `src/ingest/import-runner.ts` | Drop `--provider` to auto-detect, or force the correct one. |
| `WRAPPER_OBJECT_FORMAT` | info | Some elements were wrapper objects with a `conversations` array; their members were imported. | `src/ingest/import-runner.ts` | None. |

### 3.6 Repository (storage layer)

src/db/repo.ts.

| Code | Severity | Meaning | Emitted by | Operator action |
| --- | --- | --- | --- | --- |
| `DUPLICATE_CONVERSATION_IN_BATCH` | - | The same normalized conversation id appeared twice in one batch (two winners whose raw ids normalized to one id). The first occurrence was kept. `ids` lists up to 20. | `src/db/repo.ts`, `src/ingest/import-runner.ts` | None; unexpected, report it. |
| `STORED_JSON_INVALID` | - | A stored JSON column could not be read and was replaced by an empty value (a database damaged outside GCR). Repository: a conversation read. Also emitted by `audit` (an unreadable child list; parent pointers were used), by `graph build` (unreadable block or attachment JSON was ignored) and by `search` with scope `attachments` or `all` (a message whose stored attachment list could not be read; its attachments were not searched; "At least N" when a full page stopped the scan early). | `src/analysis/audit.ts`, `src/db/repo.ts`, `src/graph/build.ts`, `src/sdk/gcr.ts` | The database file was modified or damaged. Re-import into a new file. |

### 3.7 Tree analysis (read time)

src/domain/branches.ts (`analyzeTree`, `selectBranchByPolicy`). Computed on every read of `get`, `thread`, `branches` and by `audit`; never stored. The four codes it shares with the ChatGPT adapter (`DUPLICATE_NODE_ID`, `NO_CURRENT_NODE`, `INVALID_CURRENT_NODE`, `CURRENT_NODE_NOT_LEAF`) are in section 1.

| Code | Severity | Meaning | Emitted by | Operator action |
| --- | --- | --- | --- | --- |
| `ACTIVE_BRANCH_HEURISTIC` | - | The source did not identify the active branch; the returned branch was chosen by the explicit `last_child` or `latest_leaf` heuristic and may not be the one the user last viewed. Never produced unless the caller opted in. | `src/domain/branches.ts` | Show it to the user. Prefer `--branch <id>` when the right branch is known. |
| `BRANCH_LIMIT_EXCEEDED` | - | Branch enumeration was truncated (`maxBranches` 10,000 or `maxTotalPathNodes` 5,000,000). `ids` lists leaves that were not enumerated. Forwarded by `graph explain`. | `src/domain/branches.ts` | Very branchy conversation. Only some branches can be listed or read; the active branch may be known but not enumerable (reads then fail with `ACTIVE_BRANCH_UNKNOWN`). |
| `CHILD_PARENT_MISMATCH` | - | Declared child lists disagree with the parent pointers (a declared child is absent or has another parent, or a child is not listed by its parent). Parent pointers were used; dangling declared children are reported this way. | `src/domain/branches.ts` | Damaged or trimmed export; the tree shown follows the parent pointers. |
| `CYCLE_DETECTED` | - | Parent pointers form a cycle. The nodes on it and their descendants are unreachable from any root and are not part of any branch. At most 100 cycles are listed individually. | `src/domain/branches.ts` | Damaged or hostile input. `audit` reports it as a tree_integrity error. |
| `MISSING_PARENT` | - | Nodes name a parent that does not exist; each is treated as a root. | `src/domain/branches.ts` | Trimmed or damaged export. Several roots can make the active branch ambiguous. |
| `SELF_PARENT` | - | Nodes list themselves as their own parent; they are unreachable from any root. | `src/domain/branches.ts` | Damaged or hostile input. `audit` reports it as a tree_integrity error. |

### 3.8 SDK facade and envelope

src/sdk/gcr.ts and src/sdk/envelope.ts. Present in the `warnings` array of the `ResultEnvelope` (and therefore in the MCP envelope and the JSON output of the CLI).

| Code | Severity | Meaning | Emitted by | Operator action |
| --- | --- | --- | --- | --- |
| `ACTIVE_BRANCH_UNKNOWN` | - | SDK `get` with `allBranches`: the source did not identify the active branch (or its branch is beyond the enumeration limit), so `thread` is null and every branch is listed in `threads`. The Claude adapter emits it when explicit parent pointers do not form a single chain. The same string is also an error code (`ACTIVE_BRANCH_UNKNOWN`, exit 3) for `get`/`thread` without `allBranches`. | `src/ingest/claude-export.ts`, `src/sdk/gcr.ts` | Pick a branch (`gcr branches`, then `--branch <id>`) or opt in to `--branch-policy`. |
| `ATTACHMENTS_NOT_SEARCHED` | - | Search scope `all` in raw mode: raw FTS5 syntax cannot be applied to attachment file names, so the attachment part of `all` was skipped (titles and messages were searched). Scope `attachments` with raw mode is the error `INVALID_ARGUMENT` instead. | `src/sdk/gcr.ts` | Use plain mode (or `--scope attachments`) to search attachment names. |
| `ATTACHMENTS_PARTLY_SEARCHED` | - | Search scope `attachments` or `all`: a message stores more than 5,000 attachments (the ChatGPT importer accepts up to 50,000 per message), and only the first 5,000 of its list were searched, so an attachment further down cannot be found by name. The message names how many messages were cut; it reads "At least N" when a full page stopped the scan early (the count is then a lower bound). | `src/sdk/gcr.ts` | `gcr get` lists every attachment of the message; search for the message text instead. |
| `GRAPH_STALE` | - | Some conversations have a newer imported snapshot than the one the graph was built from; the graph facts and the cited source describe the older snapshot. | `src/sdk/gcr.ts` | Rebuild the graph (`gcr graph build`). |
| `NEIGHBORS_TRUNCATED` | - | Only part of the neighbours of a node are listed (the `limit`). | `src/sdk/gcr.ts` | Raise `--limit` or narrow with `--kinds` / `--edge-kinds`. |
| `NO_BRANCHES` | - | There is no branch, hence no thread to show. Two different cases with two different messages: the snapshot stores no message ("The stored message tree of this snapshot is empty"), or N messages are stored but none is reachable from a root (their parent pointers form a cycle or point at themselves: "N message(s) are stored ... none of them is reachable from a root"; the text is still searchable but get / thread cannot read it; `CYCLE_DETECTED` / `SELF_PARENT` say why). SDK `get` without an explicit `branch` succeeds with `thread` null and this warning; `thread()` on such a snapshot fails with the error `BRANCH_NOT_FOUND` and `details.reason = "no_branches"` (plus `details.unreachableMessages` in the second case) instead (`src/sdk/gcr.ts`, `get`, `selectPrimary`). | `src/sdk/gcr.ts` | Empty: import an export that contains messages for it. Unreachable: nothing to do with GCR (the export's tree is damaged); `gcr audit --tree` lists such conversations. |
| `PATH_SEARCH_TRUNCATED` | - | The path search budget was exhausted: "not found" means not found within the budget, not that no path exists. | `src/sdk/gcr.ts` | Inspect the neighbours of both nodes (`gcr graph neighbors`), or give the SDK option `maxExplored` a larger budget; there is no CLI flag for the budget. |
| `SOURCE_BATCH_MISSING` | - | A contributing import batch row could not be read (a database edited outside GCR); its provenance is unknown and counts as `unknown` completeness. | `src/sdk/envelope.ts` | Re-import into a new database file. |
| `SOURCE_NOT_FULL_HISTORY` | - | The first warning of every envelope whose completeness is not `exported_tree` (and of an empty result): this result is NOT the full conversation history, and states what is missing (FR-09). `ids` lists the batches. | `src/sdk/envelope.ts` | Do not present the result as the complete history. An empty result only says nothing matched in the data you imported. |

### 3.9 Statistics

src/analysis/stats.ts (`gcr stats`, `gcr_stats`).

| Code | Severity | Meaning | Emitted by | Operator action |
| --- | --- | --- | --- | --- |
| `HIDDEN_MESSAGES_EXCLUDED` | - | Messages the source marked hidden are not counted. | `src/analysis/stats.ts` | Pass `--include-hidden` to count them. |
| `INCOMPLETE_SOURCE` | - | Some conversation snapshots in scope come from sources whose completeness is not `exported_tree`; the numbers describe only what those sources contained. Also emitted by `audit`. | `src/analysis/audit.ts`, `src/analysis/stats.ts` | Read the numbers with that limit in mind. |
| `NO_MATCHING_MESSAGES` | - | No messages matched the filters; an empty result is not evidence that the source is empty. | `src/analysis/stats.ts` | Check the filters (provider, account, role, dates). |
| `SUPERSEDED_SNAPSHOTS_INCLUDED` | - | Superseded import snapshots are included (`--all-batches`), so the same message can be counted or listed once per snapshot. Emitted by `stats`, `audit` and `search`. | `src/analysis/audit.ts`, `src/analysis/stats.ts`, `src/sdk/gcr.ts` | Drop `--all-batches` for deduplicated results. |
| `UNDATED_MESSAGES_EXCLUDED` | - | Messages without a usable timestamp are excluded because a date bound was given; a message with unknown time never matches a bound. | `src/analysis/stats.ts` | Drop the date bound to include them. |

### 3.10 Audit

src/analysis/audit.ts (`gcr audit`, `gcr_audit`).

| Code | Severity | Meaning | Emitted by | Operator action |
| --- | --- | --- | --- | --- |
| `BRANCH_PROVENANCE_NOT_COMPUTED` | - | `branchProvenance` is `null` because no tree-based check (`tree_integrity`, `no_current_node`, `timestamps`) was selected; it was not measured (it is never reported as zeros). `modelProvenance` is always measured. | `src/analysis/audit.ts` | Select one of those checks (or all) to get branch provenance. |
| `BYCODE_TRUNCATED` | - | The `byCode` breakdown of a finding lists only the 100 most frequent values; counts and samples still cover everything. | `src/analysis/audit.ts` | None. |
| `NO_CONVERSATIONS_IN_SCOPE` | - | No conversations matched the filters; a clean result here is not evidence that the source is clean. | `src/analysis/audit.ts` | Check the filters. |

### 3.11 Graph build

src/graph/build.ts (`gcr graph build`, `Gcr.buildGraph`).

| Code | Severity | Meaning | Emitted by | Operator action |
| --- | --- | --- | --- | --- |
| `CLUSTER_NOT_CONVERGED` | - | Label propagation stopped at `maxIterations` (default 50) without converging; communities are approximate. | `src/graph/build.ts` | None; community ids are approximate for this build. |
| `EVIDENCE_TRUNCATED` | - | Build: edges that occur in more messages than `maxEvidencePerEdge` (default 1,000) list only the first ones as evidence (edge weights stay exact). Also emitted by `graph explain` (SDK) when an edge lists fewer citations than exist. | `src/graph/build.ts`, `src/sdk/gcr.ts` | None; the weight is exact, the evidence list is capped. |
| `NO_MESSAGES_IN_SCOPE` | - | No imported messages matched the requested scope; the graph is empty. | `src/graph/build.ts` | Import first, or widen `--provider` / `--account`. |
| `TEXT_TRUNCATED_FOR_EXTRACTION` | - | Messages longer than `maxTextChars` (default 200,000) were scanned for entities only up to that length. | `src/graph/build.ts` | None. |

### 3.12 Graph queries

src/graph/query.ts (query, neighbours, path, explain, export).

| Code | Severity | Meaning | Emitted by | Operator action |
| --- | --- | --- | --- | --- |
| `BRANCH_IDS_TRUNCATED` | - | A cited message lies on 1,000 or more branches (the per-citation cap `MAX_BRANCH_IDS_PER_EVIDENCE`); only the first 1,000 branch ids are listed. | `src/graph/query.ts` | None. |
| `EDGES_TRUNCATED` | - | The subgraph has more than 5,000 edges (`MAX_SUBGRAPH_EDGES`); the heaviest 5,000 are returned. | `src/graph/query.ts` | Narrow the query (`--depth`, `--kinds`). |
| `GRAPH_EMPTY` | - | The graph has no nodes (not built), or, for the overview export, has nodes but none with a connection to show (entities seen in fewer than 2 conversations are left out by default). | `src/graph/query.ts`, `src/sdk/gcr.ts` | Run `gcr graph build` (a lower `--min-conversations 1` keeps rarer entities). |
| `NODES_TRUNCATED` | - | The neighbourhood has more nodes than `maxNodes`; only the first in breadth-first order are returned. Emitted only when neither `SEEDS_TRUNCATED` nor `EDGES_TRUNCATED` was already added to the same result. | `src/graph/query.ts` | Narrow the query or raise `--max-nodes`. |
| `NO_MATCHING_NODE` | - | No node matched the term, not even after splitting it into keywords (`TERM_SPLIT`): the answer is an empty graph, not an error. A graph with no nodes at all says `GRAPH_EMPTY` instead. With `--kinds` the message adds "among the requested kinds". | `src/graph/query.ts` | Try a different term or one of the words it is made of; `gcr graph god-nodes` lists the most connected nodes. Common reasons for a term that is in the data: it is shorter than three letters (never a keyword), or it occurs in only one conversation and the graph was built with the default minimum (`gcr graph build --min-conversations 1` keeps it). |
| `SEEDS_TRUNCATED` | - | More nodes match the term than `maxNodes`; only the best are used as seeds. | `src/graph/query.ts` | Use a more specific term. |
| `TERM_SPLIT` | - | No node matched the whole term and it contains a hyphen, underscore, dot between letters or white space, so it was split into the keywords the extractor would produce (a hyphenated name is stored as separate keyword nodes) and every keyword node matching one of them was used as a seed. The message names the words used, any word that has a node which the seed limit (`--max-nodes`) left out (SEEDS_TRUNCATED is then reported too) and any word without a node. | `src/graph/query.ts` | None; to match a node exactly, use one of the words. |

### 3.13 Renderers

src/format/render.ts. Added to the rendered document; present in all four output formats.

| Code | Severity | Meaning | Emitted by | Operator action |
| --- | --- | --- | --- | --- |
| `HIDDEN_HITS_OMITTED` | - | Search hits in hidden messages were omitted from the rendered page. | `src/format/render.ts` | Pass `--include-hidden`. |
| `MESSAGE_TRUNCATED` | - | Messages were cut to the caller-supplied `maxMessageChars` by a renderer; each cut is marked `[truncated N chars]` in the text. The stored message is untouched. | `src/format/render.ts` | None. Only SDK callers that pass `maxMessageChars` to a renderer can see it; neither the CLI nor the MCP server sets it. |

### 3.14 MCP envelope

src/mcp/envelope.ts and src/mcp/registry.ts.

| Code | Severity | Meaning | Emitted by | Operator action |
| --- | --- | --- | --- | --- |
| `DEPRECATED_TOOL_ALIAS` | - | The tool was called through a legacy alias name. The alias table is empty in this build (ADR-0002), so this cannot occur today. | `src/mcp/registry.ts` | Use the canonical tool name. |
| `RESULT_TRUNCATED` | - | The MCP result was reduced to stay within the byte cap (default 200,000; `GCR_MCP_MAX_RESULT_BYTES`). Items were dropped from the end of lists, never cut mid-item; `truncated` is true and paging fields are adjusted. | `src/mcp/envelope.ts` | Request fewer items (smaller `limit`, tighter filters) or continue with `offset`. |

## 4. Upper-case literals that are not warning codes

These strings look like codes but are not `Warning.code` values. They are classified so that the check in Section 2 can tell a forgotten warning code from a known piece of vocabulary. Not repeated here because other lists in the source already define them: the 28 error codes (`ERROR_CODES`), the ZIP rejection reasons (`ZIP_REASONS` in `src/ingest/zip.ts`), the JSON framing reasons (`JSON_PARSE_REASONS` in `src/ingest/json-stream.ts`), and environment-variable names (`GCR_*`, `GIT_*`, `ERR_*`).

| Category | Literals |
| --- | --- |
| audit byCode keys (finding sub-codes of the timestamps check) | `CONVERSATION_CREATED_AT_INVALID`, `CONVERSATION_CREATED_AT_NULL`, `CONVERSATION_UPDATED_AT_INVALID`, `CONVERSATION_UPDATED_BEFORE_CREATED`, `MESSAGE_BEFORE_PARENT`, `MESSAGE_CREATED_AT_INVALID`, `MESSAGE_CREATED_AT_NULL` |
| error details.reason / limit labels (not part of Warning.code) | `BAD_ACCOUNT_LABEL`, `BAD_BUFFER`, `BAD_CHUNK_TYPE`, `BAD_ENTRY_NAME`, `BAD_EXTENSION`, `BAD_IMPORTED_AT`, `BAD_MAX_BYTES`, `BAD_NAME`, `BAD_NESTED_LIMIT`, `BAD_OPTIONS`, `BAD_PASSES`, `BAD_PATH`, `BAD_SOURCE`, `BAD_SOURCE_KIND`, `BAD_STREAM`, `CHANGED_WHILE_READING`, `CONCURRENT_MODIFICATION`, `CONTEXT_NOT_OBJECT`, `ELEMENT_TOO_LARGE`, `ENTRY_IS_DIRECTORY`, `ENTRY_NOT_FOUND`, `FTS5_UNAVAILABLE`, `INPUT_TOO_LARGE`, `INVALID_JSON`, `IS_DIRECTORY`, `LIMITS_NOT_OBJECT`, `LIMIT_NOT_POSITIVE_FINITE`, `MANUAL_COPY_MAX_DOCUMENT_CHARS`, `MANUAL_COPY_MAX_MESSAGES`, `MANUAL_COPY_MAX_TEXT_BYTES`, `MANUAL_COPY_MAX_TOTAL_BYTES`, `MANUAL_COPY_TOO_LARGE`, `MAX_JSON_DEPTH`, `MAX_MESSAGES_PER_CONVERSATION`, `MIXED_PROVIDERS`, `NESTED_ZIP_TOO_LARGE`, `NOT_FOUND`, `NOT_JSON`, `NOT_READABLE`, `NOT_REGULAR_FILE`, `NOT_UTF8`, `NO_CONVERSATION_FILE`, `NO_DIRECTORY`, `NO_OPTIONS`, `NO_SOURCE`, `OPEN_FAILED`, `OUTPUT_TOO_LARGE`, `PERMISSION_DENIED`, `PROVIDER_UNDETECTED`, `READER_CLOSED`, `READ_FAILED`, `READ_ONLY_LOCATION`, `STDIN_NOT_JSON`, `STDIN_TOO_LARGE`, `STDOUT_WRITE_FAILED`, `STRAY_SIDECAR_FILES`, `SUPPORT_FILE_TOO_LARGE`, `SYMLINK_DB_PATH`, `SYMLINK_REFUSED`, `TEXT_NOT_STRING`, `UNEXPECTED_ADAPTER_FAILURE`, `UNEXPECTED_ITERATION`, `UNKNOWN_ADAPTER`, `UNKNOWN_LIMIT`, `UNSUPPORTED_ENCODING`, `WRITE_FAILED`, `ZIP_ON_STDIN` |

## 5. Audit findings (not warnings, but also code-keyed)

`gcr audit` / `gcr_audit` return **findings**, each with a `severity` of `info`, `warn` or `error` (`src/analysis/audit.ts`). A finding with count 0 is always `info`. The `byCode` map of a finding is keyed by warning codes (tree checks) or by the seven timestamp sub-codes of Section 4.

| Check | Severity when something is found | Keys of `byCode` |
| --- | --- | --- |
| `missing_model` | info | none |
| `empty` | warn | none |
| `untitled` | info | none |
| `tree_integrity` | warn; error when `CYCLE_DETECTED` or `SELF_PARENT` is present | `MISSING_PARENT`, `CYCLE_DETECTED`, `CHILD_PARENT_MISMATCH`, `SELF_PARENT`, `DUPLICATE_NODE_ID`, `BRANCH_LIMIT_EXCEEDED` |
| `no_current_node` | warn | `NO_CURRENT_NODE`, `INVALID_CURRENT_NODE` |
| `unknown_roles` | warn | author role strings (data values, not codes) |
| `unknown_content_types` | warn | content-type strings (data values; ChatGPT provider only) |
| `timestamps` | info; warn when a value is invalid or time runs backwards | the seven sub-codes in Section 4 |
| `hidden` | info | author role strings (data values, not codes) |

The audit also emits the warnings `NO_CONVERSATIONS_IN_SCOPE`, `BRANCH_PROVENANCE_NOT_COMPUTED`, `BYCODE_TRUNCATED`, `SUPERSEDED_SNAPSHOTS_INCLUDED`, `INCOMPLETE_SOURCE` and `STORED_JSON_INVALID`, catalogued above.

## 6. Cross-references

* Import behaviour and the format profile: `docs/IMPORT_GUIDE.md`, `docs/IMPORT_FORMAT.md` (its warning-code section is a shorter, adapter-level view; this file is the complete, source-derived list).
* Decisions behind several codes: `docs/DECISIONS.md` (ADR-0009 active branch, ADR-0013 depth and size limits, ADR-0014 hidden messages, ADR-0015 Claude completeness, ADR-0018 reads refused during writes).
* Architecture and the list of deviations from the original contract: `docs/ARCHITECTURE.md`.
