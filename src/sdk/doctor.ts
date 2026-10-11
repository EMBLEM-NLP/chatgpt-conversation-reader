/**
 * `gcr doctor`: a STATIC, OFFLINE self-check (SPEC section 3 and 6: "doctor must report supported modes and
 * environmental prerequisites"; "Commands should never fall back to remote browser access invisibly").
 *
 * What it does: reads the running Node version, probes node:sqlite and FTS5 on a throw-away in-memory database, states
 * the schema version this tool supports, optionally inspects ONE database file READ-ONLY (it never creates, migrates or
 * writes a file), reports which environment knobs are set and lists the capability modes A-E honestly.
 *
 * What it never does: open a socket, resolve a name, read a conversation, or print a secret. Concretely:
 *  - environment variables are reported as present / absent only; their VALUES are never read into the report;
 *  - paths are reduced to their BASENAME (the report may be pasted into an issue);
 *  - SQLite error text is never forwarded (it can embed SQL or paths): failures become fixed status words;
 *  - the function never throws for bad input: a bad path is a status, not an exception.
 */
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sqliteErrcode } from '../db/open.js';
import { GCR_APPLICATION_ID } from '../db/schema.js';
import { listAdapters } from '../ingest/registry.js';
import { SCHEMA_VERSION, TOOL_NAME, TOOL_VERSION } from '../version.js';

/**
 * `engines.node` of package.json (">=22.16.0"); kept as numbers so the check needs no semver library. 22.16 is the first
 * Node whose bundled node:sqlite ships SQLite WITH FTS5 (22.13-22.15 fail with "no such module: fts5"), so it is a hard
 * floor for GCR, not merely a recommendation.
 */
const REQUIRED_NODE: readonly [number, number, number] = [22, 16, 0];
const REQUIRED_NODE_RANGE = '>=22.16';
const FTS5_MISSING_MESSAGE =
  "FTS5 is missing from this Node build's SQLite, so full-text search cannot work. Upgrade to Node >= 22.16.0 (the first release whose node:sqlite includes FTS5).";

export type DoctorModeId = 'A' | 'B' | 'C' | 'D' | 'E';

export interface DoctorMode {
  mode: DoctorModeId;
  name: string;
  /** Honest status sentence; never "supported" for something that has no code or no live verification. */
  status: string;
}

/** Exact status strings required by the SDK contract (SPEC section 3 capability levels). */
export const MODE_STATUS: Readonly<Record<DoctorModeId, string>> = Object.freeze({
  A: 'supported (synthetic-fixture tested; no live export verified)',
  B: 'supported (manual copy, partial)',
  C: 'supported (local drafts/annotations only)',
  D: 'not implemented (interface + disabled adapter only)',
  E: 'gated - no code (docs/BROWSER_GATE.md)',
});

const MODE_NAMES: Readonly<Record<DoctorModeId, string>> = Object.freeze({
  A: 'Official export (conversations.json or export ZIP)',
  B: 'Manual copy (user-supplied messages)',
  C: 'Local write (drafts and annotations)',
  D: 'OpenAI developer API (API-owned conversations)',
  E: 'Browser interaction',
});

export const NO_REMOTE_FALLBACK_STATEMENT = 'Commands never fall back to remote browser access.';

export type DatabaseSchemaStatus =
  | 'ok'
  | 'missing'
  | 'in_memory'
  | 'empty_uninitialized'
  | 'needs_migration'
  | 'newer_than_tool'
  | 'not_a_gcr_database'
  | 'not_a_file'
  | 'unreadable'
  | 'invalid_path'
  /**
   * This Node build cannot run GCR at all (node:sqlite without FTS5, Node < 22.16). Says nothing about the file itself:
   * it is reported INSTEAD of a schema verdict because the same condition makes db/open.ts refuse every open with
   * DB_ERROR reason "FTS5_UNAVAILABLE".
   */
  | 'unsupported_runtime';

export interface DoctorDatabase {
  /** Basename of the file (or ":memory:"). Never a directory path. */
  label: string;
  exists: boolean;
  /** File permissions would allow a read-write open (an existing file is writable, or a missing one has a writable directory). */
  writable: boolean;
  /** PRAGMA user_version of the file, or null when it could not be read. */
  schemaVersion: number | null;
  schemaStatus: DatabaseSchemaStatus;
}

export interface DoctorEnvKnob {
  name: string;
  /** Presence only. The value is never read into the report. */
  status: 'present' | 'absent';
}

export interface DoctorReport {
  /** false when a prerequisite is missing or the inspected database is unusable (see `problems`). */
  ok: boolean;
  tool: { name: string; version: string };
  node: { version: string; requiredRange: string; satisfiesEngines: boolean };
  sqlite: { module: 'node:sqlite'; available: boolean; version: string | null; fts5: boolean };
  schema: { supportedVersion: number };
  /** null when no database path was supplied. */
  database: DoctorDatabase | null;
  env: DoctorEnvKnob[];
  modes: DoctorMode[];
  adapters: Array<{ id: string; provider: string; provenance: string }>;
  /** GCR contains no network code; this report is produced without any. */
  network: { used: false; statement: string };
  /** Always present: the fallback sentence of SPEC section 6. */
  statement: string;
  problems: string[];
}

export interface DoctorOptions {
  /** A database file to inspect read-only. Missing is fine (an import creates it); only its basename is reported. */
  dbPath?: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Node and SQLite probes
// ---------------------------------------------------------------------------------------------------------------

/** true when `version` ("22.22.0") is at least `required`. A version string we cannot parse fails the check. */
export function nodeSatisfies(version: string, required: readonly [number, number, number] = REQUIRED_NODE): boolean {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (m === null) return false;
  const actual = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) {
    const a = actual[i] ?? 0;
    const r = required[i] ?? 0;
    if (a !== r) return a > r;
  }
  return true;
}

interface SqliteProbe {
  available: boolean;
  version: string | null;
  fts5: boolean;
}

/** In-memory only: nothing touches the disk. Failures are reported as "unavailable", never thrown. */
function probeSqlite(): SqliteProbe {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(':memory:');
    const row = db.prepare('SELECT sqlite_version() AS v').get();
    const version = typeof row?.['v'] === 'string' ? row['v'] : null;
    let fts5 = false;
    try {
      db.exec('CREATE VIRTUAL TABLE doctor_probe USING fts5(body)');
      db.prepare('INSERT INTO doctor_probe (body) VALUES (?)').run('probe');
      const hit = db.prepare('SELECT count(*) AS n FROM doctor_probe WHERE doctor_probe MATCH ?').get('probe');
      fts5 = hit?.['n'] === 1;
    } catch {
      fts5 = false;
    }
    return { available: true, version, fts5 };
  } catch {
    return { available: false, version: null, fts5: false };
  } finally {
    try {
      db?.close();
    } catch {
      /* the probe result is what matters */
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Database file inspection (read-only)
// ---------------------------------------------------------------------------------------------------------------

function canWrite(path: string): boolean {
  try {
    accessSync(path, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const INVALID_PATH_STATUS: DoctorDatabase = { label: '(invalid path)', exists: false, writable: false, schemaVersion: null, schemaStatus: 'invalid_path' };

/** Same refusals as openDatabase: empty, NUL bytes, "file:" URIs (which could smuggle SQLite open options). */
export function inspectDatabase(dbPath: unknown, fts5: boolean): DoctorDatabase {
  const inspected = inspectFile(dbPath);
  // A runtime without FTS5 cannot open ANY GCR database, whatever the file looks like: that is the actionable finding, not a schema problem.
  const usable: readonly DatabaseSchemaStatus[] = ['ok', 'missing', 'in_memory', 'empty_uninitialized', 'needs_migration'];
  return !fts5 && usable.includes(inspected.schemaStatus) ? { ...inspected, schemaStatus: 'unsupported_runtime' } : inspected;
}

function inspectFile(dbPath: unknown): DoctorDatabase {
  if (typeof dbPath !== 'string' || dbPath === '' || dbPath.includes('\0') || /^file:/i.test(dbPath)) return INVALID_PATH_STATUS;
  if (dbPath === ':memory:') return { label: ':memory:', exists: true, writable: true, schemaVersion: SCHEMA_VERSION, schemaStatus: 'in_memory' };
  const label = basename(dbPath);

  let isFile: boolean;
  try {
    isFile = statSync(dbPath).isFile();
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code === 'ENOENT') {
      // A missing file is normal before the first import; `writable` says whether the import could create it here.
      return { label, exists: false, writable: canWrite(dirname(dbPath)), schemaVersion: null, schemaStatus: 'missing' };
    }
    return { label, exists: false, writable: false, schemaVersion: null, schemaStatus: 'unreadable' };
  }
  if (!isFile) return { label, exists: true, writable: false, schemaVersion: null, schemaStatus: 'not_a_file' };

  const writable = canWrite(dbPath);
  let db: DatabaseSync | undefined;
  try {
    // readOnly: the file is not created, migrated or modified. query_only is implied by the read-only open.
    db = new DatabaseSync(dbPath, { readOnly: true });
    const version = Number(db.prepare('PRAGMA user_version').get()?.['user_version'] ?? 0);
    const appId = Number(db.prepare('PRAGMA application_id').get()?.['application_id'] ?? 0);
    const objects = Number(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").get()?.['n'] ?? 0);
    const base = { label, exists: true, writable, schemaVersion: version };
    if (version === 0) {
      // A brand-new 0-byte file (created 0600 by an import that has not run yet) is fine; a file with foreign tables is not ours.
      if (appId === 0 && objects === 0) return { ...base, schemaStatus: 'empty_uninitialized' };
      return { ...base, schemaStatus: 'not_a_gcr_database' };
    }
    if (appId !== GCR_APPLICATION_ID) return { ...base, schemaStatus: 'not_a_gcr_database' };
    if (version > SCHEMA_VERSION) return { ...base, schemaStatus: 'newer_than_tool' };
    if (version < SCHEMA_VERSION) return { ...base, schemaStatus: 'needs_migration' };
    return { ...base, schemaStatus: 'ok' };
  } catch (e) {
    // SQLITE_NOTADB (26) is "not a database file"; everything else is simply unreadable. SQLite's text is never forwarded.
    const code = sqliteErrcode(e);
    const notADb = code !== null && (code & 0xff) === 26;
    return { label, exists: true, writable, schemaVersion: null, schemaStatus: notADb ? 'not_a_gcr_database' : 'unreadable' };
  } finally {
    try {
      db?.close();
    } catch {
      /* nothing to add */
    }
  }
}

function presence(value: string | undefined): 'present' | 'absent' {
  return value !== undefined && value !== '' ? 'present' : 'absent';
}

// ---------------------------------------------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------------------------------------------

/** Run the self-check. Pure with respect to GCR data: reads no conversation, writes nothing, uses no network. */
export function runDoctor(opts: DoctorOptions = {}): DoctorReport {
  const nodeVersion = process.versions.node;
  const satisfies = nodeSatisfies(nodeVersion);
  const sqlite = probeSqlite();
  const database = opts !== null && typeof opts === 'object' && opts.dbPath !== undefined ? inspectDatabase(opts.dbPath, sqlite.fts5) : null;

  const problems: string[] = [];
  if (!satisfies) problems.push(`Node ${nodeVersion} does not satisfy engines ${REQUIRED_NODE_RANGE}; upgrade Node.`);
  if (!sqlite.available) problems.push('node:sqlite is not available in this Node build; GCR cannot store or search data.');
  else if (!sqlite.fts5) problems.push(FTS5_MISSING_MESSAGE);
  if (database !== null) {
    switch (database.schemaStatus) {
      case 'newer_than_tool':
        problems.push('The database was written by a newer GCR (schema too new); upgrade GCR or choose another file.');
        break;
      case 'not_a_gcr_database':
        problems.push('The file is not a GCR database; GCR will not write into it.');
        break;
      case 'unreadable':
      case 'not_a_file':
      case 'invalid_path':
        problems.push(`The database path is not usable (${database.schemaStatus}).`);
        break;
      case 'unsupported_runtime':
        problems.push('This Node runtime cannot open GCR databases (unsupported runtime, see the FTS5 finding); the database file itself was not judged.');
        break;
      default:
        break;
    }
  }

  const modes: DoctorMode[] = (['A', 'B', 'C', 'D', 'E'] as const).map((mode) => ({ mode, name: MODE_NAMES[mode], status: MODE_STATUS[mode] }));
  return {
    ok: problems.length === 0,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    node: { version: nodeVersion, requiredRange: REQUIRED_NODE_RANGE, satisfiesEngines: satisfies },
    sqlite: { module: 'node:sqlite', available: sqlite.available, version: sqlite.version, fts5: sqlite.fts5 },
    schema: { supportedVersion: SCHEMA_VERSION },
    database,
    // Literal reads on purpose: only presence is derived, the values themselves never enter the report.
    env: [
      { name: 'GCR_DB', status: presence(process.env['GCR_DB']) },
      { name: 'GCR_APPROVED_IMPORT_ROOTS', status: presence(process.env['GCR_APPROVED_IMPORT_ROOTS']) },
    ],
    modes,
    adapters: listAdapters().map((a) => ({ id: a.id, provider: a.provider, provenance: a.provenance })),
    network: { used: false, statement: 'This report was produced without any network access; GCR contains no network code.' },
    statement: NO_REMOTE_FALLBACK_STATEMENT,
    problems,
  };
}
