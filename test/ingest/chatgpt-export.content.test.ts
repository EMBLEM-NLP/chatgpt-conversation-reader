/**
 * Message content: the 16 named content types, every parts[] variant, hidden rules, attachments and the asset index,
 * sanitation (NUL, lone surrogates), and the size limits. All data is synthetic.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ConversationRecord, MessageRecord } from '../../src/domain/types.js';
import { validateConversationRecord } from '../../src/domain/validate.js';
import { GcrError } from '../../src/errors.js';
import type { AdapterContext } from '../../src/ingest/adapter.js';
import { ChatGPTExportAdapter, MAX_RAW_NESTING_DEPTH, NAMED_CONTENT_TYPES, chatGptExportAdapter } from '../../src/ingest/chatgpt-export.js';
import type { ChatGPTAdapterLimits } from '../../src/ingest/chatgpt-export.js';
import { ConversationBuilder, OMIT, adapterContext, contents, parts, rawJson, syntheticUuid } from '../helpers/chatgpt-export-builder.js';
import type { MessageOptions, RawObject } from '../helpers/chatgpt-export-builder.js';

interface One {
  r: ConversationRecord;
  m: MessageRecord;
}

/** A conversation with a structural root and ONE message carrying `content`; returns the validated record and that message. */
function one(content: unknown, o: MessageOptions & { role?: string; adapter?: ChatGPTExportAdapter; ctx?: AdapterContext } = {}): One {
  const b = new ConversationBuilder({ id: syntheticUuid(1) });
  b.message(b.root(), o.role ?? 'assistant', content, { id: 'm', ...o });
  const out = (o.adapter ?? chatGptExportAdapter).normalizeElementText(b.text(), o.ctx ?? adapterContext(), 0);
  assert.equal(out.kind, 'record');
  if (out.kind !== 'record') throw new Error('unreachable');
  const r = validateConversationRecord(out.record);
  const m = r.messages.find((x) => x.id === 'm');
  assert.ok(m);
  return { r, m };
}

function codes(r: ConversationRecord): string[] {
  return r.warnings.map((w) => w.code);
}
const types = (m: MessageRecord): string[] => m.blocks.map((b) => b.type);
const meta = (m: MessageRecord, i = 0): RawObject => m.blocks[i]?.metadata as RawObject;

describe('named content types: explicit handlers', () => {
  it('there are exactly the 16 named types of the format notes', () => {
    assert.equal(NAMED_CONTENT_TYPES.length, 16);
    assert.equal(new Set(NAMED_CONTENT_TYPES).size, 16);
  });

  describe('text / multimodal_text', () => {
    it('string parts become text blocks; message.text joins them with a newline; empty parts keep a block but add no text', () => {
      const { m, r } = one(contents.text('first', '', 'second'));
      assert.deepEqual(types(m), ['text', 'text', 'text']);
      assert.equal(m.text, 'first\nsecond');
      assert.equal(m.blocks[1]?.text, '');
      assert.deepEqual(r.warnings, []);
    });
    it('a single part is the very same string (no copy)', () => {
      const { m } = one(contents.text('only'));
      assert.equal(m.text, 'only');
      assert.equal(m.blocks[0]?.text, 'only');
    });
    it('parts null / absent / [] are normal: zero blocks, empty text, no warning', () => {
      for (const c of [{ content_type: 'text', parts: null }, { content_type: 'text' }, { content_type: 'text', parts: [] }, { content_type: 'multimodal_text', parts: null }]) {
        const { m, r } = one(c);
        assert.equal(m.text, '');
        assert.deepEqual(m.blocks, []);
        assert.deepEqual(r.warnings, [], JSON.stringify(c));
      }
    });
    it('parts of the wrong type: kept raw in an unknown block, CONTENT_SHAPE_UNEXPECTED, no text', () => {
      for (const bad of ['loose string', { a: 1 }, 5, true]) {
        const { m, r } = one({ content_type: 'text', parts: bad });
        assert.deepEqual(types(m), ['unknown']);
        assert.deepEqual(meta(m)['raw'], bad);
        assert.equal(m.text, '');
        assert.ok(codes(r).includes('CONTENT_SHAPE_UNEXPECTED'));
      }
    });
  });

  describe('code', () => {
    it('keeps the code as a code block with language / response_format_name as metadata; recipient and channel stay on the message', () => {
      const { m } = one({ content_type: 'code', language: 'python', response_format_name: 'json', text: 'x = 1' }, { recipient: 'python', channel: 'commentary' });
      assert.deepEqual(types(m), ['code']);
      assert.equal(m.text, 'x = 1');
      assert.deepEqual(meta(m), { contentType: 'code', language: 'python', responseFormatName: 'json' });
      assert.equal(m.recipient, 'python');
      assert.equal(m.channel, 'commentary');
      assert.equal(m.hidden, false);
    });
    it('missing or non-string text: an empty code block + CONTENT_SHAPE_UNEXPECTED (nothing invented)', () => {
      for (const c of [{ content_type: 'code', language: 'unknown' }, { content_type: 'code', text: 5 }, { content_type: 'code', text: null }]) {
        const { m, r } = one(c);
        assert.deepEqual(types(m), ['code']);
        assert.equal(m.blocks[0]?.text, undefined);
        assert.equal(m.text, '');
        assert.ok(codes(r).includes('CONTENT_SHAPE_UNEXPECTED'));
      }
    });
    it('non-string language is simply not recorded', () => {
      const { m } = one({ content_type: 'code', language: 5, text: 'x' });
      assert.deepEqual(meta(m), { contentType: 'code' });
    });
  });

  describe('single-string content types', () => {
    const cases: Array<[string, RawObject, string, string]> = [
      ['execution_output', contents.executionOutput('out text'), 'tool_output', 'out text'],
      ['tether_quote', contents.tetherQuote({ text: 'quote text' }), 'citation', 'quote text'],
      ['sonic_webpage', contents.sonicWebpage({ text: 'page text' }), 'citation', 'page text'],
      ['system_error', contents.systemError('err text'), 'error', 'err text'],
      ['citable_code_output', contents.citableCodeOutput('citable text'), 'tool_output', 'citable text'],
      ['reasoning_recap', contents.reasoningRecap('recap text'), 'reasoning_recap', 'recap text'],
    ];
    for (const [name, content, block, text] of cases) {
      it(`${name}: ${block} block with the text, contentType in metadata`, () => {
        const { m, r } = one(content);
        assert.deepEqual(types(m), [block]);
        assert.equal(m.text, text);
        assert.equal(meta(m)['contentType'], name);
        assert.deepEqual(r.warnings, []);
        assert.equal(m.contentType, name);
      });
      it(`${name}: a missing/non-string text field is a shape warning with an empty block`, () => {
        const field = name === 'citable_code_output' ? 'output_str' : name === 'reasoning_recap' ? 'content' : 'text';
        for (const bad of [OMIT, null, 7, { x: 1 }]) {
          const c: RawObject = { ...content };
          if (bad === OMIT) Reflect.deleteProperty(c, field);
          else c[field] = bad;
          const { m, r } = one(c);
          assert.equal(m.text, '', name);
          assert.deepEqual(types(m), [block]);
          assert.ok(codes(r).includes('CONTENT_SHAPE_UNEXPECTED'), name);
        }
      });
    }
    it('tether_quote / sonic_webpage metadata keeps only string fields (url, domain, title ...)', () => {
      const { m } = one({ content_type: 'tether_quote', url: 'u', domain: 5, title: 't', text: 'x' });
      assert.deepEqual(meta(m), { contentType: 'tether_quote', url: 'u', title: 't' });
      const s = one(contents.sonicWebpage());
      assert.equal(meta(s.m)['snippet'], 'synthetic snippet');
      assert.equal(meta(s.m)['ref_id'], 'turn0search0');
    });
    it('system_error keeps the error name in metadata', () => {
      assert.equal(meta(one(contents.systemError()).m)['name'], 'SyntheticError');
    });
  });

  describe('tether_browsing_display', () => {
    it('result becomes the tool_output text; summary / tether_id / assets are metadata', () => {
      const assets = [{ k: 1 }];
      const { m } = one(contents.tetherBrowsingDisplay({ result: 'res', summary: 'sum', assets, tetherId: 'tid' }));
      assert.equal(m.text, 'res');
      assert.deepEqual(meta(m), { contentType: 'tether_browsing_display', summary: 'sum', tether_id: 'tid', assets });
    });
    it('null summary/assets are not recorded; a missing result is a shape warning', () => {
      const { m } = one(contents.tetherBrowsingDisplay());
      assert.deepEqual(meta(m), { contentType: 'tether_browsing_display' });
      const bad = one({ content_type: 'tether_browsing_display', result: null });
      assert.ok(codes(bad.r).includes('CONTENT_SHAPE_UNEXPECTED'));
      assert.equal(bad.m.text, '');
    });
  });

  describe('raw-preserving types (field set unknown): tether_browsing_code, app_pairing_content', () => {
    for (const make of [contents.tetherBrowsingCode, contents.appPairingContent]) {
      const c = make();
      it(`${String(c['content_type'])}: whole payload kept in an unknown block, no text, and NOT reported as an unknown content type`, () => {
        const { m, r } = one(c);
        assert.deepEqual(types(m), ['unknown']);
        assert.deepEqual(meta(m), { contentType: c['content_type'], raw: c });
        assert.equal(m.text, '');
        assert.deepEqual(r.warnings, []);
        assert.equal(m.contentType, c['content_type']);
      });
    }
  });

  describe('user_editable_context / model_editable_context', () => {
    it('real values in the content fields become context blocks; "None" is ignored', () => {
      const { m } = one(contents.userEditableContext({ profile: 'about me text', instructions: 'None' }));
      assert.deepEqual(types(m), ['context']);
      assert.equal(m.text, 'about me text');
      assert.equal(meta(m)['field'], 'user_profile');
      assert.equal(m.hidden, true);
    });
    it('when the content fields are empty/"None", the values come from metadata.user_context_message_data', () => {
      const md = { user_context_message_data: { about_user_message: 'AU', about_model_message: 'AM' } };
      const { m } = one(contents.userEditableContext(), { metadata: md });
      assert.equal(m.text, 'AU\nAM');
      assert.equal(meta(m)['field'], 'metadata.user_context_message_data.about_user_message');
    });
    it('content values win over metadata; no source at all -> no blocks and no warning', () => {
      const md = { user_context_message_data: { about_user_message: 'AU' } };
      assert.equal(one(contents.userEditableContext({ profile: 'P' }), { metadata: md }).m.text, 'P');
      const none = one(contents.userEditableContext());
      assert.deepEqual(none.m.blocks, []);
      assert.deepEqual(none.r.warnings, []);
      const odd = one(contents.userEditableContext(), { metadata: { user_context_message_data: 'not an object' } });
      assert.deepEqual(odd.m.blocks, []);
    });
    it('model_editable_context: string fields -> context blocks; structured (non-string) values are kept raw without text; nulls skipped', () => {
      const { m } = one({ content_type: 'model_editable_context', model_set_context: 'mem', repository: null, repo_summary: '', structured_context: { k: [1] } });
      assert.deepEqual(types(m), ['context', 'context']);
      assert.equal(m.text, 'mem');
      assert.deepEqual(meta(m, 1), { contentType: 'model_editable_context', field: 'structured_context', raw: { k: [1] } });
      assert.equal(m.hidden, true);
    });
  });

  describe('thoughts', () => {
    it('array form: summary + content per item; finished and source id are metadata; hidden', () => {
      const { m, r } = one(contents.thoughts([{ summary: 'S1', content: 'C1', finished: true }, { summary: 'S2', content: '', finished: false }]));
      assert.deepEqual(types(m), ['thoughts', 'thoughts']);
      assert.equal(m.blocks[0]?.text, 'S1\nC1');
      assert.equal(m.blocks[1]?.text, 'S2');
      assert.equal(meta(m, 0)['finished'], true);
      assert.equal(meta(m, 1)['finished'], false);
      assert.equal(meta(m, 0)['index'], 0);
      assert.equal(meta(m, 0)['sourceAnalysisMsgId'], syntheticUuid(0xaa));
      assert.equal(m.text, 'S1\nC1\nS2');
      assert.equal(m.hidden, true);
      assert.deepEqual(r.warnings, []);
    });
    it('JSON-string form gives the same blocks as the array form', () => {
      const items = [{ summary: 'S1', content: 'C1', finished: true }];
      const a = one(contents.thoughts(items, false)).m;
      const s = one(contents.thoughts(items, true)).m;
      assert.deepEqual(s.blocks, a.blocks);
      assert.equal(s.text, a.text);
    });
    it('chunks are used only when content is not a string', () => {
      const { m } = one({ content_type: 'thoughts', thoughts: [{ summary: 'S', chunks: ['a', 'b'] }, { content: 'C', chunks: ['x'] }] });
      assert.equal(m.blocks[0]?.text, 'S\nab');
      assert.equal(m.blocks[1]?.text, 'C');
    });
    it('items with nothing readable, or that are not objects, are kept raw (shape warning only for non-objects)', () => {
      const { m, r } = one({ content_type: 'thoughts', thoughts: [{}, 'str', 7, { summary: 5, chunks: [1] }] });
      assert.equal(m.blocks.length, 4);
      assert.equal(m.text, '');
      assert.deepEqual(meta(m, 0)['raw'], {});
      assert.equal(meta(m, 1)['raw'], 'str');
      assert.equal(r.warnings.find((w) => w.code === 'CONTENT_SHAPE_UNEXPECTED')?.message.includes('thoughts.item'), true);
    });
    it('a string that is not JSON, JSON that is not an array, a number, null and absent are handled without throwing', () => {
      const bad = one({ content_type: 'thoughts', thoughts: 'plain words, not json' });
      assert.deepEqual(types(bad.m), ['thoughts']);
      assert.equal(meta(bad.m)['rawThoughts'], 'plain words, not json');
      assert.equal(bad.m.text, '', 'a string that is not the documented JSON is never presented as reasoning text');
      assert.ok(codes(bad.r).includes('CONTENT_SHAPE_UNEXPECTED'));
      const obj = one({ content_type: 'thoughts', thoughts: '{"a":1}' });
      assert.ok(codes(obj.r).includes('CONTENT_SHAPE_UNEXPECTED'));
      const num = one({ content_type: 'thoughts', thoughts: 5 });
      assert.deepEqual(meta(num.m)['raw'], 5);
      assert.ok(codes(num.r).includes('CONTENT_SHAPE_UNEXPECTED'));
      for (const c of [{ content_type: 'thoughts', thoughts: null }, { content_type: 'thoughts' }]) {
        const x = one(c);
        assert.deepEqual(types(x.m), ['thoughts']);
        assert.deepEqual(x.r.warnings, []);
      }
    });
    it('hidden reasoning is never fabricated: nothing but the exported strings appears', () => {
      const { m } = one(contents.thoughts([{ summary: 'only this' }]));
      assert.equal(m.text, 'only this');
    });
  });

  describe('computer_output', () => {
    it('screenshot given as an asset-pointer object becomes an image_ref block plus attachment metadata', () => {
      const { m } = one(contents.computerOutput({ screenshot: parts.image('sediment://file_000000000000000000000000000000aa') }));
      assert.deepEqual(types(m), ['tool_output', 'image_ref']);
      assert.equal(m.text, '[image]');
      assert.equal(m.attachments[0]?.id, 'file_000000000000000000000000000000aa');
      assert.deepEqual(meta(m), { contentType: 'computer_output', computer_id: 'synthetic-computer-1', state: 'ok', isEphemeral: false });
    });
    it('null screenshot adds nothing; a non-object screenshot is an unknown part', () => {
      assert.deepEqual(types(one(contents.computerOutput()).m), ['tool_output']);
      const s = one(contents.computerOutput({ screenshot: 'base64-looking-string' }));
      assert.deepEqual(types(s.m), ['tool_output', 'unknown']);
      assert.ok(codes(s.r).includes('UNKNOWN_PART_TYPE'));
      assert.equal(s.m.text, '');
    });
  });

  describe('unknown content types', () => {
    it('become one unknown block with the whole content kept raw, no text, and UNKNOWN_CONTENT_TYPE', () => {
      const c = contents.unknown('future_widget_v9');
      const { m, r } = one(c);
      assert.deepEqual(types(m), ['unknown']);
      assert.deepEqual(meta(m), { contentType: 'future_widget_v9', raw: c });
      assert.equal(m.text, '');
      assert.equal(m.contentType, 'future_widget_v9');
      assert.equal(r.warnings.filter((w) => w.code === 'UNKNOWN_CONTENT_TYPE').length, 1);
    });
    it('are aggregated ONCE PER TYPE per conversation with a count', () => {
      const b = new ConversationBuilder({ id: syntheticUuid(1) });
      let p = b.root();
      for (const t of ['alpha_v1', 'beta_v1', 'alpha_v1', 'alpha_v1', 'beta_v1']) p = b.message(p, 'assistant', contents.unknown(t));
      const out = chatGptExportAdapter.normalizeElementText(b.text(), adapterContext(), 0);
      assert.equal(out.kind, 'record');
      if (out.kind !== 'record') return;
      const w = out.record.warnings.filter((x) => x.code === 'UNKNOWN_CONTENT_TYPE');
      assert.equal(w.length, 2);
      const alpha = w.find((x) => x.message.includes('alpha_v1'));
      const beta = w.find((x) => x.message.includes('beta_v1'));
      assert.match(alpha?.message ?? '', /\(3 occurrences\)$/);
      assert.match(beta?.message ?? '', /\(2 occurrences\)$/);
      assert.equal(alpha?.ids?.length, 3);
    });
    it('the type name is reduced to <= 64 harmless characters inside the warning', () => {
      const hostile = `evil<script>alert(1)</script>\n"quoted" ${'x'.repeat(500)}`;
      const { r, m } = one({ content_type: hostile, a: 1 });
      const w = r.warnings.find((x) => x.code === 'UNKNOWN_CONTENT_TYPE');
      assert.ok(w);
      assert.match(w.message, /^Unknown content_type "[A-Za-z0-9_.:/?-]{1,64}" was kept/);
      assert.ok(!w.message.includes('<') && !w.message.includes('\n') && !w.message.includes('"quoted"'));
      assert.equal(m.contentType, hostile.slice(0, 512), 'the message keeps the (bounded) type verbatim');
    });
    it('lookups use exact names: "TEXT", "text " and "Text" are unknown types, not text', () => {
      for (const t of ['TEXT', 'text ', 'Text', 'multimodal-text']) {
        const { m, r } = one({ content_type: t, parts: ['x'] });
        assert.deepEqual(types(m), ['unknown'], t);
        assert.ok(codes(r).includes('UNKNOWN_CONTENT_TYPE'), t);
      }
    });
    it('a known type name that is an Object.prototype member cannot hit a handler by accident', () => {
      for (const t of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
        const { m, r } = one({ content_type: t });
        assert.deepEqual(types(m), ['unknown'], t);
        assert.ok(codes(r).includes('UNKNOWN_CONTENT_TYPE'), t);
      }
    });
  });

  describe('missing or odd content objects', () => {
    it('content null/absent: no blocks, CONTENT_MALFORMED, contentType null', () => {
      for (const c of [null, undefined]) {
        const b = new ConversationBuilder({ id: syntheticUuid(1) });
        b.message(b.root(), 'user', c, { id: 'm', set: c === undefined ? { content: OMIT } : {} });
        const out = chatGptExportAdapter.normalizeElementText(b.text(), adapterContext(), 0);
        assert.equal(out.kind, 'record');
        if (out.kind !== 'record') return;
        const m = out.record.messages.find((x) => x.id === 'm') as MessageRecord;
        assert.deepEqual(m.blocks, []);
        assert.equal(m.contentType, null);
        assert.ok(out.record.warnings.some((w) => w.code === 'CONTENT_MALFORMED'));
      }
    });
    it('content that is a string/array/number is kept raw in an unknown block (never coerced to text)', () => {
      for (const c of ['loose text', ['a', 'b'], 12]) {
        const { m, r } = one(c);
        assert.deepEqual(types(m), ['unknown']);
        assert.deepEqual(meta(m)['raw'], c);
        assert.equal(m.text, '');
        assert.ok(codes(r).includes('CONTENT_MALFORMED'));
      }
    });
    it('content_type missing or not a string: kept raw, CONTENT_MALFORMED, contentType null', () => {
      for (const c of [{ parts: ['x'] }, { content_type: 5, parts: ['x'] }, { content_type: null }]) {
        const { m, r } = one(c);
        assert.equal(m.contentType, null);
        assert.deepEqual(types(m), ['unknown']);
        assert.ok(codes(r).includes('CONTENT_MALFORMED'));
      }
    });
  });
});

describe('parts[] variants', () => {
  it('image / audio / video / real-time parts: typed ref blocks, generic placeholders, raw object in metadata', () => {
    const image = parts.image('sediment://file_000000000000000000000000000000a1', 77);
    const audio = parts.audioPointer('sediment://file_000000000000000000000000000000a2');
    const video = parts.videoContainer('sediment://file_000000000000000000000000000000a3');
    const rt = parts.realTime();
    const { m } = one(contents.multimodal([image, audio, video, rt]));
    assert.deepEqual(types(m), ['image_ref', 'audio_ref', 'file_ref', 'audio_ref']);
    assert.equal(m.text, '[image]\n[audio]\n[file]\n[audio]');
    assert.deepEqual(meta(m, 0), { contentType: 'image_asset_pointer', assetPointer: 'sediment://file_000000000000000000000000000000a1', raw: image });
    assert.equal(meta(m, 3)['contentType'], 'real_time_user_audio_video_asset_pointer');
    assert.deepEqual(meta(m, 3)['raw'], rt);
  });
  it('image part without a usable asset_pointer is still an image_ref block and creates no attachment', () => {
    for (const ap of [OMIT, null, 5, '']) {
      const p: RawObject = { ...parts.image() };
      if (ap === OMIT) Reflect.deleteProperty(p, 'asset_pointer');
      else p['asset_pointer'] = ap;
      const { m } = one(contents.multimodal([p]));
      assert.deepEqual(types(m), ['image_ref']);
      assert.deepEqual(m.attachments, []);
      assert.equal(m.text, '[image]');
    }
  });
  it('parts keyed by `type` instead of `content_type` (search results) become citation blocks without text', () => {
    const { m } = one(contents.multimodal([parts.searchResultGroup(), { type: 'search_result', url: 'u' }]));
    assert.deepEqual(types(m), ['citation', 'citation']);
    assert.equal(m.text, '');
    assert.equal(meta(m, 0)['contentType'], 'search_result_group');
  });
  it('audio_transcription is real text (type text, direction in metadata); without text it is unknown', () => {
    const { m } = one(contents.multimodal([parts.audioTranscription('hello there', 'out'), { content_type: 'audio_transcription' }]));
    assert.deepEqual(types(m), ['text', 'unknown']);
    assert.equal(m.text, 'hello there');
    assert.equal(meta(m, 0)['direction'], 'out');
  });
  it('any other *_asset_pointer with a string pointer is a file_ref', () => {
    const { m } = one(contents.multimodal([{ content_type: 'sprite_asset_pointer', asset_pointer: 'file-service://file-ZZ' }]));
    assert.deepEqual(types(m), ['file_ref']);
    assert.equal(m.attachments[0]?.id, 'file-ZZ');
    assert.equal(m.text, '[file]');
  });
  it('numbers, booleans, null, nested arrays and unrecognised objects: unknown blocks with the raw value, never "[object Object]"', () => {
    const nested = [['a'], [{ b: 1 }]];
    const { m, r } = one(contents.multimodal([1.5, false, null, nested[0], { x: { y: 1 } }, 'ok']));
    assert.deepEqual(types(m), ['unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'text']);
    assert.deepEqual(m.blocks.slice(0, 5).map((b) => (b.metadata as RawObject)['raw']), [1.5, false, null, ['a'], { x: { y: 1 } }]);
    assert.equal(m.text, 'ok');
    assert.ok(!m.text.includes('[object') && !m.text.includes('null') && !m.text.includes('1.5'));
    const w = r.warnings.find((x) => x.code === 'UNKNOWN_PART_TYPE');
    assert.match(w?.message ?? '', /\(5 occurrences\)$/);
  });
  it('a part with a toString-like or prototype-looking key does not confuse the type switch', () => {
    const { m } = one(contents.multimodal([{ content_type: '__proto__', asset_pointer: 'x' }, { content_type: 'constructor' }]));
    assert.deepEqual(types(m), ['unknown', 'unknown']);
  });
  it('real-time part: audio, video container and frame pointers are all recorded as attachment METADATA', () => {
    const { m } = one(contents.multimodal([parts.realTime()]));
    assert.deepEqual(m.attachments.map((a) => a.id), ['file_00000000000000000000000000000003', 'file_00000000000000000000000000000004', 'file_00000000000000000000000000000005']);
    assert.ok(m.attachments.every((a) => a.presentInExportAs === null));
  });
  it('the number of parts converted per message is capped (PARTS_TRUNCATED); the rest stays in rawSource', () => {
    const adapter = new ChatGPTExportAdapter({ limits: { maxPartsPerMessage: 3 } });
    const { m, r } = one(contents.text('1', '2', '3', '4', '5'), { adapter });
    assert.equal(m.blocks.length, 3);
    assert.equal(m.text, '1\n2\n3');
    assert.ok(codes(r).includes('PARTS_TRUNCATED'));
    assert.equal((((m.rawSource as RawObject)['content'] as RawObject)['parts'] as unknown[]).length, 5);
    assert.ok(!codes(one(contents.text('1', '2', '3'), { adapter }).r).includes('PARTS_TRUNCATED'), 'exactly at the limit is fine');
  });
});

describe('hidden', () => {
  const hiddenOf = (content: unknown, o: MessageOptions & { role?: string } = {}): boolean => one(content, o).m.hidden;

  it('is true for role "system", the visually-hidden flag, and the four scaffolding content types', () => {
    assert.equal(hiddenOf(contents.text('x'), { role: 'system' }), true);
    assert.equal(hiddenOf(contents.text('x'), { role: 'user', hidden: true }), true);
    assert.equal(hiddenOf(contents.userEditableContext(), { role: 'user' }), true);
    assert.equal(hiddenOf(contents.modelEditableContext(), { role: 'user' }), true);
    assert.equal(hiddenOf(contents.thoughts([{ summary: 'x' }]), { role: 'assistant' }), true);
    assert.equal(hiddenOf(contents.reasoningRecap(), { role: 'assistant' }), true);
  });
  it('is false for user/assistant text, tool output, code, execution output, errors, browsing and citations', () => {
    assert.equal(hiddenOf(contents.text('x'), { role: 'user' }), false);
    assert.equal(hiddenOf(contents.text('x'), { role: 'assistant' }), false);
    for (const [role, c] of [
      ['tool', contents.executionOutput('x')],
      ['tool', contents.tetherQuote()],
      ['tool', contents.tetherBrowsingDisplay()],
      ['tool', contents.systemError()],
      ['tool', contents.sonicWebpage()],
      ['assistant', contents.code('x')],
      ['tool', contents.citableCodeOutput()],
      ['tool', contents.computerOutput()],
    ] as Array<[string, RawObject]>) {
      assert.equal(hiddenOf(c, { role }), false, String(c['content_type']));
    }
  });
  it('only a boolean true counts: false, "true", 1 and null do not hide', () => {
    for (const v of [false, 'true', 1, null, 'yes']) {
      assert.equal(hiddenOf(contents.text('x'), { role: 'user', metadata: { is_visually_hidden_from_conversation: v } }), false, JSON.stringify(v));
    }
  });
  it('the match is exact: role "System" / "system " are not system', () => {
    assert.equal(hiddenOf(contents.text('x'), { role: 'System' }), false);
    assert.equal(hiddenOf(contents.text('x'), { role: 'system ' }), false);
  });
  it('hidden messages keep all their content (hidden is an attribute, not a deletion)', () => {
    const { m } = one(contents.text('scaffolding text'), { role: 'system' });
    assert.equal(m.text, 'scaffolding text');
    assert.equal(m.blocks.length, 1);
  });
});

describe('attachments: metadata.attachments[] and asset pointers', () => {
  const att = (items: unknown[], c?: AdapterContext): One => one(contents.text('x'), { role: 'user', attachments: items, ctx: c });

  it('reads id, name, mime_type|mimeType and the byte-size variants; token counts are not bytes', () => {
    const { m } = att([
      { id: 'file-A', name: 'a.txt', mime_type: 'text/plain', size: 10 },
      { id: 'file-B', mimeType: 'image/png', size_bytes: 20 },
      { id: 'file-C', file_size_bytes: 30 },
      { id: 'file-D', sizeBytes: 40 },
      { id: 'file-E', size: -1 },
      { id: 'file-F', size: 1.5 },
      { id: 'file-G', size: '12' },
      { id: 'file-H', fileSizeTokens: 5, file_token_size: 6 },
      { id: 'file-I', size: 0 },
    ]);
    assert.deepEqual(m.attachments.map((a) => [a.id, a.name, a.mimeType, a.sizeBytes]), [
      ['file-A', 'a.txt', 'text/plain', 10],
      ['file-B', null, 'image/png', 20],
      ['file-C', null, null, 30],
      ['file-D', null, null, 40],
      ['file-E', null, null, null],
      ['file-F', null, null, null],
      ['file-G', null, null, null],
      ['file-H', null, null, null],
      ['file-I', null, null, 0],
    ]);
  });
  it('an unusable id becomes null (and is reported); an entry with no fields is still kept as an all-null reference', () => {
    const { m, r } = att([{ id: 5, name: 'n' }, { id: '' }, { id: 'a\nb' }, {}]);
    assert.deepEqual(m.attachments.map((a) => a.id), [null, null, null, null]);
    assert.equal(m.attachments[0]?.name, 'n');
    assert.ok(codes(r).includes('UNEXPECTED_FIELD_TYPE'));
  });
  it('non-object entries and a non-array attachments value are reported and ignored', () => {
    const a = att(['str', 5, null, ['x']]);
    assert.deepEqual(a.m.attachments, []);
    assert.ok(codes(a.r).includes('UNEXPECTED_FIELD_TYPE'));
    const b = one(contents.text('x'), { metadata: { attachments: { id: 'file-A' } } });
    assert.deepEqual(b.m.attachments, []);
    assert.ok(codes(b.r).includes('UNEXPECTED_FIELD_TYPE'));
    assert.deepEqual(one(contents.text('x'), { metadata: { attachments: null } }).r.warnings, []);
  });
  it('names are inert strings: path-like and markup names are stored verbatim, and never become presentInExportAs', () => {
    const c = adapterContext({ availableAssetNames: new Set(['../../etc/passwd', 'evil.png']) });
    const { m } = att([{ id: 'file-A', name: '../../etc/passwd' }, { id: 'file-B', name: 'evil.png' }, { name: '<img src=x onerror=1>' }], c);
    assert.deepEqual(m.attachments.map((a) => a.name), ['../../etc/passwd', 'evil.png', '<img src=x onerror=1>']);
    assert.ok(m.attachments.every((a) => a.presentInExportAs === null), 'presence is decided by the id, never by the display name');
  });
  it('the same file given twice (same id) is merged into one reference, filling gaps', () => {
    const { m } = att([{ id: 'file-A', name: 'a.txt' }, { id: 'file-A', mime_type: 'text/plain', size: 5 }, { id: 'file-A', name: 'other-name.txt' }]);
    assert.deepEqual(m.attachments, [{ id: 'file-A', name: 'a.txt', mimeType: 'text/plain', sizeBytes: 5, assetPointer: null, presentInExportAs: null }]);
  });
  it('the same id on two different messages stays two references (they are different messages)', () => {
    const b = new ConversationBuilder({ id: syntheticUuid(1) });
    const u1 = b.user(b.root(), 'a', { id: 'u1', attachments: [{ id: 'file-A' }] });
    b.user(u1, 'b', { id: 'u2', attachments: [{ id: 'file-A' }] });
    const out = chatGptExportAdapter.normalizeElementText(b.text(), adapterContext(), 0);
    assert.equal(out.kind === 'record' && out.record.messages.filter((m) => m.attachments.length === 1).length, 2);
  });
  it('an attachment pointer given in the object is kept as assetPointer (never dereferenced)', () => {
    const { m } = att([{ id: 'file-A', asset_pointer: 'file-service://file-A' }]);
    assert.equal(m.attachments[0]?.assetPointer, 'file-service://file-A');
  });
  it('asset pointer file ids are parsed from the three documented pointer forms', () => {
    const ptrs = ['sediment://file_0000000000000000000000000000000f', 'file-service://file-ABC123', 'sediment://deadbeefhash#file_0000000000000000000000000000000e#p_2.jpg', 'file-service://dir/sub/file-XYZ', 'weird-pointer-without-scheme', 'sediment://'];
    const { m } = one(contents.multimodal(ptrs.map((p) => parts.image(p))));
    assert.deepEqual(m.attachments.map((a) => a.id), ['file_0000000000000000000000000000000f', 'file-ABC123', 'file_0000000000000000000000000000000e', 'file-XYZ', 'weird-pointer-without-scheme', null]);
  });
});

describe('presentInExportAs: only for names that really exist in the container', () => {
  const present = (id: string, names: Iterable<string> | undefined): string | null => {
    const c = adapterContext(names === undefined ? {} : { availableAssetNames: new Set(names) });
    const { m } = one(contents.text('x'), { role: 'user', attachments: [{ id }], ctx: c });
    return m.attachments[0]?.presentInExportAs ?? null;
  };

  it('exact name, then <id>.dat, then a basename that starts with the id plus - _ or .', () => {
    assert.equal(present('file-X', ['file-X']), 'file-X');
    assert.equal(present('file-X', ['file-X.dat']), 'file-X.dat');
    assert.equal(present('file-X', ['file-X-synthetic-name.png']), 'file-X-synthetic-name.png');
    assert.equal(present('file-X', ['file-X_name.bin']), 'file-X_name.bin');
    assert.equal(present('file-X', ['file-X.png']), 'file-X.png');
  });
  it('priority: exact > <id>.dat > smallest prefix match; deterministic', () => {
    assert.equal(present('file-X', ['file-X-a.png', 'file-X.dat', 'file-X']), 'file-X');
    assert.equal(present('file-X', ['file-X-a.png', 'file-X.dat']), 'file-X.dat');
    assert.equal(present('file-X', ['file-X-b.png', 'file-X-a.png', 'file-X-c.png']), 'file-X-a.png');
    assert.equal(present('file-X', ['z/file-X-a.png', 'a/file-X-b.png']), 'z/file-X-a.png', 'ordered by basename, then full name');
  });
  it('nested folders match on the basename and return the full archive path', () => {
    assert.equal(present('file-X', ['dalle-generations/file-X-0001.webp']), 'dalle-generations/file-X-0001.webp');
    assert.equal(present('file-X', ['user-123/file-X.png']), 'user-123/file-X.png');
    assert.equal(present('file-X', ['conv/audio/file-X.dat']), 'conv/audio/file-X.dat');
  });
  it('NEGATIVE: no boundary character, shorter ids, other ids, a folder named like the id: not present', () => {
    assert.equal(present('file-1', ['file-10-x.png']), null, 'file-10 is not file-1');
    assert.equal(present('file-X', ['file-XY.png']), null);
    assert.equal(present('file-XY', ['file-X.png']), null);
    assert.equal(present('file-X', ['xfile-X.png']), null);
    assert.equal(present('file-X', ['file-X/inner.png']), null, 'a folder is not a file');
    assert.equal(present('file-X', ['FILE-X.png']), null, 'case-sensitive');
    assert.equal(present('file-X', []), null);
    assert.equal(present('file-X', undefined), null);
  });
  it('NEGATIVE: unsafe archive names are never reported (traversal, absolute, drive letter, backslash, control char)', () => {
    for (const bad of ['../file-X', 'a/../file-X', '/abs/file-X', 'C:file-X', 'dir\\file-X', 'file-X\u0000.png', 'file-X\n.png']) {
      assert.equal(present('file-X', [bad]), null, JSON.stringify(bad));
    }
    // ...but a safe name next to unsafe ones is still found
    assert.equal(present('file-X', ['../file-X-evil', 'file-X-ok.png']), 'file-X-ok.png');
  });
  it('the container set is indexed once per Set object, and a changed Set is re-indexed', () => {
    const names = new Set(['file-A.dat']);
    const c = adapterContext({ availableAssetNames: names });
    const lookup = (id: string): string | null => one(contents.text('x'), { attachments: [{ id }], ctx: c }).m.attachments[0]?.presentInExportAs ?? null;
    assert.equal(lookup('file-A'), 'file-A.dat');
    assert.equal(lookup('file-B'), null);
    names.add('file-B.dat');
    assert.equal(lookup('file-B'), 'file-B.dat', 'size changed -> index rebuilt');
    assert.equal(lookup('file-A'), 'file-A.dat');
  });
  it('different contexts never see each other\'s assets', () => {
    assert.equal(present('file-Q', ['file-Q.dat']), 'file-Q.dat');
    assert.equal(present('file-Q', ['other.dat']), null);
  });
  it('a hostile 1-character id cannot make lookups slow (bounded prefix probing) and does not match by accident', () => {
    // One Set / one context for all lookups: the index is built once, so this measures the lookup, not the indexing.
    const c = adapterContext({ availableAssetNames: new Set(Array.from({ length: 20_000 }, (_, i) => `f${i}-x.bin`)) });
    const lookup = (): string | null => one(contents.text('x'), { role: 'user', attachments: [{ id: 'f' }], ctx: c }).m.attachments[0]?.presentInExportAs ?? null;
    assert.equal(lookup(), null);
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) assert.equal(lookup(), null);
    assert.ok(performance.now() - t0 < 6000, `200 lookups took ${(performance.now() - t0).toFixed(0)} ms`);
  });
  it('a large container is indexed fast and answers correctly', () => {
    const names = new Set(Array.from({ length: 6_000 }, (_, i) => `file-${i.toString(16).padStart(8, '0')}.dat`));
    assert.equal(present('file-000000ff', names), 'file-000000ff.dat');
    assert.equal(present('file-ffffffff', names), null);
  });
});

describe('sanitation: NUL bytes, lone surrogates, control characters', () => {
  it('message text and block text lose NUL and get U+FFFD for lone surrogates; rawSource keeps the originals', () => {
    const { m, r } = one(contents.text('a\u0000b', 'lone \ud800 high', 'lone \udc00 low', 'pair 😀 ok'));
    assert.deepEqual(m.blocks.map((b) => b.text), ['ab', 'lone � high', 'lone � low', 'pair \u{1F600} ok']);
    assert.equal(m.text, 'ab\nlone � high\nlone � low\npair \u{1F600} ok');
    assert.deepEqual(((m.rawSource as RawObject)['content'] as RawObject)['parts'], ['a\u0000b', 'lone \ud800 high', 'lone \udc00 low', 'pair 😀 ok']);
    assert.deepEqual(r.warnings.filter((w) => w.code === 'NUL_STRIPPED').map((w) => w.ids), [['m']]);
    assert.deepEqual(r.warnings.filter((w) => w.code === 'LONE_SURROGATE').map((w) => w.ids), [['m']]);
  });
  it('the replacement is minimal: well-formed text, other control characters and bidi marks are untouched', () => {
    const s = 'tab\t nl\n cr\r bell\u0007 rlo‮ ls  zwj‍ pua astral\u{10FFFF}';
    const { m, r } = one(contents.text(s));
    assert.equal(m.text, s);
    assert.deepEqual(r.warnings, []);
  });
  it('short fields (role, name, channel, recipient, status, model, content_type) are sanitized too', () => {
    const { m } = one(contents.text('x'), {
      role: 'ro\u0000le\ud800',
      authorName: 'na\u0000me',
      channel: 'ch\u0000an',
      recipient: 're\ud800c',
      status: 'st\u0000at',
      model: 'mo\u0000del',
    });
    assert.equal(m.authorRole, 'role�');
    assert.equal(m.authorName, 'name');
    assert.equal(m.channel, 'chan');
    assert.equal(m.recipient, 're�c');
    assert.equal(m.status, 'stat');
    assert.equal(m.modelSlug, 'model');
    // the NUL-stripped type is what is stored AND what selects the handler, so stored type and interpretation agree
    const ct = one({ content_type: 'te\u0000xt', parts: ['x'] });
    assert.equal(ct.m.contentType, 'text');
    assert.deepEqual(types(ct.m), ['text']);
  });
  it('attachment fields and pointers are sanitized', () => {
    const { m } = one(contents.text('x'), { attachments: [{ id: 'file-A', name: 'na\u0000me\ud800.txt', mime_type: 'te\u0000xt/plain' }] });
    assert.equal(m.attachments[0]?.name, 'name�.txt');
    assert.equal(m.attachments[0]?.mimeType, 'text/plain');
  });
  it('titles are sanitized', () => {
    const b = new ConversationBuilder({ id: syntheticUuid(1), title: 'ti\u0000tle\udfff' });
    b.user(b.root(), 'x');
    const out = chatGptExportAdapter.normalizeElementText(b.text(), adapterContext(), 0);
    assert.equal(out.kind === 'record' && out.record.title, 'title�');
  });
  it('unicode is not normalized: NFC and NFD spellings stay distinct', () => {
    const nfc = 'é';
    const nfd = 'é';
    assert.equal(one(contents.text(nfc)).m.text, nfc);
    assert.equal(one(contents.text(nfd)).m.text, nfd);
  });
  it('NUL inside ids, parent pointers, children and the current node is mapped to stand-ins consistently and the record validates', () => {
    const text = JSON.stringify({
      id: syntheticUuid(1),
      current_node: 'bad\u0000id',
      mapping: {
        'bad\u0000id': { id: 'x', parent: 'p\u0000arent-missing', children: ['c\ud800hild', 'k'], message: null },
        k: { id: 'k', parent: 'bad\u0000id', children: [], message: null },
      },
    });
    const out = chatGptExportAdapter.normalizeElementText(text, adapterContext(), 0);
    assert.equal(out.kind, 'record');
    if (out.kind !== 'record') return;
    const r = validateConversationRecord(out.record);
    const first = r.messages[0] as MessageRecord;
    assert.match(first.id, /^gcr-node-/);
    assert.match(first.parentId ?? '', /^gcr-ref-/);
    assert.match(first.childIds[0] ?? '', /^gcr-ref-/);
    assert.equal(first.childIds[1], 'k');
    assert.equal(r.currentNodeId, first.id);
    assert.equal(r.messages[1]?.parentId, first.id);
  });
  it('a 600-character id is unusable as an identifier and gets a stand-in (ids are bounded to 512)', () => {
    const long = 'L'.repeat(600);
    const text = JSON.stringify({ id: 'c', current_node: long, mapping: { [long]: { id: long, parent: null, message: null }, kid: { id: 'kid', parent: long, message: null } } });
    const out = chatGptExportAdapter.normalizeElementText(text, adapterContext(), 0);
    assert.equal(out.kind, 'record');
    if (out.kind !== 'record') return;
    const r = validateConversationRecord(out.record);
    assert.match(r.messages[0]?.id ?? '', /^gcr-node-/);
    assert.equal(r.messages[1]?.parentId, r.messages[0]?.id);
    assert.equal(r.currentNodeId, r.messages[0]?.id);
  });
  it('warnings never echo message text, titles, attachment names, author names or channels', () => {
    const canary = 'CANARY-LEAK-5521';
    const b = new ConversationBuilder({ id: syntheticUuid(1), title: `${canary} title \u0000` });
    b.message(b.root(), 'user', contents.multimodal([`${canary} text \u0000 \ud800`, 5, { odd: canary }]), {
      id: 'm',
      authorName: `${canary}-name`,
      channel: `${canary}-channel`,
      createTime: `${canary}-time`,
      attachments: [{ id: 'file-A', name: `${canary}-attachment \u0000`, size: `${canary}` }],
    });
    const out = chatGptExportAdapter.normalizeElementText(b.text(), adapterContext(), 0);
    assert.equal(out.kind, 'record');
    if (out.kind !== 'record') return;
    assert.ok(out.record.warnings.length >= 4, 'the scenario must actually produce warnings');
    assert.ok(!JSON.stringify(out.record.warnings).includes(canary));
    for (const w of out.record.warnings) {
      assert.ok(w.message.length <= 2048);
      for (const id of w.ids ?? []) assert.ok(id.length <= 512);
    }
  });
});

describe('size limits', () => {
  it('maxTextBytesPerMessage: text and blocks stop at the byte limit across parts, never splitting a character', () => {
    const adapter = new ChatGPTExportAdapter({ limits: { maxTextBytesPerMessage: 10 } });
    const a = one(contents.text('abcdef', 'ghijkl', 'mnop'), { adapter });
    assert.equal(a.m.text, 'abcdef\nghi');
    assert.deepEqual(a.m.blocks.map((b) => b.text), ['abcdef', 'ghi', '']);
    assert.equal(Buffer.byteLength(a.m.text), 10);
    assert.equal(a.r.warnings.filter((w) => w.code === 'TEXT_TRUNCATED').length, 1);
    const emoji = one(contents.text('\u{1F600}\u{1F600}\u{1F600}'), { adapter: new ChatGPTExportAdapter({ limits: { maxTextBytesPerMessage: 6 } }) });
    assert.equal(emoji.m.text, '\u{1F600}', 'a 4-byte character is not split to fill the remaining 2 bytes');
    const cjk = one(contents.text('日本語のテスト'), { adapter: new ChatGPTExportAdapter({ limits: { maxTextBytesPerMessage: 7 } }) });
    assert.equal(cjk.m.text, '日本');
    assert.ok(Buffer.byteLength(cjk.m.text) <= 7);
  });
  it('exactly at the limit is not truncated', () => {
    const adapter = new ChatGPTExportAdapter({ limits: { maxTextBytesPerMessage: 10 } });
    const { m, r } = one(contents.text('abcdefghij'), { adapter });
    assert.equal(m.text, 'abcdefghij');
    assert.ok(!codes(r).includes('TEXT_TRUNCATED'));
  });
  it('truncation never leaves a dangling surrogate and the result still validates', () => {
    for (let limit = 1; limit < 12; limit++) {
      const adapter = new ChatGPTExportAdapter({ limits: { maxTextBytesPerMessage: limit } });
      const { m } = one(contents.text('a\u{1F600}b\u{1F680}c'), { adapter });
      assert.ok(Buffer.byteLength(m.text) <= limit, `limit ${limit}`);
      assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(m.text), `limit ${limit}`);
    }
  });
  it('maxNodesPerConversation: the first N nodes in FILE order are kept, the rest dropped with TOO_MANY_NODES; completeness unknown', () => {
    const adapter = new ChatGPTExportAdapter({ limits: { maxNodesPerConversation: 3 } });
    const b = new ConversationBuilder({ id: syntheticUuid(1) });
    let p = b.root();
    for (let i = 0; i < 5; i++) p = b.user(p, `t${i}`, { id: `n${i}` });
    const out = adapter.normalizeElementText(b.text(), adapterContext(), 0);
    assert.equal(out.kind, 'record');
    if (out.kind !== 'record') return;
    const r = validateConversationRecord(out.record);
    assert.deepEqual(r.messages.map((m) => m.id), ['client-created-root', 'n0', 'n1']);
    assert.ok(r.warnings.some((w) => w.code === 'TOO_MANY_NODES'));
    assert.equal(r.completeness, 'unknown');
    assert.equal(r.currentNodeId, null, 'the current node was dropped, so it is not a key of the kept mapping');
    assert.ok(r.warnings.some((w) => w.code === 'INVALID_CURRENT_NODE'));
  });
  it('exactly at the node limit keeps everything', () => {
    const adapter = new ChatGPTExportAdapter({ limits: { maxNodesPerConversation: 3 } });
    const b = new ConversationBuilder({ id: syntheticUuid(1) });
    b.user(b.user(b.root(), 'a'), 'b');
    const out = adapter.normalizeElementText(b.text(), adapterContext(), 0);
    assert.equal(out.kind === 'record' && out.record.messages.length, 3);
    assert.equal(out.kind === 'record' && out.record.warnings.some((w) => w.code === 'TOO_MANY_NODES'), false);
  });
  it('invalid limits are rejected at construction', () => {
    const bad: Array<Partial<ChatGPTAdapterLimits>> = [
      { maxNodesPerConversation: 0 },
      { maxPartsPerMessage: -1 },
      { maxTextBytesPerMessage: 1.5 },
      { maxNodesPerConversation: Number.NaN },
      { maxPartsPerMessage: Number.POSITIVE_INFINITY },
      { maxTextBytesPerMessage: '5' as unknown as number },
      { maxTextBytesPerMessage: 64 * 1024 * 1024 + 1 },
    ];
    for (const limits of bad) {
      assert.throws(() => new ChatGPTExportAdapter({ limits }), (e: unknown) => e instanceof GcrError && e.code === 'INVALID_ARGUMENT', JSON.stringify(limits));
    }
    assert.doesNotThrow(() => new ChatGPTExportAdapter({ limits: { maxNodesPerConversation: undefined } }));
    assert.doesNotThrow(() => new ChatGPTExportAdapter());
  });
  it('1,000,000 tiny parts convert quickly; only the first 50,000 become blocks (PARTS_TRUNCATED)', () => {
    const body = `["${'0123456789'}"${',"0123456789"'.repeat(999_999)}]`;
    const text = `{"id":"c","current_node":"m","mapping":{"m":{"id":"m","parent":null,"message":{"id":"m","author":{"role":"user"},"content":{"content_type":"text","parts":${body}}}}}}`;
    const t0 = performance.now();
    const out = chatGptExportAdapter.normalizeElementText(text, adapterContext(), 0);
    const ms = performance.now() - t0;
    assert.equal(out.kind, 'record');
    if (out.kind !== 'record') return;
    assert.equal(out.record.messages[0]?.blocks.length, 50_000);
    assert.ok(out.record.warnings.some((w) => w.code === 'PARTS_TRUNCATED'));
    assert.ok(ms < 10_000, `took ${ms.toFixed(0)} ms`);
  });
  it('an absurd exponent timestamp literal does not slow anything down', () => {
    const { m } = one(contents.text('x'), { createTime: rawJson('1e999999999') });
    assert.equal(m.createdAt, null);
  });
});

describe('nesting guard: records stay serializable whatever the input nests', () => {
  const nest = (k: number): unknown => rawJson('['.repeat(k) + '1' + ']'.repeat(k));
  /** Depth of a value (iterative); only called on values the guard already bounded. */
  const depthOf = (root: unknown): number => {
    let best = 0;
    const stack: Array<[unknown, number]> = [[root, 0]];
    while (stack.length > 0) {
      const [v, d] = stack.pop() as [unknown, number];
      if (typeof v !== 'object' || v === null) continue;
      best = Math.max(best, d + 1);
      for (const c of Array.isArray(v) ? v : Object.values(v)) stack.push([c, d + 1]);
    }
    return best;
  };
  const serializable = (r: ConversationRecord): void => {
    assert.doesNotThrow(() => JSON.stringify(r));
    assert.doesNotThrow(() => structuredClone(r));
  };

  it('the limit is a documented constant', () => {
    assert.equal(MAX_RAW_NESTING_DEPTH, 256);
  });

  it('deep nesting inside message metadata is cut at the limit; siblings, text and shallow data are untouched; a warning names the message', () => {
    const keep = { a: [1, 2, { b: 3 }], s: 'kept' };
    const { r, m } = one(contents.text('still readable'), { metadata: { keep, deep: nest(5000) } });
    serializable(r);
    const raw = m.rawSource as RawObject;
    const md = raw['metadata'] as RawObject;
    assert.deepEqual(md['keep'], keep);
    assert.ok(depthOf(raw) <= MAX_RAW_NESTING_DEPTH + 1);
    assert.equal(m.text, 'still readable');
    assert.deepEqual(((raw['content'] as RawObject)['parts']), ['still readable']);
    const w = r.warnings.find((x) => x.code === 'NESTING_TOO_DEEP');
    assert.deepEqual(w?.ids, ['m']);
    assert.ok(JSON.stringify(md['deep']).includes('nesting_too_deep'));
  });

  it('the boundary is exact: message-relative depth 256 is kept whole, 257 is cut', () => {
    // message object = depth 1, metadata = 2, then k nested arrays
    const atLimit = one(contents.text('x'), { metadata: { deep: nest(MAX_RAW_NESTING_DEPTH - 2) } });
    assert.ok(!atLimit.r.warnings.some((w) => w.code === 'NESTING_TOO_DEEP'));
    assert.ok(!JSON.stringify(atLimit.m.rawSource).includes('nesting_too_deep'));
    const over = one(contents.text('x'), { metadata: { deep: nest(MAX_RAW_NESTING_DEPTH - 1) } });
    assert.ok(over.r.warnings.some((w) => w.code === 'NESTING_TOO_DEEP'));
    assert.ok(JSON.stringify(over.m.rawSource).includes('nesting_too_deep'));
  });

  it('block metadata that references a deep raw part is cut as well (unknown parts, unknown content types)', () => {
    const deepPart = { synthetic_unknown_part: true, deep: nest(3000) };
    const { r, m } = one(contents.multimodal(['before', deepPart, 'after']));
    serializable(r);
    assert.deepEqual(types(m), ['text', 'unknown', 'text']);
    assert.equal(m.text, 'before\nafter');
    assert.ok(depthOf(m.blocks[1]?.metadata) <= MAX_RAW_NESTING_DEPTH + 1);
    const unk = one({ content_type: 'future_widget_v9', widget: nest(3000) });
    serializable(unk.r);
    assert.ok(unk.r.warnings.some((w) => w.code === 'NESTING_TOO_DEEP'));
    assert.ok(depthOf(unk.m.blocks[0]?.metadata) <= MAX_RAW_NESTING_DEPTH + 1);
  });

  it('deep nesting in a conversation-level key is cut in rawMetadata; messages are untouched', () => {
    const b = new ConversationBuilder({ id: syntheticUuid(1), extra: { voice: nest(4000), keep: 'yes' } });
    b.user(b.root(), 'hello', { id: 'm' });
    const out = chatGptExportAdapter.normalizeElementText(b.text(), adapterContext(), 0);
    assert.equal(out.kind, 'record');
    if (out.kind !== 'record') return;
    serializable(out.record);
    const meta = out.record.rawMetadata as RawObject;
    assert.equal(meta['keep'], 'yes');
    assert.ok(depthOf(meta) <= MAX_RAW_NESTING_DEPTH + 1);
    assert.deepEqual(out.record.warnings.find((w) => w.code === 'NESTING_TOO_DEEP')?.ids, [syntheticUuid(1)]);
    assert.equal(out.record.messages.find((x) => x.id === 'm')?.text, 'hello');
  });

  it('a non-object mapping that is itself deeply nested is cut in the preserved copy', () => {
    const r = validateConversationRecord(
      (() => {
        const out = chatGptExportAdapter.normalizeElementText(`{"id":"c","mapping":${'['.repeat(3000)}${']'.repeat(3000)}}`, adapterContext(), 0);
        assert.equal(out.kind, 'record');
        if (out.kind !== 'record') throw new Error('unreachable');
        return out.record;
      })(),
    );
    serializable(r);
    assert.ok(r.warnings.some((w) => w.code === 'MAPPING_INVALID'));
    assert.ok(r.warnings.some((w) => w.code === 'NESTING_TOO_DEEP'));
  });

  it('thoughts given as a JSON string that hides deep nesting is treated as unparseable, not expanded', () => {
    const nested = '['.repeat(300) + ']'.repeat(300);
    const { m, r } = one({ content_type: 'thoughts', thoughts: nested });
    serializable(r);
    assert.equal(m.text, '');
    assert.ok(r.warnings.some((w) => w.code === 'CONTENT_SHAPE_UNEXPECTED'));
    assert.equal(((m.blocks[0]?.metadata) as RawObject)['rawThoughts'], nested);
  });

  it('ordinary documents are never copied or altered: rawSource equals the parsed message exactly', () => {
    const text = JSON.stringify({ id: 'c', current_node: 'm', mapping: { m: { id: 'm', parent: null, children: [], message: { id: 'm', author: { role: 'user' }, content: { content_type: 'text', parts: ['x'] }, metadata: { citations: [{ start_ix: 1, nested: { a: [{ b: [1, 2, 3] }] } }] } } } } });
    const out = chatGptExportAdapter.normalizeElementText(text, adapterContext(), 0);
    assert.equal(out.kind, 'record');
    if (out.kind !== 'record') return;
    const parsed = JSON.parse(text) as { mapping: { m: { message: unknown } } };
    assert.deepEqual(out.record.messages[0]?.rawSource, parsed.mapping.m.message);
    assert.deepEqual(out.record.warnings, []);
  });
});
