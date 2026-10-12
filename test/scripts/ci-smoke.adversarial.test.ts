/**
 * Mutation testing of scripts/ci-smoke.mjs, second round: regressions the FIRST version of the smoke did not notice.
 *
 * Method: a private copy of the freshly built product is changed in one realistic way, the whole smoke is run against the copy
 * (`--dist <copy>`), and the smoke has to name the damage in a FAIL line. These cases passed the first smoke ("SMOKE OK"):
 *
 *   - a command that must never print message text puts a sample of one into its report (stats, import);
 *   - an error names an absolute temporary path (text mode: import of a missing file);
 *   - a JSON error carries the database path;
 *   - the importer copies the decoy user.json somewhere outside the database (the temp directory);
 *   - the product keeps a history file in HOME, or creates ./.gcr next to the working directory (doctor);
 *   - hidden messages leak through MCP (gcr_search, gcr_get) although the CLI renderer filters them a second time;
 *   - stats attributes a model to some messages that never stated one (only a partial inference; the first smoke only
 *     looked for the presence of an "unknown" group);
 *   - the draft status CHECK constraint admits "sent";
 *   - graph export follows a symbolic link;
 *   - the approved-root test is a string prefix test, or does not resolve symlinks;
 *   - gcr_import_export is not behind the write switch when roots are configured;
 *   - the single-line escaping of the renderers is switched off (the fixtures' own hostile strings are cleaned at import, so
 *     only an inline field that really holds a bidi override shows it);
 *   - an overstated completeness ("exported_tree" or the first source's value instead of "mixed");
 *   - a renderer that drops the last message or the last conversation in ONE format (markdown, compact), a compact header
 *     that states another completeness than the JSON, an import report that silently loses a warning code.
 *
 * LONG: three complete smoke runs (about 15 s each when idle), started together. The mutations inside one run touch different
 * checks, so one run reports several of them; the reasons are asserted exactly, so a mutation cannot hide behind another one.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { assertRed, cleanupBuilds, failureOf, hasPassed, replaceInFile, smokeOnSabotaged } from './scripts.helpers.test.js';
import type { SmokeOutcome } from './scripts.helpers.test.js';

after(cleanupBuilds);

/** Replace `from` by `to` in the part of `file` between two markers (the same sentence occurs in several commands). */
function replaceBetween(file: string, startMarker: string, endMarker: string, from: string, to: string): void {
  const text = readFileSync(file, 'utf8');
  const a = text.indexOf(startMarker);
  assert.ok(a >= 0, `sabotage start marker not found: ${startMarker}`);
  const b = text.indexOf(endMarker, a + startMarker.length);
  assert.ok(b >= 0, `sabotage end marker not found: ${endMarker}`);
  const segment = text.slice(a, b);
  assert.ok(segment.includes(from), `sabotage anchor not found between the markers: ${from.slice(0, 50)}`);
  writeFileSync(file, text.slice(0, a) + segment.replace(from, () => to) + text.slice(b));
}

/** Code that adds a stored message text to `env.data.sample` (the command then reports content it must not). */
const LEAK = (dbExpression: string): string =>
  `{ const { DatabaseSync } = await import('node:sqlite'); const __d = new DatabaseSync(${dbExpression}, { readOnly: true }); ` +
  `const __t = __d.prepare("SELECT text FROM messages WHERE node_kind = 'message' AND hidden = 0 AND length(text) > 15 ORDER BY rowid LIMIT 1 OFFSET 3").get(); __d.close(); ` +
  `env.data = { ...env.data, sample: __t.text }; }`;
const EMIT = 'emit(ctx, renderEnvelope(env, ctx.renderOptions()));';

type Mutation = (dist: string) => void;

// ---- group A: seven different checks ---------------------------------------------------------------------------------------
const groupA: Mutation[] = [
  // import prints a sample message text
  (dist) => replaceBetween(join(dist, 'cli', 'commands', 'import.js'), 'export const importCommand', 'export const importCopyCommand', EMIT, `${LEAK('ctx.db.path')}\n        ${EMIT}`),
  // the "input not found" error names the absolute path
  (dist) => replaceInFile(join(dist, 'cli', 'commands', 'import.js'), 'printable(basename(path), 60)', 'printable(path, 600)'),
  // the importer copies user.json into the temp directory
  (dist) => {
    const file = join(dist, 'ingest', 'layout.js');
    replaceInFile(file, 'c.auxiliary++;', 'c.auxiliary++; (c.auxOpen ??= []).push(open);');
    replaceInFile(
      file,
      'async function finish(a) {\n    const c = a.collected;',
      "async function finish(a) {\n    const c = a.collected;\n    for (const o of c.auxOpen ?? []) { const chunks = []; for await (const b of o()) chunks.push(b); (await import('node:fs')).writeFileSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'aux-copy.bin'), Buffer.concat(chunks)); }",
    );
  },
  // the SQL layer returns hidden messages by default (the CLI renderer filters again, MCP does not)
  (dist) => replaceInFile(join(dist, 'db', 'search.js'), "if (!f.includeHidden)\n        add('AND m.hidden = 0 ');", "if (false)\n        add('AND m.hidden = 0 ');"),
  // the draft status column admits "sent"
  (dist) => {
    replaceInFile(join(dist, 'db', 'schema.js'), "CHECK (status IN ('draft','archived'))", "CHECK (status IN ('draft','archived','sent'))");
    replaceInFile(join(dist, 'drafts', 'drafts.js'), "const DRAFT_STATUSES = ['draft', 'archived'];", "const DRAFT_STATUSES = ['draft', 'archived', 'sent'];");
  },
  // graph export follows symbolic links
  (dist) => {
    const file = join(dist, 'cli', 'export-file.js');
    replaceInFile(file, "import { lstat, open, rename, stat, unlink } from 'node:fs/promises';", "import { lstat as __lstat, open, rename, stat, unlink } from 'node:fs/promises';\nconst lstat = stat;");
    replaceInFile(file, "open(path, 'wx', 0o600)", "open(path, 'w', 0o600)");
  },
  // approved roots: string prefix instead of path containment
  (dist) => replaceInFile(join(dist, 'mcp', 'approved-roots.js'), 'if (!approved.roots.some((root) => isInsideRoot(root, real)))', 'if (!approved.roots.some((root) => real.startsWith(root)))'),
  // import is not behind the write switch, and the handle is writable
  (dist) => {
    replaceInFile(join(dist, 'mcp', 'tools.js'), '// 2. The write switch.\n            assertWritesAllowed(deps);', '');
    replaceInFile(join(dist, 'mcp', 'entry.js'), 'readOnly: !allowWrites,', 'readOnly: false,');
  },
  // the combined completeness is the first source's value instead of "mixed"
  (dist) => replaceInFile(join(dist, 'format', 'render.js'), "return values.every((v) => v === first) ? first : 'mixed';", 'return first;'),
  // the markdown thread/get output drops the last message
  (dist) => replaceInFile(join(dist, 'format', 'render.js'), 'views.forEach((v, i) => blocks.push(mdMessageBlock(i + 1, v, ro)));', 'views.slice(0, -1).forEach((v, i) => blocks.push(mdMessageBlock(i + 1, v, ro)));'),
];

// ---- group B: six more -------------------------------------------------------------------------------------------------------
const groupB: Mutation[] = [
  // stats gives about half of the assistant messages a model they never stated
  (dist) =>
    replaceInFile(
      join(dist, 'analysis', 'stats.js'),
      'THEN m.model_slug ELSE NULL END`, nullLabel: UNKNOWN_MODEL_LABEL',
      "THEN m.model_slug WHEN m.author_role = 'assistant' AND m.rowid % 2 = 0 THEN 'synthetic-default-model' ELSE NULL END`, nullLabel: UNKNOWN_MODEL_LABEL",
    ),
  // the JSON error envelope carries the database path
  (dist) => replaceInFile(join(dist, 'cli', 'report-error.js'), 'const envelope = err.toEnvelope();', 'const envelope = err.toEnvelope(); envelope.error.details = { ...(envelope.error.details ?? {}), db: process.env.GCR_DB };'),
  // the CLI appends every invocation to ~/.gcr_history
  (dist) =>
    replaceInFile(
      join(dist, 'cli', 'main.js'),
      'process.exitCode = code;',
      "process.exitCode = code; (await import('node:fs')).appendFileSync((await import('node:path')).join((await import('node:os')).homedir(), '.gcr_history'), argv.join(' ') + '\\n');",
    ),
  // the SDK stops dropping hidden messages from get/thread
  (dist) => replaceInFile(join(dist, 'sdk', 'gcr.js'), 'if (m.hidden && !ctx.includeHidden) {', 'if (false) {'),
  // approved roots: no symlink resolution
  (dist) => replaceInFile(join(dist, 'mcp', 'approved-roots.js'), 'real = await realpath(candidate);', 'await realpath(candidate); real = candidate;'),
  // the compact thread/get output drops the last message
  (dist) => replaceInFile(join(dist, 'format', 'render.js'), 'body: views.flatMap(compactMessageLines),', 'body: views.slice(0, -1).flatMap(compactMessageLines),'),
  // the compact list header always claims a complete tree
  (dist) => replaceInFile(join(dist, 'format', 'render.js'), '# conversations | ${providerList(sources)} | ${cField(completeness, 40)} |', '# conversations | ${providerList(sources)} | exported_tree |'),
  // one-line renderers pass hazardous characters through
  (dist) =>
    replaceInFile(
      join(dist, 'format', 'render.js'),
      "out += m[0] === '\\n' ? '\\\\n' : m[0] === '\\t' ? '\\\\t' : visibleEscape(m[0]);",
      "out += m[0] === '\\n' ? '\\\\n' : m[0] === '\\t' ? '\\\\t' : m[0];",
    ),
];

// ---- group C: two checks that group A and B already use --------------------------------------------------------------------------
const groupC: Mutation[] = [
  // doctor creates ./.gcr
  (dist) =>
    replaceInFile(
      join(dist, 'cli', 'commands', 'system.js'),
      "const { Gcr } = await import('../../sdk/gcr.js');\n        const report",
      "(await import('node:fs')).mkdirSync('.gcr', { recursive: true });\n        const { Gcr } = await import('../../sdk/gcr.js');\n        const report",
    ),
  // stats puts a message text into its result
  (dist) => replaceBetween(join(dist, 'cli', 'commands', 'read.js'), 'export const statsCommand', 'export const auditCommand', EMIT, `${LEAK('ctx.db.path')}\n        ${EMIT}`),
  // the import report loses a warning code
  (dist) =>
    replaceInFile(
      join(dist, 'ingest', 'import-runner.js'),
      'toSummaries() {\n        return this.codes().map((code) => {',
      "toSummaries() {\n        return this.codes().filter((c) => c !== 'CURRENT_NODE_NOT_LEAF').map((code) => {",
    ),
  // the compact list omits the last conversation
  (dist) => replaceInFile(join(dist, 'format', 'render.js'), 'body: page.items.map((c) => `[${cRole(c.provider)}]', 'body: page.items.slice(0, -1).map((c) => `[${cRole(c.provider)}]'),
  // the text-mode error ends with the working directory
  (dist) => replaceInFile(join(dist, 'cli', 'report-error.js'), "const lines = [`error[${err.code}]: ${indentBlock(err.message, '  ')}`];", "const lines = [`error[${err.code}]: ${indentBlock(err.message, '  ')} (cwd ${process.cwd()})`];"),
];

const outcomes: Record<'A' | 'B' | 'C', SmokeOutcome | undefined> = { A: undefined, B: undefined, C: undefined };

describe('scripts/ci-smoke.mjs finds the regressions the first version missed (LONG)', { timeout: 900_000 }, () => {
  before(async () => {
    const [a, b, c] = await Promise.all([
      smokeOnSabotaged((dist) => groupA.forEach((m) => m(dist))),
      smokeOnSabotaged((dist) => groupB.forEach((m) => m(dist))),
      smokeOnSabotaged((dist) => groupC.forEach((m) => m(dist))),
    ]);
    outcomes.A = a;
    outcomes.B = b;
    outcomes.C = c;
  });

  const outcome = (key: 'A' | 'B' | 'C'): SmokeOutcome => {
    const o = outcomes[key];
    assert.ok(o, 'the smoke did not run');
    return o;
  };

  describe('group A', () => {
    it('is red, with FAIL lines that carry no path and no canary', () => {
      assertRed(outcome('A'));
    });
    it('import reports a message text: named by the leak scan', () => {
      assert.match(failureOf(outcome('A'), 'cli: import stores the export').reason, /^import: \d+ imported message text\(s\) appear in output that must not carry message text$/);
    });
    it('an error that names the absolute path of a missing import file', () => {
      assert.equal(failureOf(outcome('A'), 'cli errors: a missing import file exits 4').reason, 'import (text): the error names an absolute path');
    });
    it('the importer copies the decoy user.json into the temp directory: found by the file scan and by the footprint check', () => {
      assert.equal(failureOf(outcome('A'), 'canary: absent from every file in the sandbox').reason, 'the canary is in aux-copy.bin');
      assert.equal(failureOf(outcome('A'), 'fs: the product left only').reason, 'entries the product created in TMPDIR: got 1, expected 0');
      assert.ok(hasPassed(outcome('A'), 'canary: absent from every database table'), 'the database itself is clean: only the file scan can see this');
      assert.ok(hasPassed(outcome('A'), 'canary: absent from every captured stdout and stderr'), 'no output shows it either');
    });
    it('search over MCP returns a hidden message', () => {
      assert.equal(failureOf(outcome('A'), 'mcp: hidden messages stay hidden by default').reason, 'gcr_search hits for a term that exists only in a hidden message: got 1, expected 0');
      assert.ok(hasPassed(outcome('A'), 'cli read: hidden messages stay hidden by default'), 'the CLI renderer filters a second time: only the MCP surface shows the regression');
    });
    it('the draft status column accepts "sent"', () => {
      assert.equal(failureOf(outcome('A'), 'db: a local draft cannot be given any status').reason, 'the database accepts the status "sent" for a local draft');
      assert.ok(hasPassed(outcome('A'), 'cli: draft create and draft list are local only'), 'behaviour is unchanged: only the schema probe can see this');
    });
    it('graph export follows a dangling symbolic link', () => {
      assert.equal(failureOf(outcome('A'), 'cli: graph export never writes through a symbolic link').reason, 'dangling link exit code: got 0, expected 2');
    });
    it('the approved-root test is a string prefix test', () => {
      assert.equal(failureOf(outcome('A'), 'mcp: gcr_import_export refuses paths').reason, 'sibling directory with the same name prefix: error code: got undefined, expected IMPORT_PATH_NOT_ALLOWED');
    });
    it('import over MCP works with roots configured but writes off', () => {
      assert.equal(failureOf(outcome('A'), 'mcp: in the default read-only mode every write tool is refused').reason, 'import inside the root ok: got true, expected false');
    });
  });

  describe('group A (formats and completeness)', () => {
    it('a list over complete and partial conversations claims the first source completeness instead of "mixed"', () => {
      assert.equal(failureOf(outcome('A'), 'cli read: list (json').reason, 'completeness of a list over complete and partial conversations: got unknown, expected mixed');
    });
    it('the markdown output of get drops the last message', () => {
      assert.equal(failureOf(outcome('A'), 'cli read: get <uuid> (json').reason, 'get uuid (markdown): 1 of 2 items of the JSON output are missing');
    });
  });

  describe('group B', () => {
    it('is red, with FAIL lines that carry no path and no canary', () => {
      assertRed(outcome('B'));
    });
    it('stats attributes a model to messages that never stated one (partial inference)', () => {
      assert.equal(failureOf(outcome('B'), 'cli read: stats --group-by model').reason, 'messages per model group: values differ');
      assert.ok(hasPassed(outcome('B'), 'cli read: stats --group-by role'));
    });
    it('a JSON error carries the database path', () => {
      assert.equal(failureOf(outcome('B'), 'output: no absolute path').reason, 'an absolute path of the sandbox appears in the captured output');
    });
    it('a history file appears in HOME', () => {
      assert.equal(failureOf(outcome('B'), 'fs: the product left only').reason, 'entries the product created in HOME: got 1, expected 0');
    });
    it('get over MCP returns the hidden messages', () => {
      assert.equal(failureOf(outcome('B'), 'mcp: hidden messages stay hidden by default').reason, 'gcr_get messages of F04 by default: got 23, expected 16');
    });
    it('the approved-root test does not resolve symlinks', () => {
      assert.equal(failureOf(outcome('B'), 'mcp: gcr_import_export refuses paths').reason, 'symlink that leaves the root: error code: got undefined, expected IMPORT_PATH_NOT_ALLOWED');
    });
    it('the compact output of get drops the last message', () => {
      assert.equal(failureOf(outcome('B'), 'cli read: get <uuid> (json').reason, 'get uuid (compact): 1 of 2 items of the JSON output are missing');
    });
    it('the compact list header claims a complete tree', () => {
      assert.equal(failureOf(outcome('B'), 'cli read: list (json').reason, 'list (compact): completeness differs from the JSON output');
    });
    it('one-line renderers pass a bidi override through raw (only an inline field with such text shows it)', () => {
      assert.match(failureOf(outcome('B'), 'cli read: hostile characters in a title').reason, /raw control, bidi or separator character on the wire$/);
      assert.ok(hasPassed(outcome('B'), 'cli read: get on the hostile fixture is safe'), 'the fixtures alone cannot see this regression');
    });
  });

  describe('group C', () => {
    it('is red, with FAIL lines that carry no path and no canary', () => {
      assertRed(outcome('C'));
    });
    it('doctor creates ./.gcr in the working directory', () => {
      assert.equal(failureOf(outcome('C'), 'fs: the product left only').reason, '1 unexpected entry in the working directory: .gcr');
    });
    it('stats reports a message text', () => {
      assert.match(failureOf(outcome('C'), 'cli read: stats --group-by model').reason, /^stats model \(json\): \d+ imported message text\(s\) appear in output that must not carry message text$/);
    });
    it('the import report loses a warning code', () => {
      assert.equal(failureOf(outcome('C'), 'cli: import stores the export').reason, 'import warnings by code and count: values differ');
    });
    it('the compact list omits the last conversation', () => {
      assert.equal(failureOf(outcome('C'), 'cli read: list (json').reason, 'list (compact): 1 of 28 items of the JSON output are missing');
    });
    it('a text-mode error ends with the absolute working directory', () => {
      assert.equal(failureOf(outcome('C'), 'cli errors: a missing import file exits 4').reason, 'import (text): the error names an absolute path');
    });
  });
});
