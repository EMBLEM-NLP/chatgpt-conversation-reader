/**
 * ATK-08(b): a single conversation larger than the sniffing limit (DEFAULT_MAX_DETECT_CHARS, 64 Mi characters) is not parsed to
 * find its provider, and the import then said "no element has a ChatGPT mapping or a Claude chat_messages array" although the
 * element does have a mapping. The registry now says what really happened (the element is too large to sniff) and what to do
 * (pass --provider chatgpt|claude). The error CODES are unchanged (IMPORT_UNSUPPORTED_FORMAT, details.reason PROVIDER_UNDETECTED).
 *
 * The import runner builds its error with `providerUndetectedError` (registry.ts); see the contract request in the report of
 * this fix wave for the three lines the runner needs.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GcrError } from '../../src/errors.js';
import { DEFAULT_MAX_DETECT_CHARS, SNIFF_SKIPPED_TOO_LARGE, detectAdapterFromElementText, providerUndetectedError } from '../../src/ingest/registry.js';

describe('ATK-08(b): sniffing skipped because the element is too large', () => {
  const text = '{"mapping":{},"pad":"xxxxxxxxxx"}';

  it('the reason says the element is too large to sniff and that --provider chatgpt|claude must be passed; the result keys are unchanged', () => {
    const r = detectAdapterFromElementText(text, { maxChars: text.length - 1 });
    assert.equal(r.adapter, null);
    assert.match(r.reason, /too large to sniff/i);
    assert.match(r.reason, /--provider chatgpt\|claude/);
    assert.match(r.reason, /sniffing limit/, 'the older wording is still there');
    assert.deepEqual(Object.keys(r).sort(), ['adapter', 'reason']);
    assert.equal(r.reason, SNIFF_SKIPPED_TOO_LARGE, 'the exported constant names exactly this situation');
    assert.ok(!r.reason.includes('xxxxxxxxxx'), 'no element content in the reason');
  });

  it('no other undetected case uses that reason (a caller can tell "too large" from "no marker")', () => {
    for (const el of ['{"x":1}', '[]', 'not json', '{"mapping":null}', '{"mapping":{},"chat_messages":[]}']) {
      assert.notEqual(detectAdapterFromElementText(el).reason, SNIFF_SKIPPED_TOO_LARGE, el);
    }
  });

  it('the default limit is unchanged (64 MiB characters)', () => {
    assert.equal(DEFAULT_MAX_DETECT_CHARS, 64 * 1024 * 1024);
  });
});

describe('providerUndetectedError', () => {
  it('without an oversize element it is the error the importer has always produced', () => {
    const e = providerUndetectedError({ tooLarge: false });
    assert.ok(e instanceof GcrError);
    assert.equal(e.code, 'IMPORT_UNSUPPORTED_FORMAT');
    assert.equal(e.details?.['reason'], 'PROVIDER_UNDETECTED');
    assert.match(e.message, /could not be detected/);
    assert.match(e.message, /no element has a ChatGPT "mapping" or a Claude "chat_messages" array/);
    assert.match(e.remedy ?? '', /--provider chatgpt \| claude/);
  });

  it('with an oversize element it says so, names the way out, and keeps code and reason', () => {
    const e = providerUndetectedError({ tooLarge: true });
    assert.equal(e.code, 'IMPORT_UNSUPPORTED_FORMAT');
    assert.equal(e.details?.['reason'], 'PROVIDER_UNDETECTED');
    assert.equal(e.details?.['sniffSkipped'], 'ELEMENT_TOO_LARGE');
    assert.equal(e.details?.['maxDetectChars'], DEFAULT_MAX_DETECT_CHARS);
    assert.match(e.message, /too large to sniff/i);
    assert.doesNotMatch(e.message, /no element has/i, 'the misleading claim is gone');
    assert.match(e.remedy ?? '', /--provider chatgpt\|claude/);
    assert.match(e.remedy ?? '', /must|pass|select/i);
  });
});
