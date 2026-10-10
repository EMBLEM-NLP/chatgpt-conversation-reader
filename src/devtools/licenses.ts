/**
 * Dependency license inventory (ADR-0008 promises an `npm run licenses` summary).
 *
 * DEV TOOL ONLY: this module is allow-listed under src/devtools/ and must never be imported by the SDK, CLI or
 * MCP server (test/security/no-network.test.ts enforces that). It performs no network access: it reads
 * `package-lock.json` and the `package.json` / LICENSE files of the packages that are already installed.
 *
 * Principle (AGENTS.md, CODEX_TASK Phase 0): never assert rights by inference. A license is reported only when
 *  1. the installed package.json declares one (SPDX expressions are kept verbatim), or
 *  2. the package ships a LICENSE/LICENCE/COPYING file whose text matches a canonical MIT, ISC, Apache-2.0,
 *     BSD-2-Clause or BSD-3-Clause text apart from copyright lines and a few named-party slots.
 * Everything else is "unknown", and unknown is never a statement that a package is unlicensed. The report is an
 * inventory to help a human decide; it is not legal advice.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { GcrError } from '../errors.js';

export type LicenseSource = 'package.json' | 'license-file' | 'unknown';

export interface LicensedPackage {
  name: string;
  version: string;
  /** SPDX id/expression exactly as declared, a detected id for `license-file`, or the literal "unknown". */
  license: string;
  source: LicenseSource;
  /** True only when every installed copy of this name@version is reachable solely through devDependencies. */
  dev: boolean;
}

export interface LicenseCollection {
  /** Sorted by name, then version. One entry per distinct name@version. */
  packages: LicensedPackage[];
  /** License string -> number of packages, keys sorted. */
  summary: Record<string, number>;
  /** `name@version` of every package whose license could not be established, in the same order as `packages`. */
  unknown: string[];
}

const UNKNOWN = 'unknown';
/** A package.json is a few KiB; refuse anything absurd rather than parse it. */
const MAX_PACKAGE_JSON_BYTES = 4 * 1024 * 1024;
/** Real license texts are < 20 KiB; a larger file is not an "obvious case". */
const MAX_LICENSE_FILE_BYTES = 128 * 1024;
const CONCURRENCY = 16;

/** Locale-independent ordering so output is identical on every machine. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ===================================================================================================
// package.json license field
// ===================================================================================================

function textOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s === '' ? null : s;
}

/** One entry of a legacy license list: a bare string or a `{ type, url }` object. */
function legacyEntry(v: unknown): string | null {
  if (typeof v === 'string') return textOrNull(v);
  if (isRecord(v)) return textOrNull(v['type']);
  return null;
}

/** Declarations that state "no license" or nothing at all; they identify no license, so the LICENSE file is consulted. */
const NO_LICENSE_PLACEHOLDER = /^(?:unknown|none|noassertion|no licen[sc]e|n\/a)$/i;

/**
 * Reads the declared license from a parsed package.json. Handles the modern string, the legacy `{ type }` object,
 * and the legacy `licenses: [...]` array (documented by npm as alternatives, hence joined with OR). Returns null
 * when nothing usable is declared. "SEE LICENSE IN <file>" and a literal "unknown" identify no license, so they
 * and the placeholders NONE / NOASSERTION / "no license" / N/A count as absent and the LICENSE file is consulted instead.
 */
export function licenseFromPackageJson(pkg: unknown): string | null {
  if (!isRecord(pkg)) return null;
  const candidates: unknown[] = [pkg['license'], pkg['licenses']];
  for (const field of candidates) {
    const parts: string[] = [];
    if (Array.isArray(field)) {
      for (const entry of field) {
        const text = legacyEntry(entry);
        if (text !== null && !parts.includes(text)) parts.push(text);
      }
    } else {
      const text = legacyEntry(field);
      if (text !== null) parts.push(text);
    }
    if (parts.length === 0) continue;
    const joined = parts.length === 1 ? (parts[0] ?? '') : `(${parts.join(' OR ')})`;
    if (/^SEE LICENSE IN\b/i.test(joined) || NO_LICENSE_PLACEHOLDER.test(joined)) continue;
    return joined;
  }
  return null;
}

// ===================================================================================================
// License text classification (conservative)
// ===================================================================================================

/** Lower-cased words only: punctuation, quotes, hyphens and layout differences must not matter. */
function normalizeWords(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const COPYRIGHT_YEAR_LINE = /^(?:copyright\s*(?:\(c\)|©|\d{4})|\(c\)\s|©)/i;
/** A year-less "Copyright Holder" notice is only believed before the license body starts: wrapped body text can begin with "copyright". */
const COPYRIGHT_HOLDER_LINE = /^copyright\b/i;
/**
 * A copyright or title line may be dropped only if it is a plain notice. Text written next to the copyright line
 * ("Copyright 2020 Foo. Commercial use requires a paid license.") is a condition, not a notice: keeping it in the body
 * makes the text fail the canonical match, so the package stays "unknown" instead of being asserted permissive.
 */
const RESTRICTIVE_NOTICE =
  /\b(?:non[- ]?commercial|commercial|prohibit\w*|forbid\w*|restrict\w*|except|only|not|never|without|unless|exclusive\w*|military|educational|personal|research|academic|resale|sell|redistribut\w*|require\w*|provided|condition\w*|subject)\b/i;
/** Extra words that make a *copyright* line suspicious (a title legitimately says "License"). */
const RESTRICTIVE_COPYRIGHT_EXTRA = /\b(?:licen[sc]\w*|permission|permit\w*|shall|must|may)\b/i;
const COPYRIGHT_NOTICE_MAX_CHARS = 200;

function isCopyrightNotice(line: string, seenBody: boolean): boolean {
  if (/^all rights reserved\.?$/i.test(line)) return true;
  if (line.length > COPYRIGHT_NOTICE_MAX_CHARS || RESTRICTIVE_NOTICE.test(line) || RESTRICTIVE_COPYRIGHT_EXTRA.test(line)) return false;
  return COPYRIGHT_YEAR_LINE.test(line) || (!seenBody && COPYRIGHT_HOLDER_LINE.test(line));
}
const TITLE_LINE = /^\(?(?:the\s+)?(?:mit|isc|bsd[ \-\w]{0,24})(?:\s+licen[sc]e)?(?:\s*\([^)]{1,20}\))?\)?\s*:?$|^licen[sc]e\s*:?$/i;
const LIST_MARKER = /^\s*(?:\d{1,2}[.)]|[*•-])\s+/;

/** Drops BOM, copyright statements, "All rights reserved", a leading title and list markers, then normalizes. */
function licenseBodyWords(text: string): string {
  const kept: string[] = [];
  let seenBody = false;
  for (const raw of text.replace(/^﻿/, '').split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (isCopyrightNotice(line, seenBody)) continue;
    if (!seenBody && TITLE_LINE.test(line) && !RESTRICTIVE_NOTICE.test(line)) continue;
    seenBody = true;
    kept.push(line.replace(LIST_MARKER, ''));
  }
  return normalizeWords(kept.join(' '));
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A short run of words naming a party (copyright holder, organization, "the regents", ...). */
const PARTY_WORDS = '[a-z0-9]+(?: [a-z0-9]+){0,9}?';

/**
 * Compiles a canonical license text into an anchored regex over normalized words. `@@NAME@@` marks a slot whose
 * pattern is looked up in `slots`; everything else must match exactly (modulo punctuation and line wrapping), so
 * an extra clause, a missing clause or a changed warranty paragraph makes the text "not obvious".
 */
function compileTemplate(text: string, slots: Readonly<Record<string, string>>): RegExp {
  const parts = text.split(/@@([A-Z]+)@@/);
  const pieces: string[] = [];
  parts.forEach((part, index) => {
    if (index % 2 === 0) {
      const words = normalizeWords(part);
      if (words !== '') pieces.push(escapeRegExp(words));
    } else {
      pieces.push(slots[part] ?? '(?!)');
    }
  });
  return new RegExp(`^${pieces.join(' ')}$`);
}

const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy,
modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL @@AUTHORS@@ BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

const ISC_TEXT = `Permission to use, copy, modify, @@ANDOR@@ distribute this software for any purpose with or without fee is hereby granted,
provided that the above copyright notice and this permission notice appear in all copies.
THE SOFTWARE IS PROVIDED "AS IS" AND @@PARTY@@ @@DISCLAIM@@ ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL @@PARTY@@ BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR
CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT,
NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`;

const BSD_HEAD = `Redistribution and use in source and binary forms, with or without modification, are permitted provided that the
following conditions are met:
Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the distribution.`;

const BSD_ENDORSEMENT = `Neither the name of @@NAME@@ nor the names of its contributors may be used to endorse or promote products derived
from this software without specific prior written permission.`;

const BSD_DISCLAIMER = `THIS SOFTWARE IS PROVIDED BY @@NAME@@ "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL @@NAME@@ BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;

const TEMPLATES: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: 'MIT', re: compileTemplate(MIT_TEXT, { AUTHORS: '(?:the )?authors? or copyright holders?' }) },
  { id: 'ISC', re: compileTemplate(ISC_TEXT, { ANDOR: '(?:and or|and)', PARTY: '(?:the authors?|isc)', DISCLAIM: 'disclaims?' }) },
  { id: 'BSD-2-Clause', re: compileTemplate(`${BSD_HEAD}\n${BSD_DISCLAIMER}`, { NAME: PARTY_WORDS }) },
  { id: 'BSD-3-Clause', re: compileTemplate(`${BSD_HEAD}\n${BSD_ENDORSEMENT}\n${BSD_DISCLAIMER}`, { NAME: PARTY_WORDS }) },
];

/** Bound on the text handed to the template regexes: a longer text cannot be one of these short licenses. */
const MAX_TEMPLATE_WORDS_LENGTH = 4000;

/** Apache-2.0 is too long to template; match its fixed header, its section markers and its size instead. */
function isApache2(text: string): boolean {
  const words = normalizeWords(text);
  if (!words.startsWith('apache license version 2 0 january 2004 http www apache org licenses')) return false;
  if (!words.includes('terms and conditions for use reproduction and distribution')) return false;
  const endMarker = 'end of terms and conditions';
  const end = words.indexOf(endMarker);
  if (end < 0) return false;
  const bodyWordCount = words.slice(0, end + endMarker.length).split(' ').length;
  // The unmodified body is ~1,420 words. Added conditions (e.g. a "Commons Clause") change this, so refuse them.
  if (bodyWordCount < 1350 || bodyWordCount > 1500) return false;
  const tail = words.slice(end + endMarker.length).trim();
  return tail === '' || tail.startsWith('appendix how to apply the apache license');
}

/**
 * Classifies a license TEXT. Returns an SPDX id only for obvious cases (MIT, ISC, Apache-2.0, BSD-2-Clause,
 * BSD-3-Clause); null for anything else, including near-misses, modified texts and the 4-clause BSD license.
 */
export function classifyLicenseText(text: string): string | null {
  if (text.length > MAX_LICENSE_FILE_BYTES) return null;
  if (isApache2(text)) return 'Apache-2.0';
  const body = licenseBodyWords(text);
  if (body === '' || body.length > MAX_TEMPLATE_WORDS_LENGTH) return null;
  for (const { id, re } of TEMPLATES) {
    if (re.test(body)) return id;
  }
  return null;
}

const LICENSE_FILE_NAME = /^(?:licen[sc]e|copying)(?:[-_.][a-z0-9._+-]{1,32})?$/i;
const NOT_A_LICENSE_TEXT = /\.(?:js|mjs|cjs|ts|mts|cts|json|map|node|wasm|html|css)$/i;

async function readSmallText(path: string, maxBytes: number): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > maxBytes) return null;
    return await readFile(path, 'utf8');
  } catch {
    // Missing/unreadable files are reported as "unknown" by the caller, never as an error.
    return null;
  }
}

/** All license files of a package must classify, and to the same license, or the answer is "unknown". */
async function licenseFromFiles(dir: string): Promise<string | null> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => LICENSE_FILE_NAME.test(n) && !NOT_A_LICENSE_TEXT.test(n)).sort(cmp);
  } catch {
    return null;
  }
  if (names.length === 0) return null;
  const found = new Set<string>();
  for (const name of names) {
    const text = await readSmallText(join(dir, name), MAX_LICENSE_FILE_BYTES);
    const id = text === null ? null : classifyLicenseText(text);
    if (id === null) return null;
    found.add(id);
  }
  return found.size === 1 ? ([...found][0] ?? null) : null;
}

// ===================================================================================================
// Non-permissive detection
// ===================================================================================================

/** Matched against single SPDX identifiers (or words of free text). Order matters: AGPL/LGPL before GPL. */
const FAMILY_BY_IDENTIFIER: ReadonlyArray<{ family: string; test: RegExp }> = [
  { family: 'AGPL', test: /^agpl/i },
  { family: 'LGPL', test: /^lgpl/i },
  { family: 'GPL', test: /^(?:gpl|gnu(?![a-z]))/i },
  { family: 'SSPL', test: /^sspl/i },
  { family: 'BUSL', test: /^(?:busl|business[ _-]source)/i },
  { family: 'CC-BY-NC', test: /^cc[ _-]by[ _-]nc/i },
  { family: 'non-commercial', test: /non[ _-]?commercial/i },
  { family: 'UNLICENSED', test: /^unlicensed$/i },
  { family: 'proprietary', test: /^(?:proprietary|commercial|private|closed[ _-]?source)$/i },
  { family: 'custom license reference', test: /^licenseref-/i },
];

/** Matched against the whole string, for free-text license names that are not SPDX identifiers. */
const FAMILY_BY_PHRASE: ReadonlyArray<{ family: string; test: RegExp }> = [
  { family: 'CC-BY-NC', test: /\bcc[ _-]?by[ _-]?nc\b/i },
  { family: 'proprietary', test: /\ball rights reserved\b/i },
  { family: 'proprietary', test: /\bclosed[ -]source\b/i },
  { family: 'proprietary', test: /\b(?:personal|educational|internal|research|academic|evaluation)[ -]use[ -]only\b/i },
  { family: 'GPL', test: /\bgeneral public licen[sc]e\b/i },
  { family: 'SSPL', test: /\bserver side public licen[sc]e\b/i },
  { family: 'BUSL', test: /\bbusiness source licen[sc]e\b/i },
  { family: 'non-commercial', test: /\bnon[ -]?commercial\b/i },
];

function familyOfIdentifier(id: string): string | null {
  for (const { family, test } of FAMILY_BY_IDENTIFIER) {
    if (test.test(id)) return family;
  }
  return null;
}

const SPDX_IDSTRING = /^[A-Za-z0-9.+:_-]+$/;

type SpdxNode = { op: 'id'; id: string } | { op: 'and' | 'or'; items: SpdxNode[] };

/** Minimal SPDX expression parser (ids, AND, OR, WITH, parentheses). Returns null if the text is not an expression. */
function parseSpdx(input: string): SpdxNode | null {
  // Real expressions are short; the bound also limits recursion depth on hostile input.
  if (input.length > 500) return null;
  const tokens = input.match(/[()]|[^\s()]+/g) ?? [];
  let pos = 0;
  const isOp = (t: string | undefined, op: string): boolean => t !== undefined && t.toUpperCase() === op;

  const parsePrimary = (): SpdxNode | null => {
    const t = tokens[pos];
    if (t === undefined || t === ')' || isOp(t, 'AND') || isOp(t, 'OR') || isOp(t, 'WITH')) return null;
    if (t === '(') {
      pos++;
      const inner = parseOr();
      if (inner === null || tokens[pos] !== ')') return null;
      pos++;
      return inner;
    }
    // An SPDX idstring is letters, digits, '.', '-' (and '+', ':' for LicenseRef/DocumentRef). A token such as
    // "MIT/GPL-3.0" or "MIT,GPL-3.0" is two licenses glued together: not an expression, so it is checked word by word.
    if (!SPDX_IDSTRING.test(t)) return null;
    pos++;
    if (isOp(tokens[pos], 'WITH')) {
      pos++;
      const exception = tokens[pos];
      if (exception === undefined || !SPDX_IDSTRING.test(exception)) return null;
      pos++;
    }
    return { op: 'id', id: t };
  };
  const chain = (op: 'and' | 'or', next: () => SpdxNode | null): SpdxNode | null => {
    const first = next();
    if (first === null) return null;
    const items = [first];
    while (isOp(tokens[pos], op.toUpperCase())) {
      pos++;
      const item = next();
      if (item === null) return null;
      items.push(item);
    }
    return items.length === 1 ? first : { op, items };
  };
  const parseAnd = (): SpdxNode | null => chain('and', parsePrimary);
  const parseOr = (): SpdxNode | null => chain('or', parseAnd);

  const root = parseOr();
  return root !== null && pos === tokens.length ? root : null;
}

function familyOfNode(node: SpdxNode): string | null {
  if (node.op === 'id') return familyOfIdentifier(node.id);
  const families = node.items.map(familyOfNode);
  // OR is the licensee's choice, so it is non-permissive only if every alternative is; AND binds all of them.
  if (node.op === 'or') return families.every((f) => f !== null) ? (families[0] ?? null) : null;
  return families.find((f) => f !== null) ?? null;
}

/**
 * Returns the restricted-license family (GPL, LGPL, AGPL, SSPL, BUSL, CC-BY-NC, UNLICENSED, ...) a license string
 * belongs to, or null if none matched. Strings that are not valid SPDX expressions are checked word by word and as
 * a whole, erring on the side of flagging. The result says "needs a human decision", not "forbidden".
 */
export function nonPermissiveFamily(license: string): string | null {
  const text = license.trim();
  if (text === '' || text === UNKNOWN) return null;
  const node = parseSpdx(text);
  if (node !== null) return familyOfNode(node);
  for (const { family, test } of FAMILY_BY_PHRASE) {
    if (test.test(text)) return family;
  }
  for (const word of text.split(/[\s,;/()]+/)) {
    const family = word === '' ? null : familyOfIdentifier(word);
    if (family !== null) return family;
  }
  return null;
}

export function isNonPermissiveLicense(license: string): boolean {
  return nonPermissiveFamily(license) !== null;
}

// ===================================================================================================
// Collection
// ===================================================================================================

interface LockCandidate {
  /** Lockfile key, e.g. "node_modules/a/node_modules/@s/b": also the install directory relative to the root. */
  key: string;
  name: string;
  lockVersion: string | undefined;
  dev: boolean;
  optional: boolean;
  /** The `license` npm copied from the package's manifest into the lockfile entry, if any. */
  lockLicense: string | null;
}

async function loadLockPackages(root: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(join(root, 'package-lock.json'), 'utf8');
  } catch (cause) {
    throw new GcrError('INVALID_ARGUMENT', 'package-lock.json was not found or could not be read in the project root.', {
      remedy: 'Run `npm install` to create it, or point the tool at the directory that contains it.',
      details: { file: 'package-lock.json' },
      cause,
    });
  }
  let lock: unknown;
  try {
    lock = JSON.parse(text.replace(/^\uFEFF/, '')); // npm tolerates a byte order mark written by an editor
  } catch (cause) {
    throw new GcrError('INVALID_ARGUMENT', 'package-lock.json is not valid JSON.', { details: { file: 'package-lock.json' }, cause });
  }
  if (!isRecord(lock)) throw new GcrError('INVALID_ARGUMENT', 'package-lock.json is not a JSON object.', { details: { file: 'package-lock.json' } });
  const version = lock['lockfileVersion'];
  const packages = lock['packages'];
  if ((version !== 2 && version !== 3) || !isRecord(packages)) {
    throw new GcrError('INVALID_ARGUMENT', 'package-lock.json must be lockfileVersion 2 or 3 (it needs the "packages" map).', {
      remedy: 'Regenerate it with npm 7 or newer (`npm install --package-lock-only`).',
      details: { file: 'package-lock.json', lockfileVersion: typeof version === 'number' ? version : null },
    });
  }
  return packages;
}

function candidatesFrom(packages: Record<string, unknown>): LockCandidate[] {
  const out: LockCandidate[] = [];
  for (const key of Object.keys(packages).sort(cmp)) {
    const entry = packages[key];
    // "" is the project itself; keys outside node_modules are workspace/first-party packages whose license is the
    // owner's own choice; `link` entries are symlinks to such packages (and would duplicate them).
    if (key === '' || !isRecord(entry) || entry['link'] === true) continue;
    const marker = key.lastIndexOf('node_modules/');
    if (marker < 0) continue;
    const pathName = key.slice(marker + 'node_modules/'.length);
    const aliasOf = textOrNull(entry['name']); // set by npm for `npm:` alias installs
    out.push({
      key,
      name: aliasOf ?? pathName,
      lockVersion: textOrNull(entry['version']) ?? undefined,
      // `devOptional` (dev tree OR an optional runtime edge) is deliberately treated as runtime: when in doubt, report more.
      dev: entry['dev'] === true,
      optional: entry['optional'] === true,
      lockLicense: licenseFromPackageJson({ license: entry['license'] }),
    });
  }
  return out;
}

/** The install directory for a lockfile key, or null if the key tries to leave the project root. */
function installDir(root: string, key: string): string | null {
  if (isAbsolute(key)) return null;
  const abs = resolve(root, key);
  const rel = relative(root, abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return abs;
}

async function readPackageJson(dir: string): Promise<Record<string, unknown> | null> {
  const text = await readSmallText(join(dir, 'package.json'), MAX_PACKAGE_JSON_BYTES);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, '')); // some published packages carry a BOM; npm reads them
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null; // corrupt package.json: reported as unknown
  }
}

async function inspect(root: string, c: LockCandidate): Promise<LicensedPackage | null> {
  const dir = installDir(root, c.key);
  const pkg = dir === null ? null : await readPackageJson(dir);
  if (dir === null || pkg === null) {
    // Platform-specific optional packages are legitimately absent; anything else missing from disk is a gap to show.
    // An absent optional package is still listed when the lockfile's copy of its manifest declares a non-permissive license,
    // so that the release gate cannot be dodged by building on a platform that does not install it.
    if (c.optional) {
      return c.lockLicense !== null && isNonPermissiveLicense(c.lockLicense)
        ? { name: c.name, version: c.lockVersion ?? UNKNOWN, license: c.lockLicense, source: 'package.json', dev: c.dev }
        : null;
    }
    return { name: c.name, version: c.lockVersion ?? UNKNOWN, license: UNKNOWN, source: 'unknown', dev: c.dev };
  }
  const version = textOrNull(pkg['version']) ?? c.lockVersion ?? UNKNOWN;
  const declared = licenseFromPackageJson(pkg);
  if (declared !== null) return { name: c.name, version, license: declared, source: 'package.json', dev: c.dev };
  const detected = await licenseFromFiles(dir);
  if (detected !== null) return { name: c.name, version, license: detected, source: 'license-file', dev: c.dev };
  return { name: c.name, version, license: UNKNOWN, source: 'unknown', dev: c.dev };
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index] as T;
      results[index] = await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Inventories the licenses of every package in `<root>/package-lock.json` (lockfileVersion 2 or 3) using the
 * installed copies under `<root>/node_modules`. Throws GcrError(INVALID_ARGUMENT) if the lockfile is missing or
 * unsupported, or if packages are locked but `node_modules` does not exist (run `npm ci` first).
 */
export async function collectLicenses(root: string): Promise<LicenseCollection> {
  const absRoot = resolve(root);
  const candidates = candidatesFrom(await loadLockPackages(absRoot));
  if (candidates.length > 0) {
    const nm = await stat(join(absRoot, 'node_modules')).catch(() => null);
    if (nm === null || !nm.isDirectory()) {
      throw new GcrError('INVALID_ARGUMENT', 'node_modules was not found: licenses are read from the installed packages.', {
        remedy: 'Run `npm ci` first.',
      });
    }
  }
  const inspected = await mapLimit(candidates, CONCURRENCY, (c) => inspect(absRoot, c));

  // The same name@version can be installed in several places. It is "dev" only if every copy is, and "unknown" if any copy is.
  const merged = new Map<string, LicensedPackage>();
  for (const p of inspected) {
    if (p === null) continue;
    const id = `${p.name}\u0000${p.version}`;
    const existing = merged.get(id);
    if (existing === undefined) {
      merged.set(id, p);
      continue;
    }
    const keep = existing.source === 'unknown' ? existing : p.source === 'unknown' ? p : existing;
    // Two copies of the same name@version that declare different licenses are an anomaly (a modified copy): do not
    // pick one, let a human look.
    const conflict = existing.source !== 'unknown' && p.source !== 'unknown' && existing.license !== p.license;
    merged.set(id, conflict ? { ...existing, license: UNKNOWN, source: 'unknown', dev: existing.dev && p.dev } : { ...keep, dev: existing.dev && p.dev });
  }
  const packages = [...merged.values()].sort((a, b) => cmp(a.name, b.name) || cmp(a.version, b.version));

  const counts = new Map<string, number>();
  for (const p of packages) counts.set(p.license, (counts.get(p.license) ?? 0) + 1);
  // Object.fromEntries defines own properties, so a license string such as "__proto__" cannot corrupt the object.
  const summary = Object.fromEntries([...counts.entries()].sort((a, b) => cmp(a[0], b[0])));
  const unknown = packages.filter((p) => p.source === 'unknown').map((p) => `${p.name}@${p.version}`);
  return { packages, summary, unknown };
}

// ===================================================================================================
// Reporting
// ===================================================================================================

/** Runtime (non-dev) packages whose license is unknown or non-permissive: what makes `npm run licenses` exit 1. */
export function blockingPackages(result: LicenseCollection): LicensedPackage[] {
  return result.packages.filter((p) => !p.dev && (p.source === 'unknown' || isNonPermissiveLicense(p.license)));
}

/** Control characters, line separators, bidi overrides/isolates, zero-width and invisible format characters, tag characters. */
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]+/gu;

/**
 * Replaces every run of characters that can drive a terminal or a CI log (ESC sequences, CR/LF that forge extra
 * log lines such as `::add-mask::`), reorder displayed text (bidi) or hide it (zero-width) by one space. Package
 * metadata is untrusted: use this for everything that is printed as text.
 */
export function sanitizeForTerminal(text: string): string {
  return text.replace(UNSAFE_TEXT, ' ').trim();
}

/** Makes metadata safe to print (see sanitizeForTerminal) and neutralises markdown table syntax. */
function cell(value: string, max = 120): string {
  const clean = sanitizeForTerminal(value).replace(/[\\|`]/g, '\\$&');
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

const scope = (p: LicensedPackage): string => (p.dev ? 'dev' : 'runtime');
const idOf = (p: LicensedPackage): string => `${p.name}@${p.version}`;

function countLine(label: string, list: readonly LicensedPackage[]): string {
  const runtime = list.filter((p) => !p.dev).length;
  return `- ${label}: ${list.length} (runtime ${runtime}, dev ${list.length - runtime})`;
}

/** Deterministic markdown: no timestamps, no absolute paths, sorted everywhere. */
export function formatLicenseReport(result: LicenseCollection): string {
  const all = [...result.packages];
  const unknownPkgs = all.filter((p) => p.source === 'unknown').sort((a, b) => cmp(a.name, b.name) || cmp(a.version, b.version));
  const restricted = all
    .filter((p) => p.source !== 'unknown' && isNonPermissiveLicense(p.license))
    .sort((a, b) => cmp(a.license, b.license) || cmp(a.name, b.name) || cmp(a.version, b.version));
  const blocking = blockingPackages(result);
  const runtimeCount = all.filter((p) => !p.dev).length;

  const lines: string[] = [];
  lines.push('# Dependency license report', '');
  lines.push(`- Packages: ${all.length} (runtime ${runtimeCount}, dev ${all.length - runtimeCount})`);
  lines.push(countLine('Unknown license', unknownPkgs));
  lines.push(countLine('Non-permissive license', restricted));
  lines.push(`- Release gate: ${blocking.length === 0 ? 'PASS' : `FAIL (${blocking.length} runtime package(s) with an unknown or non-permissive license)`}`, '');

  lines.push('## Needs attention', '');
  lines.push(`### Unknown license (${unknownPkgs.length})`, '');
  if (unknownPkgs.length === 0) lines.push('None.');
  for (const p of unknownPkgs) lines.push(`- **${cell(idOf(p))}** (${scope(p)})`);
  lines.push('');
  lines.push(`### Non-permissive license: GPL, LGPL, AGPL, SSPL, BUSL, CC-BY-NC, UNLICENSED and similar (${restricted.length})`, '');
  if (restricted.length === 0) lines.push('None.');
  for (const p of restricted) lines.push(`- **${cell(idOf(p))}**: \`${cell(p.license)}\` [${nonPermissiveFamily(p.license) ?? ''}] (${scope(p)})`);
  lines.push('');

  lines.push('## Summary by license', '', '| License | Packages |', '| --- | ---: |');
  for (const [license, count] of Object.entries(result.summary).sort((a, b) => cmp(a[0], b[0]))) lines.push(`| ${cell(license)} | ${count} |`);
  lines.push('');

  lines.push('## All packages', '', '| License | Package | Version | Scope | Source |', '| --- | --- | --- | --- | --- |');
  const sorted = all.sort((a, b) => cmp(a.license, b.license) || cmp(a.name, b.name) || cmp(a.version, b.version));
  for (const p of sorted) lines.push(`| ${cell(p.license)} | ${cell(p.name)} | ${cell(p.version)} | ${scope(p)} | ${p.source} |`);
  lines.push('');

  lines.push(
    '## Notes',
    '',
    '- "unknown" means the license could not be established from package metadata or an unmodified standard license text. It does not mean the package is unlicensed.',
    '- Source `package.json` is the license the package declares (SPDX expressions verbatim); `license-file` means an unmodified MIT, ISC, Apache-2.0 or BSD text was recognised.',
    '- Scope `dev` packages are reachable only through devDependencies; the release gate considers runtime packages only.',
    '- This inventory is a starting point for a human decision, not legal advice.',
    '',
  );
  return lines.join('\n');
}
