/**
 * The committed Claude fixtures: synthetic-only discipline (the privacy scanner requires the marker), and that every
 * fixture is consumable by the adapter exactly as the importer would feed it (one array element at a time).
 */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  CLAUDE_FIXTURE_FILES,
  SYNTHETIC_MARKER,
  fixtureElementTexts,
  readFixtureText,
  recordOf,
} from '../helpers/claude-export-builder.js';

const FIXTURE_DIR = new URL('../../../fixtures/claude/', import.meta.url);

describe('fixtures/claude', () => {
  it('the helper list equals the files on disk (no fixture is forgotten, none is missing)', () => {
    const onDisk = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json')).sort();
    assert.deepEqual([...CLAUDE_FIXTURE_FILES].sort(), onDisk);
  });

  for (const file of CLAUDE_FIXTURE_FILES) {
    describe(file, () => {
      const text = readFixtureText(file);

      it(`contains the literal marker ${SYNTHETIC_MARKER}`, () => {
        assert.ok(text.includes(SYNTHETIC_MARKER));
      });

      it('is a JSON array like a real conversations.json, with at least one element', () => {
        const parsed: unknown = JSON.parse(text);
        assert.ok(Array.isArray(parsed) && parsed.length > 0);
      });

      it('uses only clearly synthetic UUIDs (00000000-0000-4000-8000-...) and no e-mail-like or URL-like data', () => {
        const uuids = text.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g) ?? [];
        for (const u of uuids) assert.ok(u.startsWith('00000000-0000-4000-8000-'), u);
        assert.ok(!text.includes('@'), 'no e-mail-like text');
        assert.ok(!/https?:\/\//i.test(text), 'no URLs');
      });

      it('every element normalizes to a record that passes validateConversationRecord', () => {
        for (const element of fixtureElementTexts(file)) recordOf(element);
      });
    });
  }
});
