/**
 * SPEC-02 adversarial review: the first fix was proven on two conversations. This differential test runs EVERY conversation of
 * every committed synthetic fixture (ChatGPT and Claude: complete trees, broken trees, hostile strings, partial sources) through
 * `gcr get` and `gcr thread` and requires the warning CODES the CLI prints to equal the SDK's, in the same order, in the
 * json, markdown and compact formats, for the default selection and for the explicit heuristic policies. It also pins the
 * `get --all-branches` text documents (each one stands alone, starts with SOURCE_NOT_FULL_HISTORY when the source is partial
 * and lists the envelope warnings). SYNTHETIC data only.
 */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Gcr } from '../../src/sdk/gcr.js';
import type { ConversationSummary } from '../../src/domain/results.js';
import { FIXTURES, assertOk, envelope, gcr, tempDir } from './cli.helpers.test.js';

type TextFormat = 'json' | 'markdown' | 'compact';

function printedCodes(stdout: string, format: TextFormat): string[] {
  if (format === 'json') return envelope(stdout).warnings.map((w) => w.code);
  if (format === 'markdown') {
    const at = stdout.indexOf('\n## Warnings\n');
    if (at < 0) return [];
    const rest = stdout.slice(at + 1);
    const next = rest.indexOf('\n## ', 4);
    return [...(next < 0 ? rest : rest.slice(0, next)).matchAll(/^- `([A-Z][A-Z0-9_]+)`: /gm)].map((m) => m[1] as string);
  }
  const line = stdout.split('\n').find((l) => l.startsWith('# warnings: '));
  if (line === undefined) return [];
  return [...line.slice('# warnings: '.length).matchAll(/(?:^|; )([A-Z][A-Z0-9_]+): /g)].map((m) => m[1] as string);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `--stored-id` is needed for ids that are not UUIDs (a Claude fixture has one). */
const idArgs = (c: ConversationSummary): string[] => [c.conversationId, ...(UUID.test(c.conversationId) ? [] : ['--stored-id'])];

let dbPath = '';
let sdk: Gcr;
let conversations: ConversationSummary[] = [];

before(async () => {
  const dir = tempDir('gcr-spec02-adv-');
  dbPath = join(dir, 'all.sqlite');
  for (const sub of ['chatgpt', 'claude']) {
    for (const f of readdirSync(join(FIXTURES, sub)).filter((n) => n.endsWith('.json')).sort()) {
      assertOk(await gcr(['import', join(FIXTURES, sub, f), '--db', dbPath, '--format', 'json']), `import ${sub}/${f}`);
    }
  }
  sdk = Gcr.open({ dbPath, readOnly: true });
  conversations = sdk.list({ limit: 200 }).data.items;
});

after(() => {
  sdk.close();
});

/** Run `tasks` with at most `width` in flight (each task is one child process). */
async function pool<T>(items: readonly T[], width: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const i = next++;
        const item = items[i];
        if (item === undefined) return;
        await fn(item);
      }
    }),
  );
}

describe('SPEC-02 review: the CLI lists the SDK warnings for every conversation of every fixture', () => {
  it('the fixtures were imported (premise)', () => {
    assert.ok(conversations.length >= 30, `got ${conversations.length} conversations`);
    assert.ok(new Set(conversations.map((c) => c.completeness)).size >= 2, 'partial and complete sources are both present');
  });

  for (const [label, cli, opts] of [
    ['default selection', [] as string[], {}],
    ['--branch-policy last_child', ['--branch-policy', 'last_child'], { branchPolicy: 'last_child' as const }],
    ['--branch-policy latest_leaf', ['--branch-policy', 'latest_leaf'], { branchPolicy: 'latest_leaf' as const }],
  ] as const) {
    it(`get, ${label}: json, markdown and compact print exactly the SDK warning codes`, async () => {
      const failures: string[] = [];
      let compared = 0;
      await pool(conversations, 6, async (c) => {
        const ref = { conversationId: c.conversationId, provider: c.provider, accountLabel: c.accountLabel };
        let want: string[];
        try {
          const env = sdk.get(ref, opts);
          if (env.data.thread === null) return; // nothing is rendered as a thread: renderEnvelope path, covered elsewhere
          want = env.warnings.map((w) => w.code);
        } catch {
          return; // the SDK refuses (for example ACTIVE_BRANCH_UNKNOWN): the CLI refuses the same way, nothing to compare
        }
        for (const format of ['json', 'markdown', 'compact'] as const) {
          const r = await gcr(['get', ...idArgs(c), '--provider', c.provider, '--account', c.accountLabel, ...cli, '--db', dbPath, '--format', format]);
          if (r.code !== 0) {
            failures.push(`${c.conversationId} ${format}: exit ${String(r.code)} ${r.stderr.slice(0, 120)}`);
            continue;
          }
          compared++;
          const got = printedCodes(r.stdout, format);
          if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`${c.conversationId} ${format}: cli [${got.join(',')}] sdk [${want.join(',')}]`);
          if (new Set(got).size !== got.length && new Set(want).size === want.length) failures.push(`${c.conversationId} ${format}: a code is listed twice`);
        }
      });
      assert.ok(compared >= 30, `compared ${compared} documents`);
      assert.deepEqual(failures, []);
    });
  }

  it('thread --branch <first branch>: json and markdown print exactly the SDK warning codes', async () => {
    const failures: string[] = [];
    let compared = 0;
    await pool(conversations, 6, async (c) => {
      const ref = { conversationId: c.conversationId, provider: c.provider, accountLabel: c.accountLabel };
      const branch = sdk.branches(ref).data.branches[0]?.branchId;
      if (branch === undefined) return;
      const want = sdk.thread(ref, { branch }).warnings.map((w) => w.code);
      for (const format of ['json', 'markdown'] as const) {
        const r = await gcr(['thread', ...idArgs(c), '--provider', c.provider, '--account', c.accountLabel, '--branch', branch, '--db', dbPath, '--format', format]);
        if (r.code !== 0) {
          failures.push(`${c.conversationId} ${format}: exit ${String(r.code)} ${r.stderr.slice(0, 120)}`);
          continue;
        }
        compared++;
        const got = printedCodes(r.stdout, format);
        if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`${c.conversationId} ${format}: cli [${got.join(',')}] sdk [${want.join(',')}]`);
      }
    });
    assert.ok(compared >= 30, `compared ${compared} documents`);
    assert.deepEqual(failures, []);
  });
});

describe('SPEC-02 review: get --all-branches text documents', () => {
  it('every per-branch document of a partial source starts its warnings with SOURCE_NOT_FULL_HISTORY and lists the envelope warnings', async () => {
    const partial = conversations.filter((c) => c.completeness !== 'exported_tree');
    assert.ok(partial.length > 0);
    let documents = 0;
    for (const c of partial) {
      const ref = { conversationId: c.conversationId, provider: c.provider, accountLabel: c.accountLabel };
      const env = sdk.get(ref, { allBranches: true });
      if ((env.data.threads ?? []).length === 0) continue;
      const r = await gcr(['get', ...idArgs(c), '--provider', c.provider, '--account', c.accountLabel, '--all-branches', '--db', dbPath, '--format', 'compact']);
      assertOk(r, `get --all-branches ${c.conversationId}`);
      const lines = r.stdout.split('\n').filter((l) => l.startsWith('# warnings: '));
      assert.equal(lines.length, (env.data.threads ?? []).length, 'one warnings line per branch document');
      for (const line of lines) {
        documents++;
        const codes = [...line.slice('# warnings: '.length).matchAll(/(?:^|; )([A-Z][A-Z0-9_]+): /g)].map((m) => m[1] as string);
        assert.equal(codes[0], 'SOURCE_NOT_FULL_HISTORY', `${c.conversationId}: ${codes.join(',')}`);
        // The SDK envelope itself can hold one code twice with two different messages (for example two ACTIVE_BRANCH_UNKNOWN: the
        // tree analysis and the facade); the CLI shows the envelope as it is, so the lists are equal, duplicates included.
        assert.deepEqual(codes, env.warnings.map((w) => w.code), `${c.conversationId}: the document lists the envelope warnings`);
      }
    }
    assert.ok(documents > 0);
  });
});
