/**
 * Adversarial review of the stdio shutdown path (MCP lens: "any stdout byte that is not JSON-RPC", "resource cleanup on client
 * disconnect", "unbounded memory/time").
 *
 * Defect pinned here: when stdin ended (or SIGTERM arrived) the entry closed the server and the process left through
 * `process.exit` WITHOUT waiting for stdout. Stdout is a pipe, pipe writes are asynchronous, and the pipe holds only 64 KiB:
 * every response that was already computed but not yet handed to the kernel was silently dropped (exit code 0, nothing on
 * stderr). A client that pipelines its requests and then closes stdin (the documented `printf ... | node entry.js` style, or a
 * smoke script) therefore lost answers. With many pipelined large answers the SDK transport also registers one `drain` listener
 * per blocked write and Node printed a spurious MaxListenersExceededWarning (possible memory leak) on stderr.
 *
 * The reader is made slow on purpose: the child's stdout is paused from the start, so after ~80 KiB the child blocks.
 */
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ENTRY_JS, INITIALIZED, assertOnlyJsonRpcFrames, createFixture, initializeMessage } from './mcp.helpers.test.js';
import type { Fixture } from './mcp.helpers.test.js';

interface SlowReaderChild {
  /** Everything the child wrote to stdout, in order (valid once `closed` resolved). */
  stdout: () => Buffer;
  stderr: () => string;
  send: (message: unknown) => void;
  endInput: () => void;
  /** Start reading stdout (it is paused until this is called). */
  startReading: () => void;
  signal: (s: NodeJS.Signals) => void;
  /** Resolves when the process ended AND both of its output streams are drained. */
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Resolves when the process ended (its output may not be drained yet). */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill: () => void;
}

function spawnSlowReader(dbPath: string): SlowReaderChild {
  const child = spawn(process.execPath, [ENTRY_JS, '--db', dbPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', GCR_LOG_LEVEL: 'info' },
  });
  const out: Buffer[] = [];
  let err = '';
  // The listener must exist BEFORE the pause: Node drains an unread child stdout when the child exits, and only a listener
  // keeps those bytes. Pausing makes the kernel pipe fill up, which is what a slow reader looks like to the child.
  child.stdout.on('data', (d: Buffer) => out.push(d));
  child.stdout.pause();
  child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
  child.stdin.on('error', () => undefined);
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return {
    stdout: () => Buffer.concat(out),
    stderr: () => err,
    send: (m) => void child.stdin.write(`${typeof m === 'string' ? m : JSON.stringify(m)}\n`),
    endInput: () => void child.stdin.end(),
    startReading: () => child.stdout.resume(),
    signal: (s) => void child.kill(s),
    closed,
    exited,
    kill: () => void child.kill('SIGKILL'),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait for the child, killing it (and failing) when it takes unreasonably long. */
async function within<T>(c: SlowReaderChild, promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      c.kill();
      reject(new Error(`${what}: no result within ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

describe('shutdown never drops or cuts an answer that was already computed', () => {
  let fx: Fixture;
  before(async () => {
    fx = await createFixture({ graph: false });
  });
  after(async () => {
    await fx.cleanup();
  });

  /** initialize, then `count` tools/list requests (about 64 KB each): far more than a pipe holds. */
  function sendLargeRequests(c: SlowReaderChild, count: number): void {
    c.send(initializeMessage('2025-11-25', 1));
    c.send(INITIALIZED);
    for (let i = 2; i < 2 + count; i++) c.send({ jsonrpc: '2.0', id: i, method: 'tools/list' });
  }

  for (const trigger of ['stdin end', 'SIGTERM'] as const) {
    it(`${trigger} while the reader is slow: every one of the six answers arrives as a whole frame, then exit 0`, async () => {
      const c = spawnSlowReader(fx.dbPath);
      try {
        sendLargeRequests(c, 5);
        if (trigger === 'stdin end') c.endInput();
        await sleep(500); // the child has computed everything and is blocked on a full pipe; nobody is reading
        if (trigger === 'SIGTERM') c.signal('SIGTERM');
        await sleep(300);
        c.startReading();
        const result = await within(c, c.closed, 15_000, trigger);
        assert.deepEqual(result, { code: 0, signal: null }, `${trigger}: clean exit; stderr: ${c.stderr().slice(0, 300)}`);
        const frames = assertOnlyJsonRpcFrames(c.stdout());
        assert.deepEqual(
          frames.map((f) => f['id']).sort(),
          [1, 2, 3, 4, 5, 6],
          `${trigger}: all six responses must reach the reader (got ${frames.length} frame(s) in ${c.stdout().length} bytes)`,
        );
      } finally {
        c.kill();
      }
    });
  }

  it('a reader that never reads cannot keep the server alive: it still leaves, with exit code 0, after a bounded wait', async () => {
    const c = spawnSlowReader(fx.dbPath);
    try {
      sendLargeRequests(c, 5);
      c.endInput();
      // Nobody reads while the process runs. The wait for stdout is bounded, so the process must end by itself.
      const started = Date.now();
      const result = await within(c, c.exited, 20_000, 'exit with a stuck reader');
      assert.deepEqual(result, { code: 0, signal: null });
      assert.ok(Date.now() - started < 15_000, 'the bounded flush wait is a few seconds, not unbounded');
    } finally {
      c.startReading();
      c.kill();
    }
  });

  it('pipelined answers behind a full pipe do not trigger Node\'s MaxListenersExceededWarning (one drain listener per blocked write)', async () => {
    const c = spawnSlowReader(fx.dbPath);
    try {
      c.send(initializeMessage('2025-11-25', 1));
      c.send(INITIALIZED);
      for (let i = 2; i < 42; i++) c.send({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'gcr_list', arguments: {} } });
      await sleep(500); // 40 answers of ~7 KB each are queued behind a full pipe
      c.startReading();
      // A well-behaved client: it waits for all 41 answers, then closes stdin.
      const deadline = Date.now() + 15_000;
      const completeLines = (): number => c.stdout().filter((b) => b === 0x0a).length;
      while (completeLines() < 41 && Date.now() < deadline) await sleep(25);
      c.endInput();
      const result = await within(c, c.closed, 15_000, 'pipelined');
      assert.deepEqual(result, { code: 0, signal: null });
      assert.equal(assertOnlyJsonRpcFrames(c.stdout()).length, 41);
      assert.doesNotMatch(c.stderr(), /MaxListenersExceededWarning|memory leak/i, 'the transport\'s drain listeners must not look like a leak');
    } finally {
      c.kill();
    }
  });
});
