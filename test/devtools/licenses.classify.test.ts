/**
 * ADR-0008 license tooling, unit level: license-text classification (conservative: only obvious MIT, ISC,
 * Apache-2.0, BSD-2/3-Clause), package.json license field parsing and non-permissive detection.
 * The texts below are the public standard license texts with a made-up holder; nothing is real third-party data.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { classifyLicenseText, isNonPermissiveLicense, licenseFromPackageJson, nonPermissiveFamily } from '../../src/devtools/licenses.js';

const SEED = 20261010;

const MIT_BODY = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const ISC_BODY = `Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
`;

const bsdBody = (who: { provided: string; liable: string }, endorsement: string | null): string => `Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
${endorsement === null ? '' : `\n3. ${endorsement}\n`}
THIS SOFTWARE IS PROVIDED BY ${who.provided} "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL ${who.liable} BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
`;

const HOLDERS = { provided: 'THE COPYRIGHT HOLDERS AND CONTRIBUTORS', liable: 'THE COPYRIGHT HOLDER OR CONTRIBUTORS' };
const BSD2_BODY = bsdBody(HOLDERS, null);
const BSD3_ENDORSEMENT =
  'Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.';
const BSD3_BODY = bsdBody(HOLDERS, BSD3_ENDORSEMENT);
/** The advertising clause makes it 4-clause BSD: a different (GPL-incompatible) license, and deliberately not "obvious". */
const BSD4_BODY = bsdBody(HOLDERS, 'All advertising materials mentioning features or use of this software must display the following acknowledgement: This product includes software developed by Example Holder.');

/** Apache-2.0 is ~1,400 words. A stub with the genuine fixed header, section markers and a plausible size exercises the header match without embedding the full text. */
function apacheStub(opts: { words?: number; tail?: string; header?: string } = {}): string {
  const filler = Array.from({ length: opts.words ?? 1400 }, (_, i) => `term${i % 97}`).join(' ');
  return [
    opts.header ?? 'Apache License\n\nVersion 2.0, January 2004\n\nhttp://www.apache.org/licenses/',
    'TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION',
    filler,
    'END OF TERMS AND CONDITIONS',
    opts.tail ?? '',
  ].join('\n\n');
}

describe('classifyLicenseText: obvious cases', () => {
  const titles = ['', 'MIT License\n\n', 'The MIT License (MIT)\n\n', '(The MIT License)\n\n', 'The MIT License\n\n', 'MIT\n\n', 'License\n\n'];
  const copyrights = ['', 'Copyright (c) 2024 Example Holder\n\n', 'Copyright 2024 Example Holder <holder@example.test>\n\n', 'Copyright © 2020-2024 Example Holder\n\n', '(c) 2019 Example Holder\n\n', 'Copyright (c) 2014 A\nCopyright (c) 2015 B\nAll rights reserved.\n\n'];
  for (const title of titles) {
    for (const copyright of copyrights) {
      it(`MIT with title ${JSON.stringify(title.trim())} and copyright ${JSON.stringify(copyright.slice(0, 18))}`, () => {
        assert.equal(classifyLicenseText(`${title}${copyright}${MIT_BODY}`), 'MIT');
      });
    }
  }

  it('MIT is insensitive to line wrapping, indentation, CRLF, BOM, tabs, curly quotes and trailing blank lines', () => {
    const base = `Copyright (c) 2024 Example Holder\n\n${MIT_BODY}`;
    assert.equal(classifyLicenseText(base.replace(/\n/g, '\r\n')), 'MIT');
    assert.equal(classifyLicenseText(`﻿${base}`), 'MIT');
    assert.equal(classifyLicenseText(base.replace(/^/gm, '\t')), 'MIT');
    assert.equal(classifyLicenseText(base.replace(/\n(?!\n)/g, ' ')), 'MIT');
    assert.equal(classifyLicenseText(base.replace(/"/g, '“')), 'MIT');
    assert.equal(classifyLicenseText(base.replace(/'/g, '’') + '\n\n\n'), 'MIT');
    assert.equal(classifyLicenseText(base.replace('"Software"', "'Software'").replace('"AS IS"', "'AS IS'")), 'MIT');
  });

  it('MIT with the singular "author or copyright holder" wording', () => {
    assert.equal(classifyLicenseText(MIT_BODY.replace('THE\nAUTHORS OR COPYRIGHT HOLDERS', 'THE\nAUTHOR OR COPYRIGHT HOLDER')), 'MIT');
  });

  it('ISC with its common wording variants', () => {
    assert.equal(classifyLicenseText(`ISC License\n\nCopyright (c) 2024, Example Holder\n\n${ISC_BODY}`), 'ISC');
    assert.equal(classifyLicenseText(ISC_BODY), 'ISC');
    assert.equal(classifyLicenseText(ISC_BODY.replace('and/or distribute', 'and distribute')), 'ISC');
    assert.equal(classifyLicenseText(ISC_BODY.replace(/THE AUTHOR DISCLAIMS/, 'THE AUTHORS DISCLAIM').replace('THE AUTHOR BE', 'THE AUTHORS BE')), 'ISC');
    assert.equal(classifyLicenseText(ISC_BODY.replace('THE AUTHOR DISCLAIMS', 'ISC DISCLAIMS').replace('THE AUTHOR BE', 'ISC BE')), 'ISC');
  });

  it('BSD-2-Clause and BSD-3-Clause, with different named parties, list styles and titles', () => {
    assert.equal(classifyLicenseText(`BSD 2-Clause License\n\nCopyright (c) 2024, Example Holder\nAll rights reserved.\n\n${BSD2_BODY}`), 'BSD-2-Clause');
    assert.equal(classifyLicenseText(`The BSD 3-Clause License\n\nCopyright (c) 2024, Example Holder\n\n${BSD3_BODY}`), 'BSD-3-Clause');
    assert.equal(classifyLicenseText(BSD3_BODY.replace(/^\d\. /gm, '* ')), 'BSD-3-Clause');
    assert.equal(classifyLicenseText(BSD3_BODY.replace(/^\d\. /gm, '')), 'BSD-3-Clause');
    const regents = bsdBody({ provided: 'THE REGENTS AND CONTRIBUTORS', liable: 'THE REGENTS OR CONTRIBUTORS' }, 'Neither the name of the University nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.');
    assert.equal(classifyLicenseText(regents), 'BSD-3-Clause');
    const author = bsdBody({ provided: 'THE AUTHOR AND CONTRIBUTORS', liable: 'THE AUTHOR OR CONTRIBUTORS' }, null);
    assert.equal(classifyLicenseText(author), 'BSD-2-Clause');
  });

  it('Apache-2.0 by fixed header, section markers and size; with or without the standard appendix', () => {
    assert.equal(classifyLicenseText(apacheStub()), 'Apache-2.0');
    assert.equal(classifyLicenseText(apacheStub({ tail: 'APPENDIX: How to apply the Apache License to your work.\n\nTo apply the Apache License to your work, attach the following boilerplate notice, with the fields enclosed by brackets "[]" replaced with your own identifying information.' })), 'Apache-2.0');
    assert.equal(classifyLicenseText(apacheStub().replace(/\n/g, '\r\n')), 'Apache-2.0');
  });
});

describe('classifyLicenseText: anything else is null (never infer rights)', () => {
  const negatives: ReadonlyArray<readonly [string, string]> = [
    ['empty', ''],
    ['whitespace', ' \n\t\n '],
    ['only a copyright line', 'Copyright (c) 2024 Example Holder\n'],
    ['only a title', 'MIT License\n'],
    ['the word MIT in prose', 'This project is released under the MIT license. See the website.\n'],
    ['GPL notice', 'This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License.\n'],
    ['MIT plus one added sentence', `${MIT_BODY}\nThe Software shall be used for Good, not Evil.\n`],
    ['MIT with an added leading restriction', `Use is limited to non-commercial purposes.\n\n${MIT_BODY}`],
    ['MIT plus a Commons-Clause style rider', `${MIT_BODY}\n"Commons Clause" License Condition v1.0: the grant above does not include the right to Sell the Software.\n`],
    ['MIT without the warranty disclaimer', MIT_BODY.slice(0, MIT_BODY.indexOf('THE SOFTWARE IS PROVIDED'))],
    ['MIT with "sublicense" removed', MIT_BODY.replace('sublicense, ', '')],
    ['MIT with "NOT" inserted into the warranty', MIT_BODY.replace('WITHOUT WARRANTY OF ANY KIND', 'WITHOUT NOT WARRANTY OF ANY KIND')],
    ['MIT permission changed', MIT_BODY.replace('free of charge', 'for a fee')],
    ['two licenses concatenated', `${MIT_BODY}\n${ISC_BODY}`],
    ['ISC with a missing warranty sentence', ISC_BODY.replace('THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH\nREGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND\nFITNESS. ', '')],
    ['4-clause BSD (advertising clause)', BSD4_BODY],
    ['BSD-3 with a reworded endorsement clause', bsdBody(HOLDERS, 'The names of any contributors may not be used to endorse or promote products derived from this software without specific prior written permission.')],
    ['BSD-2 with an added clause', bsdBody(HOLDERS, 'Redistributions must not be used in weapons systems.')],
    ['BSD-2 with a long unrelated party name (more than ten words)', bsdBody({ provided: 'ONE TWO THREE FOUR FIVE SIX SEVEN EIGHT NINE TEN ELEVEN TWELVE', liable: 'THE COPYRIGHT HOLDER OR CONTRIBUTORS' }, null)],
    ['Apache without the header', apacheStub({ header: 'Some Other License\n\nVersion 2.0' })],
    ['Apache 1.1 header', apacheStub({ header: 'Apache License\n\nVersion 1.1\n\nhttp://www.apache.org/licenses/' })],
    ['Apache too short to be the full text', apacheStub({ words: 100 })],
    ['Apache with a large added section (e.g. a rider)', apacheStub({ words: 1700 })],
    ['Apache with unexpected text after the terms', apacheStub({ tail: 'Additional restriction: no use by competitors.' })],
    ['Apache missing the terms marker', apacheStub().replace('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION', 'TERMS')],
    ['Apache missing the end marker', apacheStub().replace('END OF TERMS AND CONDITIONS', '')],
    ['an oversized text', `${MIT_BODY}${' '.repeat(200 * 1024)}`],
    ['binary-looking junk', '\u0000\u0001\u0002 not a license �'],
  ];
  for (const [name, text] of negatives) {
    it(name, () => {
      assert.equal(classifyLicenseText(text), null);
    });
  }

  it('inserting any extra word anywhere into a canonical MIT or ISC text makes it unclassifiable (property)', () => {
    for (const body of [MIT_BODY, ISC_BODY]) {
      const words = body.split(/(\s+)/); // keep separators so layout is preserved
      assert.equal(classifyLicenseText(body), body === MIT_BODY ? 'MIT' : 'ISC');
      fc.assert(
        fc.property(fc.integer({ min: 0, max: words.length - 1 }), fc.constantFrom('zzz', 'not', 'except', 'commercial', 'and'), (at, extra) => {
          const mutated = [...words.slice(0, at), ` ${extra} `, ...words.slice(at)].join('');
          assert.equal(classifyLicenseText(mutated), null, `accepted after inserting ${JSON.stringify(extra)} at ${at}`);
        }),
        { seed: SEED, numRuns: 150 },
      );
    }
  });

  it('truncating a canonical text at any point makes it unclassifiable (property)', () => {
    for (const body of [MIT_BODY, ISC_BODY, BSD2_BODY, BSD3_BODY]) {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: body.length - 8 }), (cut) => {
          // Cutting trailing whitespace or a final period changes nothing in the normalized words, so require a real loss.
          const truncated = body.slice(0, cut);
          if (truncated.replace(/[^A-Za-z0-9]/g, '') === body.replace(/[^A-Za-z0-9]/g, '')) return;
          assert.equal(classifyLicenseText(truncated), null);
        }),
        { seed: SEED, numRuns: 150 },
      );
    }
  });

  it('never throws and never claims a license for arbitrary text (property)', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 300 }), (s) => {
        assert.equal(classifyLicenseText(s), null);
      }),
      { seed: SEED, numRuns: 300 },
    );
  });
});

describe('licenseFromPackageJson', () => {
  const cases: ReadonlyArray<readonly [string, unknown, string | null]> = [
    ['string', { license: 'MIT' }, 'MIT'],
    ['SPDX expression kept verbatim', { license: '(MIT OR Apache-2.0)' }, '(MIT OR Apache-2.0)'],
    ['SPDX with exception', { license: 'GPL-2.0-only WITH Classpath-exception-2.0' }, 'GPL-2.0-only WITH Classpath-exception-2.0'],
    ['surrounding whitespace trimmed', { license: ' ISC\n' }, 'ISC'],
    ['legacy object', { license: { type: 'MIT', url: 'https://example.test/l' } }, 'MIT'],
    ['legacy array of objects, one entry', { licenses: [{ type: 'BSD-2-Clause' }] }, 'BSD-2-Clause'],
    ['legacy array, two entries are alternatives', { licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] }, '(MIT OR Apache-2.0)'],
    ['legacy array of strings', { licenses: ['MIT', 'ISC'] }, '(MIT OR ISC)'],
    ['legacy array de-duplicates', { licenses: ['MIT', { type: 'MIT' }] }, 'MIT'],
    ['array in the license field', { license: ['MIT', 'ISC'] }, '(MIT OR ISC)'],
    ['license wins over licenses', { license: 'ISC', licenses: [{ type: 'MIT' }] }, 'ISC'],
    ['unusable license falls through to licenses', { license: 5, licenses: [{ type: 'MIT' }] }, 'MIT'],
    ['SEE LICENSE IN is not an identification', { license: 'SEE LICENSE IN LICENSE.md' }, null],
    ['see license in (any case)', { license: 'see license in ./legal/LICENSE' }, null],
    ['declared "unknown" is not an identification', { license: 'Unknown' }, null],
    ['UNLICENSED is a real declaration and is kept', { license: 'UNLICENSED' }, 'UNLICENSED'],
    ['empty string', { license: '' }, null],
    ['number', { license: 1 }, null],
    ['object without a type', { license: { url: 'x' } }, null],
    ['array of junk', { licenses: [1, null, {}, ''] }, null],
    ['absent', { name: 'x' }, null],
    ['non-object manifest', 'MIT', null],
    ['null manifest', null, null],
    ['array manifest', ['MIT'], null],
  ];
  for (const [name, manifest, expected] of cases) {
    it(name, () => {
      assert.equal(licenseFromPackageJson(manifest), expected);
    });
  }
});

describe('nonPermissiveFamily / isNonPermissiveLicense', () => {
  const restricted: ReadonlyArray<readonly [string, string]> = [
    ['GPL-2.0', 'GPL'],
    ['GPL-2.0-only', 'GPL'],
    ['GPL-3.0-or-later', 'GPL'],
    ['GPL-2.0+', 'GPL'],
    ['GPLv3', 'GPL'],
    ['gpl-3.0', 'GPL'],
    ['AGPL-3.0', 'AGPL'],
    ['AGPL-3.0-or-later', 'AGPL'],
    ['LGPL-2.1', 'LGPL'],
    ['LGPL-3.0-only', 'LGPL'],
    ['SSPL-1.0', 'SSPL'],
    ['BUSL-1.1', 'BUSL'],
    ['CC-BY-NC-4.0', 'CC-BY-NC'],
    ['CC-BY-NC-SA-4.0', 'CC-BY-NC'],
    ['CC-BY-NC-ND-3.0', 'CC-BY-NC'],
    ['UNLICENSED', 'UNLICENSED'],
    ['unlicensed', 'UNLICENSED'],
    ['Polyform-Noncommercial-1.0.0', 'non-commercial'],
    ['Proprietary', 'proprietary'],
    ['LicenseRef-Acme-Internal', 'custom license reference'],
    ['GNU General Public License v3', 'GPL'],
    ['GNU Lesser General Public License', 'GPL'],
    ['Server Side Public License', 'SSPL'],
    ['Business Source License 1.1', 'BUSL'],
    ['GPL-2.0-only WITH Classpath-exception-2.0', 'GPL'],
    ['(MIT AND GPL-3.0-only)', 'GPL'],
    ['(GPL-2.0-only OR LGPL-3.0-only)', 'GPL'],
    ['(GPL-2.0-only OR GPL-3.0-only)', 'GPL'],
    ['MIT AND (ISC AND AGPL-3.0)', 'AGPL'],
    ['((GPL-3.0', 'GPL'], // malformed: fall back to flagging
  ];
  for (const [license, family] of restricted) {
    it(`${license} is non-permissive (${family})`, () => {
      assert.equal(nonPermissiveFamily(license), family);
      assert.equal(isNonPermissiveLicense(license), true);
    });
  }

  const permissive: readonly string[] = [
    'MIT',
    'ISC',
    'Apache-2.0',
    'BSD-2-Clause',
    'BSD-3-Clause',
    '0BSD',
    'Unlicense', // public-domain dedication; not the npm marker UNLICENSED
    'CC0-1.0',
    'Python-2.0',
    'MPL-2.0', // weak copyleft: outside the reviewed list, documented as such
    '(MIT OR Apache-2.0)',
    '(MIT OR GPL-3.0-only)',
    '(GPL-3.0-only OR MIT)',
    '(BSD-2-Clause OR MIT OR Apache-2.0)',
    'Apache-2.0 WITH LLVM-exception',
    '(MIT OR (GPL-2.0-only AND BSD-3-Clause))',
    'MIT License',
    'unknown',
    '',
    '   ',
  ];
  for (const license of permissive) {
    it(`${JSON.stringify(license)} is not flagged`, () => {
      assert.equal(nonPermissiveFamily(license), null);
      assert.equal(isNonPermissiveLicense(license), false);
    });
  }

  it('is case-insensitive for operators and identifiers', () => {
    assert.equal(isNonPermissiveLicense('(mit or gpl-3.0)'), false);
    assert.equal(isNonPermissiveLicense('(mit and gpl-3.0)'), true);
  });

  it('copes with hostile input: very long, deeply nested, unbalanced and binary strings', () => {
    assert.equal(isNonPermissiveLicense(`${'('.repeat(2000)}MIT${')'.repeat(2000)}`), false);
    assert.equal(isNonPermissiveLicense(`${'('.repeat(200)}GPL-3.0${')'.repeat(200)}`), true);
    assert.equal(isNonPermissiveLicense(`${'MIT OR '.repeat(5000)}GPL-3.0`), true);
    assert.equal(isNonPermissiveLicense('x'.repeat(100_000)), false);
  });

  it('never throws for arbitrary strings, and a GPL token among otherwise unparseable text is flagged (property)', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 120 }), (s) => {
        const result = nonPermissiveFamily(s);
        assert.ok(result === null || typeof result === 'string');
      }),
      { seed: SEED, numRuns: 300 },
    );
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z ]{0,20}$/), fc.stringMatching(/^[a-z ]{0,20}$/), (a, b) => {
        // Free text around a bare GPL token is not valid SPDX, so the fallback must catch it.
        assert.equal(isNonPermissiveLicense(`${a} GPL-3.0 ${b} ,`), true);
      }),
      { seed: SEED, numRuns: 100 },
    );
  });
});
