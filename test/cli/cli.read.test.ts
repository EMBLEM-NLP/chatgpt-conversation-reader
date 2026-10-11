/**
 * Happy paths of every read command in every output format, against a real database built by `gcr import` from a
 * synthetic export. Each run is a child process; stdout is validated as what it claims to be (JSON parses, every JSONL line
 * parses, Markdown/compact documents have their header) and stderr must be EMPTY.
 */
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { before, describe, it } from 'node:test';
import { FORMATS, ID, arr, assertOk, envelope, gcr, obj, parseJsonl, templateDb } from './cli.helpers.test.js';
import type { Envelope, Format, Obj, StandardExport } from './cli.helpers.test.js';

let dbPath = '';
let std: StandardExport;

before(async () => {
  ({ dbPath, std } = await templateDb());
});

/** Run in one format, assert success and a well-formed document of that format; return stdout. */
async function run(args: string[], format: Format, extra: string[] = []): Promise<string> {
  const r = await gcr([...args, '--db', dbPath, '--format', format, ...extra]);
  assertOk(r, `gcr ${args.join(' ')} --format ${format}`);
  switch (format) {
    case 'json':
      envelope(r.stdout);
      assert.ok(r.stdout.endsWith('\n'));
      break;
    case 'jsonl': {
      const lines = parseJsonl(r.stdout);
      assert.equal(lines[0]?.['type'], 'header');
      assert.equal(lines.at(-1)?.['type'], 'footer');
      break;
    }
    case 'markdown':
    case 'compact':
      assert.ok(r.stdout.startsWith('# '), `${format} output starts with a title line: ${r.stdout.slice(0, 40)}`);
      assert.ok(r.stdout.endsWith('\n'));
      break;
  }
  return r.stdout;
}

async function json(args: string[], extra: string[] = []): Promise<Envelope> {
  return envelope(await run(args, 'json', extra));
}

/** Run in all four formats (each validated by `run`) and return them keyed by format. */
async function everyFormat(args: string[], extra: string[] = []): Promise<Record<Format, string>> {
  const out = {} as Record<Format, string>;
  for (const f of FORMATS) out[f] = await run(args, f, extra);
  return out;
}

const items = (env: Envelope): Obj[] => arr(env.data['items']);
const messages = (env: Envelope): Obj[] => arr(env.data['messages']);
const conversationIds = (env: Envelope): unknown[] => items(env).map((i) => i['conversationId']);
const hitKey = (h: Obj): string => `${String(h['conversationId'])}/${String(h['messageId'])}`;

describe('list', () => {
  it('lists every conversation once, in all formats', async () => {
    const o = await everyFormat(['list']);
    const env = envelope(o.json);
    assert.equal(items(env).length, 5);
    assert.equal(env.data['total'], 5);
    assert.deepEqual(new Set(conversationIds(env)), new Set([ID.linear, ID.branched, ID.noPointer, ID.hidden, ID.hostile]));
    assert.ok(o.markdown.includes(ID.linear) && o.compact.includes(ID.linear));
    assert.equal(parseJsonl(o.jsonl).filter((l) => l['type'] === 'item').length, 5);
  });

  it('--sort title orders by title; --title-query filters; --limit/--offset page', async () => {
    const byTitle = await json(['list'], ['--sort', 'title']);
    const titles = items(byTitle).map((i) => String(i['title']));
    assert.deepEqual(titles, [...titles].sort());
    const q = await json(['list'], ['--title-query', 'alpha']);
    assert.deepEqual(conversationIds(q), [ID.linear]);
    const page = await json(['list'], ['--sort', 'title', '--limit', '2', '--offset', '1']);
    assert.equal(items(page).length, 2);
    assert.equal(page.data['offset'], 1);
    assert.equal(page.data['nextOffset'], 3);
    assert.equal(page.data['total'], 5);
    assert.equal(items(await json(['list'], ['--sort', 'created'])).length, 5);
    const none = await json(['list'], ['--provider', 'claude']);
    assert.equal(items(none).length, 0);
    assert.equal(none.completeness, 'unknown', 'an empty result says nothing about completeness');
    assert.equal(none.warnings[0]?.code, 'SOURCE_NOT_FULL_HISTORY');
  });

  it('--tz changes the human formats but not the JSON timestamps', async () => {
    const utc = await run(['list'], 'markdown');
    const kolkata = await run(['list'], 'markdown', ['--tz', 'Asia/Kolkata']);
    assert.ok(utc.includes('UTC+00:00'));
    assert.ok(kolkata.includes('UTC+05:30'), kolkata);
    assert.equal(await run(['list'], 'json'), await run(['list'], 'json', ['--tz', 'Asia/Kolkata']), 'JSON is UTC whatever --tz says');
  });

  it('lists every snapshot with --all-batches', async () => {
    assert.equal(items(await json(['list'], ['--all-batches'])).length, 5);
  });
});

describe('get and thread', () => {
  it('prints a linear conversation in all formats', async () => {
    const o = await everyFormat(['get', ID.linear]);
    const env = envelope(o.json);
    assert.equal(obj(env.data['conversation'])['conversationId'], ID.linear);
    assert.equal(env.data['selectionPolicy'], 'source_current_node');
    assert.deepEqual(messages(env).map((m) => m['authorRole']), ['user', 'assistant', 'user', 'assistant']);
    assert.equal(messages(env)[0]?.['text'], 'tell me about the quokka habitat');
    assert.ok(o.markdown.includes('tell me about the quokka habitat'));
    assert.ok(o.compact.includes('[assistant'));
    assert.equal(parseJsonl(o.jsonl).filter((l) => l['type'] === 'message').length, 4);
  });

  it('accepts an exact chatgpt.com link as a lookup key (query and fragment ignored, case-insensitive host)', async () => {
    const a = await json(['get', `https://chatgpt.com/c/${ID.linear}`]);
    assert.equal(obj(a.data['conversation'])['conversationId'], ID.linear);
    const b = await json(['get', `HTTPS://ChatGPT.com/c/${ID.linear.toUpperCase()}/?x=1#frag`]);
    assert.equal(obj(b.data['conversation'])['conversationId'], ID.linear);
  });

  it('chooses the branch the export names, and reports how it was chosen', async () => {
    const env = await json(['get', ID.branched]);
    assert.equal(env.data['selectionPolicy'], 'source_current_node');
    assert.equal(env.data['branchId'], std.branched.a2b);
    assert.equal(messages(env).at(-1)?.['text'], 'answer two regenerated');
    assert.equal(env.data['activeness'], 'active');
  });

  it('--branch picks another branch explicitly', async () => {
    const env = await json(['get', ID.branched], ['--branch', std.branched.a1e]);
    assert.equal(env.data['selectionPolicy'], 'explicit_branch');
    assert.equal(messages(env).at(-1)?.['text'], 'answer to the edited prompt');
    const t = await json(['thread', ID.branched], ['--branch', std.branched.a2]);
    assert.equal(messages(t).at(-1)?.['text'], 'answer two original');
  });

  it('--all-branches: one JSON document with a thread per branch; text formats print every branch', async () => {
    const o = await everyFormat(['get', ID.branched], ['--all-branches']);
    const env = envelope(o.json);
    assert.equal(arr(env.data['threads']).length, 3);
    assert.equal(obj(env.data['thread'])['branchId'], std.branched.a2b);
    for (const text of ['answer two original', 'answer two regenerated', 'answer to the edited prompt']) {
      assert.ok(o.markdown.includes(text), `markdown has ${text}`);
      assert.ok(o.compact.includes(text), `compact has ${text}`);
      assert.ok(o.jsonl.includes(text), `jsonl has ${text}`);
    }
    // jsonl is a concatenation of one header-led document per branch, every line valid JSON
    assert.equal(parseJsonl(o.jsonl).filter((l) => l['type'] === 'header').length, 3);
  });

  it('never guesses the active branch; --branch-policy is an explicit, labelled opt-in', async () => {
    const heuristic = await json(['get', ID.noPointer], ['--branch-policy', 'last_child']);
    assert.equal(heuristic.data['selectionPolicy'], 'last_child');
    assert.ok(heuristic.warnings.some((w) => w.code === 'ACTIVE_BRANCH_HEURISTIC'));
    const latest = await json(['thread', ID.noPointer], ['--branch-policy', 'latest_leaf']);
    assert.equal(latest.data['selectionPolicy'], 'latest_leaf');
    assert.ok(latest.warnings.some((w) => w.code === 'ACTIVE_BRANCH_HEURISTIC'));
    const all = await json(['get', ID.noPointer], ['--all-branches']);
    assert.equal(all.data['thread'], null);
    assert.equal(arr(all.data['threads']).length, 3);
    assert.ok(all.warnings.some((w) => w.code === 'ACTIVE_BRANCH_UNKNOWN'));
    for (const f of ['markdown', 'compact', 'jsonl'] as const) await run(['get', ID.noPointer], f, ['--all-branches']);
  });

  it('hides hidden messages and says how many; --include-hidden shows them', async () => {
    const plain = await json(['get', ID.hidden]);
    assert.equal(plain.data['omittedHidden'], 1);
    assert.equal(JSON.stringify(plain).includes('secret scaffold zebra'), false);
    const shown = await json(['get', ID.hidden], ['--include-hidden']);
    assert.ok(JSON.stringify(shown).includes('secret scaffold zebra'));
    assert.equal(shown.data['omittedHidden'], 0);
    const md = await run(['thread', ID.hidden], 'markdown', ['--include-hidden']);
    assert.ok(md.includes('secret scaffold zebra'));
    assert.ok(md.toLowerCase().includes('hidden'));
  });

  it('--batch pins an import snapshot', async () => {
    const batches = await json(['batches']);
    const batchId = String(arr(batches.data)[0]?.['batchId']);
    const env = await json(['get', ID.linear], ['--batch', batchId]);
    assert.equal(obj(env.data['conversation'])['batchId'], batchId);
  });

  it('shows the source and completeness of what it prints', async () => {
    const env = await json(['get', ID.linear]);
    assert.equal(env.completeness, 'exported_tree');
    assert.equal(env.source.length, 1);
    assert.equal(env.source[0]?.['provenance'], 'official_chatgpt_export');
    assert.equal(env.untrustedContent, true);
    const md = await run(['get', ID.noPointer], 'markdown', ['--branch', std.noPointerLeaves[0] ?? '']);
    assert.ok(md.includes('NOTICE'), 'a conversation whose completeness is lowered is flagged');
  });
});

describe('branches', () => {
  it('lists every branch with its activeness', async () => {
    const o = await everyFormat(['branches', ID.branched]);
    const env = envelope(o.json);
    const branches = arr(env.data['branches']);
    assert.equal(branches.length, 3);
    assert.equal(env.data['activeBranchId'], std.branched.a2b);
    assert.deepEqual(branches.filter((b) => b['activeness'] === 'active').map((b) => b['branchId']), [std.branched.a2b]);
    assert.ok(o.markdown.includes(std.branched.a1e));
    assert.equal(parseJsonl(o.jsonl).filter((l) => l['type'] === 'branch').length, 3);
  });

  it('says plainly when the active branch is unknown', async () => {
    const env = await json(['branches', ID.noPointer]);
    assert.equal(env.data['activeBranchId'], null);
    assert.ok(env.warnings.some((w) => w.code === 'NO_CURRENT_NODE'));
    assert.ok((await run(['branches', ID.noPointer], 'markdown')).includes('unknown'));
  });
});

describe('search', () => {
  it('finds messages with snippets in every format', async () => {
    const o = await everyFormat(['search', 'quokka']);
    const env = envelope(o.json);
    assert.ok(items(env).length >= 4);
    const hit = items(env)[0] ?? {};
    assert.equal(typeof hit['snippet'], 'string');
    assert.equal(String(hit['snippet']).includes('\u0001'), false, 'match markers never reach the output');
    assert.ok(Array.isArray(hit['snippetMatches']));
    assert.ok(o.compact.includes('[[quokka]]'));
    assert.ok(o.markdown.includes('**quokka**'));
  });

  it('plain mode treats operators as words; --raw passes FTS5 syntax through', async () => {
    assert.equal(items(await json(['search', 'quokka OR marsupial'])).length, 0, 'plain mode: all three words must occur');
    assert.ok(items(await json(['search', 'quokka OR marsupial'], ['--raw'])).length >= 5);
    assert.ok(items(await json(['search', 'quok*'])).length >= 4);
  });

  it('filters: role, channel, has-model, conversation, time range', async () => {
    const assistant = await json(['search', 'quokka'], ['--role', 'assistant']);
    assert.ok(items(assistant).length > 0 && items(assistant).every((h) => h['authorRole'] === 'assistant'));
    const final = await json(['search', 'quokka'], ['--channel', 'final']);
    assert.ok(items(final).length > 0 && items(final).every((h) => h['channel'] === 'final'));
    const withModel = await json(['search', 'quokka'], ['--has-model']);
    assert.ok(items(withModel).length > 0 && items(withModel).every((h) => h['modelSlug'] !== null));
    const inConv = await json(['search', 'quokka'], ['--conversation', `https://chatgpt.com/c/${ID.linear}`]);
    assert.ok(items(inConv).length > 0 && items(inConv).every((h) => h['conversationId'] === ID.linear));
    const byId = await json(['search', 'quokka'], ['--conversation', ID.branched]);
    assert.ok(items(byId).length > 0 && items(byId).every((h) => h['conversationId'] === ID.branched));
    assert.equal(items(await json(['search', 'quokka'], ['--after', '2100-01-01T00:00:00Z'])).length, 0);
    assert.ok(items(await json(['search', 'quokka'], ['--before', '2100-01-01T00:00:00Z'])).length >= 4);
  });

  it('hidden messages are skipped unless --include-hidden', async () => {
    assert.equal(items(await json(['search', 'zebra'])).length, 0);
    const shown = await json(['search', 'zebra'], ['--include-hidden']);
    assert.equal(items(shown).length, 1);
    assert.equal(items(shown)[0]?.['hidden'], true);
  });

  it('pages with --limit/--offset and with a keyset cursor, without repeats', async () => {
    const all = await json(['search', 'quokka'], ['--limit', '200']);
    const keys = items(all).map(hitKey);
    assert.ok(keys.length >= 4);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const page: Envelope = await json(['search', 'quokka'], ['--limit', '2', ...(cursor === null ? [] : ['--cursor', cursor])]);
      for (const h of items(page)) seen.push(hitKey(h));
      cursor = page.data['nextCursor'] as string | null;
      if (cursor === null) break;
    }
    assert.deepEqual(seen, keys, 'cursor paging yields the same sequence');
    const offset = await json(['search', 'quokka'], ['--limit', '2', '--offset', '2']);
    assert.deepEqual(items(offset).map(hitKey), keys.slice(2, 4));
  });

  it('--scope titles and --scope all', async () => {
    const o = await everyFormat(['search', 'alpha'], ['--scope', 'titles']);
    const titles = envelope(o.json);
    assert.equal(items(titles).length, 1);
    assert.equal(items(titles)[0]?.['kind'], 'title');
    assert.equal(items(titles)[0]?.['conversationId'], ID.linear);
    const all = await everyFormat(['search', 'quokka'], ['--scope', 'all']);
    const both = envelope(all.json);
    assert.ok(items(both).some((i) => i['kind'] === 'message'));
    assert.equal(all.json.includes('\u0001'), false, 'snippet markers are rendered as visible text');
    assert.ok(all.compact.includes('[[quokka]]'));
  });

  it('a query that starts with a dash goes after "--"', async () => {
    const r = await gcr(['search', '--db', dbPath, '--format', 'json', '--', '-nothing-matches-this']);
    assertOk(r);
    assert.equal(items(envelope(r.stdout)).length, 0);
  });

  it('--all-batches says that superseded snapshots were searched: in the JSON warnings, and as a note for human formats', async () => {
    const env = await json(['search', 'quokka'], ['--all-batches']);
    assert.ok(env.warnings.some((w) => w.code === 'SUPERSEDED_SNAPSHOTS_INCLUDED'));
    const jsonl = await run(['search', 'quokka'], 'jsonl', ['--all-batches']);
    assert.ok(jsonl.includes('SUPERSEDED_SNAPSHOTS_INCLUDED'));
    const md = await gcr(['search', 'quokka', '--all-batches', '--db', dbPath]);
    assert.equal(md.code, 0);
    assert.match(md.stderr, /^note: Superseded import snapshots were searched too/);
    const quiet = await gcr(['search', 'quokka', '--all-batches', '--db', dbPath, '--quiet']);
    assert.equal(quiet.stderr, '', '--quiet suppresses notes');
    assert.equal(quiet.stdout, md.stdout, 'the result itself is identical');
  });

  it('an empty result still carries the not-full-history warning', async () => {
    const env = await json(['search', 'nomatchwordatall']);
    assert.equal(items(env).length, 0);
    assert.equal(env.warnings[0]?.code, 'SOURCE_NOT_FULL_HISTORY');
  });
});

describe('stats', () => {
  for (const group of ['role', 'model', 'channel', 'day', 'conversation', 'provider', 'content_type']) {
    it(`--group-by ${group}`, async () => {
      const o = await everyFormat(['stats'], ['--group-by', group]);
      const env = envelope(o.json);
      assert.equal(env.data['groupBy'], group);
      assert.ok(arr(env.data['rows']).length >= 1);
      assert.ok(Number(obj(env.data['totals'])['messages']) >= 10);
      assert.equal(String(obj(env.data['modelProvenance'])['note']).includes('never inferred'), true);
    });
  }

  it('defaults to grouping by role and counts models only where the source states one', async () => {
    assert.equal((await json(['stats'])).data['groupBy'], 'role');
    const model = await json(['stats'], ['--group-by', 'model']);
    const labels = arr(model.data['rows']).map((r) => r['label']);
    assert.ok(labels.includes('unknown (not supplied by source)'));
    assert.ok(labels.includes('synthetic-model-1'));
  });

  it('--group-by day honours --tz and the filters narrow the scope', async () => {
    const day = await json(['stats'], ['--group-by', 'day', '--tz', 'Asia/Kolkata']);
    assert.equal(day.data['tz'], 'Asia/Kolkata');
    const onlyUsers = await json(['stats'], ['--group-by', 'role', '--role', 'user']);
    assert.deepEqual(arr(onlyUsers.data['rows']).map((r) => r['key']), ['user']);
    const none = await json(['stats'], ['--after', '2100-01-01T00:00:00Z']);
    assert.equal(obj(none.data['totals'])['messages'], 0);
    const limited = await json(['stats'], ['--group-by', 'conversation', '--limit', '2']);
    assert.equal(arr(limited.data['rows']).length, 2);
    assert.equal(limited.data['nextOffset'], 2);
  });
});

describe('audit', () => {
  const checks = (env: Envelope): unknown[] => arr(env.data['findings']).map((f) => f['check']);

  it('runs every check by default, in all formats', async () => {
    const o = await everyFormat(['audit']);
    const env = envelope(o.json);
    assert.deepEqual(checks(env).sort(), ['empty', 'hidden', 'missing_model', 'no_current_node', 'timestamps', 'tree_integrity', 'unknown_content_types', 'unknown_roles', 'untitled']);
    assert.ok(obj(env.data['branchProvenance']));
    assert.ok(obj(env.data['modelProvenance']));
  });

  it('flags select checks', async () => {
    assert.deepEqual(checks(await json(['audit'], ['--empty', '--untitled'])).sort(), ['empty', 'untitled']);
    const one = await json(['audit'], ['--no-current-node']);
    assert.deepEqual(checks(one), ['no_current_node']);
    const finding = arr(one.data['findings'])[0] ?? {};
    assert.equal(finding['count'], 1);
    assert.deepEqual(finding['sampleConversationIds'], [ID.noPointer]);
    const many = await json(['audit'], ['--missing-model', '--tree', '--unknown-roles', '--unknown-content-types', '--timestamps', '--hidden', '--sample', '2']);
    assert.equal(arr(many.data['findings']).length, 6);
    assert.ok(arr(many.data['findings']).every((f) => Array.isArray(f['sampleMessageIds']) && (f['sampleMessageIds'] as unknown[]).length <= 2));
  });

  it('never prints message text', async () => {
    const r = await gcr(['audit', '--db', dbPath, '--format', 'json']);
    assertOk(r);
    for (const secret of ['quokka', 'marsupial', 'zebra', 'follow up question']) assert.equal(r.stdout.includes(secret), false, `audit output contains "${secret}"`);
  });
});

describe('batches', () => {
  it('lists the import batch in all formats', async () => {
    const o = await everyFormat(['batches']);
    const rows = arr(envelope(o.json).data);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.['conversations'], 5);
    assert.equal(rows[0]?.['sourceLabel'], 'conversations.json', 'a basename, never a directory');
    for (const text of Object.values(o)) {
      assert.equal(text.includes(dbPath), false);
      assert.equal(text.includes(tmpdir()), false, 'no absolute path is printed');
    }
  });
});
