/**
 * Legacy tool-name aliases (SPEC section 7: "keep the existing chatgpt_* tool names as compatibility aliases where safe").
 *
 * ADR-0002: the names the v0.1.1 baseline used are UNKNOWN (the baseline was never available), so inventing them would
 * fabricate compatibility. The mechanism exists, is tested with a test table, and the shipped table is EMPTY. Supplying the
 * real names later is a one-line change here (plus the documentation), not a redesign.
 *
 * Semantics of an alias:
 *  - the SAME entry (handler, schemas, annotations, size plan) registered under one more name, so it behaves identically
 *    and appears in `tools/list` (with the description suffixed "Deprecated alias of <canonical>");
 *  - every successful call through the alias carries a DEPRECATED_TOOL_ALIAS warning naming the canonical tool;
 *  - the table is validated when the server is built: an alias must be a legal tool name and must not collide with any
 *    existing tool or alias, and its canonical tool must exist and not itself be an alias. A mistake stops the server at
 *    startup instead of shadowing a tool;
 *  - an alias duplicates the tool's schemas in `tools/list` (about 2-3 KB per alias).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GcrError } from '../errors.js';
import { existingRegistry, isLegalToolName } from './registry.js';

/** canonical tool name -> legacy names that must keep working. */
export type AliasTable = Readonly<Record<string, readonly string[]>>;

/** The shipped table: empty by ADR-0002. */
export const LEGACY_ALIASES: AliasTable = Object.freeze({});

/** Register every alias of `table` on `server`. Returns how many were registered. Throws GcrError(INVALID_ARGUMENT) on a bad table. */
export function registerAliases(server: McpServer, table: AliasTable = LEGACY_ALIASES): number {
  // The table is data written by a programmer, but it is still validated as untrusted: a string where a list belongs would be
  // iterated character by character (one-letter tools), a non-string name would crash, and a bad table must fail the build
  // with the documented coded error, not with whatever the SDK throws.
  if (typeof table !== 'object' || table === null || Array.isArray(table)) throw new GcrError('INVALID_ARGUMENT', 'The alias table must be an object that maps a tool name to a list of alias names.');
  const canonicals = Object.keys(table);
  if (canonicals.length === 0) return 0;
  const registry = existingRegistry(server);
  if (registry === undefined) throw new GcrError('INVALID_ARGUMENT', 'Aliases can only be registered on a server that already has its tools.');
  let count = 0;
  for (const canonical of canonicals) {
    const entry = registry.entryFor(canonical);
    if (entry === undefined || entry.name !== canonical) {
      throw new GcrError('INVALID_ARGUMENT', 'An alias must point at an existing, non-alias tool.', { details: { canonical: canonical.slice(0, 64) } });
    }
    const aliases: unknown = table[canonical];
    if (!Array.isArray(aliases)) throw new GcrError('INVALID_ARGUMENT', 'The aliases of a tool must be given as a list of names.', { details: { canonical: canonical.slice(0, 64) } });
    for (const alias of aliases as unknown[]) {
      if (!isLegalToolName(alias)) {
        throw new GcrError('INVALID_ARGUMENT', 'An alias is not a legal tool name.', { details: { alias: typeof alias === 'string' ? alias.slice(0, 64) : typeof alias } });
      }
      if (registry.has(alias)) throw new GcrError('INVALID_ARGUMENT', 'An alias collides with an existing tool name.', { details: { alias: alias.slice(0, 64) } });
      registry.add(server, entry, alias, canonical);
      count++;
    }
  }
  return count;
}
