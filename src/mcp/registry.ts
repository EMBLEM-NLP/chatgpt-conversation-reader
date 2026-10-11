/**
 * Tool registry and call dispatch for the MCP server: the one place where an MCP `tools/call` meets the SDK facade.
 *
 * WHAT IT ADDS to `McpServer.registerTool` (and why the dispatch is ours)
 *  - The SDK validates arguments BEFORE the handler and, on failure, answers with free text ("MCP error -32602: Input
 *    validation error ...") that carries no error code and no `structuredContent`. Every GCR error must carry an explicit code
 *    in the same envelope as a success (`INVALID_ARGUMENT` here), so after the tools are registered (they are still
 *    registered with the SDK: that is what drives `tools/list`, schemas and capabilities) this module installs its own
 *    `tools/call` handler through the public `server.server.setRequestHandler`. It validates with the SAME strict zod object
 *    that was advertised. An unknown tool is a JSON-RPC error (-32602), which is what the protocol prescribes for it.
 *  - The SDK's own guard against hostile argument sizes (`maxToolInputElements`) lives in the handler that this module replaces,
 *    so it is re-implemented here: BEFORE zod looks at the arguments, their total number of values is bounded
 *    (`MAX_INPUT_ELEMENTS`). Without it a few megabytes of JSON (a million bad array elements) made zod build a million issues:
 *    seconds of blocked event loop and hundreds of megabytes of memory, for one call of a tool that takes at most ten values.
 *  - ONE error path: `GcrError` -> its envelope; anything else -> the generic INTERNAL_ERROR (raw messages can embed paths
 *    or conversation text). Only the error NAME is logged, never its message.
 *  - A server-side deadline per call (`AbortSignal.any([client signal, deadline signal])`, its timer cleared when the call ends), because the SDK has none
 *    and the client default is 60 s. Cancellation is cooperative: a client abort or timeout only flips `ctx.signal`. Work that
 *    is synchronous (every read: node:sqlite is synchronous) cannot be interrupted, so it is bounded by its input limits
 *    instead; asynchronous work (writes, imports) is awaited through `ctx.abortable`, which stops WAITING when the signal
 *    fires. The work itself keeps running to completion: a write that was started may still commit after a deadline error,
 *    and the error says so.
 *  - The size cap and truncation (`boundEnvelope`) are applied to every success.
 *  - Aliases: the same entry registered under more names (`aliases.ts`); the dispatch knows which name was used and adds a
 *    DEPRECATED_TOOL_ALIAS warning.
 *
 * The registry is per server (a WeakMap), so several servers in one process (tests) never share state.
 */
import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { CallToolRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolRequest, CallToolResult, ServerNotification, ServerRequest, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type * as z from 'zod';
import type { ResultEnvelope } from '../domain/types.js';
import { GcrError } from '../errors.js';
import type { Warning } from '../errors.js';
import { log } from '../logger.js';
import { normalizeError } from '../sdk/gcr.js';
import { boundEnvelope, errorEnvelope, mcpEnvelopeSchema, successEnvelope, toCallToolResult } from './envelope.js';
import type { McpEnvelope, Reduction } from './envelope.js';

export type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Names the protocol allows and that every client can show: letters, digits, `_`, `-`, `.`. */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * A usable tool name: a string of the allowed shape that is not a property every plain object already has (`constructor`,
 * `toString`, `__proto__`, ...). The SDK keeps its tools in a plain object and would answer such a name with an untyped
 * "already registered" Error (or, for `__proto__`, misbehave), so it is refused here with a coded error instead.
 */
export function isLegalToolName(name: unknown): name is string {
  return typeof name === 'string' && TOOL_NAME_PATTERN.test(name) && !(name in Object.prototype);
}

/** Most values (array elements and object members, at any depth) that the arguments of one call may hold. Real calls hold fewer than fifty. */
export const MAX_INPUT_ELEMENTS = 1000;

/**
 * true when `value` holds more than `max` values in total: every array element and every object member counts one, nested
 * containers count themselves and then their contents. Iterative (no recursion limit for deeply nested input) and it stops at
 * the first excess, so hostile input costs at most `max` steps whatever its size.
 */
export function exceedsElementBudget(value: unknown, max: number = MAX_INPUT_ELEMENTS): boolean {
  let budget = max;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current !== 'object' || current === null) continue;
    if (Array.isArray(current)) {
      budget -= current.length;
      if (budget < 0) return true;
      for (const item of current) if (typeof item === 'object' && item !== null) stack.push(item);
    } else {
      for (const key in current) {
        if (--budget < 0) return true;
        const member = (current as Record<string, unknown>)[key];
        if (typeof member === 'object' && member !== null) stack.push(member);
      }
    }
  }
  return false;
}

export interface ToolRuntime {
  /** Cap for the serialized envelope in bytes (see envelope.ts). */
  readonly maxResultBytes: number;
  /** Server-side deadline for tools that do not set their own. */
  readonly defaultDeadlineMs: number;
}

export interface ToolCallContext {
  /** Aborted when the client cancels or times out, or when the server-side deadline passes. */
  readonly signal: AbortSignal;
  /** Stop WAITING for `work` when the signal fires (the work itself cannot be stopped). Rejects with the signal's reason. */
  abortable<T>(work: Promise<T>): Promise<T>;
  /** Advisory progress notification; a no-op unless the client sent a progress token. Never throws. */
  reportProgress(progress: number, total?: number, message?: string): void;
}

/** A registered tool with its types erased (the table is heterogeneous). Build it with `defineTool`. */
export interface ToolEntry {
  readonly name: string;
  readonly title: string;
  /** Static text. NEVER derived from imported data. */
  readonly description: string;
  readonly input: z.ZodObject;
  readonly annotations: ToolAnnotations;
  readonly reduce: readonly Reduction[];
  readonly deadlineMs?: number;
  readonly run: (args: unknown, ctx: ToolCallContext) => Promise<ResultEnvelope<unknown>> | ResultEnvelope<unknown>;
}

export interface ToolDefinition<I extends z.ZodObject> {
  name: string;
  title: string;
  description: string;
  input: I;
  annotations: ToolAnnotations;
  reduce?: readonly Reduction[];
  deadlineMs?: number;
  run: (args: z.output<I>, ctx: ToolCallContext) => Promise<ResultEnvelope<unknown>> | ResultEnvelope<unknown>;
}

/** Erase the argument type. The cast is sound because the registry only calls `run` with the output of `input.safeParse`. */
export function defineTool<I extends z.ZodObject>(def: ToolDefinition<I>): ToolEntry {
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    input: def.input,
    annotations: def.annotations,
    reduce: def.reduce ?? [],
    ...(def.deadlineMs === undefined ? {} : { deadlineMs: def.deadlineMs }),
    run: (args, ctx) => def.run(args as z.output<I>, ctx),
  };
}

interface Registered {
  readonly entry: ToolEntry;
  readonly name: string;
  readonly canonical: string;
}

// ---------------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------------

/** Text that came from the caller, made safe to echo: bounded, control characters and line separators replaced. */
function printable(s: string, max = 64): string {
  let out = '';
  for (const ch of s.length > max ? s.slice(0, max) : s) {
    const code = ch.codePointAt(0) ?? 0;
    // C0 and C1 control characters and the Unicode line/paragraph separators (written as numbers: see stdout-guard.ts).
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 ? ' ' : ch;
  }
  return s.length > max ? `${out}...` : out;
}

function invalidArguments(tool: string, error: z.ZodError): GcrError {
  const issues = error.issues.slice(0, 10).map((issue) => ({
    path: printable(issue.path.map((p) => String(p)).join('.'), 80),
    message: printable(issue.message, 200),
  }));
  return new GcrError('INVALID_ARGUMENT', `Invalid arguments for ${tool}.`, {
    remedy: 'Read the tool inputSchema (tools/list): only the listed fields are accepted, with the listed types, bounds and enum values.',
    details: { issueCount: error.issues.length, issues },
  });
}

function tooManyElements(tool: string): GcrError {
  return new GcrError('INVALID_ARGUMENT', `The arguments for ${tool} hold too many values.`, {
    remedy: 'Send only the documented fields with short lists: no tool takes more than a few dozen values in total.',
    details: { reason: 'too_many_elements', max: MAX_INPUT_ELEMENTS },
  });
}

/** Stop waiting for `work` when `signal` fires. `work` keeps running; its late outcome is swallowed so it cannot go unhandled. */
export function abortable<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function makeContext(signal: AbortSignal, extra: Extra): ToolCallContext {
  return {
    signal,
    abortable: (work) => abortable(signal, work),
    reportProgress: (progress, total, message) => {
      const token = extra._meta?.progressToken;
      if (token === undefined || signal.aborted) return;
      extra
        .sendNotification({
          method: 'notifications/progress',
          params: { progressToken: token, progress, ...(total === undefined ? {} : { total }), ...(message === undefined ? {} : { message }) },
        })
        .catch(() => undefined); // progress is advisory: the client may already be gone
    },
  };
}

const errorName = (e: unknown): string => (e instanceof Error ? e.name : typeof e);

// ---------------------------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------------------------

export class ToolRegistry {
  readonly runtime: ToolRuntime;
  private readonly byName = new Map<string, Registered>();
  private dispatchInstalled = false;

  constructor(runtime: ToolRuntime) {
    this.runtime = runtime;
  }

  names(): string[] {
    return [...this.byName.keys()];
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** The canonical entry behind a name (an alias resolves to the same entry). */
  entryFor(name: string): ToolEntry | undefined {
    return this.byName.get(name)?.entry;
  }

  /** Register `entry` with the SDK under `name` (an alias when `canonical` differs) and make sure our dispatch is installed. */
  add(server: McpServer, entry: ToolEntry, name: string, canonical: string): void {
    if (!isLegalToolName(name)) throw new GcrError('INVALID_ARGUMENT', 'A tool name may only contain letters, digits, "_", "-" and "." (1-128 characters) and must not be a property every object has.');
    if (this.byName.has(name)) throw new GcrError('INVALID_ARGUMENT', `Tool ${name} is already registered.`);
    const alias = name !== canonical;
    const description = alias ? `${entry.description} (Deprecated alias of ${canonical}: use ${canonical}.)` : entry.description;
    // Never invoked while our dispatch is installed (it replaces the SDK's), but kept correct so removing the override
    // would still give a working server.
    const callback = (async (_args: unknown, extra: Extra): Promise<CallToolResult> => toCallToolResult(await this.execute(name, _args, extra))) as unknown as ToolCallback<z.ZodObject>;
    server.registerTool(
      name,
      { title: entry.title, description, inputSchema: entry.input, outputSchema: mcpEnvelopeSchema, annotations: { title: entry.title, ...entry.annotations } },
      callback,
    );
    this.byName.set(name, { entry, name, canonical });
    if (!this.dispatchInstalled) {
      // Must come AFTER the first registerTool: that call installs the SDK's own handler, which this replaces.
      server.server.setRequestHandler(CallToolRequestSchema, (request, extra) => this.call(request, extra));
      this.dispatchInstalled = true;
    }
  }

  /** `tools/call`: unknown tool is a protocol error; everything else is a tool result (success or error envelope). */
  async call(request: CallToolRequest, extra: Extra): Promise<CallToolResult> {
    const { name, arguments: args, task } = request.params;
    // The SDK already refuses task-augmented requests (this server has no task capability); kept in case that ever changes.
    if (task !== undefined) throw new McpError(ErrorCode.InvalidParams, 'Task-augmented tool calls are not supported by this server.');
    if (!this.byName.has(name)) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${printable(name)}`);
    return toCallToolResult(await this.execute(name, args, extra));
  }

  /** Validate, run with a deadline, bound the size, map errors. Never throws. */
  async execute(name: string, rawArgs: unknown, extra: Extra): Promise<McpEnvelope> {
    const reg = this.byName.get(name);
    if (reg === undefined) return errorEnvelope(new GcrError('INVALID_ARGUMENT', `Unknown tool: ${printable(name)}`));
    const { entry } = reg;

    let args: unknown;
    try {
      // Before zod: validation allocates one issue per bad value, so the cost of a hostile call must be bounded first.
      if (exceedsElementBudget(rawArgs)) return errorEnvelope(tooManyElements(name));
      const parsed = entry.input.safeParse(rawArgs ?? {});
      if (!parsed.success) return errorEnvelope(invalidArguments(name, parsed.error));
      args = parsed.data;
    } catch (e) {
      return errorEnvelope(this.internal(name, e));
    }

    const deadlineMs = entry.deadlineMs ?? this.runtime.defaultDeadlineMs;
    // Not AbortSignal.timeout(): that timer cannot be cancelled, so every finished call would keep its signal alive for the whole
    // deadline (about 2.8 KB each, hundreds of megabytes for a client that floods the server). This one is cleared in `finally`.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new DOMException('The tool call exceeded its deadline.', 'TimeoutError')), deadlineMs);
    timer.unref();
    const signal = AbortSignal.any([extra.signal, deadline.signal]);
    try {
      signal.throwIfAborted();
      const result = await entry.run(args, makeContext(signal, extra));
      const aliasNote: Warning[] =
        reg.name === reg.canonical
          ? []
          : [{ code: 'DEPRECATED_TOOL_ALIAS', message: `The tool name ${reg.name} is a deprecated alias of ${reg.canonical}; use ${reg.canonical}.` }];
      return boundEnvelope(successEnvelope(result, aliasNote), entry.reduce, this.runtime.maxResultBytes);
    } catch (e) {
      // A real, coded failure that happened to coincide with the deadline is still reported as itself. It obeys the size cap
      // like a success: details can quote ids from the data (the branch ids of ACTIVE_BRANCH_UNKNOWN, the candidates of
      // AMBIGUOUS_CONVERSATION) and a remedy is free text, so an unbounded error could close the connection (transport buffer).
      if (e instanceof GcrError) return boundEnvelope(errorEnvelope(e), [], this.runtime.maxResultBytes);
      if (signal.aborted && !extra.signal.aborted) {
        return errorEnvelope(
          new GcrError('INTERNAL_ERROR', `The tool call exceeded its server-side deadline of ${deadlineMs} ms.`, {
            remedy: 'Retry with a narrower request. A write that was already started may still complete in the background: check the outcome (for example with gcr_list) before repeating it.',
            details: { reason: 'deadline_exceeded', deadlineMs },
          }),
        );
      }
      if (extra.signal.aborted) {
        // The SDK drops the response of a cancelled request; this envelope only keeps the function total.
        return errorEnvelope(new GcrError('INTERNAL_ERROR', 'The call was cancelled by the client.', { details: { reason: 'cancelled' } }));
      }
      return errorEnvelope(this.internal(name, e));
    } finally {
      clearTimeout(timer);
    }
  }

  /** Any thrown value -> GcrError. Unknown errors are logged by NAME only (messages can hold paths or content). */
  private internal(tool: string, e: unknown): GcrError {
    const err = normalizeError(e);
    if (err.code === 'INTERNAL_ERROR') {
      log.error('mcp_tool_internal_error', { tool, cause: errorName(e) });
      log.debug('mcp_tool_internal_error_stack', { tool, stack: e instanceof Error ? (e.stack ?? '') : '' });
    }
    return err;
  }
}

const registries = new WeakMap<McpServer, ToolRegistry>();

/** The registry of `server`, created on first use with `runtime` (later calls ignore `runtime`). */
export function registryFor(server: McpServer, runtime: ToolRuntime): ToolRegistry {
  let registry = registries.get(server);
  if (registry === undefined) {
    registry = new ToolRegistry(runtime);
    registries.set(server, registry);
  }
  return registry;
}

/** The registry of `server` if tools were registered on it. */
export function existingRegistry(server: McpServer): ToolRegistry | undefined {
  return registries.get(server);
}

/** Register one tool on `server`. Exported for tests that add a purpose-built tool (a slow one) next to the real set. */
export function registerToolEntry(server: McpServer, entry: ToolEntry, runtime: ToolRuntime): void {
  registryFor(server, runtime).add(server, entry, entry.name, entry.name);
}
