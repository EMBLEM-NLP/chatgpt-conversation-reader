/**
 * The static "this module cannot perform I/O" assertions of openai-api.ts / registry.ts / claude-export.ts are only as good as
 * the helper that strips comments before scanning for imports. The first version of that helper used two regular
 * expressions that knew nothing about strings: a comment marker INSIDE a string literal made it delete real code, including
 * an import (defect S1). This file pins the string-aware replacement (stripComments) and cross-checks the real modules with a scan
 * of the UNSTRIPPED source, which cannot hide anything. Synthetic snippets only.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { IO_CAPABLE_MODULES, codeOf, moduleSpecifiers, stripComments } from '../helpers/claude-export-builder.js';

/** The helper as it was handed to the review (kept here only to show what it missed). */
function legacyStrip(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

describe('S1: comment stripping must not be blinded by comment markers inside strings', () => {
  const EVASIVE = ['const open = "/*";', "import { readFileSync } from 'node:fs';", 'const close = "*/";'].join('\n');

  it('the previous regex stripper deleted the import (documenting the defect)', () => {
    assert.deepEqual(moduleSpecifiers(legacyStrip(EVASIVE)), [], 'the old helper saw nothing');
  });

  it('stripComments keeps it, so the module scan reports node:fs', () => {
    assert.deepEqual(moduleSpecifiers(stripComments(EVASIVE)), ['node:fs']);
  });

  const cases: Array<[string, string, string]> = [
    ['a line comment', 'const a = 1; // import x from "fs"\nconst b = 2;', 'const a = 1; \nconst b = 2;'],
    ['a block comment', 'a /* import x from "fs" */ b', 'a   b'],
    ['a multi-line block comment', 'a\n/*\n * import x from "fs"\n */\nb', 'a\n \nb'],
    ['an unterminated block comment runs to the end', 'a /* import x from "fs"\nmore', 'a  '],
    ['a // inside a double-quoted string is not a comment', 'const u = "http://example.test/x"; import y from "net";', 'const u = "http://example.test/x"; import y from "net";'],
    ['a // inside a single-quoted string', "const u = 'a // b'; import y from 'net';", "const u = 'a // b'; import y from 'net';"],
    ['a /* inside a string', 'const o = "/*"; import y from "net"; const c = "*/";', 'const o = "/*"; import y from "net"; const c = "*/";'],
    ['escaped quotes do not end a string early', 'const s = "a\\"// not a comment"; x();', 'const s = "a\\"// not a comment"; x();'],
    ['a template literal with comment markers', 'const t = `// not\n/* a comment */`; y();', 'const t = `// not\n/* a comment */`; y();'],
    ['code inside ${ } of a template IS code, with its own comments', 'const t = `a ${ /* c */ x } b`;', 'const t = `a ${   x } b`;'],
    ['nested templates and braces inside ${ }', 'const t = `a ${ `b ${ {k:1}.k } c` } d // kept`; // gone\nz();', 'const t = `a ${ `b ${ {k:1}.k } c` } d // kept`; \nz();'],
    ['a regular expression with quotes and slashes', 'const r = /["\'/]\\//g; import y from "net"; // gone', 'const r = /["\'/]\\//g; import y from "net"; '],
    ['a slash inside a regex character class', 'const r = /[/*]/; /* gone */ x();', 'const r = /[/*]/;   x();'],
    ['a division is not a regex', 'const q = a / b / c; // gone', 'const q = a / b / c; '],
    ['a regex after return', 'function f() { return /\'/.test(s); } // gone', "function f() { return /'/.test(s); } "],
    ['a comment right after code, no space', 'x();//c\ny();', 'x();\ny();'],
    ['code without any comment is returned unchanged', 'import a from "./a.js";\nexport const b = 1;\n', 'import a from "./a.js";\nexport const b = 1;\n'],
  ];
  for (const [label, input, expected] of cases) {
    it(label, () => {
      assert.equal(stripComments(input), expected);
    });
  }

  it('is total and fail-closed: arbitrary text never throws and never produces MORE text than it was given', () => {
    for (const text of ['', '/', '//', '/*', '*/', '"', "'", '`', '${', '`${', '`${`', '/[', '\\', '"\\', 'a/b/c', '/*/', '`\\', '}', '`${}`}']) {
      const out = stripComments(text);
      assert.ok(out.length <= text.length + 1, JSON.stringify(text));
    }
  });
});

describe('the real modules: stripping comments never changes which modules they import', () => {
  const MODULES = ['src/ingest/openai-api.ts', 'src/ingest/registry.ts', 'src/ingest/claude-export.ts', 'src/errors.ts'];
  for (const rel of MODULES) {
    it(`${rel}: the specifiers of the stripped source equal those of the raw source`, () => {
      const raw = readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8');
      assert.deepEqual(moduleSpecifiers(codeOf(rel)), moduleSpecifiers(raw));
    });
  }

  it('openai-api.ts: not one specifier of the RAW source (comments included) names an I/O-capable module, with or without node:', () => {
    const raw = readFileSync(new URL('../../../src/ingest/openai-api.ts', import.meta.url), 'utf8');
    const specs = moduleSpecifiers(raw).map((s) => s.replace(/^node:/, ''));
    assert.deepEqual(specs, ['../domain/types.js', '../errors.js', './adapter.js']);
    for (const forbidden of IO_CAPABLE_MODULES) assert.ok(!specs.includes(forbidden), forbidden);
  });

  it('openai-api.ts: the code (comments removed) contains none of the spec\'s forbidden words as an identifier or string', () => {
    const code = codeOf('src/ingest/openai-api.ts');
    for (const word of ['fs', 'net', 'http', 'https', 'child_process', 'dns', 'tls', 'worker_threads', 'fetch']) {
      assert.ok(!new RegExp(`['"\`/]${word}['"\`/]|\\b${word}\\s*\\(`).test(code), word);
    }
  });
});
