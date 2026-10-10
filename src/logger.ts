/**
 * Minimal stderr-only logger. stdout is reserved for command output and (in MCP stdio mode) JSON-RPC frames,
 * so nothing here may ever write to stdout. Callers must pass ids/counts/codes only: NEVER conversation
 * content, credentials, or absolute private paths (NFR-07).
 */
type Level = 'error' | 'warn' | 'info' | 'debug';

const ORDER: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

function threshold(): number {
  const raw = (process.env['GCR_LOG_LEVEL'] ?? (process.env['GCR_DEBUG'] === '1' ? 'debug' : 'warn')).toLowerCase();
  return raw in ORDER ? ORDER[raw as Level] : ORDER.warn;
}

function emit(level: Level, msg: string, fields?: Record<string, string | number | boolean | null>): void {
  if (ORDER[level] > threshold()) return;
  const line = JSON.stringify({ level, msg, ...(fields ?? {}) });
  process.stderr.write(line + '\n');
}

export const log = {
  error: (msg: string, fields?: Record<string, string | number | boolean | null>) => emit('error', msg, fields),
  warn: (msg: string, fields?: Record<string, string | number | boolean | null>) => emit('warn', msg, fields),
  info: (msg: string, fields?: Record<string, string | number | boolean | null>) => emit('info', msg, fields),
  debug: (msg: string, fields?: Record<string, string | number | boolean | null>) => emit('debug', msg, fields),
};
