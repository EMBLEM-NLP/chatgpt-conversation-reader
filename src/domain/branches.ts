/**
 * Message-tree reconstruction: branch enumeration, active-branch marking, thread extraction (SPEC FR-04,
 * ARCHITECTURE section 4). Pure, deterministic, ITERATIVE (no recursion anywhere: a 200k-deep chain is fine) and
 * cycle-safe. Inputs are untrusted; warnings carry ids and counts only, never message text.
 *
 * Model: PARENT POINTERS are authoritative for structure. `childIds` (declared by the source, in source order) is only
 * used to order siblings, and only when it agrees exactly with the parent pointers. Disagreements are reported as
 * CHILD_PARENT_MISMATCH and never silently "fixed".
 *
 * Determinism: nothing depends on the order of the input array. All ordering uses one total order,
 * (createdAt asc with null LAST, ordinal asc, id asc), compared with plain `<` (never locale-aware comparison) and
 * with timestamps parsed by validate.ts' strict parser (never `Date.parse`, which is time-zone dependent for
 * zone-less strings). No clock or randomness is used.
 *
 * Extra warning codes beyond the contract list (all id-only): DUPLICATE_NODE_ID and CURRENT_NODE_NOT_LEAF.
 *
 * Untrusted arguments: every public function type-checks its arguments (`messages` must be an array of objects with
 * string ids; parentId null/undefined/string; childIds an array of strings, or absent) and throws GcrError
 * INVALID_ARGUMENT otherwise, with content-free details (an index and a field name). Nothing here can throw a raw
 * TypeError because of a wrong-typed JSON value. (Objects whose property ACCESSORS throw are out of scope: this module
 * works on plain data, not on exotic proxies.)
 */
import { GcrError } from '../errors.js';
import type { Warning } from '../errors.js';
import type { Branch, BranchActiveness, MessageRecord, TreeAnalysis } from './types.js';
import { parseIsoUtcToEpochMs } from './validate.js';

/** Default cap on enumerated branches (leaves). */
export const DEFAULT_MAX_BRANCHES = 10_000;
/**
 * Default cap on the SUM of all branch path lengths. Each branch stores its full path, so a deep tree with many leaves
 * (a 100k-long chain with 100k leaves hanging off it) would need ~5*10^9 path entries: this bound is what stops that
 * quadratic-memory blow-up.
 */
export const DEFAULT_MAX_TOTAL_PATH_NODES = 5_000_000;

/** Longest id list attached to one warning (the true total is stated in the message). */
const MAX_WARNING_IDS = 1000;
/** Individually reported cycles; further cycles are summarized in one extra warning. */
const MAX_CYCLE_WARNINGS = 100;
const MAX_ID_ECHO = 512;

export interface AnalyzeOptions {
  /** Positive integer (or Infinity). Default 10_000. */
  maxBranches?: number;
  /** Positive integer (or Infinity). Default 5_000_000. */
  maxTotalPathNodes?: number;
}

export interface ThreadOptions {
  /** Include messages the source marked hidden. Default false. */
  includeHidden?: boolean;
  /** Include structural_empty placeholder nodes. Default false. */
  includeStructural?: boolean;
}

export type BranchPolicy = 'last_child' | 'latest_leaf';

// ------------------------------------------------------------------------------------------
// Argument guards (untrusted input: JSON-shaped garbage must end in INVALID_ARGUMENT, not a raw TypeError)
// ------------------------------------------------------------------------------------------

function invalidArgument(message: string, details: Record<string, unknown>): never {
  throw new GcrError('INVALID_ARGUMENT', message, { details });
}

/** Content-free: reports an index and a field NAME, never a value. */
function assertMessageList(messages: unknown): asserts messages is readonly MessageRecord[] {
  if (!Array.isArray(messages)) invalidArgument('messages must be an array of message records.', { argument: 'messages' });
  for (let i = 0; i < messages.length; i++) {
    const msg: unknown = messages[i]; // a hole in a sparse array reads as undefined and is rejected here
    if (typeof msg !== 'object' || msg === null) invalidArgument('messages must contain only message records (objects).', { argument: 'messages', index: i, field: 'record' });
    const r = msg as { id?: unknown; parentId?: unknown; childIds?: unknown };
    if (typeof r.id !== 'string') invalidArgument('Every message needs a string id.', { argument: 'messages', index: i, field: 'id' });
    if (r.parentId !== null && r.parentId !== undefined && typeof r.parentId !== 'string') {
      invalidArgument('A message parentId must be a string or null.', { argument: 'messages', index: i, field: 'parentId' });
    }
    // An absent or non-array childIds is tolerated (= "declares nothing"); an array must hold only strings.
    if (Array.isArray(r.childIds)) {
      for (const c of r.childIds as unknown[]) {
        if (typeof c !== 'string') invalidArgument('A message childIds list must contain only strings.', { argument: 'messages', index: i, field: 'childIds' });
      }
    }
  }
}

function assertOptionsObject(opts: unknown, name: string): void {
  if (typeof opts !== 'object' || opts === null) invalidArgument(`${name} must be an object.`, { argument: name });
}

/** A TreeAnalysis as produced by analyzeTree: only the parts the callers read are checked, all in O(#branches). */
function assertAnalysis(analysis: unknown, needRootIds: boolean): asserts analysis is TreeAnalysis {
  const a = analysis as { branches?: unknown; rootIds?: unknown } | null | undefined;
  if (typeof analysis !== 'object' || a === null || a === undefined || !Array.isArray(a.branches) || (needRootIds && !Array.isArray(a.rootIds))) {
    invalidArgument('analysis must be a TreeAnalysis returned by analyzeTree.', { argument: 'analysis' });
  }
  for (const b of a.branches as unknown[]) {
    const br = b as { branchId?: unknown; leafId?: unknown; path?: unknown } | null | undefined;
    if (typeof b !== 'object' || br === null || br === undefined || typeof br.branchId !== 'string' || typeof br.leafId !== 'string' || !Array.isArray(br.path)) {
      invalidArgument('analysis.branches must hold branches returned by analyzeTree.', { argument: 'analysis' });
    }
  }
}

// ------------------------------------------------------------------------------------------
// Node index and the single total order
// ------------------------------------------------------------------------------------------

interface TreeNode {
  id: string;
  msg: MessageRecord;
  /** createdAt as epoch ms; Infinity when null/invalid so that unknown times sort LAST. */
  key: number;
  /** Source ordinal, sanitized to a finite number so the comparator is a true total order. */
  ordinal: number;
  isMessage: boolean;
  isVisible: boolean;
}

function makeNode(msg: MessageRecord): TreeNode {
  const ms = parseIsoUtcToEpochMs(msg.createdAt);
  const isMessage = msg.nodeKind !== 'structural_empty';
  return {
    id: msg.id,
    msg,
    key: ms === null ? Number.POSITIVE_INFINITY : ms,
    ordinal: Number.isFinite(msg.ordinal) ? msg.ordinal : Number.MAX_SAFE_INTEGER,
    isMessage,
    isVisible: isMessage && msg.hidden !== true,
  };
}

/** (createdAt asc, null last), then ordinal asc, then id asc. Ids are unique per index, so this is a strict total order. */
function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.key !== b.key) return a.key < b.key ? -1 : 1;
  if (a.ordinal !== b.ordinal) return a.ordinal < b.ordinal ? -1 : 1;
  return compareStrings(a.id, b.id);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Duplicate ids cannot occur in a validated record (validate.ts rejects them) but analyzeTree is also fed raw data.
 * Which duplicate wins must not depend on the order of the input array, so the preference is a total preorder over
 * every field that can change an analysis or a thread (structure first, then flags, then the remaining scalar fields
 * and the text). Only records that agree on ALL of these (true clones) are tie-broken by input order, and for those the
 * choice is unobservable except through blocks/attachments/rawSource. The comparison reads content but never emits it.
 */
const DUPLICATE_TIEBREAK_FIELDS = ['createdAt', 'updatedAt', 'conversationId', 'authorRole', 'authorName', 'modelSlug', 'channel', 'recipient', 'contentType', 'status', 'text'] as const;

/** null/non-strings first, then plain code-unit order. */
function compareNullableText(a: unknown, b: unknown): number {
  const sa = typeof a === 'string' ? a : null;
  const sb = typeof b === 'string' ? b : null;
  if (sa === null || sb === null) return sa === sb ? 0 : sa === null ? -1 : 1;
  return compareStrings(sa, sb);
}

function compareStringLists(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = compareStrings(a[i] as string, b[i] as string);
    if (d !== 0) return d;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** Negative when `a` is the record to keep, positive when `b` is, 0 for interchangeable clones. */
function compareDuplicates(a: TreeNode, b: TreeNode): number {
  if (a.ordinal !== b.ordinal) return a.ordinal < b.ordinal ? -1 : 1;
  if (a.key !== b.key) return a.key < b.key ? -1 : 1;
  let d = compareNullableText(a.msg.parentId, b.msg.parentId); // null parent (a root) before any named parent
  if (d !== 0) return d;
  d = compareStringLists(declaredChildren(a), declaredChildren(b));
  if (d !== 0) return d;
  if (a.isMessage !== b.isMessage) return a.isMessage ? -1 : 1;
  const aHidden = a.msg.hidden === true;
  if (aHidden !== (b.msg.hidden === true)) return aHidden ? 1 : -1;
  for (const field of DUPLICATE_TIEBREAK_FIELDS) {
    d = compareNullableText(a.msg[field], b.msg[field]);
    if (d !== 0) return d;
  }
  return 0;
}

function prefersOver(a: TreeNode, b: TreeNode): boolean {
  return compareDuplicates(a, b) < 0;
}

/** The declared child list, tolerating a missing/garbled field in unvalidated input. */
function declaredChildren(n: TreeNode): readonly string[] {
  return Array.isArray(n.msg.childIds) ? n.msg.childIds : [];
}

function indexMessages(messages: readonly MessageRecord[]): { nodes: Map<string, TreeNode>; duplicateIds: Set<string> } {
  const nodes = new Map<string, TreeNode>();
  const duplicateIds = new Set<string>();
  for (const msg of messages) {
    const node = makeNode(msg);
    const existing = nodes.get(node.id);
    if (existing === undefined) {
      nodes.set(node.id, node);
    } else {
      duplicateIds.add(node.id);
      if (prefersOver(node, existing)) nodes.set(node.id, node);
    }
  }
  return { nodes, duplicateIds };
}

// ------------------------------------------------------------------------------------------
// Structure: roots, ordered children, anomalies
// ------------------------------------------------------------------------------------------

interface Structure {
  nodes: Map<string, TreeNode>;
  /** All nodes in the total order. */
  ordered: TreeNode[];
  /** parent id -> children in VISIT order. Only parents that actually have children are present. */
  kids: Map<string, readonly string[]>;
  /** Roots (parentId null, or parent missing) in the total order. */
  rootIds: string[];
  selfParentIds: string[];
  missingParentIds: string[];
  /** Ids involved in a declared-vs-actual child disagreement (parents, children, dangling declared ids). */
  mismatchIds: Set<string>;
  duplicateIds: Set<string>;
}

/**
 * true iff `declared` is a permutation of `actual` (same members, no repeats). Otherwise records every offending id.
 * `actual` is derived from the children's parent pointers (the authority), so every difference is a real disagreement:
 * a declared child that does not exist or points elsewhere, a child its parent does not list, or a repeated entry.
 */
function declaredMatchesActual(parentId: string, declared: readonly string[], actual: readonly string[], involved: Set<string>): boolean {
  if (declared.length === 1 && actual.length === 1) {
    // Fast path for the overwhelmingly common linear chain: no Set allocation.
    if (declared[0] === actual[0]) return true;
    involved.add(parentId);
    if (declared[0] !== undefined) involved.add(declared[0]);
    if (actual[0] !== undefined) involved.add(actual[0]);
    return false;
  }
  const declaredSet = new Set(declared);
  const actualSet = new Set(actual);
  let ok = declared.length === actual.length && declaredSet.size === declared.length;
  if (declaredSet.size !== declared.length) {
    const seen = new Set<string>();
    for (const d of declared) {
      if (seen.has(d)) involved.add(d);
      seen.add(d);
    }
  }
  for (const d of declaredSet) {
    if (!actualSet.has(d)) {
      ok = false;
      involved.add(d);
    }
  }
  for (const a of actualSet) {
    if (!declaredSet.has(a)) {
      ok = false;
      involved.add(a);
    }
  }
  if (!ok) involved.add(parentId);
  return ok;
}

function buildStructure(messages: readonly MessageRecord[]): Structure {
  const { nodes, duplicateIds } = indexMessages(messages);
  const ordered = Array.from(nodes.values()).sort(compareNodes);

  // Actual children from parent pointers. Iterating in the total order makes every child list already sorted by
  // (createdAt, ordinal, id): the fallback order used when the declared order is unusable.
  const actual = new Map<string, string[]>();
  const rootIds: string[] = [];
  const selfParentIds: string[] = [];
  const missingParentIds: string[] = [];
  for (const n of ordered) {
    const p = n.msg.parentId;
    if (p === null || p === undefined) {
      rootIds.push(n.id);
    } else if (p === n.id) {
      // A node that is its own parent is a 1-cycle: it can never be reached from a root.
      selfParentIds.push(n.id);
    } else if (!nodes.has(p)) {
      // Dangling pointer: treat the node as a root (and say so) instead of dropping its whole subtree.
      missingParentIds.push(n.id);
      rootIds.push(n.id);
    } else {
      const list = actual.get(p);
      if (list === undefined) actual.set(p, [n.id]);
      else list.push(n.id);
    }
  }

  // Visit order: the declared order when it agrees exactly with the parent pointers, else the sorted fallback.
  const kids = new Map<string, readonly string[]>();
  const mismatchIds = new Set<string>();
  const selfParentSet = new Set(selfParentIds);
  for (const n of ordered) {
    // A self-parent node lists itself as a child in a consistent export; that loop is already reported as
    // SELF_PARENT, so its own id is left out of the comparison instead of raising a second, redundant warning.
    const rawDeclared = declaredChildren(n);
    const declared = selfParentSet.has(n.id) ? rawDeclared.filter((d) => d !== n.id) : rawDeclared;
    const act = actual.get(n.id);
    if (declared.length === 0 && act === undefined) continue;
    const actualList = act ?? [];
    const consistent = declaredMatchesActual(n.id, declared, actualList, mismatchIds);
    if (actualList.length > 0) kids.set(n.id, consistent ? declared : actualList);
  }

  return { nodes, ordered, kids, rootIds, selfParentIds, missingParentIds, mismatchIds, duplicateIds };
}

// ------------------------------------------------------------------------------------------
// Warnings
// ------------------------------------------------------------------------------------------

function echoId(id: string): string {
  return id.length > MAX_ID_ECHO ? id.slice(0, MAX_ID_ECHO) : id;
}

/** Warning with a sorted, de-duplicated, capped id list. */
function idsWarning(code: string, message: string, ids: Iterable<string>): Warning {
  const sorted = Array.from(new Set(ids)).sort(compareStrings);
  const total = sorted.length;
  const shown = total > MAX_WARNING_IDS ? sorted.slice(0, MAX_WARNING_IDS) : sorted;
  return {
    code,
    message: total > MAX_WARNING_IDS ? `${message} (${total} ids; first ${MAX_WARNING_IDS} listed)` : message,
    ids: shown.map(echoId),
  };
}

/**
 * Cycles among the nodes that no root can reach. Every unreachable node has exactly one (existing) parent, so the
 * graph restricted to them is functional: each walk up the parent pointers ends in a cycle or in an already-seen
 * node. Linear time, iterative. Each cycle is rotated to start at its smallest id so the output does not depend on
 * where the walk entered it. Self-parent nodes are reported separately (SELF_PARENT) and excluded here.
 */
function findCycles(unreachable: readonly TreeNode[], nodes: Map<string, TreeNode>): string[][] {
  const state = new Map<string, 1 | 2>(); // 1 = on the current walk, 2 = finished
  const cycles: string[][] = [];
  const startOrder = unreachable.map((n) => n.id).sort(compareStrings);
  for (const start of startOrder) {
    if (state.has(start)) continue;
    const walk: string[] = [];
    const position = new Map<string, number>();
    let cur: string | undefined = start;
    while (cur !== undefined) {
      const s = state.get(cur);
      if (s === 2) break;
      if (s === 1) {
        const from = position.get(cur);
        if (from !== undefined) {
          const cycle = walk.slice(from);
          if (cycle.length > 1) cycles.push(rotateToSmallest(cycle));
        }
        break;
      }
      state.set(cur, 1);
      position.set(cur, walk.length);
      walk.push(cur);
      cur = nodes.get(cur)?.msg.parentId ?? undefined;
    }
    for (const id of walk) state.set(id, 2);
  }
  return cycles.sort((a, b) => compareStrings(a[0] ?? '', b[0] ?? ''));
}

function rotateToSmallest(cycle: string[]): string[] {
  let min = 0;
  for (let i = 1; i < cycle.length; i++) {
    if (compareStrings(cycle[i] ?? '', cycle[min] ?? '') < 0) min = i;
  }
  return min === 0 ? cycle : cycle.slice(min).concat(cycle.slice(0, min));
}

// ------------------------------------------------------------------------------------------
// analyzeTree
// ------------------------------------------------------------------------------------------

function resolveLimit(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !(value >= 1) || (Number.isFinite(value) && !Number.isInteger(value))) {
    throw new GcrError('INVALID_ARGUMENT', `${name} must be a positive integer (or Infinity).`, { details: { option: name } });
  }
  return value;
}

interface RawBranch {
  path: string[];
  messageCount: number;
  visibleMessageCount: number;
}

type CurrentState =
  | { kind: 'none' }
  | { kind: 'invalid'; reason: 'not_a_node' | 'unreachable' }
  | { kind: 'valid'; id: string; depth: number };

/**
 * Reconstructs every root->leaf branch of a conversation's message tree.
 *
 * Roots are nodes whose parentId is null or names a missing node. A branch is one root->leaf path; branchId is the leaf
 * id. Branches are ordered by (leaf createdAt asc, null last; leaf ordinal; leaf id) and `index` follows that order.
 * Children are visited in the declared `childIds` order when it agrees with the parent pointers, else in sorted order;
 * the visit order only matters when enumeration is truncated by the limits (the first leaves visited are kept).
 *
 * The active branch comes ONLY from a valid `currentNodeId` (a node reachable from a root); otherwise every branch is
 * 'unknown' and `activeBranchId` is null: nothing is inferred. If currentNodeId is a non-leaf, every branch through it
 * is 'contains_current_node' and activeBranchId is the first of them (with a CURRENT_NODE_NOT_LEAF warning when that
 * is a choice among several).
 *
 * `leafIds` lists ALL reachable leaves even when enumeration was truncated (BRANCH_LIMIT_EXCEEDED); `branches` then
 * holds only the enumerated ones. `unreachableIds` holds only nodes no root can reach (cycles and their descendants).
 */
export function analyzeTree(conversationId: string, messages: readonly MessageRecord[], currentNodeId: string | null, opts: AnalyzeOptions = {}): TreeAnalysis {
  if (typeof conversationId !== 'string') invalidArgument('conversationId must be a string.', { argument: 'conversationId' });
  assertOptionsObject(opts, 'opts');
  assertMessageList(messages);
  const maxBranches = resolveLimit('maxBranches', opts.maxBranches, DEFAULT_MAX_BRANCHES);
  const maxTotalPathNodes = resolveLimit('maxTotalPathNodes', opts.maxTotalPathNodes, DEFAULT_MAX_TOTAL_PATH_NODES);
  const s = buildStructure(messages);
  const warnings: Warning[] = [];

  if (s.duplicateIds.size > 0) {
    warnings.push(idsWarning('DUPLICATE_NODE_ID', 'Several messages share an id; one was chosen deterministically and the others ignored.', s.duplicateIds));
  }
  if (s.selfParentIds.length > 0) {
    warnings.push(idsWarning('SELF_PARENT', 'Nodes list themselves as their own parent; they are unreachable from any root.', s.selfParentIds));
  }
  if (s.missingParentIds.length > 0) {
    warnings.push(idsWarning('MISSING_PARENT', 'Nodes name a parent that does not exist; each is treated as a root.', s.missingParentIds));
  }
  if (s.mismatchIds.size > 0) {
    warnings.push(
      idsWarning(
        'CHILD_PARENT_MISMATCH',
        'Declared child lists disagree with parent pointers (a declared child is absent or has another parent, or a child is not listed by its parent); parent pointers were used.',
        s.mismatchIds,
      ),
    );
  }

  // --- reachability from the roots (iterative) --------------------------------------------------------------
  const reachable = new Set<string>();
  const leafNodes: TreeNode[] = [];
  const walkStack: string[] = [];
  for (let i = s.rootIds.length - 1; i >= 0; i--) walkStack.push(s.rootIds[i] as string);
  while (walkStack.length > 0) {
    const id = walkStack.pop() as string;
    reachable.add(id);
    const children = s.kids.get(id);
    if (children === undefined) {
      const leaf = s.nodes.get(id);
      if (leaf !== undefined) leafNodes.push(leaf);
    } else {
      for (const c of children) walkStack.push(c);
    }
  }
  leafNodes.sort(compareNodes);

  const unreachable = s.ordered.filter((n) => !reachable.has(n.id));
  if (unreachable.length > 0) {
    const cycles = findCycles(unreachable, s.nodes);
    cycles.slice(0, MAX_CYCLE_WARNINGS).forEach((cycle) => {
      // A capped id list no longer closes on itself, so the message must not claim that it does.
      const order =
        cycle.length > MAX_WARNING_IDS
          ? `only the first ${MAX_WARNING_IDS} ids are listed, in cycle order: each id's parent is the next id in the list`
          : "each id's parent is the next id in the list, the last one's parent is the first";
      warnings.push({
        code: 'CYCLE_DETECTED',
        message: `Parent pointers form a cycle of ${cycle.length} nodes (${order}). These nodes and their descendants are unreachable from any root.`,
        ids: cycle.slice(0, MAX_WARNING_IDS).map(echoId),
      });
    });
    if (cycles.length > MAX_CYCLE_WARNINGS) {
      warnings.push({ code: 'CYCLE_DETECTED', message: `${cycles.length - MAX_CYCLE_WARNINGS} further cycles were detected and are not listed individually.` });
    }
  }

  // --- the current node ---------------------------------------------------------------------------------------
  let current: CurrentState;
  if (currentNodeId === null || currentNodeId === undefined) {
    current = { kind: 'none' };
    warnings.push({ code: 'NO_CURRENT_NODE', message: 'The source gave no active-branch pointer; activeness is unknown for every branch.', ids: [echoId(conversationId)] });
  } else if (typeof currentNodeId !== 'string' || !s.nodes.has(currentNodeId)) {
    current = { kind: 'invalid', reason: 'not_a_node' };
    warnings.push({
      code: 'INVALID_CURRENT_NODE',
      message: 'currentNodeId does not name a node of this conversation; activeness is unknown for every branch.',
      ids: typeof currentNodeId === 'string' ? [echoId(currentNodeId)] : [],
    });
  } else if (!reachable.has(currentNodeId)) {
    current = { kind: 'invalid', reason: 'unreachable' };
    warnings.push({
      code: 'INVALID_CURRENT_NODE',
      message: 'currentNodeId names a node that no root can reach (it lies on or below a cycle); activeness is unknown for every branch.',
      ids: [echoId(currentNodeId)],
    });
  } else {
    // Depth = number of ancestors. The node is reachable, so the walk ends at a root; the counter is belt and braces.
    let depth = 0;
    let cursor: TreeNode | undefined = s.nodes.get(currentNodeId);
    while (cursor !== undefined && depth <= s.nodes.size) {
      const parentId: string | null = cursor.msg.parentId;
      const parent: TreeNode | undefined = parentId === null || parentId === cursor.id ? undefined : s.nodes.get(parentId);
      if (parent === undefined) break;
      depth++;
      cursor = parent;
    }
    current = { kind: 'valid', id: currentNodeId, depth };
  }

  // --- iterative DFS with explicit limits ---------------------------------------------------------------------
  const raw: RawBranch[] = [];
  let totalPathNodes = 0;
  let truncatedBy: 'maxBranches' | 'maxTotalPathNodes' | null = null;
  const path: string[] = [];
  const cursors: number[] = [];
  let messageCount = 0;
  let visibleMessageCount = 0;

  const push = (id: string): void => {
    const node = s.nodes.get(id);
    if (node !== undefined) {
      if (node.isMessage) messageCount++;
      if (node.isVisible) visibleMessageCount++;
    }
    path.push(id);
    cursors.push(0);
  };
  const pop = (): void => {
    const id = path.pop();
    cursors.pop();
    const node = id === undefined ? undefined : s.nodes.get(id);
    if (node !== undefined) {
      if (node.isMessage) messageCount--;
      if (node.isVisible) visibleMessageCount--;
    }
  };

  enumerate: for (const rootId of s.rootIds) {
    push(rootId);
    while (path.length > 0) {
      const depth = path.length - 1;
      const id = path[depth] as string;
      const children = s.kids.get(id);
      if (children === undefined) {
        // Leaf. The limits are checked BEFORE the O(depth) path copy: this is what bounds memory.
        if (raw.length >= maxBranches) {
          truncatedBy = 'maxBranches';
          break enumerate;
        }
        if (totalPathNodes + path.length > maxTotalPathNodes) {
          truncatedBy = 'maxTotalPathNodes';
          break enumerate;
        }
        raw.push({ path: path.slice(), messageCount, visibleMessageCount });
        totalPathNodes += path.length;
        pop();
        continue;
      }
      const next = cursors[depth] as number;
      if (next < children.length) {
        cursors[depth] = next + 1;
        push(children[next] as string);
      } else {
        pop();
      }
    }
  }

  // --- branch objects -----------------------------------------------------------------------------------------
  const withLeaf = raw
    .map((r) => ({ r, leaf: s.nodes.get(r.path[r.path.length - 1] as string) as TreeNode }))
    .sort((a, b) => compareNodes(a.leaf, b.leaf));

  // forkNodeId = deepest node this branch shares with ANY earlier branch (earlier = lower index). Instead of comparing
  // against every earlier branch (quadratic), keep the set of nodes already used by earlier paths: the shared prefix
  // is exactly the leading run of this path that is already in the set. Roots are distinct trees, so ids never
  // collide across roots, and the first branch of each root finds nothing claimed -> null.
  const claimed = new Set<string>();
  const branches: Branch[] = withLeaf.map(({ r }, index) => {
    const p = r.path;
    let shared = 0;
    while (shared < p.length && claimed.has(p[shared] as string)) shared++;
    const forkNodeId = shared > 0 ? (p[shared - 1] as string) : null;
    for (let j = shared; j < p.length; j++) claimed.add(p[j] as string);
    const leafId = p[p.length - 1] as string;
    let activeness: BranchActiveness = 'unknown';
    if (current.kind === 'valid') {
      // The branch contains the current node iff the node at the current node's depth IS the current node (paths are
      // root-anchored), an O(1) test instead of scanning the path.
      activeness = leafId === current.id ? 'active' : p[current.depth] === current.id ? 'contains_current_node' : 'inactive';
    }
    return {
      branchId: leafId,
      index,
      rootId: p[0] as string,
      leafId,
      path: p,
      visibleMessageCount: r.visibleMessageCount,
      messageCount: r.messageCount,
      forkNodeId,
      activeness,
    };
  });

  let activeBranchId: string | null = null;
  if (current.kind === 'valid') {
    const exact = branches.find((b) => b.activeness === 'active');
    if (exact !== undefined) {
      activeBranchId = exact.branchId;
    } else {
      const containing = branches.filter((b) => b.activeness === 'contains_current_node');
      const first = containing[0];
      if (first !== undefined) {
        activeBranchId = first.branchId;
        if (containing.length > 1) {
          warnings.push({
            code: 'CURRENT_NODE_NOT_LEAF',
            message: `currentNodeId is not a leaf and ${containing.length} branches pass through it; activeBranchId is the first of them in branch order.`,
            ids: [echoId(current.id)],
          });
        }
      }
    }
  }

  if (truncatedBy !== null) {
    const enumerated = new Set(branches.map((b) => b.leafId));
    const skippedLeaves = leafNodes.filter((n) => !enumerated.has(n.id)).map((n) => n.id);
    const activeNote =
      current.kind === 'valid' && activeBranchId === null ? ' The branch containing currentNodeId was NOT enumerated (activeBranchId is null).' : '';
    warnings.push(
      idsWarning(
        'BRANCH_LIMIT_EXCEEDED',
        `Branch enumeration was truncated (limit reached: ${truncatedBy}; maxBranches=${maxBranches}, maxTotalPathNodes=${maxTotalPathNodes}). ` +
          `${branches.length} of ${leafNodes.length} branches were enumerated, in visit order; ids lists leaves that were not.${activeNote}`,
        skippedLeaves,
      ),
    );
  }

  return {
    conversationId,
    rootIds: s.rootIds,
    leafIds: leafNodes.map((n) => n.id),
    branches,
    activeBranchId,
    unreachableIds: unreachable.map((n) => n.id),
    warnings,
  };
}

// ------------------------------------------------------------------------------------------
// threadForBranch
// ------------------------------------------------------------------------------------------

/**
 * The messages of one branch in root->leaf order. By default hidden messages and structural placeholder nodes are
 * omitted. Throws BRANCH_NOT_FOUND for an unknown branch id and MESSAGE_NOT_FOUND when `messages` does not contain a
 * node of the branch path (the analysis and the messages passed in must belong together).
 * Returns the caller's own message objects (no copies).
 */
export function threadForBranch(analysis: TreeAnalysis, messages: readonly MessageRecord[], branchId: string, opts: ThreadOptions = {}): MessageRecord[] {
  assertAnalysis(analysis, false);
  if (typeof branchId !== 'string') {
    throw new GcrError('INVALID_ARGUMENT', 'branchId must be a string.', { details: { option: 'branchId' } });
  }
  assertMessageList(messages);
  assertOptionsObject(opts, 'opts');
  const branch = analysis.branches.find((b) => b.branchId === branchId);
  if (branch === undefined) {
    // A truncated analysis (BRANCH_LIMIT_EXCEEDED) lists every leaf in leafIds but only enumerates some of them: tell the
    // caller that a real leaf was skipped by the limits instead of claiming that no such branch exists.
    const skippedByLimits = Array.isArray(analysis.leafIds) && analysis.leafIds.includes(branchId);
    throw new GcrError('BRANCH_NOT_FOUND', skippedByLimits ? 'This leaf exists but its branch was not enumerated: the analysis was truncated by its branch limits.' : 'No such branch in this conversation.', {
      remedy: skippedByLimits
        ? 'Run analyzeTree again with a higher maxBranches / maxTotalPathNodes (the BRANCH_LIMIT_EXCEEDED warning lists the skipped leaves).'
        : 'List the branches first and pass one of the returned branch ids (a branch id is the id of its leaf message).',
      details: { branchId: echoId(branchId), reason: skippedByLimits ? 'not_enumerated' : 'unknown_branch' },
    });
  }
  const includeHidden = opts.includeHidden === true;
  const includeStructural = opts.includeStructural === true;

  // Only nodes on this path are indexed (memory proportional to the path, one pass over `messages`).
  const wanted = new Set(branch.path);
  const chosen = new Map<string, TreeNode>();
  for (const msg of messages) {
    if (!wanted.has(msg.id)) continue;
    const node = makeNode(msg);
    const existing = chosen.get(node.id);
    if (existing === undefined || prefersOver(node, existing)) chosen.set(node.id, node);
  }

  const out: MessageRecord[] = [];
  for (const id of branch.path) {
    const node = chosen.get(id);
    if (node === undefined) {
      throw new GcrError('MESSAGE_NOT_FOUND', 'A message on the branch path is missing from the supplied messages.', { details: { messageId: echoId(id) } });
    }
    if (!node.isMessage && !includeStructural) continue;
    if (node.msg.hidden === true && !includeHidden) continue;
    out.push(node.msg);
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// selectBranchByPolicy (explicit, labelled heuristics; never the default)
// ------------------------------------------------------------------------------------------

/**
 * HEURISTIC active-branch choice for callers that explicitly opt in (ADR-0009). The source did not say which branch is
 * active, so the result is always accompanied by an ACTIVE_BRANCH_HEURISTIC warning that must be shown to the user.
 *
 *  - 'last_child':  from the FIRST root, follow the last child at every node (declared order when it agrees with the
 *                   parent pointers, else the sorted fallback) down to a leaf.
 *  - 'latest_leaf': the branch whose leaf has the greatest createdAt among ALL reachable leaves (`analysis.leafIds`, which is
 *                   complete even for a truncated analysis); ties by greater ordinal, then greater id. Leaves without a
 *                   usable timestamp never win; if no leaf has one the result is null (no guessing).
 *
 * Returns null when no branch can be selected (no branches, no timestamps, or a truncated analysis whose enumerated
 * branches do not include the chosen leaf: a truncated analysis never yields a different answer than the full one).
 */
export function selectBranchByPolicy(analysis: TreeAnalysis, messages: readonly MessageRecord[], policy: BranchPolicy): { branch: Branch; warning: Warning } | null {
  if (policy !== 'last_child' && policy !== 'latest_leaf') {
    throw new GcrError('INVALID_ARGUMENT', "policy must be 'last_child' or 'latest_leaf'.", { details: { option: 'policy' } });
  }
  assertAnalysis(analysis, true);
  assertMessageList(messages);
  let branch: Branch | undefined;
  if (policy === 'last_child') {
    const firstRoot = analysis.rootIds[0];
    if (firstRoot === undefined) return null;
    const s = buildStructure(messages);
    let cur = firstRoot;
    let steps = 0;
    // Iterative, bounded by the node count (a mismatched analysis/messages pair cannot loop forever).
    for (;;) {
      const children = s.kids.get(cur);
      if (children === undefined || children.length === 0) break;
      cur = children[children.length - 1] as string;
      if (++steps > s.nodes.size) return null;
    }
    const leaf = cur;
    branch = analysis.branches.find((b) => b.leafId === leaf);
  } else {
    const { nodes } = indexMessages(messages);
    // Candidates are ALL reachable leaves (`leafIds` stays complete when enumeration was truncated), not just the enumerated
    // branches: otherwise a truncated analysis would present the newest ENUMERATED leaf as "the latest leaf". If the real
    // winner was not enumerated there is no Branch to return and the result is null (same rule as 'last_child').
    const candidateIds: readonly unknown[] = Array.isArray(analysis.leafIds) ? analysis.leafIds : analysis.branches.map((b) => b.leafId);
    let best: TreeNode | undefined;
    for (const candidateId of candidateIds) {
      if (typeof candidateId !== 'string') continue;
      const leaf = nodes.get(candidateId);
      if (leaf === undefined || leaf.key === Number.POSITIVE_INFINITY) continue;
      if (
        best === undefined ||
        leaf.key > best.key ||
        (leaf.key === best.key && (leaf.ordinal > best.ordinal || (leaf.ordinal === best.ordinal && leaf.id > best.id)))
      ) {
        best = leaf;
      }
    }
    if (best !== undefined) {
      const bestId = best.id;
      branch = analysis.branches.find((b) => b.leafId === bestId);
    }
  }
  if (branch === undefined) return null;
  return {
    branch,
    warning: {
      code: 'ACTIVE_BRANCH_HEURISTIC',
      message: `The source did not identify the active branch; this branch was chosen by the explicit '${policy}' heuristic and may not be the one the user last viewed.`,
      ids: [branch.branchId],
    },
  };
}
