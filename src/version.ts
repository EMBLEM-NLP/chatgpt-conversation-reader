/** Tool version reported by `gcr --version`, `gcr doctor`, MCP serverInfo and source_batches.tool_version. Keep in sync with package.json (checked by test/version.test.ts). */
export const TOOL_VERSION = '0.2.0-dev.0';
/** Name of this product, used in MCP serverInfo and CLI banners. */
export const TOOL_NAME = 'gcr';
/** SQLite schema version written to PRAGMA user_version and gcr_meta. Bump only together with a new entry in db/schema.ts MIGRATIONS. */
export const SCHEMA_VERSION = 1;
