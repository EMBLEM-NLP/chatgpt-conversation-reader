/**
 * SQLite schema, migrations and compatibility checks (ARCHITECTURE section 3).
 *
 * Design notes
 *  - The DDL below is the contract for table and column names. Additions beyond the contract: a few secondary indexes,
 *    the helper table `source_batch_stats`, the FTS tables, and extra safety triggers (see each block).
 *  - Imported data is IMMUTABLE: BEFORE UPDATE / BEFORE DELETE triggers abort with a fixed message. The importer only
 *    ever INSERTs (`ON CONFLICT DO NOTHING`). `INSERT OR REPLACE` would delete the conflicting row, which fires the
 *    delete trigger because openDatabase() turns `recursive_triggers` ON (REPLACE only fires delete triggers then).
 *  - Full-text design (the constraints are written down in ARCHITECTURE section 3):
 *      * `messages_fts` / `conversations_fts` are CONTENTLESS FTS5 tables (`content=''`). They store only the inverted
 *        index, never a second copy of the text, which keeps the index well inside the ~3x budget. Their rowid is the
 *        rowid of the row in `messages` / `conversations` (set explicitly at insert time, in the same transaction).
 *        Consequences: no `snippet()`/`highlight()` (they need stored content) - snippets are built in JS from the
 *        ORIGINAL text, which is also what makes CJK snippets correct; and no DELETE/UPDATE (never needed: rows are
 *        immutable). If the index is ever suspect, `rebuildSearchIndex()` in repo.ts recreates it from the tables.
 *      * The indexed string is `buildSearchText(text)` from cjk.ts (NFKC + lower-case + diacritic folding + one space
 *        around every CJK code point). The tokenizer is unicode61 with `categories 'L* N* Co Mn Mc'` so that combining
 *        marks of Indic scripts stay inside their word. No stemming (predictable, language independent; use `word*`).
 *      * rowid stability: VACUUM may renumber rowids of tables WITHOUT an explicit INTEGER PRIMARY KEY. SQLite keeps them
 *        when the table has an index (ours have), and a test pins that behaviour for the bundled SQLite build.
 *  - Local (writable) tables and derived graph tables live in the same file but are separate from imported originals.
 *  - All SQL here is static text. The only interpolated value is the integer schema version in `PRAGMA user_version`
 *    (PRAGMA cannot take bound parameters), which is checked to be a positive safe integer first.
 */
import type { DatabaseSync } from 'node:sqlite';
import { GcrError } from '../errors.js';
import { SCHEMA_VERSION } from '../version.js';

/** `PRAGMA application_id` written by migration 1 ("GCR1"); lets us refuse to touch somebody else's SQLite file. */
export const GCR_APPLICATION_ID = 0x47435231;

/** Tokenizer shared by both FTS tables; see the design notes above and cjk.ts for why plain unicode61 is not enough. */
const FTS_TOKENIZE = `unicode61 remove_diacritics 2 categories 'L* N* Co Mn Mc'`;

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: (db: DatabaseSync) => void;
}

const IMMUTABLE_MESSAGE = 'imported data is immutable';
const APPEND_ONLY_MESSAGE = 'audit log is append-only';

/** BEFORE UPDATE / BEFORE DELETE aborting triggers for one immutable table. `table` comes from a fixed list below. */
function immutabilityTriggers(table: string): string {
  return `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT, '${IMMUTABLE_MESSAGE}'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT, '${IMMUTABLE_MESSAGE}'); END;`;
}

const DDL_V1 = `
CREATE TABLE gcr_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;

CREATE TABLE source_batches (
  batch_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  provider TEXT NOT NULL, account_label TEXT NOT NULL,
  provenance TEXT NOT NULL, completeness TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_label TEXT,
  input_sha256 TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  tool_version TEXT NOT NULL, schema_version INTEGER NOT NULL,
  conversation_count INTEGER NOT NULL, message_count INTEGER NOT NULL,
  warnings_json TEXT NOT NULL DEFAULT '[]'
) STRICT;

-- Helper (not in the contract DDL): node counts that source_batches cannot hold because that table is immutable and its
-- row is written last. Lets an idempotent re-import report the same counts without scanning messages.
CREATE TABLE source_batch_stats (
  batch_id TEXT PRIMARY KEY REFERENCES source_batches(batch_id),
  node_count INTEGER NOT NULL,
  structural_count INTEGER NOT NULL
) STRICT;

CREATE TABLE conversations (
  provider TEXT NOT NULL, account_label TEXT NOT NULL, conversation_id TEXT NOT NULL,
  source_batch TEXT NOT NULL REFERENCES source_batches(batch_id),
  title TEXT, source_uri TEXT,
  provenance TEXT NOT NULL, completeness TEXT NOT NULL, imported_at TEXT NOT NULL,
  created_at TEXT, updated_at TEXT,
  current_node_id TEXT, default_model_slug TEXT,
  message_count INTEGER NOT NULL,
  raw_metadata_json TEXT, warnings_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (provider, account_label, conversation_id, source_batch)
) STRICT;
CREATE INDEX conversations_by_conv ON conversations(conversation_id);
CREATE INDEX conversations_by_batch ON conversations(source_batch);

CREATE TABLE messages (
  provider TEXT NOT NULL, account_label TEXT NOT NULL, conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL, source_batch TEXT NOT NULL REFERENCES source_batches(batch_id),
  ordinal INTEGER NOT NULL,
  parent_id TEXT, child_ids_json TEXT NOT NULL DEFAULT '[]',
  node_kind TEXT NOT NULL CHECK (node_kind IN ('message','structural_empty')),
  author_role TEXT NOT NULL, author_name TEXT,
  model_slug TEXT, channel TEXT, recipient TEXT, content_type TEXT, status TEXT,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0,1)),
  created_at TEXT, updated_at TEXT,
  text TEXT NOT NULL, blocks_json TEXT NOT NULL, attachments_json TEXT NOT NULL DEFAULT '[]',
  raw_source_json TEXT,
  PRIMARY KEY (provider, account_label, conversation_id, message_id, source_batch)
) STRICT;
CREATE INDEX messages_parent ON messages(provider, account_label, conversation_id, source_batch, parent_id);
CREATE INDEX messages_created ON messages(created_at);
CREATE INDEX messages_role ON messages(author_role);

CREATE TABLE conversation_heads (
  provider TEXT NOT NULL, account_label TEXT NOT NULL, conversation_id TEXT NOT NULL,
  source_batch TEXT NOT NULL REFERENCES source_batches(batch_id),
  PRIMARY KEY (provider, account_label, conversation_id)
) STRICT;
CREATE INDEX conversation_heads_by_conv ON conversation_heads(conversation_id);

-- Full-text indexes (see the design notes at the top of schema.ts). rowid = rowid of messages / conversations.
CREATE VIRTUAL TABLE messages_fts USING fts5(search_text, content = '', tokenize = "${FTS_TOKENIZE}");
CREATE VIRTUAL TABLE conversations_fts USING fts5(title_text, content = '', tokenize = "${FTS_TOKENIZE}");

${immutabilityTriggers('source_batches')}
${immutabilityTriggers('source_batch_stats')}
${immutabilityTriggers('conversations')}
${immutabilityTriggers('messages')}

-- Local (writable) data: separate from imported originals, never transmitted anywhere.
CREATE TABLE local_drafts (
  draft_id TEXT PRIMARY KEY, namespace TEXT NOT NULL DEFAULT 'default',
  provider TEXT NOT NULL, account_label TEXT NOT NULL, conversation_id TEXT NOT NULL,
  anchor_message_id TEXT,
  title TEXT, body TEXT NOT NULL, body_sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','archived')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_via TEXT NOT NULL
) STRICT;
CREATE TABLE local_annotations (
  annotation_id TEXT PRIMARY KEY, namespace TEXT NOT NULL DEFAULT 'default',
  provider TEXT NOT NULL, account_label TEXT NOT NULL, conversation_id TEXT NOT NULL,
  message_id TEXT,
  kind TEXT NOT NULL DEFAULT 'note', body TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_via TEXT NOT NULL
) STRICT;
CREATE TABLE local_audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor TEXT NOT NULL,
  action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE TRIGGER local_audit_log_no_update BEFORE UPDATE ON local_audit_log
BEGIN SELECT RAISE(ABORT, '${APPEND_ONLY_MESSAGE}'); END;
CREATE TRIGGER local_audit_log_no_delete BEFORE DELETE ON local_audit_log
BEGIN SELECT RAISE(ABORT, '${APPEND_ONLY_MESSAGE}'); END;

-- Derived artifacts (rebuilt by graph build; safe to DROP and recreate).
CREATE TABLE entities (entity_id INTEGER PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL, normalized TEXT NOT NULL, UNIQUE(kind, normalized)) STRICT;
CREATE TABLE entity_mentions (entity_id INTEGER NOT NULL REFERENCES entities(entity_id), provider TEXT NOT NULL, account_label TEXT NOT NULL,
  conversation_id TEXT NOT NULL, message_id TEXT NOT NULL, source_batch TEXT NOT NULL, count INTEGER NOT NULL,
  PRIMARY KEY (entity_id, provider, account_label, conversation_id, message_id, source_batch)) STRICT;
CREATE TABLE graph_nodes (node_id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, ref TEXT, weight REAL NOT NULL DEFAULT 1, community_id INTEGER) STRICT;
CREATE TABLE graph_edges (edge_id INTEGER PRIMARY KEY, src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1,
  UNIQUE(src, dst, kind)) STRICT;
CREATE TABLE graph_edge_evidence (edge_id INTEGER NOT NULL REFERENCES graph_edges(edge_id), provider TEXT NOT NULL, account_label TEXT NOT NULL,
  conversation_id TEXT NOT NULL, message_id TEXT, source_batch TEXT NOT NULL) STRICT;
CREATE TABLE graph_communities (community_id INTEGER PRIMARY KEY, size INTEGER NOT NULL, label TEXT) STRICT;
`;

function migrateV1(db: DatabaseSync): void {
  db.exec(DDL_V1);
  db.exec(`PRAGMA application_id = ${GCR_APPLICATION_ID}`);
  db.prepare('INSERT INTO gcr_meta (key, value) VALUES (?, ?)').run('fts_design', 'contentless-unicode61-v1');
}

/** Ordered, gap-free list of migrations. `up` must run entirely inside the transaction applyMigrations opens. */
export const MIGRATIONS: ReadonlyArray<Migration> = [{ version: 1, name: 'initial_schema', up: migrateV1 }];

/** Tables that must exist in a compatible database (cheap structural sanity check, not a full schema comparison). */
const REQUIRED_TABLES: readonly string[] = [
  'gcr_meta',
  'source_batches',
  'source_batch_stats',
  'conversations',
  'messages',
  'conversation_heads',
  'messages_fts',
  'conversations_fts',
  'local_drafts',
  'local_annotations',
  'local_audit_log',
];

// ---------------------------------------------------------------------------------------------------------------
// Pragmas and helpers
// ---------------------------------------------------------------------------------------------------------------

function readIntPragma(db: DatabaseSync, name: 'user_version' | 'application_id'): number {
  // `name` is a compile-time literal union, never user input.
  const row = db.prepare(`PRAGMA ${name}`).get();
  const v = row === undefined ? 0 : row[name];
  return typeof v === 'number' ? v : 0;
}

/** Schema version stored in the file header (`PRAGMA user_version`). */
export function readUserVersion(db: DatabaseSync): number {
  return readIntPragma(db, 'user_version');
}

function userObjectCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").get();
  const n = row?.['n'];
  return typeof n === 'number' ? n : 0;
}

function schemaTooNew(fileVersion: number, supported: number): GcrError {
  return new GcrError('DB_SCHEMA_TOO_NEW', `Database schema version ${fileVersion} is newer than this tool supports (${supported}).`, {
    remedy: 'Upgrade GCR, or use a different database file. The file was not modified.',
    details: { fileVersion, supportedVersion: supported },
  });
}

function notGcrDatabase(): GcrError {
  return new GcrError('DB_ERROR', 'The file is a SQLite database but not a GCR database; refusing to use or modify it.', {
    remedy: 'Choose a different --db path. GCR never writes into databases it did not create.',
    details: { reason: 'not_gcr_database' },
  });
}

/**
 * Apply every pending migration, each in its own `BEGIN IMMEDIATE` transaction.
 *  - file newer than this tool  -> DB_SCHEMA_TOO_NEW (nothing is touched);
 *  - a migration throws         -> that transaction is rolled back and DB_MIGRATION_FAILED is thrown (earlier,
 *                                  already committed migrations stay applied; the file is left at a consistent version);
 *  - the version is re-read INSIDE the transaction, so two processes opening a fresh file at the same time cannot
 *    apply a migration twice (the loser waits on busy_timeout, then sees the new version and skips).
 * `migrations` is a TEST SEAM (inject a deliberately failing migration); production callers use the default.
 * Returns the version before and after.
 */
export function applyMigrations(db: DatabaseSync, migrations: ReadonlyArray<Migration> = MIGRATIONS): { from: number; to: number } {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1 || !Number.isSafeInteger(m.version)) {
      throw new GcrError('INTERNAL_ERROR', 'The migration list is not a gap-free sequence starting at 1.');
    }
  });
  const latest = migrations.length;
  if (migrations === MIGRATIONS && latest !== SCHEMA_VERSION) {
    throw new GcrError('INTERNAL_ERROR', 'SCHEMA_VERSION and the MIGRATIONS list are out of sync.', { details: { latest, SCHEMA_VERSION } });
  }

  const from = readUserVersion(db);
  if (from > latest) throw schemaTooNew(from, latest);

  if (from === 0) {
    // A brand-new file has no objects. A non-empty file with version 0 belongs to some other application: never
    // create our tables inside it.
    const appId = readIntPragma(db, 'application_id');
    if (appId !== 0 && appId !== GCR_APPLICATION_ID) throw notGcrDatabase();
    if (appId === 0 && userObjectCount(db) > 0) throw notGcrDatabase();
  }

  let current = from;
  for (const m of migrations) {
    if (m.version <= current) continue;
    try {
      db.exec('BEGIN IMMEDIATE');
      const inTxn = readUserVersion(db);
      if (inTxn >= m.version) {
        db.exec('ROLLBACK'); // somebody else migrated while we waited for the lock
        current = Math.max(current, inTxn);
        continue;
      }
      m.up(db);
      // PRAGMA cannot be parameterized; m.version was validated as a positive safe integer above.
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.prepare('INSERT INTO gcr_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
        'schema_version',
        String(m.version),
      );
      db.exec('COMMIT');
      current = m.version;
    } catch (e) {
      try {
        if (db.isTransaction) db.exec('ROLLBACK');
      } catch {
        /* the original failure is the one worth reporting; the connection is discarded by the caller */
      }
      throw new GcrError('DB_MIGRATION_FAILED', `Migration to schema version ${m.version} (${m.name}) failed and was rolled back.`, {
        remedy: 'The database was left at its previous version. Report the issue (without attaching private data).',
        details: { fromVersion: current, toVersion: m.version },
        cause: e,
      });
    }
  }
  return { from, to: current };
}

/**
 * Cheap compatibility gate used by read-only opens and the SDK: the file must be a GCR database at exactly this tool's
 * schema version with the expected tables. Never modifies anything.
 */
export function assertCompatible(db: DatabaseSync): void {
  const appId = readIntPragma(db, 'application_id');
  if (appId !== 0 && appId !== GCR_APPLICATION_ID) throw notGcrDatabase();
  const v = readUserVersion(db);
  if (v > SCHEMA_VERSION) throw schemaTooNew(v, SCHEMA_VERSION);
  if (v < SCHEMA_VERSION) {
    throw new GcrError('DB_ERROR', v === 0 ? 'The database has not been initialized.' : `The database schema (version ${v}) needs migration to version ${SCHEMA_VERSION}.`, {
      remedy: 'Open the database once in read-write mode (for example by running an import) to initialize or migrate it.',
      details: { fileVersion: v, requiredVersion: SCHEMA_VERSION, reason: 'needs_migration' },
    });
  }
  const present = new Set(
    db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
      .all()
      .map((r) => String(r['name'])),
  );
  const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
  if (missing.length > 0) {
    throw new GcrError('DB_ERROR', 'The database schema is incomplete or damaged.', {
      remedy: 'Restore the database from a backup or re-import your export into a new file.',
      details: { reason: 'missing_tables', missing },
    });
  }
  const meta = db.prepare("SELECT value FROM gcr_meta WHERE key = 'schema_version'").get();
  if (meta === undefined || meta['value'] !== String(v)) {
    throw new GcrError('DB_ERROR', 'The database metadata does not match its schema version.', {
      remedy: 'Restore the database from a backup or re-import your export into a new file.',
      details: { reason: 'meta_mismatch' },
    });
  }
}
