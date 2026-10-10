/**
 * Structured errors shared by the SDK, CLI and MCP server.
 *
 * Every failure that can reach a user is a `GcrError` with a stable machine-readable `code`
 * (NFR-07). The CLI maps codes to process exit codes; the MCP server maps them to
 * `isError` tool results carrying the same envelope. Messages must NEVER contain
 * conversation content, credentials, or absolute private paths (log hygiene, NFR-07).
 */

export const ERROR_CODES = [
  // --- caller input -------------------------------------------------------------------
  'INVALID_ARGUMENT',
  'INVALID_URL', //          malformed URL / not a chatgpt.com/c/<uuid> link
  'INVALID_UUID',
  'UNSUPPORTED_URL', //      share/ links, other domains: refused by design (FR-01)
  // --- lookup -------------------------------------------------------------------------
  'NOT_IN_LOCAL_EXPORT', //  UUID is not present in imported, user-authorized data (never guessed)
  'BRANCH_NOT_FOUND',
  'MESSAGE_NOT_FOUND',
  'AMBIGUOUS_CONVERSATION', // same id present under several accounts/providers; caller must disambiguate
  'ACTIVE_BRANCH_UNKNOWN', // source has no current_node; GCR refuses to guess unless a heuristic is requested
  // --- import -------------------------------------------------------------------------
  'IMPORT_INPUT_NOT_FOUND',
  'IMPORT_UNSUPPORTED_FORMAT',
  'IMPORT_ZIP_UNSAFE', //    path traversal, symlink, encrypted entry, duplicate names, bad structure
  'IMPORT_LIMIT_EXCEEDED', // decompression-bomb / size / entry-count guard tripped
  'IMPORT_PARSE_ERROR',
  'IMPORT_PATH_NOT_ALLOWED', // path outside approved roots (MCP delegated execution)
  // --- storage ------------------------------------------------------------------------
  'DB_NOT_FOUND',
  'DB_SCHEMA_TOO_NEW',
  'DB_MIGRATION_FAILED',
  'DB_ERROR',
  'FTS_SYNTAX_ERROR', //     user supplied raw FTS5 syntax that SQLite rejected
  // --- local write path ---------------------------------------------------------------
  'WRITE_FORBIDDEN', //      database opened read-only / write tool disabled
  'DRAFT_NOT_FOUND',
  'ANNOTATION_NOT_FOUND',
  'ANNOTATION_CONFLICT', //  optimistic-concurrency version mismatch
  // --- boundaries ---------------------------------------------------------------------
  'NOT_IMPLEMENTED',
  'FEATURE_GATED', //        FR-17 browser interaction etc.: behind a default-OFF gate, no code path
  'REMOTE_ACCESS_FORBIDDEN', // anything that would touch a ChatGPT consumer endpoint
  // --- fallback -----------------------------------------------------------------------
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Process exit codes (documented in docs/CLI_REFERENCE.md). 0 = success. */
export const EXIT_CODES: Readonly<Record<ErrorCode, number>> = {
  INVALID_ARGUMENT: 2,
  INVALID_URL: 2,
  INVALID_UUID: 2,
  UNSUPPORTED_URL: 2,
  NOT_IN_LOCAL_EXPORT: 3,
  BRANCH_NOT_FOUND: 3,
  MESSAGE_NOT_FOUND: 3,
  AMBIGUOUS_CONVERSATION: 3,
  ACTIVE_BRANCH_UNKNOWN: 3,
  IMPORT_INPUT_NOT_FOUND: 4,
  IMPORT_UNSUPPORTED_FORMAT: 4,
  IMPORT_ZIP_UNSAFE: 4,
  IMPORT_LIMIT_EXCEEDED: 4,
  IMPORT_PARSE_ERROR: 4,
  IMPORT_PATH_NOT_ALLOWED: 4,
  DB_NOT_FOUND: 5,
  DB_SCHEMA_TOO_NEW: 5,
  DB_MIGRATION_FAILED: 5,
  DB_ERROR: 5,
  FTS_SYNTAX_ERROR: 2,
  WRITE_FORBIDDEN: 6,
  DRAFT_NOT_FOUND: 3,
  ANNOTATION_NOT_FOUND: 3,
  ANNOTATION_CONFLICT: 6,
  NOT_IMPLEMENTED: 7,
  FEATURE_GATED: 7,
  REMOTE_ACCESS_FORBIDDEN: 7,
  INTERNAL_ERROR: 1,
};

/** A non-fatal observation attached to results (never silently dropped; FR-09). */
export interface Warning {
  /** Stable code, e.g. 'MISSING_PARENT', 'CYCLE_DETECTED', 'NO_CURRENT_NODE', 'UNKNOWN_CONTENT_TYPE'. */
  code: string;
  message: string;
  /** Ids (conversation/message/branch) the warning refers to. Never content. */
  ids?: string[];
}

/** JSON error envelope: stderr in the CLI (with --format json) and the body of MCP `isError` results. */
export interface ErrorEnvelope {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    /** Actionable next step for the human operator, e.g. how to obtain/import an export. */
    remedy?: string;
    /** Structured, content-free details (ids, limits, counts). */
    details?: Record<string, unknown>;
  };
  warnings: Warning[];
}

export class GcrError extends Error {
  readonly code: ErrorCode;
  readonly remedy: string | undefined;
  readonly details: Record<string, unknown> | undefined;
  readonly warnings: Warning[];

  constructor(
    code: ErrorCode,
    message: string,
    opts: { remedy?: string; details?: Record<string, unknown>; warnings?: Warning[]; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'GcrError';
    this.code = code;
    this.remedy = opts.remedy;
    this.details = opts.details;
    this.warnings = opts.warnings ?? [];
  }

  get exitCode(): number {
    return EXIT_CODES[this.code];
  }

  toEnvelope(): ErrorEnvelope {
    const error: ErrorEnvelope['error'] = { code: this.code, message: this.message };
    if (this.remedy !== undefined) error.remedy = this.remedy;
    if (this.details !== undefined) error.details = this.details;
    return { ok: false, error, warnings: this.warnings };
  }
}

export function isGcrError(e: unknown): e is GcrError {
  return e instanceof GcrError;
}

/**
 * Normalize ANY thrown value into a GcrError. Unknown errors become INTERNAL_ERROR with a generic
 * message: raw messages from SQLite/fs/JSON can embed content or absolute paths, so they are not forwarded.
 */
export function toGcrError(e: unknown): GcrError {
  if (e instanceof GcrError) return e;
  return new GcrError('INTERNAL_ERROR', 'An unexpected internal error occurred.', {
    remedy: 'Re-run with GCR_DEBUG=1 to print the stack trace to stderr, then report the issue without attaching private data.',
    cause: e,
  });
}
