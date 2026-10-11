/**
 * Tests for src/graph/export-html.ts.
 *
 *  1. Document security, by string / regex analysis of the generated page: exactly the expected script elements, the CSP
 *     hashes match the inline program and stylesheet, no event-handler / style / src attributes, no external URL loads,
 *     hostile labels exist ONLY inside the JSON data block (escaped), and the JSON round-trips to the exact labels. The
 *     inline program text contains none of the HTML-injection or code-evaluation sinks and only literal, allow-listed
 *     setAttribute names.
 *  2. Accessibility structure (NFR-04): landmarks, headings, table headers, labelled controls, live region, colour
 *     contrast computed from the stylesheet's own variables, reduced-motion and forced-colors support.
 *  3. Behaviour: the REAL inline program is executed in node:vm against a small fake DOM that records every attribute and
 *     element it creates, then driven through selection, neighbour buttons, filtering, sorting, paging and the diagram.
 *  4. Determinism of the precomputed layout, input validation, limits and an end-to-end run from a real database.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { openDatabase } from '../../src/db/open.js';
import { Repository } from '../../src/db/repo.js';
import type { ImportBatchMeta } from '../../src/db/repo.js';
import { GcrError } from '../../src/errors.js';
import { buildGraph } from '../../src/graph/build.js';
import { MAX_EXPORT_EDGES, MAX_EXPORT_NODES, exportGraphHtml } from '../../src/graph/export-html.js';
import { graphQuery } from '../../src/graph/query.js';
import type { GraphEdgeDto, GraphNodeDto } from '../../src/graph/query.js';
import { convo, iso, link, msg } from '../helpers/records.js';

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------------------------

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const NUL = String.fromCharCode(0);
const LONE = String.fromCharCode(0xd800);

const HOSTILE: readonly string[] = [
  '</script><img src=x onerror=alert(1)>',
  '"><svg onload=1>',
  'javascript:alert(1)',
  `line${LS}separator${PS}paragraph`,
  'back`tick ${process.exit(1)} {{7*7}}',
  '<!-- comment --><script>alert(1)</script>',
  "'+alert(1)+'",
  ']]> &amp; &lt;b&gt; %3Cscript%3E',
  `nul${NUL}byte and lone${LONE}surrogate`,
  '<iframe src="https://evil.invalid/"></iframe>',
  '',
  'plain label',
];

function node(i: number, label: string, kind: GraphNodeDto['kind'] = 'entity'): GraphNodeDto {
  const entityKind = kind === 'conversation' ? null : kind === 'tool' ? 'tool' : 'keyword';
  return {
    id: kind === 'conversation' ? `conv:chatgpt:default:n${i}` : kind === 'tool' ? `tool:n${i}` : `ent:keyword:n${i}`,
    kind,
    entityKind,
    label,
    weight: i + 1,
    communityId: i % 3 === 0 ? null : (i % 3) + 1,
    conversation: kind === 'conversation' ? { provider: 'chatgpt', accountLabel: 'default', conversationId: `n${i}` } : null,
  };
}

/** A ring of nodes plus one chord. */
function ringGraph(labels: readonly string[]): { nodes: GraphNodeDto[]; edges: GraphEdgeDto[] } {
  const kinds: GraphNodeDto['kind'][] = ['entity', 'conversation', 'tool'];
  const nodes = labels.map((l, i) => node(i, l, kinds[i % 3] as GraphNodeDto['kind']));
  const edges: GraphEdgeDto[] = nodes.map((n, i) => {
    const next = nodes[(i + 1) % nodes.length] as GraphNodeDto;
    return { id: i + 1, src: n.id, dst: next.id, kind: i % 2 === 0 ? 'co_occurs' : 'mentioned_in', weight: 1 + (i % 4) };
  });
  if (nodes.length > 4) edges.push({ id: 900, src: (nodes[0] as GraphNodeDto).id, dst: (nodes[3] as GraphNodeDto).id, kind: 'co_occurs', weight: 7 });
  return { nodes, edges };
}

interface Parts {
  html: string;
  json: string;
  program: string;
  style: string;
  scripts: Array<{ attrs: string; body: string }>;
  rest: string;
}

function parts(html: string): Parts {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].map((m) => ({ attrs: m[1] as string, body: m[2] as string }));
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1] as string);
  const json = scripts.find((s) => /type="application\/json"/.test(s.attrs))?.body ?? '';
  const program = scripts.find((s) => !/type=/.test(s.attrs))?.body ?? '';
  const rest = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '<script></script>').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '<style></style>');
  return { html, json, program, style: styles[0] ?? '', scripts, rest };
}

const b64sha = (s: string): string => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;

interface Tag {
  name: string;
  attrs: Map<string, string>;
  close: boolean;
}

function tags(markup: string): Tag[] {
  const out: Tag[] = [];
  for (const m of markup.matchAll(/<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    const attrs = new Map<string, string>();
    for (const a of (m[3] as string).matchAll(/([^\s=\/"']+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g)) {
      const raw = a[2] ?? '';
      attrs.set((a[1] as string).toLowerCase(), raw.replace(/^["']|["']$/g, ''));
    }
    out.push({ name: (m[2] as string).toLowerCase(), attrs, close: m[1] === '/' });
  }
  return out;
}

function expectCode(code: string): (e: unknown) => boolean {
  return (e) => e instanceof GcrError && e.code === code;
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. Security by document analysis
// ---------------------------------------------------------------------------------------------------------------------

describe('exportGraphHtml: document security', () => {
  const graph = ringGraph(HOSTILE);
  const html = exportGraphHtml(graph, { title: '</title><script>alert(1)</script>' });
  const p = parts(html);

  it('contains exactly two script elements: one JSON data block and one inline program', () => {
    assert.equal(p.scripts.length, 2);
    assert.match(p.scripts[0]?.attrs ?? '', /^\s*type="application\/json"\s+id="graph-data"\s*$/);
    assert.equal((p.scripts[1]?.attrs ?? 'x').trim(), '');
    assert.equal((html.match(/<script/gi) ?? []).length, 2);
    assert.equal((html.match(/<\/script/gi) ?? []).length, 2);
    assert.equal((html.match(/<style/gi) ?? []).length, 1);
  });

  it('the CSP is a meta tag whose hashes match the inline program and stylesheet exactly', () => {
    const metas = tags(p.rest).filter((t) => t.name === 'meta' && t.attrs.get('http-equiv')?.toLowerCase() === 'content-security-policy');
    assert.equal(metas.length, 1);
    const csp = new Map(
      (metas[0]?.attrs.get('content') ?? '')
        .split(';')
        .map((d) => d.trim())
        .filter((d) => d.length > 0)
        .map((d) => [d.split(/\s+/)[0] as string, d.split(/\s+/).slice(1).join(' ')] as const),
    );
    assert.equal(csp.get('default-src'), "'none'");
    assert.equal(csp.get('img-src'), 'data:');
    assert.equal(csp.get('script-src'), b64sha(p.program));
    assert.equal(csp.get('style-src'), b64sha(p.style));
    assert.equal(csp.get('base-uri'), "'none'");
    assert.equal(csp.get('form-action'), "'none'");
    const all = [...csp.values()].join(' ');
    for (const forbidden of ["'unsafe-inline'", "'unsafe-eval'", "'strict-dynamic'", '*', 'http:', 'https:', 'blob:', 'ws:']) assert.ok(!all.includes(forbidden), forbidden);
    assert.ok(!csp.has('connect-src') && !csp.has('frame-src'), 'everything else falls back to default-src none');
    // The meta tag precedes every script and style so the policy is in force before they are parsed.
    assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<style'));
    assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<script'));
  });

  it('has no event-handler, style, src, form or external-resource attributes or elements', () => {
    const all = tags(p.rest).filter((t) => !t.close);
    for (const t of all) {
      for (const [name, value] of t.attrs) {
        assert.ok(!/^on/.test(name), `${t.name} has ${name}`);
        assert.ok(!['style', 'src', 'srcdoc', 'srcset', 'formaction', 'action', 'xlink:href', 'data', 'poster', 'ping', 'background'].includes(name), `${t.name} has ${name}`);
        if (name === 'href') assert.ok(t.name === 'a' && value.startsWith('#'), `href on ${t.name}: ${value}`);
      }
    }
    const names = new Set(all.map((t) => t.name));
    for (const bad of ['link', 'img', 'iframe', 'frame', 'object', 'embed', 'form', 'base', 'audio', 'video', 'source', 'applet', 'use', 'image', 'foreignobject', 'a-script']) assert.ok(!names.has(bad), bad);
    assert.equal(tags(p.rest).filter((t) => t.name === 'meta' && t.attrs.get('http-equiv')?.toLowerCase() === 'refresh').length, 0);
    assert.ok(!/\bstyle\s*=/.test(p.rest));
    assert.ok(!/@import|url\(|expression\(|-moz-binding/i.test(p.style));
  });

  it('loads nothing from the network: no absolute URL outside the JSON data block', () => {
    const outside = html.replace(p.json, '');
    assert.ok(!/https?:\/\//i.test(outside));
    assert.ok(!/(?:^|[^a-z])(?:ftp|wss?|file|data|blob):\/\//i.test(outside));
  });

  it('hostile labels and the title exist only inside the escaped JSON data block', () => {
    const outside = html.replace(p.json, '');
    for (const label of HOSTILE) {
      if (label.length < 6) continue;
      assert.ok(!outside.includes(label), `label leaked outside JSON: ${JSON.stringify(label)}`);
    }
    assert.ok(!outside.includes('alert(1)'), 'no hostile payload fragment outside JSON');
    assert.ok(!outside.includes('</title><script>'));
    assert.match(outside, /<title>GCR graph export<\/title>/);
  });

  it('the JSON block cannot be broken out of and round-trips to the exact original strings', () => {
    assert.ok(!/[<>&]/.test(p.json));
    assert.ok(!p.json.includes(LS) && !p.json.includes(PS));
    assert.ok(!p.json.includes('</'));
    const data = JSON.parse(p.json) as { title: string; nodes: Array<{ id: string; label: string; kind: string }>; edges: unknown[] };
    assert.deepEqual(
      data.nodes.map((n) => n.label),
      HOSTILE,
    );
    assert.deepEqual(
      data.nodes.map((n) => n.id),
      graph.nodes.map((n) => n.id),
    );
    assert.equal(data.title, '</title><script>alert(1)</script>');
    assert.equal(data.edges.length, graph.edges.length);
  });

  it('the inline program is pure ASCII and contains none of the forbidden sinks', () => {
    const prog = p.program;
    assert.ok(prog.length > 1000);
    // eslint-disable-next-line no-control-regex
    assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(prog), 'ASCII only, so the hash is encoding independent');
    const forbidden: ReadonlyArray<readonly [string, RegExp]> = [
      ['innerHTML', /innerHTML/],
      ['outerHTML', /outerHTML/],
      ['insertAdjacentHTML', /insertAdjacent/i],
      ['document.write', /document\s*\.\s*write/],
      ['eval', /\beval\b/],
      ['Function constructor', /\bFunction\b/],
      ['timers', /\bset(?:Timeout|Interval|Immediate)\b/],
      ['src / href / action', /\.(?:src|href|action|srcdoc|formAction)\b|["'](?:src|href|srcdoc|action|formaction|xlink:href)["']/],
      ['style', /\.style\b|["']style["']|cssText/],
      ['navigation', /\b(?:location|history|open|navigate)\s*[.(=]/],
      ['network', /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|Worker|postMessage)\b/],
      ['dynamic import / require', /\bimport\s*\(|\brequire\s*\(/],
      ['inline handler property', /\.on[a-z]+\s*=[^=]/],
      ['storage / cookies', /\b(?:localStorage|sessionStorage|indexedDB|cookie)\b/],
      ['javascript: urls', /javascript:/i],
      ['markup in program', /<\/?script|<!--|-->/i],
      ['template literals', /`|\$\{/],
      ['range / contextual fragments', /createContextualFragment|DOMParser|execCommand/],
      ['absolute urls', /https?:\/\//i],
    ];
    for (const [name, re] of forbidden) assert.ok(!re.test(prog), `program contains ${name}`);
  });

  it('every setAttribute call uses a literal, allow-listed attribute name; elements come from literal tag names', () => {
    const allowed = new Set([
      'class', 'type', 'dir', 'scope', 'colspan', 'role', 'tabindex', 'aria-label', 'aria-pressed', 'aria-current', 'aria-hidden', 'aria-sort',
      'x', 'y', 'cx', 'cy', 'r', 'x1', 'x2', 'y1', 'y2', 'width', 'height', 'points',
    ]);
    const calls = [...p.program.matchAll(/setAttribute\(\s*([^,)]*)/g)].map((m) => (m[1] as string).trim());
    assert.ok(calls.length > 20);
    for (const arg of calls) {
      const lit = /^"([a-z0-9-]+)"$/.exec(arg);
      assert.ok(lit !== null, `non-literal attribute name: ${arg}`);
      assert.ok(allowed.has(lit?.[1] as string), `attribute not allow-listed: ${arg}`);
    }
    const createCalls = [...p.program.matchAll(/(?:createElement|createElementNS)\(\s*([^,)]*)/g)].map((m) => (m[1] as string).trim());
    assert.ok(createCalls.length >= 1);
    for (const arg of createCalls) assert.ok(/^(?:tag|ns|"[a-z0-9]+")$/.test(arg), `unexpected element creation argument: ${arg}`);
    // el(tag, ...) and make(tag) are only ever called with string literals.
    for (const m of p.program.matchAll(/\b(?:el|make)\(\s*([^,)]*)/g)) {
      if ((m[1] as string).trim() === 'tag') continue; // the helper definitions themselves
      assert.match((m[1] as string).trim(), /^"[a-z0-9]+"$/, `el/make called with ${m[1]}`);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. Accessibility structure
// ---------------------------------------------------------------------------------------------------------------------

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (c[0] as number) + 0.7152 * (c[1] as number) + 0.0722 * (c[2] as number);
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function cssVars(block: string): Map<string, string> {
  return new Map([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1] as string, m[2] as string] as const));
}

describe('exportGraphHtml: accessibility structure (NFR-04)', () => {
  const html = exportGraphHtml(ringGraph(['alpha', 'beta', 'gamma', 'delta', 'epsilon']), { title: 'Accessible graph' });
  const p = parts(html);
  const all = tags(p.rest);
  const open = all.filter((t) => !t.close);

  it('has the document language, a viewport, landmarks and one h1', () => {
    assert.match(html, /^<!DOCTYPE html>\n<html lang="en">/);
    assert.ok(open.some((t) => t.name === 'meta' && t.attrs.get('name') === 'viewport'));
    assert.equal(open.filter((t) => t.name === 'meta' && t.attrs.has('charset')).length, 1);
    assert.equal(open.filter((t) => t.name === 'h1').length, 1);
    for (const landmark of ['header', 'main', 'footer']) assert.equal(open.filter((t) => t.name === landmark).length, 1, landmark);
    assert.ok(open.filter((t) => t.name === 'section').every((t) => t.attrs.has('aria-labelledby')), 'every section is a named region');
  });

  it('headings never skip a level', () => {
    const levels = open.filter((t) => /^h[1-6]$/.test(t.name)).map((t) => Number(t.name.slice(1)));
    assert.equal(levels[0], 1);
    for (let i = 1; i < levels.length; i++) assert.ok((levels[i] as number) - (levels[i - 1] as number) <= 1, `heading jump at ${i}: ${levels.join(',')}`);
  });

  it('the node table has a caption and scoped column headers, with exactly one initial sort', () => {
    assert.equal(open.filter((t) => t.name === 'table').length, 1);
    assert.ok(open.some((t) => t.name === 'caption'));
    const ths = open.filter((t) => t.name === 'th');
    assert.equal(ths.length, 6);
    assert.ok(ths.every((t) => t.attrs.get('scope') === 'col'));
    assert.equal(ths.filter((t) => t.attrs.get('aria-sort') === 'ascending').length, 1);
    assert.equal(ths.filter((t) => t.attrs.get('aria-sort') === 'none').length, 4);
    const sortButtons = open.filter((t) => t.name === 'button' && t.attrs.has('data-sort'));
    assert.deepEqual(sortButtons.map((t) => t.attrs.get('data-sort')), ['label', 'kind', 'community', 'weight', 'degree']);
    assert.ok(open.some((t) => t.name === 'thead') && open.some((t) => t.name === 'tbody'));
  });

  it('every control has a programmatic label; ids are unique; references resolve', () => {
    const ids = open.map((t) => t.attrs.get('id')).filter((x): x is string => x !== undefined);
    assert.equal(new Set(ids).size, ids.length, 'ids are unique');
    const labelFor = new Set(open.filter((t) => t.name === 'label').map((t) => t.attrs.get('for')));
    for (const ctl of open.filter((t) => ['input', 'select', 'textarea'].includes(t.name))) {
      assert.ok(labelFor.has(ctl.attrs.get('id')), `unlabelled ${ctl.name}`);
    }
    const idSet = new Set(ids);
    for (const t of open) {
      for (const ref of (t.attrs.get('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)) assert.ok(idSet.has(ref), `aria-labelledby -> ${ref}`);
      const href = t.attrs.get('href');
      if (href !== undefined) assert.ok(idSet.has(href.slice(1)), `href -> ${href}`);
    }
    // Static buttons have visible text.
    const buttonTexts = [...p.rest.matchAll(/<button\b[^>]*>([^<]*)<\/button>/g)].map((m) => (m[1] as string).trim());
    assert.ok(buttonTexts.length >= 7);
    assert.ok(buttonTexts.every((t) => t.length > 0));
  });

  it('has a visually hidden polite live region and a skip link that targets the table', () => {
    const live = open.find((t) => t.attrs.get('id') === 'live');
    assert.equal(live?.attrs.get('role'), 'status');
    assert.equal(live?.attrs.get('aria-live'), 'polite');
    assert.equal(live?.attrs.get('aria-atomic'), 'true');
    assert.match(live?.attrs.get('class') ?? '', /\bsr-only\b/);
    assert.match(p.style, /\.sr-only\{[^}]*clip:rect\(0,0,0,0\)/);
    const skip = open.find((t) => t.name === 'a' && /skip-link/.test(t.attrs.get('class') ?? ''));
    assert.equal(skip?.attrs.get('href'), '#nodes-heading');
    assert.ok(open.some((t) => t.attrs.get('id') === 'nodes-heading'));
    // It is the first focusable element in the body.
    const body = html.slice(html.indexOf('<body>'));
    assert.ok(body.indexOf('skip-link') < body.indexOf('<button') && body.indexOf('skip-link') < body.indexOf('<input'));
  });

  it('is usable without a pointer: no mouse-only handlers, focusable table region, diagram has a skip link', () => {
    assert.ok(!/(?:^|[^a-z])on(?:click|mouse\w+|pointer\w+|touch\w+)\s*=/i.test(p.rest));
    const region = open.find((t) => t.attrs.get('id') === undefined && t.attrs.get('role') === 'region');
    assert.equal(region?.attrs.get('tabindex'), '0');
    const svg = open.find((t) => t.name === 'svg');
    assert.equal(svg?.attrs.get('role'), 'group');
    assert.ok(svg?.attrs.get('aria-labelledby'));
    assert.ok(open.some((t) => t.name === 'a' && t.attrs.get('href') === '#footer-info'), 'skip the diagram');
    // The program also supports keyboard activation of diagram nodes and real <button>s everywhere else.
    assert.ok(p.program.includes('"keydown"') && p.program.includes('"Enter"'));
  });

  it('carries a prominent note that labels come from imported conversations', () => {
    assert.match(html, /<div class="notice" role="note">[\s\S]*Every label on this page comes from imported conversations[\s\S]*untrusted data/);
    assert.match(p.style, /\.notice\{[^}]*border:2px solid/);
  });

  it('respects reduced motion, colour schemes, forced colours and keyboard focus', () => {
    assert.match(p.style, /@media \(prefers-reduced-motion:reduce\)\{\*\{animation:none!important;transition:none!important/);
    assert.match(p.style, /@media \(prefers-color-scheme:dark\)/);
    assert.match(p.style, /@media \(forced-colors:active\)/);
    assert.match(p.style, /:focus-visible\{outline:3px solid var\(--focus\)/);
    assert.ok(open.some((t) => t.name === 'meta' && t.attrs.get('name') === 'color-scheme'));
    assert.ok(p.program.includes('prefers-reduced-motion'));
  });

  it('text and focus colours meet WCAG contrast in both colour schemes', () => {
    const root = /:root\{([^}]*)\}/.exec(p.style)?.[1] ?? '';
    const darkBlock = /@media \(prefers-color-scheme:dark\)\{:root\{([^}]*)\}\}/.exec(p.style)?.[1] ?? '';
    const light = cssVars(root);
    const dark = new Map([...light, ...cssVars(darkBlock)]);
    for (const [scheme, v] of [['light', light], ['dark', dark]] as const) {
      const c = (a: string, b: string): number => contrast(v.get(a) as string, v.get(b) as string);
      assert.ok(c('fg', 'bg') >= 7, `${scheme} body text ${c('fg', 'bg').toFixed(2)}`);
      assert.ok(c('fg', 'soft') >= 7, `${scheme} text on panels ${c('fg', 'soft').toFixed(2)}`);
      assert.ok(c('muted', 'bg') >= 4.5, `${scheme} muted text ${c('muted', 'bg').toFixed(2)}`);
      assert.ok(c('muted', 'soft') >= 4.5, `${scheme} muted on panels ${c('muted', 'soft').toFixed(2)}`);
      assert.ok(c('accent', 'bg') >= 4.5, `${scheme} links ${c('accent', 'bg').toFixed(2)}`);
      assert.ok(c('accent', 'soft') >= 4.5, `${scheme} links on selected row ${c('accent', 'soft').toFixed(2)}`);
      assert.ok(c('notice-fg', 'notice-bg') >= 7, `${scheme} notice ${c('notice-fg', 'notice-bg').toFixed(2)}`);
      assert.ok(c('line', 'bg') >= 3, `${scheme} control borders ${c('line', 'bg').toFixed(2)}`);
      assert.ok(c('focus', 'bg') >= 3, `${scheme} focus ring ${c('focus', 'bg').toFixed(2)}`);
      assert.ok(c('notice-line', 'notice-bg') >= 3, `${scheme} notice border ${c('notice-line', 'notice-bg').toFixed(2)}`);
    }
  });

  it('does not rely on colour alone in the diagram: shapes and dashes are explained in a text legend', () => {
    assert.match(html, /<ul class="legend" aria-label="Diagram legend"><li>Square: conversation<\/li><li>Circle: entity<\/li><li>Diamond: tool<\/li>/);
    assert.match(html, /Dashed line: mentioned in or uses tool/);
  });

  it('has a noscript explanation and nothing is rendered server-side from labels', () => {
    assert.match(html, /<noscript><p>This page needs JavaScript/);
    assert.match(p.rest, /<tbody id="node-body"><\/tbody>/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. Behaviour: the real inline program in a fake DOM
// ---------------------------------------------------------------------------------------------------------------------

interface AttrCall {
  tag: string;
  name: string;
  value: string;
}

type Listener = (ev: { key?: string; preventDefault: () => void }) => void;

class FakeElement {
  readonly tagName: string;
  readonly namespaceURI: string;
  readonly attrs = new Map<string, string>();
  readonly children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  hidden = false;
  value = '';
  open = false;
  private ownText = '';
  private readonly listeners = new Map<string, Listener[]>();
  private readonly doc: FakeDocument;

  constructor(doc: FakeDocument, tag: string, ns: string) {
    this.doc = doc;
    this.tagName = tag;
    this.namespaceURI = ns;
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
    this.doc.scrolls++;
  }

  hasClass(c: string): boolean {
    return (this.attrs.get('class') ?? '').split(/\s+/).includes(c);
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
    return this.find((e) => e.tagName === 'button' && e.hasClass('select'))[0] ?? null;
  }
}

class FakeDocument {
  readonly calls: AttrCall[] = [];
  readonly createdTags = new Set<string>();
  readonly byId = new Map<string, FakeElement>();
  readonly sortButtons: FakeElement[] = [];
  activeElement: FakeElement | null = null;
  scrolls = 0;
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
  text: (id: string) => string;
  selectButton: (row: FakeElement) => FakeElement;
  th: FakeElement[];
}

function boot(html: string): Page {
  const p = parts(html);
  const doc = new FakeDocument();
  for (const [id, tag] of [
    ['result-count', 'p'], ['live', 'div'], ['filter-text', 'input'], ['filter-kind', 'select'], ['node-body', 'tbody'], ['show-more', 'button'],
    ['selected-panel', 'div'], ['overview-count', 'span'], ['page-title', 'h1'], ['filter-clear', 'button'],
  ] as const) doc.add(id, tag);
  doc.add('overview', 'svg', 'fake-svg-namespace');
  const data = doc.add('graph-data', 'script');
  data.textContent = p.json;
  const th: FakeElement[] = [];
  for (const key of ['label', 'kind', 'community', 'weight', 'degree']) {
    const header = new FakeElement(doc, 'th', 'html');
    header.attrs.set('aria-sort', key === 'label' ? 'ascending' : 'none');
    const b = new FakeElement(doc, 'button', 'html');
    b.attrs.set('data-sort', key);
    b.textContent = key;
    header.appendChild(b);
    th.push(header);
    doc.sortButtons.push(b);
  }
  doc.calls.length = 0; // only count what the program itself does
  const sandbox = { document: doc, window: { matchMedia: () => ({ matches: false }) } };
  vm.runInNewContext(p.program, sandbox, { timeout: 5000 });
  const el = (id: string): FakeElement => doc.byId.get(id) as FakeElement;
  return {
    doc,
    el,
    rows: () => el('node-body').children,
    text: (id) => el(id).textContent,
    selectButton: (row) => row.querySelector('button.select') as FakeElement,
    th,
  };
}

const ALLOWED_TAGS = new Set(['tr', 'th', 'td', 'button', 'details', 'summary', 'ul', 'li', 'span', 'p', 'h3', 'h4', 'dl', 'dt', 'dd', 'line', 'g', 'rect', 'polygon', 'circle', 'title', 'text']);
const ALLOWED_ATTRS = new Set([
  'class', 'type', 'dir', 'scope', 'colspan', 'role', 'tabindex', 'aria-label', 'aria-pressed', 'aria-current', 'aria-hidden', 'aria-sort',
  'x', 'y', 'cx', 'cy', 'r', 'x1', 'x2', 'y1', 'y2', 'width', 'height', 'points',
]);

function labelsOfRows(page: Page): string[] {
  return page.rows().map((r) => page.selectButton(r).textContent);
}

describe('exportGraphHtml: the inline program, executed', () => {
  const graph = ringGraph(HOSTILE);
  const html = exportGraphHtml(graph, { title: '</title><b>Hostile title</b>' });

  it('renders every node as a table row with its label as plain text, and the title via textContent', () => {
    const page = boot(html);
    assert.equal(page.rows().length, HOSTILE.length);
    // Default order is by label (lower-cased), ties by input order; compare as sets of exact strings.
    assert.deepEqual(
      labelsOfRows(page).map((l) => (l === '(empty label)' ? '' : l)).sort(),
      [...HOSTILE].sort(),
    );
    assert.equal(page.doc.title, '</title><b>Hostile title</b>');
    assert.equal(page.text('page-title'), '</title><b>Hostile title</b>');
    assert.match(page.text('result-count'), /^Showing 12 of 12 matching nodes\. The graph has 12 nodes and 13 edges\.$/);
  });

  it('creates only allow-listed elements and attributes; labels reach the DOM only as text and aria-labels', () => {
    const page = boot(html);
    // Drive every feature so all code paths create DOM.
    page.selectButton(page.rows()[0] as FakeElement).fire('click');
    for (const row of page.rows()) {
      const details = row.children[5]?.children[0];
      if (details !== undefined && details.tagName === 'details') {
        details.open = true;
        details.fire('toggle');
      }
    }
    page.el('filter-text').value = 'x';
    page.el('filter-text').fire('input');
    page.doc.sortButtons[2]?.fire('click');
    for (const t of page.doc.createdTags) assert.ok(ALLOWED_TAGS.has(t), `unexpected element <${t}>`);
    assert.ok(page.doc.calls.length > 100);
    for (const c of page.doc.calls) {
      assert.ok(ALLOWED_ATTRS.has(c.name), `unexpected attribute ${c.name}`);
      assert.ok(!/^on/.test(c.name));
      if (c.name !== 'aria-label') {
        for (const label of HOSTILE) {
          if (label.length >= 6) assert.ok(!c.value.includes(label), `label placed in ${c.name} of <${c.tag}>`);
        }
      }
    }
    // The only attributes whose value may contain label text are aria-labels (text for assistive technology).
    assert.ok(page.doc.calls.some((c) => c.name === 'aria-label' && c.value.includes('javascript:alert(1)')));
  });

  it('selecting a row fills the details panel, marks the row current and announces the selection', () => {
    const page = boot(exportGraphHtml(ringGraph(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'])));
    const rowFor = (label: string): FakeElement => page.rows().find((r) => page.selectButton(r).textContent === label) as FakeElement;
    page.selectButton(rowFor('gamma')).fire('click');
    const panel = page.el('selected-panel');
    assert.equal(panel.find((e) => e.tagName === 'h3')[0]?.textContent, 'gamma');
    assert.equal(rowFor('gamma').attrs.get('aria-current'), 'true');
    assert.match(page.text('live'), /^Selected \w+ gamma, \d+ connections?\./);
    assert.ok(panel.find((e) => e.tagName === 'button').length >= 1, 'neighbours are real buttons');
    page.selectButton(rowFor('delta')).fire('click');
    assert.equal(rowFor('gamma').attrs.get('aria-current'), undefined);
    assert.equal(rowFor('delta').attrs.get('aria-current'), 'true');
    assert.equal(panel.find((e) => e.tagName === 'h3')[0]?.textContent, 'delta');
  });

  it('each row lists its neighbours as buttons that move selection AND focus', () => {
    const page = boot(exportGraphHtml(ringGraph(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'])));
    const rowFor = (label: string): FakeElement => page.rows().find((r) => page.selectButton(r).textContent === label) as FakeElement;
    const alpha = rowFor('alpha');
    const details = alpha.children[5]?.children[0] as FakeElement;
    assert.equal(details.tagName, 'details');
    assert.equal(details.children.length, 1, 'only the summary until opened (lazy)');
    details.open = true;
    details.fire('toggle');
    const items = details.find((e) => e.tagName === 'li');
    assert.ok(items.length >= 2);
    const neighbourButtons = details.find((e) => e.tagName === 'button');
    assert.equal(neighbourButtons.length, items.length);
    const names = neighbourButtons.map((b) => b.textContent);
    assert.ok(names.includes('beta') && names.includes('zeta'), names.join(','));
    // Details open once only: toggling again does not duplicate the list.
    details.fire('toggle');
    assert.equal(details.find((e) => e.tagName === 'ul').length, 1);
    (neighbourButtons.find((b) => b.textContent === 'zeta') as FakeElement).fire('click');
    assert.equal(page.doc.activeElement, page.selectButton(rowFor('zeta')), 'focus moved to the neighbour\'s row button');
    assert.equal(rowFor('zeta').attrs.get('aria-current'), 'true');
    assert.equal(page.el('selected-panel').find((e) => e.tagName === 'h3')[0]?.textContent, 'zeta');
    assert.ok(page.doc.scrolls >= 1);
  });

  it('a neighbour hidden by the current filter is revealed: filters are cleared, announced, and focus lands on it', () => {
    const page = boot(exportGraphHtml(ringGraph(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'])));
    const search = page.el('filter-text');
    search.value = 'ALPHA';
    search.fire('input');
    assert.equal(page.rows().length, 1);
    assert.match(page.text('live'), /^1 node matches\./);
    const row = page.rows()[0] as FakeElement;
    const details = row.children[5]?.children[0] as FakeElement;
    details.open = true;
    details.fire('toggle');
    (details.find((e) => e.tagName === 'button').find((b) => b.textContent === 'beta') as FakeElement).fire('click');
    assert.equal(search.value, '');
    assert.equal(page.rows().length, 6);
    assert.match(page.text('live'), /Filters were cleared to show it\.$/);
    assert.equal(page.doc.activeElement?.textContent, 'beta');
  });

  it('search and kind filters narrow the table; clear restores it and returns focus to the search box', () => {
    const page = boot(exportGraphHtml(ringGraph(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'])));
    const search = page.el('filter-text');
    search.value = 'zzz-no-match';
    search.fire('input');
    assert.equal(page.rows().length, 1);
    assert.match(page.rows()[0]?.textContent ?? '', /^No node matches the current filters\.$/);
    assert.match(page.text('live'), /^0 nodes match\./);
    page.el('filter-clear').fire('click');
    assert.equal(page.rows().length, 6);
    assert.equal(page.doc.activeElement, search);
    const kind = page.el('filter-kind');
    kind.value = 'tool';
    kind.fire('change');
    assert.deepEqual(labelsOfRows(page), ['gamma', 'zeta']); // ring kinds cycle entity, conversation, tool
    kind.value = 'keyword';
    kind.fire('change');
    assert.deepEqual(labelsOfRows(page).sort(), ['alpha', 'delta']);
    kind.value = '';
    search.value = 'ENT:KEYWORD:N3'; // ids are searched too (case-insensitively)
    kind.fire('change');
    search.fire('input');
    assert.deepEqual(labelsOfRows(page), ['delta']);
  });

  it('sorting toggles direction, updates aria-sort and announces', () => {
    const page = boot(exportGraphHtml(ringGraph(['bbb', 'ccc', 'aaa', 'ddd'])));
    assert.deepEqual(labelsOfRows(page), ['aaa', 'bbb', 'ccc', 'ddd']);
    page.doc.sortButtons[0]?.fire('click'); // same key: flip to descending
    assert.deepEqual(labelsOfRows(page), ['ddd', 'ccc', 'bbb', 'aaa']);
    assert.equal(page.doc.sortButtons[0]?.parentNode?.attrs.get('aria-sort'), 'descending');
    page.doc.sortButtons[3]?.fire('click'); // weight ascending: node weights are index+1
    assert.deepEqual(labelsOfRows(page), ['bbb', 'ccc', 'aaa', 'ddd']);
    assert.equal(page.doc.sortButtons[3]?.parentNode?.attrs.get('aria-sort'), 'ascending');
    assert.equal(page.doc.sortButtons[0]?.parentNode?.attrs.get('aria-sort'), 'none');
    assert.match(page.text('live'), /^Sorted by weight, ascending\./);
    page.doc.sortButtons[4]?.fire('click'); // degree ascending
    assert.equal(page.rows().length, 4);
    page.doc.sortButtons[2]?.fire('click'); // community: null last
    assert.equal(page.doc.sortButtons[2]?.parentNode?.attrs.get('aria-sort'), 'ascending');
  });

  it('pages long tables and keeps focus sensible when the last page is shown', () => {
    const labels = Array.from({ length: 450 }, (_, i) => `node ${String(i).padStart(3, '0')}`);
    const page = boot(exportGraphHtml({ nodes: labels.map((l, i) => node(i, l)), edges: [] }));
    assert.equal(page.rows().length, 200);
    assert.equal(page.el('show-more').hidden, false);
    page.el('show-more').fire('click');
    assert.equal(page.rows().length, 400);
    page.el('show-more').fire('click');
    assert.equal(page.rows().length, 450);
    assert.equal(page.el('show-more').hidden, true);
    assert.equal(page.doc.activeElement, page.el('result-count'));
    assert.match(page.text('result-count'), /^Showing 450 of 450/);
    // Selecting a node beyond the visible page by neighbour navigation is covered by the filter test; here: no neighbours text.
    assert.equal(page.rows()[0]?.children[5]?.textContent, 'none');
  });

  it('draws an accessible overview: focusable role=button nodes with aria-labels, hidden decorative edges', () => {
    const page = boot(exportGraphHtml(ringGraph(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'])));
    const svg = page.el('overview');
    const nodesG = svg.find((e) => e.tagName === 'g');
    assert.equal(nodesG.length, 6);
    for (const g of nodesG) {
      assert.equal(g.attrs.get('role'), 'button');
      assert.equal(g.attrs.get('tabindex'), '0');
      assert.equal(g.attrs.get('aria-pressed'), 'false');
      assert.match(g.attrs.get('aria-label') ?? '', /^Select \w+ \w+, \d+ connections?$/);
      assert.ok((g.find((e) => e.tagName === 'title')[0]?.textContent.length ?? 0) > 0);
    }
    assert.deepEqual(new Set(svg.find((e) => ['rect', 'circle', 'polygon'].includes(e.tagName)).map((e) => e.tagName)), new Set(['rect', 'circle', 'polygon']));
    const lines = svg.find((e) => e.tagName === 'line');
    assert.equal(lines.length, 7);
    assert.ok(lines.every((l) => l.attrs.get('aria-hidden') === 'true'));
    for (const e of svg.find((x) => x.tagName !== 'title')) {
      for (const name of ['x', 'y', 'cx', 'cy', 'x1', 'x2', 'y1', 'y2']) {
        const v = e.attrs.get(name);
        if (v !== undefined) assert.ok(Number.isFinite(Number(v)), `${e.tagName}@${name}=${v}`);
      }
    }
    assert.match(page.text('overview-count'), /^The diagram shows all 6 nodes\.$/);
    // Keyboard: Enter and Space select, other keys do not.
    const target = nodesG[2] as FakeElement;
    target.fire('keydown', 'a');
    assert.equal(page.el('selected-panel').find((e) => e.tagName === 'h3').length, 0);
    target.fire('keydown', 'Enter');
    assert.equal(target.attrs.get('aria-pressed'), 'true');
    assert.ok(target.hasClass('sel'));
    assert.equal(page.el('selected-panel').find((e) => e.tagName === 'h3').length, 1);
    nodesG[4]?.fire('keydown', ' ');
    assert.equal(target.attrs.get('aria-pressed'), 'false');
    assert.ok(!target.hasClass('sel'));
    assert.equal(nodesG[4]?.attrs.get('aria-pressed'), 'true');
  });

  it('a graph larger than the overview budget is drawn partially and says so', () => {
    const labels = Array.from({ length: 40 }, (_, i) => `n${i}`);
    const page = boot(exportGraphHtml(ringGraph(labels), { maxOverviewNodes: 10 }));
    assert.equal(page.el('overview').find((e) => e.tagName === 'g').length, 10);
    assert.match(page.text('overview-count'), /^The diagram shows the 10 best connected of 40 nodes; the table lists all of them\.$/);
    assert.equal(page.rows().length, 40);
    const none = boot(exportGraphHtml(ringGraph(labels), { maxOverviewNodes: 0 }));
    assert.equal(none.el('overview').children.length, 0);
  });

  it('an empty graph renders a message instead of failing', () => {
    const page = boot(exportGraphHtml({ nodes: [], edges: [] }));
    assert.equal(page.rows().length, 1);
    assert.equal(page.rows()[0]?.textContent, 'This graph has no nodes.');
    assert.match(page.text('result-count'), /^Showing 0 of 0 matching nodes/);
    assert.match(page.text('selected-panel'), /No node selected/);
  });

  it('survives unreadable embedded data', () => {
    const broken = exportGraphHtml(ringGraph(['alpha', 'beta'])).replace(/(<script type="application\/json" id="graph-data">)[\s\S]*?(<\/script>)/, '$1{not json$2');
    const page = boot(broken);
    assert.equal(page.text('result-count'), 'The embedded graph data could not be read.');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. Determinism, validation, limits, end to end
// ---------------------------------------------------------------------------------------------------------------------

describe('exportGraphHtml: determinism, validation and limits', () => {
  const graph = ringGraph(Array.from({ length: 30 }, (_, i) => `label ${i}`));

  it('equal input and seed give a byte-identical document; the seed only changes coordinates', () => {
    const a = exportGraphHtml(graph, { layoutSeed: 7 });
    assert.equal(exportGraphHtml(graph, { layoutSeed: 7 }), a);
    const b = exportGraphHtml(graph, { layoutSeed: 8 });
    assert.notEqual(a, b);
    const strip = (h: string): string => h.replace(/"x":[0-9.]+,"y":[0-9.]+/g, '"x":0,"y":0');
    assert.equal(strip(a), strip(b));
    assert.equal(parts(a).program, parts(b).program);
    // Without an overview the seed is irrelevant.
    assert.equal(exportGraphHtml(graph, { layoutSeed: 1, maxOverviewNodes: 0 }), exportGraphHtml(graph, { layoutSeed: 99, maxOverviewNodes: 0 }));
    assert.equal(exportGraphHtml(graph), exportGraphHtml(graph, { layoutSeed: 1 }));
  });

  it('layout coordinates are finite, inside the canvas, rounded to 0.1 and not stacked', () => {
    const data = JSON.parse(parts(exportGraphHtml(graph)).json) as { nodes: Array<{ x: number; y: number }> };
    const pts = data.nodes;
    assert.equal(pts.length, 30);
    for (const n of pts) {
      assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y));
      assert.ok(n.x >= 40 && n.x <= 960 && n.y >= 40 && n.y <= 660, `${n.x},${n.y}`);
      assert.equal(Math.round(n.x * 10) / 10, n.x);
    }
    let minDist = Infinity;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) minDist = Math.min(minDist, Math.hypot((pts[i] as { x: number }).x - (pts[j] as { x: number }).x, (pts[i] as { y: number }).y - (pts[j] as { y: number }).y));
    }
    assert.ok(minDist > 5, `nodes too close: ${minDist}`);
  });

  it('keeps the caller node order, drops repeated ids and edges to unknown nodes', () => {
    const base = ringGraph(['a', 'b', 'c']);
    const dup = { nodes: [...base.nodes, { ...(base.nodes[0] as GraphNodeDto), label: 'duplicate' }], edges: [...base.edges, { id: 77, src: 'ent:keyword:n0', dst: 'ent:keyword:missing', kind: 'co_occurs' as const, weight: 1 }] };
    const data = JSON.parse(parts(exportGraphHtml(dup)).json) as { nodes: Array<{ label: string }>; edges: unknown[] };
    assert.deepEqual(data.nodes.map((n) => n.label), ['a', 'b', 'c']);
    assert.equal(data.edges.length, base.edges.length);
  });

  it('coerces malformed numbers instead of emitting invalid JSON', () => {
    const n = node(0, 'x');
    const odd = { nodes: [{ ...n, weight: Number.NaN, communityId: 1.5 }, { ...node(1, 'y'), weight: Number.POSITIVE_INFINITY }], edges: [{ id: Number.NaN, src: n.id, dst: node(1, 'y').id, kind: 'co_occurs' as const, weight: Number.NEGATIVE_INFINITY }] };
    const data = JSON.parse(parts(exportGraphHtml(odd)).json) as { nodes: Array<{ weight: number; community: number | null }>; edges: Array<{ weight: number; id: number }> };
    assert.deepEqual(data.nodes.map((x) => [x.weight, x.community]), [[0, null], [0, 2]]);
    assert.deepEqual(data.edges.map((e) => [e.id, e.weight]), [[0, 0]]);
  });

  it('rejects malformed arguments and oversized graphs with INVALID_ARGUMENT', () => {
    const ok = ringGraph(['a', 'b']);
    for (const g of [null, undefined, {}, { nodes: [], edges: 5 }, { nodes: 'x', edges: [] }] as unknown[]) assert.throws(() => exportGraphHtml(g as never), expectCode('INVALID_ARGUMENT'));
    for (const o of [{ title: '' }, { title: 'x'.repeat(201) }, { title: 5 }, { layoutSeed: 1.5 }, { layoutSeed: Number.NaN }, { layoutSeed: 2 ** 60 }, { maxOverviewNodes: -1 }, { maxOverviewNodes: 501 }, { maxOverviewNodes: 1.5 }, null] as unknown[]) {
      assert.throws(() => exportGraphHtml(ok, o as never), expectCode('INVALID_ARGUMENT'), JSON.stringify(o));
    }
    assert.throws(() => exportGraphHtml({ nodes: [null as never], edges: [] }), expectCode('INVALID_ARGUMENT'));
    assert.throws(() => exportGraphHtml({ nodes: [], edges: [null as never] }), expectCode('INVALID_ARGUMENT'));
    const tooMany = Array.from({ length: MAX_EXPORT_NODES + 1 }, (_, i) => node(i, `n${i}`));
    assert.throws(() => exportGraphHtml({ nodes: tooMany, edges: [] }), (e: unknown) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT' && typeof e.remedy === 'string');
    const edge: GraphEdgeDto = { id: 1, src: 'a', dst: 'b', kind: 'co_occurs', weight: 1 };
    assert.throws(() => exportGraphHtml({ nodes: [], edges: new Array<GraphEdgeDto>(MAX_EXPORT_EDGES + 1).fill(edge) }), expectCode('INVALID_ARGUMENT'));
  });

  it('exports the maximum node count within a reasonable time', () => {
    const nodes = Array.from({ length: MAX_EXPORT_NODES }, (_, i) => node(i, `bulk ${i}`));
    const edges: GraphEdgeDto[] = nodes.slice(1).map((n, i) => ({ id: i + 1, src: (nodes[i] as GraphNodeDto).id, dst: n.id, kind: 'co_occurs', weight: 1 }));
    const start = performance.now();
    const html = exportGraphHtml({ nodes, edges });
    const ms = performance.now() - start;
    assert.ok(ms < 5000, `took ${ms.toFixed(0)} ms`);
    assert.ok(html.length < 4_000_000);
    assert.equal(JSON.parse(parts(html).json).nodes.length, MAX_EXPORT_NODES);
  });
});

describe('exportGraphHtml: end to end from a real database', () => {
  it('hostile conversation titles survive build, query and export as inert data', async () => {
    const META: ImportBatchMeta = {
      provider: 'chatgpt',
      accountLabel: 'default',
      provenance: 'official_chatgpt_export',
      completeness: 'exported_tree',
      sourceKind: 'zip',
      sourceLabel: 'export.zip',
      contentDigest: 'html',
      importedAt: '2025-02-01T00:00:00.000Z',
      toolVersion: '0.2.0-dev.0',
      warnings: [],
    };
    const hostileTitles = ['</script><img src=x onerror=alert(1)>', '"><svg onload=1>', 'javascript:alert(1)', 'tick`s ${x}'];
    const convs = hostileTitles.map((title, i) => {
      const id = `h${i}`;
      const root = msg({ id: `${id}-root`, conversationId: id, nodeKind: 'structural_empty', authorRole: '', contentType: null, ordinal: 0 });
      const m = msg({ id: `${id}-m0`, conversationId: id, parentId: root.id, text: 'sharedtopic zebrawork', createdAt: iso(1), ordinal: 1 });
      return convo(id, link([root, m]), { title, currentNodeId: m.id });
    });
    const h = openDatabase(':memory:');
    await new Repository(h.db).importBatch({ batch: META, conversations: convs });
    buildGraph(h.db, { minEntityConversations: 1 });
    const q = graphQuery(h.db, { term: 'sharedtopic', depth: 1 });
    assert.ok(q.nodes.length >= 5);
    const html = exportGraphHtml(q, { title: 'Query: sharedtopic' });
    const p = parts(html);
    const outside = html.replace(p.json, '');
    for (const t of hostileTitles) assert.ok(!outside.includes(t), t);
    const labels = (JSON.parse(p.json) as { nodes: Array<{ label: string }> }).nodes.map((n) => n.label);
    for (const t of hostileTitles) assert.ok(labels.includes(t), `exact title round-trips: ${t}`);
    assert.equal(p.scripts.length, 2);
    const page = boot(html);
    assert.equal(page.rows().length, q.nodes.length);
  });
});
