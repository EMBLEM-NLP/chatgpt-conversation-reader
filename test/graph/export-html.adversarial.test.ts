/**
 * Adversarial tests from an independent review of src/graph/export-html.ts (XSS / injection lens).
 *
 *  - "labels never reach markup": for any labels, ids, kinds and titles the document OUTSIDE the JSON data block is
 *    byte-identical to the document of an empty graph (checked on seeded random hostile graphs), and the JSON block can
 *    be neither closed nor opened into markup.
 *  - The REAL inline program is executed in node:vm against a small fake DOM with hostile ids, kinds and prototype-chain
 *    names (__proto__, constructor, toString ...).
 *  - "defects found by review" failed against the reviewed code before the matching fix and stay as regression tests.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { GcrError } from '../../src/errors.js';
import { exportGraphHtml } from '../../src/graph/export-html.js';
import type { GraphEdgeDto, GraphNodeDto } from '../../src/graph/query.js';

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

const PAYLOADS: readonly string[] = [
  '</script><img src=x onerror=alert(1)>',
  '</SCRIPT >',
  '<!--',
  '--><script>alert(1)</script>',
  '"><svg onload=1>',
  "'><iframe srcdoc='<script>1</script>'>",
  'javascript:alert(1)',
  'data:text/html;base64,PHNjcmlwdD4=',
  `${LS}${PS}`,
  '`${alert(1)}`',
  '{{constructor.constructor("alert(1)")()}}',
  '&lt;b&gt;&amp;#x3c;',
  '\u0000\u0001\u{FEFF}\u{202E}',
  '\ud800',
  '__proto__',
  'constructor',
  'hasOwnProperty',
  'toString',
];

function node(id: string, label: string, over: Partial<GraphNodeDto> = {}): GraphNodeDto {
  return { id, kind: 'entity', entityKind: 'keyword', label, weight: 1, communityId: null, conversation: null, ...over };
}

function edge(id: number, src: string, dst: string, kind: GraphEdgeDto['kind'] = 'co_occurs', weight = 1): GraphEdgeDto {
  return { id, src, dst, kind, weight };
}

function expectCode(code: string): (e: unknown) => boolean {
  return (e) => e instanceof GcrError && e.code === code;
}

const JSON_BLOCK = /<script type="application\/json" id="graph-data">([\s\S]*?)<\/script>/;

function jsonBlock(html: string): string {
  const m = JSON_BLOCK.exec(html);
  assert.ok(m !== null, 'JSON data block present');
  return m[1] as string;
}

function withoutData(html: string): string {
  return html.replace(JSON_BLOCK, '<script type="application/json" id="graph-data"></script>');
}

// ---------------------------------------------------------------------------------------------------------------------
// Seeded random hostile graphs
// ---------------------------------------------------------------------------------------------------------------------

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hostileString(rnd: () => number): string {
  const n = 1 + Math.floor(rnd() * 4);
  let s = '';
  for (let i = 0; i < n; i++) s += rnd() < 0.7 ? (PAYLOADS[Math.floor(rnd() * PAYLOADS.length)] as string) : String.fromCharCode(32 + Math.floor(rnd() * 200));
  return s;
}

function hostileGraph(seed: number): { nodes: GraphNodeDto[]; edges: GraphEdgeDto[]; title: string } {
  const rnd = prng(seed);
  const count = 1 + Math.floor(rnd() * 12);
  const nodes: GraphNodeDto[] = [];
  for (let i = 0; i < count; i++) {
    nodes.push(
      node(`${hostileString(rnd)}#${i}`, hostileString(rnd), {
        kind: (['entity', 'conversation', 'tool'] as const)[Math.floor(rnd() * 3)] as GraphNodeDto['kind'],
        entityKind: rnd() < 0.3 ? null : (hostileString(rnd) as GraphNodeDto['entityKind']),
        weight: rnd() * 100,
        communityId: rnd() < 0.3 ? null : Math.floor(rnd() * 20),
      }),
    );
  }
  const edges: GraphEdgeDto[] = [];
  const edgeCount = Math.floor(rnd() * count * 2);
  for (let e = 0; e < edgeCount; e++) {
    const a = nodes[Math.floor(rnd() * count)] as GraphNodeDto;
    const b = nodes[Math.floor(rnd() * count)] as GraphNodeDto;
    edges.push(edge(e + 1, a.id, b.id, hostileString(rnd) as GraphEdgeDto['kind'], rnd() * 10));
  }
  return { nodes, edges, title: hostileString(rnd) };
}

describe('labels, ids, kinds and titles never reach markup', () => {
  const empty = exportGraphHtml({ nodes: [], edges: [] });

  it('the document outside the JSON block is byte-identical for every hostile graph (200 seeded cases)', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const g = hostileGraph(seed);
      const html = exportGraphHtml(g, { title: g.title.slice(0, 200) || 'x' });
      assert.equal(withoutData(html), withoutData(empty), `seed ${seed}`);
    }
  });

  it('the JSON block can be neither closed nor opened into markup, and round-trips every string exactly', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const g = hostileGraph(seed);
      const title = g.title.slice(0, 200) || 'x';
      const html = exportGraphHtml(g, { title });
      const block = jsonBlock(html);
      assert.equal(/[<>&\u{2028}\u{2029}]/u.test(block), false, `raw markup character in the JSON block, seed ${seed}`);
      assert.equal((html.match(/<script\b/gi) ?? []).length, 2, `script openings, seed ${seed}`);
      assert.equal((html.match(/<\/script/gi) ?? []).length, 2, `script closings, seed ${seed}`);
      const data = JSON.parse(block) as { title: string; nodes: Array<{ id: string; kind: string; entityKind: string | null; label: string }> };
      assert.equal(data.title, title);
      const seen = new Set<string>();
      const expected = g.nodes.filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)));
      assert.deepEqual(
        data.nodes.map((n) => [n.id, n.kind, n.entityKind, n.label]),
        expected.map((n) => [n.id, n.kind, n.entityKind, n.label]),
        `seed ${seed}`,
      );
    }
  });

  it('the CSP is one tag with exactly the expected directives, and the only external-looking text is inside the JSON block', () => {
    const g = hostileGraph(7);
    const html = exportGraphHtml(g, { title: 'x' });
    const metas = [...html.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)">/g)];
    assert.equal(metas.length, 1);
    const policy = metas[0]?.[1] as string;
    const directives = policy.split('; ').map((d) => d.split(' ')[0]);
    assert.deepEqual(directives, ['default-src', 'img-src', 'style-src', 'script-src', 'base-uri', 'form-action', 'require-trusted-types-for']);
    assert.match(policy, /^default-src 'none'; img-src data:; style-src 'sha256-[A-Za-z0-9+/]+=*'; script-src 'sha256-[A-Za-z0-9+/]+=*'; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'$/);
    for (const forbidden of ['unsafe-inline', 'unsafe-eval', "'self'", 'https:', 'http:', '*', 'blob:', 'strict-dynamic']) assert.equal(policy.includes(forbidden), false, forbidden);
    const markup = withoutData(html).replace(/<style>[\s\S]*?<\/style>/, '').replace(/<script>[\s\S]*?<\/script>/, '');
    assert.deepEqual([...markup.matchAll(/\b(?:href|src|action|formaction|srcdoc|poster|data)\s*=\s*"([^"]*)"/gi)].map((m) => m[1]).filter((v) => !(v as string).startsWith('#')), []);
    assert.equal(/\bon[a-z]+\s*=/i.test(markup), false);
    assert.equal(/https?:\/\//i.test(markup + policy), false);
  });

  it('the script hash in the CSP is the hash of the program that is actually in the page, for hostile data too', () => {
    const html = exportGraphHtml(hostileGraph(11), { title: '</title>' });
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1);
    const hash = `'sha256-${createHash('sha256').update(scripts[0]?.[1] as string, 'utf8').digest('base64')}'`;
    assert.ok(html.includes(`script-src ${hash}`));
    const style = /<style>([\s\S]*?)<\/style>/.exec(html);
    assert.ok(html.includes(`style-src 'sha256-${createHash('sha256').update(style?.[1] as string, 'utf8').digest('base64')}'`));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Executing the real program in a fake DOM
// ---------------------------------------------------------------------------------------------------------------------

type Listener = (ev: { key?: string; preventDefault: () => void }) => void;

class FakeElement {
  readonly attrs = new Map<string, string>();
  readonly children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  hidden = false;
  value = '';
  open = false;
  readonly tagName: string;
  readonly namespaceURI: string;
  private ownText = '';
  private readonly listeners = new Map<string, Listener[]>();
  private readonly doc: FakeDocument;

  constructor(doc: FakeDocument, tagName: string, namespaceURI: string) {
    this.doc = doc;
    this.tagName = tagName;
    this.namespaceURI = namespaceURI;
  }

  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join('');
  }

  set textContent(v: string) {
    for (const c of this.children) c.parentNode = null;
    this.children.length = 0;
    this.ownText = String(v);
  }

  appendChild(c: FakeElement): FakeElement {
    c.parentNode = this;
    this.children.push(c);
    return c;
  }

  removeChild(c: FakeElement): FakeElement {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    c.parentNode = null;
    return c;
  }

  setAttribute(name: string, value: unknown): void {
    this.doc.calls.push({ tag: this.tagName, name, value: String(value) });
    this.attrs.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  fire(type: string, key?: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ ...(key === undefined ? {} : { key }), preventDefault: () => undefined });
  }

  focus(): void {
    this.doc.activeElement = this;
  }

  scrollIntoView(): void {
    /* not observable here */
  }

  find(pred: (e: FakeElement) => boolean): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (e: FakeElement): void => {
      for (const c of e.children) {
        if (pred(c)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  querySelector(sel: string): FakeElement | null {
    if (sel !== 'button.select') throw new Error(`fake DOM: unsupported selector ${sel}`);
    return this.find((e) => e.tagName === 'button' && (e.attrs.get('class') ?? '').split(/\s+/).includes('select'))[0] ?? null;
  }
}

class FakeDocument {
  readonly calls: Array<{ tag: string; name: string; value: string }> = [];
  readonly createdTags = new Set<string>();
  readonly byId = new Map<string, FakeElement>();
  readonly sortButtons: FakeElement[] = [];
  activeElement: FakeElement | null = null;
  title = '';

  createElement(tag: string): FakeElement {
    this.createdTags.add(tag);
    return new FakeElement(this, tag, 'html');
  }

  createElementNS(ns: string, tag: string): FakeElement {
    this.createdTags.add(tag);
    return new FakeElement(this, tag, ns);
  }

  getElementById(id: string): FakeElement | null {
    return this.byId.get(id) ?? null;
  }

  querySelectorAll(sel: string): FakeElement[] {
    if (sel !== 'thead button[data-sort]') throw new Error(`fake DOM: unsupported selector ${sel}`);
    return this.sortButtons;
  }

  add(id: string, tag: string, ns = 'html'): FakeElement {
    const e = new FakeElement(this, tag, ns);
    this.byId.set(id, e);
    return e;
  }
}

interface Page {
  doc: FakeDocument;
  el: (id: string) => FakeElement;
  rows: () => FakeElement[];
}

function boot(html: string): Page {
  const program = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
  const doc = new FakeDocument();
  for (const [id, tag] of [
    ['result-count', 'p'], ['live', 'div'], ['filter-text', 'input'], ['filter-kind', 'select'], ['node-body', 'tbody'], ['show-more', 'button'],
    ['selected-panel', 'div'], ['overview-count', 'span'], ['page-title', 'h1'], ['filter-clear', 'button'],
  ] as const) doc.add(id, tag);
  doc.add('overview', 'svg', 'fake-svg-namespace');
  doc.add('graph-data', 'script').textContent = jsonBlock(html);
  for (const key of ['label', 'kind', 'community', 'weight', 'degree']) {
    const b = new FakeElement(doc, 'button', 'html');
    b.attrs.set('data-sort', key);
    b.textContent = key;
    const th = new FakeElement(doc, 'th', 'html');
    th.appendChild(b);
    doc.sortButtons.push(b);
  }
  doc.calls.length = 0;
  vm.runInNewContext(program, { document: doc, window: { matchMedia: () => ({ matches: false }) } }, { timeout: 5000 });
  return { doc, el: (id) => doc.byId.get(id) as FakeElement, rows: () => (doc.byId.get('node-body') as FakeElement).children };
}

function search(page: Page, text: string): FakeElement[] {
  const input = page.el('filter-text');
  input.value = text;
  input.fire('input');
  return page.rows();
}

function rowLabels(rows: FakeElement[]): string[] {
  return rows.map((r) => (r.querySelector('button.select') as FakeElement | null)?.textContent ?? '');
}

describe('defects found by review: the search box matched the text "null" on every conversation node', () => {
  // The search haystack was built with String(entityKind); conversation nodes have entityKind null, so every one of them
  // contained the word "null" and a search for it listed all conversations.
  const graph = {
    nodes: [
      node('conv:chatgpt:default:c1', 'Alpha talk', { kind: 'conversation', entityKind: null }),
      node('conv:chatgpt:default:c2', 'Beta talk', { kind: 'conversation', entityKind: null }),
      node('ent:keyword:zebra', 'zebra'),
      node('tool:python', 'python', { kind: 'tool', entityKind: 'tool' }),
    ],
    edges: [edge(1, 'ent:keyword:zebra', 'conv:chatgpt:default:c1', 'mentioned_in')],
  };

  it('searching for "null" or "undefined" finds nothing; searching for real words still works', () => {
    const page = boot(exportGraphHtml(graph));
    assert.equal(page.rows().length, 4);
    for (const q of ['null', 'NULL', 'undefined']) {
      const rows = search(page, q);
      assert.equal(rows.length, 1, q);
      assert.match(rows[0]?.textContent ?? '', /No node matches the current filters\./, q);
    }
    assert.deepEqual(rowLabels(search(page, 'alpha')), ['Alpha talk']);
    assert.deepEqual(rowLabels(search(page, 'zebra')), ['zebra']);
  });

  it('kind words still match through the kind fields', () => {
    const page = boot(exportGraphHtml(graph));
    assert.deepEqual(rowLabels(search(page, 'conversation')).sort(), ['Alpha talk', 'Beta talk']);
    assert.deepEqual(rowLabels(search(page, 'keyword')), ['zebra']);
    assert.deepEqual(rowLabels(search(page, 'tool')), ['python']);
    assert.deepEqual(rowLabels(search(page, 'tool:py')), ['python'], 'ids are searchable too');
  });

  it('a node whose label really contains "null" is still found', () => {
    const page = boot(exportGraphHtml({ nodes: [node('ent:keyword:n', 'nullable pointer'), node('conv:chatgpt:default:c', 'Other', { kind: 'conversation', entityKind: null })], edges: [] }));
    assert.deepEqual(rowLabels(search(page, 'null')), ['nullable pointer']);
  });
});

describe('the inline program with hostile ids, kinds and prototype-chain names', () => {
  const names = ['__proto__', 'constructor', 'hasOwnProperty', 'toString', 'valueOf', '__defineGetter__'];
  const nodes: GraphNodeDto[] = names.map((n, i) =>
    node(`id-${n}`, n, {
      kind: n as GraphNodeDto['kind'],
      entityKind: n as GraphNodeDto['entityKind'],
      communityId: i,
    }),
  );
  nodes.push(node('plain', 'plain'));
  const edges = names.map((n, i) => edge(i + 1, `id-${n}`, i + 1 < names.length ? `id-${names[i + 1] as string}` : 'plain', n as GraphEdgeDto['kind'], i + 1));
  edges.push(edge(99, 'plain', 'plain', 'co_occurs', 3)); // a self loop

  it('renders every node, never reads inherited properties, and uses only allow-listed elements and attributes', () => {
    const html = exportGraphHtml({ nodes, edges });
    const page = boot(html);
    assert.equal(page.rows().length, nodes.length);
    // Kind cells fall back to the generic word instead of "function Object() ..." or similar.
    for (const row of page.rows()) {
      const kindCell = row.children[1]?.textContent ?? '';
      assert.ok(['node', 'keyword'].includes(kindCell), `kind cell: ${kindCell}`);
    }
    // Open every neighbour list and select every node so all code paths run.
    for (const row of page.rows()) {
      const details = row.children[5]?.children[0];
      if (details !== undefined && details.tagName === 'details') {
        details.open = true;
        details.fire('toggle');
      }
    }
    for (const row of [...page.rows()]) (row.querySelector('button.select') as FakeElement).fire('click');
    page.doc.sortButtons[3]?.fire('click');
    const allowed = new Set(['tr', 'th', 'td', 'button', 'details', 'summary', 'ul', 'li', 'span', 'p', 'h3', 'h4', 'dl', 'dt', 'dd', 'line', 'g', 'rect', 'polygon', 'circle', 'title', 'text']);
    for (const t of page.doc.createdTags) assert.ok(allowed.has(t), `unexpected element <${t}>`);
    for (const c of page.doc.calls) {
      assert.ok(!/^on/.test(c.name) && c.name !== 'style' && c.name !== 'href' && c.name !== 'src' && c.name !== 'srcdoc', `unexpected attribute ${c.name}`);
      if (!['aria-label', 'class'].includes(c.name)) for (const n of names) assert.notEqual(c.value, n, `${c.name} carries data`);
      if (c.name === 'class') assert.match(c.value, /^(nd c[0-7]( sel)?|edge( e-ref)?|lbl|shape|nb|nb-btn|meta|select|num|props)?$/, c.value);
    }
  });

  it('an attacker-chosen community number can only produce one of the eight fixed colour classes', () => {
    const odd = [1e21, -1, 7.9, Number.MAX_SAFE_INTEGER, 8].map((c, i) => node(`n${i}`, `n${i}`, { communityId: c }));
    const page = boot(exportGraphHtml({ nodes: odd, edges: [] }));
    assert.equal(page.rows().length, 5);
    for (const c of page.doc.calls.filter((x) => x.name === 'class' && x.tag === 'g')) assert.match(c.value, /^nd c[0-7]( sel)?$/);
  });

  it('self loops, repeated edges and edges between duplicate ids do not break the page', () => {
    const a = node('a', 'a');
    const b = node('b', 'b');
    const page = boot(exportGraphHtml({ nodes: [a, b, { ...a, label: 'a again' }], edges: [edge(1, 'a', 'a'), edge(2, 'a', 'b'), edge(3, 'a', 'b'), edge(4, 'b', 'a', 'mentioned_in')] }));
    assert.equal(page.rows().length, 2);
    for (const row of page.rows()) (row.querySelector('button.select') as FakeElement).fire('click');
    assert.match(page.el('result-count').textContent, /Showing 2 of 2 matching nodes\. The graph has 2 nodes and 4 edges\./);
  });
});

describe('negative tests for exportGraphHtml not covered elsewhere', () => {
  it('rejects a sparse node list, non-object entries and primitives in the lists', () => {
    // eslint-disable-next-line no-sparse-arrays
    const sparse = [node('a', 'a'), , node('b', 'b')] as unknown as GraphNodeDto[];
    assert.throws(() => exportGraphHtml({ nodes: sparse, edges: [] }), expectCode('INVALID_ARGUMENT'));
    assert.throws(() => exportGraphHtml({ nodes: [5 as never], edges: [] }), expectCode('INVALID_ARGUMENT'));
    assert.throws(() => exportGraphHtml({ nodes: [], edges: ['x' as never] }), expectCode('INVALID_ARGUMENT'));
  });

  it('accepts the boundary values: a 200-character title, seed 0 and -0, the largest safe seed, 0 and 500 overview nodes', () => {
    const g = { nodes: [node('a', 'a'), node('b', 'b')], edges: [edge(1, 'a', 'b')] };
    for (const o of [{ title: 'x'.repeat(200) }, { layoutSeed: 0 }, { layoutSeed: -0 }, { layoutSeed: Number.MAX_SAFE_INTEGER }, { layoutSeed: -Number.MAX_SAFE_INTEGER }, { maxOverviewNodes: 0 }, { maxOverviewNodes: 500 }]) {
      assert.doesNotThrow(() => exportGraphHtml(g, o), JSON.stringify(o));
    }
    assert.throws(() => exportGraphHtml(g, { layoutSeed: Number.MAX_SAFE_INTEGER + 1 }), expectCode('INVALID_ARGUMENT'));
    assert.throws(() => exportGraphHtml(g, { maxOverviewNodes: 'all' as never }), expectCode('INVALID_ARGUMENT'));
    assert.throws(() => exportGraphHtml(g, { title: ['t'] as never }), expectCode('INVALID_ARGUMENT'));
  });

  it('error messages never echo labels, titles or ids', () => {
    const secret = 'zqx-private-label';
    const attempts: Array<() => unknown> = [
      () => exportGraphHtml({ nodes: [node(secret, secret)], edges: [] }, { title: '' }),
      () => exportGraphHtml({ nodes: [node(secret, secret)], edges: [] }, { layoutSeed: 1.5 }),
      () => exportGraphHtml({ nodes: [node(secret, secret), null as never], edges: [] }),
      () => exportGraphHtml({ nodes: Array.from({ length: 5001 }, (_, i) => node(`${secret}${i}`, secret)), edges: [] }),
    ];
    for (const attempt of attempts) {
      try {
        attempt();
        assert.fail('should have thrown');
      } catch (e) {
        assert.ok(e instanceof GcrError);
        assert.equal(JSON.stringify(e.toEnvelope()).includes(secret), false);
      }
    }
  });

  it('a graph of 1 MiB labels is embedded verbatim and still inert (no truncation, no unescaped character)', () => {
    const big = `<${'a'.repeat(1 << 20)}>`;
    const html = exportGraphHtml({ nodes: [node('a', big)], edges: [] });
    const data = JSON.parse(jsonBlock(html)) as { nodes: Array<{ label: string }> };
    assert.equal(data.nodes[0]?.label, big);
    assert.equal(/[<>]/.test(jsonBlock(html)), false);
  });
});
