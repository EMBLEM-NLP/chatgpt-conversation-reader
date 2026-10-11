/**
 * Self-contained, OFFLINE, accessible HTML export of (a subgraph of) the knowledge graph (SPEC FR-12, NFR-04).
 *
 * THREAT MODEL. Every node label is text cut from an imported conversation: attacker-controlled data. The page must
 * stay inert whatever the labels say ("</script><img src=x onerror=alert(1)>", javascript: URLs, template syntax, U+2028).
 * The design makes that a structural property instead of an escaping discipline:
 *   1. Labels exist in exactly ONE place in the document: a `<script type="application/json">` data block. `<`, `>`, `&`,
 *      U+2028 and U+2029 are written as \uXXXX escapes there, so the block can neither close itself nor open markup, and
 *      JSON.parse returns the exact original strings. No label is ever written into HTML text, attributes or CSS.
 *   2. The single inline program builds the DOM with createElement / textContent / setAttribute ONLY, always with
 *      literal attribute names, and never with a data-derived URL, style or event-handler attribute. It contains none of
 *      the HTML-injection or code-evaluation sinks (asserted by test/graph/export-html.test.ts on the program text).
 *   3. A Content-Security-Policy meta tag backs this up: default-src 'none' (no network of any kind), img-src data:,
 *      script-src and style-src limited to the SHA-256 hashes of the one inline program and the one inline stylesheet,
 *      base-uri/form-action 'none', and Trusted Types required for script sinks. Even a future programming mistake could
 *      neither load anything nor run injected script.
 *   4. There are no external scripts, styles, fonts, images, frames, forms or fetches, and no inline style/event
 *      attributes anywhere (which is also what makes the style hash possible).
 *
 * ACCESSIBILITY (NFR-04). The page is fully usable with a keyboard and a screen reader and without any pointing device:
 * landmarks and headings, a skip link, labelled search / kind controls, a sortable table (real <th scope> headers with
 * sort buttons and aria-sort), per-row neighbour lists made of real <button>s that move selection and focus, a details
 * panel for the selected node, a visually hidden live region that announces selection and filter results, light/dark
 * colour schemes with high contrast, forced-colors support and prefers-reduced-motion. The SVG overview is a supplement
 * (its nodes are focusable role="button" elements with aria-labels) and never the only way to use the page.
 *
 * DETERMINISM. The overview layout is a Fruchterman-Reingold run seeded from `layoutSeed` (integer PRNG, plain
 * arithmetic, coordinates rounded to 0.1), so equal input and seed give a byte-identical document. No clock is read.
 */
import { createHash } from 'node:crypto';
import { GcrError } from '../errors.js';
import type { GraphEdgeDto, GraphNodeDto } from './query.js';

export interface ExportGraphInput {
  nodes: GraphNodeDto[];
  edges: GraphEdgeDto[];
}

export interface ExportHtmlOptions {
  /** Page title (shown via textContent only). Default "GCR graph export". Max 200 characters. */
  title?: string;
  /** Seed of the overview layout. Any safe integer, default 1. */
  layoutSeed?: number;
  /** Nodes drawn in the SVG overview (heaviest first). 0..500, default 150. The table always lists every node. */
  maxOverviewNodes?: number;
}

export const MAX_EXPORT_NODES = 5000;
export const MAX_EXPORT_EDGES = 50_000;
const DEFAULT_TITLE = 'GCR graph export';
const OVERVIEW_W = 1000;
const OVERVIEW_H = 700;

// ---------------------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------------------

function badArg(field: string, why: string, remedy?: string): GcrError {
  return new GcrError('INVALID_ARGUMENT', `Invalid value for "${field}": ${why}.`, { details: { field }, ...(remedy === undefined ? {} : { remedy }) });
}

function finiteOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Embedded data
// ---------------------------------------------------------------------------------------------------------------

interface PageNode {
  id: string;
  kind: string;
  entityKind: string | null;
  label: string;
  weight: number;
  community: number | null;
  x: number | null;
  y: number | null;
}

interface PageEdge {
  id: number;
  s: number;
  t: number;
  kind: string;
  weight: number;
}

/**
 * JSON that is safe inside <script type="application/json">: every character that could end the element or start
 * markup (< > &) and the two JavaScript line terminators are written as \uXXXX escapes. JSON.parse undoes them exactly.
 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u{2028}\u{2029}]/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Deterministic layout
// ---------------------------------------------------------------------------------------------------------------

/** mulberry32: 32-bit integer PRNG, identical on every platform. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

/**
 * Fruchterman-Reingold on the chosen subset. Returns x/y arrays aligned with `subset`. Cost O(iterations * n^2): n is
 * capped by maxOverviewNodes (<= 500).
 */
function layout(subset: readonly number[], edgePairs: ReadonlyArray<readonly [number, number]>, seed: number): { x: Float64Array; y: Float64Array } {
  const n = subset.length;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const margin = 40;
  const cx = OVERVIEW_W / 2;
  const cy = OVERVIEW_H / 2;
  if (n === 0) return { x, y };
  if (n === 1) {
    x[0] = cx;
    y[0] = cy;
    return { x, y };
  }
  const rnd = mulberry32(seed);
  const radius = Math.min(OVERVIEW_W, OVERVIEW_H) * 0.35;
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / n;
    x[i] = cx + radius * Math.cos(angle) + (rnd() - 0.5) * 20;
    y[i] = cy + radius * Math.sin(angle) + (rnd() - 0.5) * 20;
  }
  const area = (OVERVIEW_W - 2 * margin) * (OVERVIEW_H - 2 * margin);
  const k = Math.sqrt(area / n) * 0.8;
  const iterations = n <= 100 ? 150 : n <= 300 ? 100 : 60;
  let temperature = Math.min(OVERVIEW_W, OVERVIEW_H) / 8;
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  for (let iter = 0; iter < iterations; iter++) {
    dx.fill(0);
    dy.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ex = (x[i] as number) - (x[j] as number);
        let ey = (y[i] as number) - (y[j] as number);
        let d2 = ex * ex + ey * ey;
        if (d2 < 0.01) {
          ex = rnd() - 0.5;
          ey = rnd() - 0.5;
          d2 = ex * ex + ey * ey + 0.01;
        }
        const d = Math.sqrt(d2);
        const f = (k * k) / d / d; // repulsive force k^2/d, applied along the unit vector (ex/d, ey/d)
        dx[i] = (dx[i] as number) + ex * f;
        dy[i] = (dy[i] as number) + ey * f;
        dx[j] = (dx[j] as number) - ex * f;
        dy[j] = (dy[j] as number) - ey * f;
      }
    }
    for (const [a, b] of edgePairs) {
      const ex = (x[a] as number) - (x[b] as number);
      const ey = (y[a] as number) - (y[b] as number);
      const d = Math.sqrt(ex * ex + ey * ey) + 0.001;
      const f = d / k; // attractive force d^2/k along the unit vector
      dx[a] = (dx[a] as number) - ex * f;
      dy[a] = (dy[a] as number) - ey * f;
      dx[b] = (dx[b] as number) + ex * f;
      dy[b] = (dy[b] as number) + ey * f;
    }
    for (let i = 0; i < n; i++) {
      // Weak gravity keeps disconnected components on the canvas.
      let mx = (dx[i] as number) - ((x[i] as number) - cx) * 0.02;
      let my = (dy[i] as number) - ((y[i] as number) - cy) * 0.02;
      const len = Math.sqrt(mx * mx + my * my);
      if (len > temperature) {
        mx = (mx / len) * temperature;
        my = (my / len) * temperature;
      }
      x[i] = Math.min(OVERVIEW_W - margin, Math.max(margin, (x[i] as number) + mx));
      y[i] = Math.min(OVERVIEW_H - margin, Math.max(margin, (y[i] as number) + my));
    }
    temperature *= 0.95;
  }
  for (let i = 0; i < n; i++) {
    x[i] = round1(x[i] as number);
    y[i] = round1(y[i] as number);
  }
  return { x, y };
}

// ---------------------------------------------------------------------------------------------------------------
// The page: stylesheet and inline program (both static, both hashed into the CSP)
// ---------------------------------------------------------------------------------------------------------------

const STYLE = [
  ':root{color-scheme:light dark;--bg:#ffffff;--fg:#14141a;--muted:#40404c;--line:#6b6b78;--soft:#f1f1f6;--accent:#0a4fc1;--focus:#0a4fc1;',
  '--notice-bg:#fff4d1;--notice-fg:#2e2200;--notice-line:#8a6400;',
  '--c0:#0072b2;--c1:#e69f00;--c2:#009e73;--c3:#d55e00;--c4:#56b4e9;--c5:#cc79a7;--c6:#f0e442;--c7:#999999}',
  '@media (prefers-color-scheme:dark){:root{--bg:#121218;--fg:#f2f2f7;--muted:#c7c7d1;--line:#9a9aa8;--soft:#1e1e27;--accent:#8ab4ff;--focus:#8ab4ff;',
  '--notice-bg:#3a2e08;--notice-fg:#ffeeb8;--notice-line:#d9a800}}',
  '*{box-sizing:border-box}',
  'html{font-size:100%}',
  'body{margin:0;padding:1rem;background:var(--bg);color:var(--fg);font:1rem/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
  'main,header,footer{max-width:80rem;margin:0 auto}',
  'h1{font-size:1.6rem;margin:.5rem 0}',
  'h2{font-size:1.25rem;margin:1.5rem 0 .5rem}',
  'h3{font-size:1.1rem;margin:.5rem 0}',
  '.notice{border:2px solid var(--notice-line);background:var(--notice-bg);color:var(--notice-fg);padding:.5rem 1rem;border-radius:.25rem;margin:.5rem 0 1rem}',
  '.notice p{margin:.25rem 0}',
  '.skip-link{position:absolute;left:-999rem;top:0;background:var(--bg);color:var(--accent);padding:.5rem 1rem;z-index:10}',
  '.skip-link:focus{left:0}',
  '.sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}',
  '.controls{display:flex;flex-wrap:wrap;gap:1rem;align-items:flex-end}',
  '.field{display:flex;flex-direction:column;gap:.25rem}',
  'label{font-weight:600}',
  'input,select,button{font:inherit;color:var(--fg);background:var(--bg);border:2px solid var(--line);border-radius:.25rem;min-height:2.25rem;padding:.25rem .5rem}',
  'button{cursor:pointer}',
  'button:hover{border-color:var(--accent)}',
  ':focus-visible{outline:3px solid var(--focus);outline-offset:2px}',
  '[hidden]{display:none!important}',
  '.table-wrap{overflow-x:auto;border:1px solid var(--line)}',
  'table{border-collapse:collapse;width:100%}',
  'caption{text-align:left;padding:.5rem;color:var(--muted)}',
  'th,td{border-top:1px solid var(--line);padding:.375rem .5rem;text-align:left;vertical-align:top}',
  'thead th{background:var(--soft)}',
  'thead button{border:0;background:none;font-weight:700;padding:.25rem;text-decoration:underline}',
  'th[aria-sort=ascending] button::after{content:" \\25B2"}',
  'th[aria-sort=descending] button::after{content:" \\25BC"}',
  'td.num{text-align:right;font-variant-numeric:tabular-nums}',
  'button.select,button.nb-btn{border:0;background:none;color:var(--accent);text-decoration:underline;text-align:left;padding:.25rem;overflow-wrap:anywhere}',
  'tr[aria-current=true]{outline:3px solid var(--accent);outline-offset:-3px;background:var(--soft)}',
  'ul.nb{margin:.25rem 0;padding-left:1.25rem}',
  '.meta{color:var(--muted)}',
  'dl.props{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem;margin:.5rem 0}',
  'dl.props dt{font-weight:700}',
  'dl.props dd{margin:0;overflow-wrap:anywhere}',
  '#selected-panel{border:1px solid var(--line);padding:.5rem 1rem;border-radius:.25rem}',
  'svg#overview{display:block;width:100%;height:auto;max-height:80vh;border:1px solid var(--line);background:var(--soft)}',
  '.edge{stroke:var(--muted);stroke-width:1;opacity:.55;fill:none}',
  '.edge.e-ref{stroke-dasharray:6 4}',
  '.nd{cursor:pointer}',
  '.nd .shape{stroke:var(--fg);stroke-width:1.5;fill:var(--c7)}',
  '.nd.c0 .shape{fill:var(--c0)}.nd.c1 .shape{fill:var(--c1)}.nd.c2 .shape{fill:var(--c2)}.nd.c3 .shape{fill:var(--c3)}',
  '.nd.c4 .shape{fill:var(--c4)}.nd.c5 .shape{fill:var(--c5)}.nd.c6 .shape{fill:var(--c6)}.nd.c7 .shape{fill:var(--c7)}',
  '.nd.sel .shape{stroke:var(--accent);stroke-width:5}',
  '.nd:focus-visible{outline:3px solid var(--focus);outline-offset:3px}',
  '.lbl{font-size:13px;fill:var(--fg);paint-order:stroke;stroke:var(--bg);stroke-width:3px;pointer-events:none}',
  '.legend{display:flex;flex-wrap:wrap;gap:.25rem 1.5rem;padding-left:1.25rem;color:var(--muted)}',
  'footer{margin-top:2rem;color:var(--muted)}',
  '@media (forced-colors:active){.nd .shape{fill:Canvas;stroke:CanvasText}.nd.sel .shape{stroke:Highlight}:focus-visible{outline-color:Highlight}}',
  '@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}}',
  '@media print{.skip-link,#filter-clear,#show-more{display:none}}',
].join('\n');

/**
 * The inline program. Pure ASCII, double-quoted strings only, no template literals and no backslashes (special
 * characters come from String.fromCharCode), so it can be embedded verbatim and hashed. It only ever calls
 * setAttribute with literal attribute names.
 */
const PROGRAM = [
  '(function () {',
  '  "use strict";',
  '  var NBSP = String.fromCharCode(160);',
  '  var ELLIPSIS = String.fromCharCode(8230);',
  '  var PAGE = 200;',
  '  var ROW_NEIGHBOURS = 25;',
  '  var PANEL_NEIGHBOURS = 100;',
  '  var KIND_NAMES = { conversation: "conversation", tool: "tool", url: "URL", uuid: "UUID", timestamp: "timestamp", keyword: "keyword", code_language: "code language", file_name: "file name", entity: "entity" };',
  '  var EDGE_WORDS = { mentioned_in: ["mentioned in", "mentions"], uses_tool: ["uses tool", "used by"], co_occurs: ["co-occurs with", "co-occurs with"] };',
  '  var EDGE_CLASS = { mentioned_in: "edge e-ref", uses_tool: "edge e-ref", co_occurs: "edge" };',
  '  var own = Object.prototype.hasOwnProperty;',
  '  var byId = function (id) { return document.getElementById(id); };',
  '  var resultCount = byId("result-count");',
  '  var live = byId("live");',
  '  var data;',
  '  try {',
  '    data = JSON.parse(byId("graph-data").textContent);',
  '  } catch (err) {',
  '    resultCount.textContent = "The embedded graph data could not be read.";',
  '    return;',
  '  }',
  '  var nodes = data.nodes;',
  '  var edges = data.edges;',
  '  var reduceMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;',
  '',
  '  var adj = [];',
  '  var degree = [];',
  '  var lowerLabels = [];',
  '  var haystack = [];',
  '  var i;',
  '  for (i = 0; i < nodes.length; i++) {',
  '    adj.push([]);',
  '    degree.push(0);',
  '    lowerLabels.push(String(nodes[i].label).toLowerCase());',
  '    haystack.push((String(nodes[i].label) + " " + String(nodes[i].id) + " " + String(nodes[i].kind) + " " + (nodes[i].entityKind === null ? "" : String(nodes[i].entityKind))).toLowerCase());',
  '  }',
  '  for (i = 0; i < edges.length; i++) {',
  '    adj[edges[i].s].push({ other: edges[i].t, edge: i, out: true });',
  '    adj[edges[i].t].push({ other: edges[i].s, edge: i, out: false });',
  '    degree[edges[i].s] += 1;',
  '    degree[edges[i].t] += 1;',
  '  }',
  '  for (i = 0; i < adj.length; i++) {',
  '    adj[i].sort(function (a, b) { return (edges[b.edge].weight - edges[a.edge].weight) || (a.edge - b.edge); });',
  '  }',
  '',
  '  function el(tag, cls, text) {',
  '    var e = document.createElement(tag);',
  '    if (cls) { e.setAttribute("class", cls); }',
  '    if (text !== undefined) { e.textContent = text; }',
  '    return e;',
  '  }',
  '  function clear(node) { while (node.firstChild) { node.removeChild(node.firstChild); } }',
  '  function kindName(n) {',
  '    var k = n.entityKind || n.kind;',
  '    return own.call(KIND_NAMES, k) ? KIND_NAMES[k] : "node";',
  '  }',
  '  function shown(label) { return label === "" ? "(empty label)" : label; }',
  '  function fmt(x) { return String(Math.round(x * 100) / 100); }',
  '  var flip = false;',
  '  function announce(message) {',
  '    flip = !flip;',
  '    live.textContent = message + (flip ? NBSP : "");',
  '  }',
  '',
  '  var state = { query: "", kind: "", sortKey: "label", dir: 1, page: 1, selected: -1 };',
  '  var search = byId("filter-text");',
  '  var kindSelect = byId("filter-kind");',
  '  var tbody = byId("node-body");',
  '  var moreButton = byId("show-more");',
  '  var panel = byId("selected-panel");',
  '  var rows = Object.create(null);',
  '  var svgNodes = Object.create(null);',
  '',
  '  function compare(a, b) {',
  '    var x;',
  '    var y;',
  '    var r = 0;',
  '    var key = state.sortKey;',
  '    if (key === "label") { x = lowerLabels[a]; y = lowerLabels[b]; r = x < y ? -1 : (x > y ? 1 : 0); }',
  '    else if (key === "kind") { x = kindName(nodes[a]); y = kindName(nodes[b]); r = x < y ? -1 : (x > y ? 1 : 0); }',
  '    else if (key === "community") {',
  '      x = nodes[a].community === null ? Infinity : nodes[a].community;',
  '      y = nodes[b].community === null ? Infinity : nodes[b].community;',
  '      r = x < y ? -1 : (x > y ? 1 : 0);',
  '    }',
  '    else if (key === "weight") { r = nodes[a].weight < nodes[b].weight ? -1 : (nodes[a].weight > nodes[b].weight ? 1 : 0); }',
  '    else { r = degree[a] - degree[b]; }',
  '    return r === 0 ? a - b : r * state.dir;',
  '  }',
  '  function matches(idx) {',
  '    var n = nodes[idx];',
  '    if (state.kind !== "" && n.kind !== state.kind && n.entityKind !== state.kind) { return false; }',
  '    return state.query === "" || haystack[idx].indexOf(state.query) !== -1;',
  '  }',
  '  function visible() {',
  '    var out = [];',
  '    for (var k = 0; k < nodes.length; k++) { if (matches(k)) { out.push(k); } }',
  '    out.sort(compare);',
  '    return out;',
  '  }',
  '',
  '  function neighbourList(idx, limit) {',
  '    var ul = el("ul", "nb");',
  '    var list = adj[idx];',
  '    var n = Math.min(list.length, limit);',
  '    var add = function (entry) {',
  '      var li = el("li", "");',
  '      var b = el("button", "nb-btn", shown(String(nodes[entry.other].label)));',
  '      b.setAttribute("type", "button");',
  '      b.setAttribute("dir", "auto");',
  '      b.addEventListener("click", function () { selectNode(entry.other, true); });',
  '      li.appendChild(b);',
  '      var ed = edges[entry.edge];',
  '      var words = own.call(EDGE_WORDS, ed.kind) ? EDGE_WORDS[ed.kind][entry.out ? 0 : 1] : "linked to";',
  '      li.appendChild(el("span", "meta", " " + words + ", weight " + fmt(ed.weight) + ", " + kindName(nodes[entry.other])));',
  '      ul.appendChild(li);',
  '    };',
  '    for (var k = 0; k < n; k++) { add(list[k]); }',
  '    if (list.length > n) { ul.appendChild(el("li", "meta", "and " + (list.length - n) + " more not shown")); }',
  '    return ul;',
  '  }',
  '',
  '  function neighbourCell(idx) {',
  '    var td = el("td", "");',
  '    if (degree[idx] === 0) { td.textContent = "none"; return td; }',
  '    var d = el("details", "");',
  '    d.appendChild(el("summary", "", degree[idx] + (degree[idx] === 1 ? " neighbour" : " neighbours")));',
  '    var filled = false;',
  '    d.addEventListener("toggle", function () {',
  '      if (d.open && !filled) { filled = true; d.appendChild(neighbourList(idx, ROW_NEIGHBOURS)); }',
  '    });',
  '    td.appendChild(d);',
  '    return td;',
  '  }',
  '',
  '  function makeRow(idx) {',
  '    var n = nodes[idx];',
  '    var tr = el("tr", "");',
  '    var th = el("th", "");',
  '    th.setAttribute("scope", "row");',
  '    var b = el("button", "select", shown(String(n.label)));',
  '    b.setAttribute("type", "button");',
  '    b.setAttribute("dir", "auto");',
  '    b.addEventListener("click", function () { selectNode(idx, false); });',
  '    th.appendChild(b);',
  '    tr.appendChild(th);',
  '    tr.appendChild(el("td", "", kindName(n)));',
  '    tr.appendChild(el("td", "num", n.community === null ? "-" : String(n.community)));',
  '    tr.appendChild(el("td", "num", fmt(n.weight)));',
  '    tr.appendChild(el("td", "num", String(degree[idx])));',
  '    tr.appendChild(neighbourCell(idx));',
  '    if (idx === state.selected) { tr.setAttribute("aria-current", "true"); }',
  '    rows[idx] = tr;',
  '    return tr;',
  '  }',
  '',
  '  function renderTable() {',
  '    var order = visible();',
  '    rows = Object.create(null);',
  '    clear(tbody);',
  '    var count = Math.min(order.length, state.page * PAGE);',
  '    for (var k = 0; k < count; k++) { tbody.appendChild(makeRow(order[k])); }',
  '    if (order.length === 0) {',
  '      var tr = el("tr", "");',
  '      var td = el("td", "", nodes.length === 0 ? "This graph has no nodes." : "No node matches the current filters.");',
  '      td.setAttribute("colspan", "6");',
  '      tr.appendChild(td);',
  '      tbody.appendChild(tr);',
  '    }',
  '    moreButton.hidden = count >= order.length;',
  '    resultCount.textContent = "Showing " + count + " of " + order.length + " matching nodes. The graph has " + nodes.length + " nodes and " + edges.length + " edges.";',
  '    return order.length;',
  '  }',
  '',
  '  function renderPanel(idx) {',
  '    clear(panel);',
  '    if (idx < 0) { panel.appendChild(el("p", "", "No node selected. Choose a node in the table or in the diagram.")); return; }',
  '    var n = nodes[idx];',
  '    panel.appendChild(el("h3", "", shown(String(n.label))));',
  '    var dl = el("dl", "props");',
  '    var pairs = [["Kind", kindName(n)], ["Id", String(n.id)], ["Community", n.community === null ? "none" : String(n.community)], ["Weight", fmt(n.weight)], ["Connections", String(degree[idx])]];',
  '    for (var k = 0; k < pairs.length; k++) {',
  '      dl.appendChild(el("dt", "", pairs[k][0]));',
  '      dl.appendChild(el("dd", "", pairs[k][1]));',
  '    }',
  '    panel.appendChild(dl);',
  '    panel.appendChild(el("h4", "", "Neighbours"));',
  '    panel.appendChild(degree[idx] === 0 ? el("p", "", "This node has no connections.") : neighbourList(idx, PANEL_NEIGHBOURS));',
  '  }',
  '',
  '  function markSelected(previous, current) {',
  '    if (previous >= 0 && rows[previous]) { rows[previous].removeAttribute("aria-current"); }',
  '    if (current >= 0 && rows[current]) { rows[current].setAttribute("aria-current", "true"); }',
  '    if (previous >= 0 && svgNodes[previous]) {',
  '      svgNodes[previous].g.setAttribute("class", svgNodes[previous].cls);',
  '      svgNodes[previous].g.setAttribute("aria-pressed", "false");',
  '    }',
  '    if (current >= 0 && svgNodes[current]) {',
  '      svgNodes[current].g.setAttribute("class", svgNodes[current].cls + " sel");',
  '      svgNodes[current].g.setAttribute("aria-pressed", "true");',
  '    }',
  '  }',
  '',
  '  function selectNode(idx, moveFocus) {',
  '    var previous = state.selected;',
  '    var note = "";',
  '    state.selected = idx;',
  '    if (moveFocus && !rows[idx]) {',
  '      if (state.query !== "" || state.kind !== "") {',
  '        state.query = "";',
  '        state.kind = "";',
  '        search.value = "";',
  '        kindSelect.value = "";',
  '        note = " Filters were cleared to show it.";',
  '      }',
  '      var pos = visible().indexOf(idx);',
  '      if (pos >= 0 && Math.ceil((pos + 1) / PAGE) > state.page) { state.page = Math.ceil((pos + 1) / PAGE); }',
  '      renderTable();',
  '    }',
  '    markSelected(previous, idx);',
  '    renderPanel(idx);',
  '    var n = nodes[idx];',
  '    announce("Selected " + kindName(n) + " " + shown(String(n.label)) + ", " + degree[idx] + (degree[idx] === 1 ? " connection." : " connections.") + note);',
  '    if (moveFocus && rows[idx]) {',
  '      var target = rows[idx].querySelector("button.select");',
  '      if (target) { target.focus(); }',
  '      rows[idx].scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });',
  '    }',
  '  }',
  '',
  '  function updateSortHeaders() {',
  '    var buttons = document.querySelectorAll("thead button[data-sort]");',
  '    for (var k = 0; k < buttons.length; k++) {',
  '      var key = buttons[k].getAttribute("data-sort");',
  '      buttons[k].parentNode.setAttribute("aria-sort", key === state.sortKey ? (state.dir === 1 ? "ascending" : "descending") : "none");',
  '    }',
  '  }',
  '',
  '  function refilter() {',
  '    state.page = 1;',
  '    var total = renderTable();',
  '    announce(total + (total === 1 ? " node matches." : " nodes match."));',
  '  }',
  '',
  '  var sortButtons = document.querySelectorAll("thead button[data-sort]");',
  '  Array.prototype.forEach.call(sortButtons, function (btn) {',
  '    btn.addEventListener("click", function () {',
  '      var key = btn.getAttribute("data-sort");',
  '      if (state.sortKey === key) { state.dir = -state.dir; } else { state.sortKey = key; state.dir = 1; }',
  '      updateSortHeaders();',
  '      state.page = 1;',
  '      renderTable();',
  '      announce("Sorted by " + btn.textContent + ", " + (state.dir === 1 ? "ascending." : "descending."));',
  '    });',
  '  });',
  '  search.addEventListener("input", function () { state.query = search.value.toLowerCase(); refilter(); });',
  '  kindSelect.addEventListener("change", function () { state.kind = kindSelect.value; refilter(); });',
  '  byId("filter-clear").addEventListener("click", function () {',
  '    state.query = "";',
  '    state.kind = "";',
  '    search.value = "";',
  '    kindSelect.value = "";',
  '    refilter();',
  '    search.focus();',
  '  });',
  '  moreButton.addEventListener("click", function () {',
  '    state.page += 1;',
  '    renderTable();',
  '    if (moreButton.hidden) { resultCount.focus(); }',
  '    announce(resultCount.textContent);',
  '  });',
  '',
  '  function drawOverview() {',
  '    var svg = byId("overview");',
  '    var ns = svg.namespaceURI;',
  '    var make = function (tag) { return document.createElementNS(ns, tag); };',
  '    var drawn = [];',
  '    for (var k = 0; k < nodes.length; k++) { if (nodes[k].x !== null && nodes[k].y !== null) { drawn.push(k); } }',
  '    var shownNote = byId("overview-count");',
  '    shownNote.textContent = drawn.length === nodes.length ? "The diagram shows all " + nodes.length + " nodes." : "The diagram shows the " + drawn.length + " best connected of " + nodes.length + " nodes; the table lists all of them.";',
  '    var e;',
  '    for (k = 0; k < edges.length; k++) {',
  '      e = edges[k];',
  '      var a = nodes[e.s];',
  '      var b = nodes[e.t];',
  '      if (a.x === null || b.x === null) { continue; }',
  '      var line = make("line");',
  '      line.setAttribute("x1", String(a.x));',
  '      line.setAttribute("y1", String(a.y));',
  '      line.setAttribute("x2", String(b.x));',
  '      line.setAttribute("y2", String(b.y));',
  '      line.setAttribute("class", own.call(EDGE_CLASS, e.kind) ? EDGE_CLASS[e.kind] : "edge");',
  '      line.setAttribute("aria-hidden", "true");',
  '      svg.appendChild(line);',
  '    }',
  '    var byWeight = drawn.slice().sort(function (p, q) { return (degree[q] - degree[p]) || (p - q); });',
  '    var labelled = Object.create(null);',
  '    for (k = 0; k < Math.min(12, byWeight.length); k++) { labelled[byWeight[k]] = true; }',
  '    drawn.forEach(function (idx) {',
  '      var n = nodes[idx];',
  '      var r = 6 + Math.min(10, Math.round(Math.sqrt(degree[idx])));',
  '      var community = typeof n.community === "number" && isFinite(n.community) ? Math.abs(Math.floor(n.community)) % 8 : 7;',
  '      var cls = "nd c" + String(community);',
  '      var g = make("g");',
  '      g.setAttribute("class", cls);',
  '      g.setAttribute("role", "button");',
  '      g.setAttribute("tabindex", "0");',
  '      g.setAttribute("aria-pressed", "false");',
  '      g.setAttribute("aria-label", "Select " + kindName(n) + " " + shown(String(n.label)) + ", " + degree[idx] + (degree[idx] === 1 ? " connection" : " connections"));',
  '      var shape;',
  '      if (n.kind === "conversation") {',
  '        shape = make("rect");',
  '        shape.setAttribute("x", String(n.x - r));',
  '        shape.setAttribute("y", String(n.y - r));',
  '        shape.setAttribute("width", String(2 * r));',
  '        shape.setAttribute("height", String(2 * r));',
  '      } else if (n.kind === "tool") {',
  '        shape = make("polygon");',
  '        shape.setAttribute("points", n.x + "," + (n.y - r - 2) + " " + (n.x + r + 2) + "," + n.y + " " + n.x + "," + (n.y + r + 2) + " " + (n.x - r - 2) + "," + n.y);',
  '      } else {',
  '        shape = make("circle");',
  '        shape.setAttribute("cx", String(n.x));',
  '        shape.setAttribute("cy", String(n.y));',
  '        shape.setAttribute("r", String(r));',
  '      }',
  '      shape.setAttribute("class", "shape");',
  '      g.appendChild(shape);',
  '      var title = make("title");',
  '      title.textContent = String(n.label);',
  '      g.appendChild(title);',
  '      g.addEventListener("click", function () { selectNode(idx, false); });',
  '      g.addEventListener("keydown", function (ev) {',
  '        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); selectNode(idx, false); }',
  '      });',
  '      svg.appendChild(g);',
  '      svgNodes[idx] = { g: g, cls: cls };',
  '      if (labelled[idx]) {',
  '        var text = make("text");',
  '        var full = String(n.label);',
  '        text.setAttribute("x", String(n.x + r + 4));',
  '        text.setAttribute("y", String(n.y + 4));',
  '        text.setAttribute("class", "lbl");',
  '        text.setAttribute("aria-hidden", "true");',
  '        text.textContent = full.length > 24 ? full.slice(0, 24) + ELLIPSIS : full;',
  '        svg.appendChild(text);',
  '      }',
  '    });',
  '  }',
  '',
  '  if (typeof data.title === "string" && data.title !== "") {',
  '    document.title = data.title;',
  '    byId("page-title").textContent = data.title;',
  '  }',
  '  renderTable();',
  '  renderPanel(-1);',
  '  drawOverview();',
  '})();',
].join('\n');

// ---------------------------------------------------------------------------------------------------------------
// Document assembly
// ---------------------------------------------------------------------------------------------------------------

const sha256Source = (text: string): string => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

/** Static part of the CSP; the two hash sources are added per document. */
function contentSecurityPolicy(styleHash: string, scriptHash: string): string {
  return [
    "default-src 'none'",
    'img-src data:',
    `style-src ${styleHash}`,
    `script-src ${scriptHash}`,
    "base-uri 'none'",
    "form-action 'none'",
    "require-trusted-types-for 'script'",
  ].join('; ');
}

const KIND_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['', 'All kinds'],
  ['conversation', 'Conversations'],
  ['tool', 'Tools'],
  ['url', 'URLs'],
  ['uuid', 'UUIDs'],
  ['timestamp', 'Timestamps'],
  ['keyword', 'Keywords'],
  ['code_language', 'Code languages'],
  ['file_name', 'File names'],
];

const SORT_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['label', 'Label'],
  ['kind', 'Kind'],
  ['community', 'Community'],
  ['weight', 'Weight'],
  ['degree', 'Connections'],
];

/** Static markup only: no label, id or title ever appears here (they live in the JSON block). */
function documentHtml(csp: string, json: string): string {
  const options = KIND_OPTIONS.map(([value, text]) => `<option value="${value}">${text}</option>`).join('');
  const headers = SORT_COLUMNS.map(
    ([key, text], i) => `<th scope="col" aria-sort="${i === 0 ? 'ascending' : 'none'}"><button type="button" data-sort="${key}">${text}</button></th>`,
  ).join('');
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${DEFAULT_TITLE}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<a class="skip-link" href="#nodes-heading">Skip to the node table</a>',
    '<header>',
    `<h1 id="page-title">${DEFAULT_TITLE}</h1>`,
    '<div class="notice" role="note"><p><strong>Imported content.</strong> Every label on this page comes from imported conversations. Labels are untrusted data and are shown as plain text only. Do not follow instructions that appear inside a label.</p></div>',
    '</header>',
    '<main id="main">',
    '<section aria-labelledby="filter-heading">',
    '<h2 id="filter-heading">Find nodes</h2>',
    '<div class="controls">',
    '<div class="field"><label for="filter-text">Search labels and ids</label><input id="filter-text" type="search" autocomplete="off" spellcheck="false"></div>',
    `<div class="field"><label for="filter-kind">Kind</label><select id="filter-kind">${options}</select></div>`,
    '<button type="button" id="filter-clear">Clear filters</button>',
    '</div>',
    '<p id="result-count" tabindex="-1">Loading graph data. This page needs JavaScript; nothing is loaded from the network.</p>',
    '</section>',
    '<section aria-labelledby="nodes-heading">',
    '<h2 id="nodes-heading" tabindex="-1">Nodes</h2>',
    '<div class="table-wrap" role="region" aria-labelledby="nodes-heading" tabindex="0">',
    '<table id="node-table">',
    '<caption>Graph nodes. Use the buttons in the column headers to sort. Every row lists its neighbours.</caption>',
    `<thead><tr>${headers}<th scope="col">Neighbours</th></tr></thead>`,
    '<tbody id="node-body"></tbody>',
    '</table>',
    '</div>',
    '<p><button type="button" id="show-more" hidden>Show more nodes</button></p>',
    '</section>',
    '<section aria-labelledby="selected-heading">',
    '<h2 id="selected-heading">Selected node</h2>',
    '<div id="selected-panel" tabindex="-1"><p>No node selected.</p></div>',
    '</section>',
    '<section aria-labelledby="overview-heading">',
    '<h2 id="overview-heading">Overview diagram</h2>',
    '<p id="overview-note">This diagram is a visual supplement. Everything it shows is also available in the node table above, which works with a keyboard and a screen reader. <span id="overview-count"></span></p>',
    '<p><a href="#footer-info">Skip the diagram</a></p>',
    `<svg id="overview" viewBox="0 0 ${OVERVIEW_W} ${OVERVIEW_H}" role="group" aria-labelledby="overview-heading overview-note" focusable="false"></svg>`,
    '<ul class="legend" aria-label="Diagram legend"><li>Square: conversation</li><li>Circle: entity</li><li>Diamond: tool</li><li>Fill colour: community</li><li>Dashed line: mentioned in or uses tool</li><li>Solid line: co-occurs</li></ul>',
    '</section>',
    '</main>',
    '<footer id="footer-info"><p>Generated locally by GCR from your own imported data. This file is self-contained: it loads nothing from the network and can be opened offline.</p></footer>',
    '<div id="live" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>',
    '<noscript><p>This page needs JavaScript to show the graph. The data is embedded in this file as JSON; nothing is loaded from the network.</p></noscript>',
    `<script type="application/json" id="graph-data">${json}</script>`,
    `<script>${PROGRAM}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------------------------

/**
 * Render a graph (typically the result of graphQuery) as one self-contained HTML document. See the file header for the
 * security and accessibility properties. Throws INVALID_ARGUMENT for malformed input or graphs larger than
 * MAX_EXPORT_NODES / MAX_EXPORT_EDGES (export a smaller neighbourhood instead).
 */
export function exportGraphHtml(graph: ExportGraphInput, opts: ExportHtmlOptions = {}): string {
  if (typeof graph !== 'object' || graph === null || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw badArg('graph', 'expected an object with nodes and edges arrays');
  }
  if (typeof opts !== 'object' || opts === null) throw badArg('opts', 'expected an object');
  if (graph.nodes.length > MAX_EXPORT_NODES || graph.edges.length > MAX_EXPORT_EDGES) {
    throw badArg('graph', `too large for one HTML page (max ${MAX_EXPORT_NODES} nodes and ${MAX_EXPORT_EDGES} edges)`, 'Export a smaller neighbourhood: query with fewer nodes or a lower depth.');
  }
  const title = opts.title === undefined ? DEFAULT_TITLE : opts.title;
  if (typeof title !== 'string' || title.length === 0 || title.length > 200) throw badArg('title', 'expected a string of 1 to 200 characters');
  const seed = opts.layoutSeed === undefined ? 1 : opts.layoutSeed;
  if (typeof seed !== 'number' || !Number.isSafeInteger(seed)) throw badArg('layoutSeed', 'expected a safe integer');
  const maxOverview = opts.maxOverviewNodes === undefined ? 150 : opts.maxOverviewNodes;
  if (typeof maxOverview !== 'number' || !Number.isInteger(maxOverview) || maxOverview < 0 || maxOverview > 500) throw badArg('maxOverviewNodes', 'expected an integer from 0 to 500');

  // Nodes keep the caller's order; a repeated id keeps its first occurrence.
  const index = new Map<string, number>();
  const nodes: PageNode[] = [];
  for (const n of graph.nodes) {
    if (typeof n !== 'object' || n === null) throw badArg('graph.nodes', 'expected node objects');
    const id = String(n.id);
    if (index.has(id)) continue;
    index.set(id, nodes.length);
    nodes.push({
      id,
      kind: String(n.kind),
      entityKind: n.entityKind === null || n.entityKind === undefined ? null : String(n.entityKind),
      label: String(n.label),
      weight: finiteOr0(n.weight),
      community: typeof n.communityId === 'number' && Number.isInteger(n.communityId) ? n.communityId : null,
      x: null,
      y: null,
    });
  }
  const edges: PageEdge[] = [];
  const weighted = new Float64Array(nodes.length);
  for (const e of graph.edges) {
    if (typeof e !== 'object' || e === null) throw badArg('graph.edges', 'expected edge objects');
    const s = index.get(String(e.src));
    const t = index.get(String(e.dst));
    if (s === undefined || t === undefined) continue; // an edge to a node that is not part of the export cannot be shown
    const weight = finiteOr0(e.weight);
    edges.push({ id: finiteOr0(e.id), s, t, kind: String(e.kind), weight });
    weighted[s] = (weighted[s] as number) + Math.abs(weight);
    weighted[t] = (weighted[t] as number) + Math.abs(weight);
  }

  // Overview: the best connected nodes (ties by position) get coordinates; the table always lists all nodes.
  const ranked = nodes.map((_, i) => i).sort((a, b) => (weighted[b] as number) - (weighted[a] as number) || a - b);
  const subset = ranked.slice(0, maxOverview).sort((a, b) => a - b);
  const position = new Map<number, number>();
  subset.forEach((nodeIdx, p) => position.set(nodeIdx, p));
  const pairs: Array<readonly [number, number]> = [];
  for (const e of edges) {
    const a = position.get(e.s);
    const b = position.get(e.t);
    if (a !== undefined && b !== undefined && a !== b) pairs.push([a, b]);
  }
  const { x, y } = layout(subset, pairs, seed);
  subset.forEach((nodeIdx, p) => {
    const node = nodes[nodeIdx] as PageNode;
    node.x = x[p] as number;
    node.y = y[p] as number;
  });

  const json = jsonForScript({ title, nodes, edges });
  const csp = contentSecurityPolicy(sha256Source(STYLE), sha256Source(PROGRAM));
  return documentHtml(csp, json);
}
