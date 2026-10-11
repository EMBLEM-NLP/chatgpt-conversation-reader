/**
 * Adversarial review (MCP lens: "error-envelope consistency", "schema accuracy").
 *
 * Defect pinned here: an INVALID_ARGUMENT raised by the SDK names the SDK's own option ("conversationId", "query"), which is not
 * the field the MCP tool accepts ("conversation", "titleQuery"). A model that follows the message retries with the SDK name and
 * is told that key is unknown (the inputs are strict): the error steers it away from the schema it was given. Errors must name
 * the field of the tool's own input schema.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ID, connectMem, createFixture } from './mcp.helpers.test.js';
import type { Fixture, MemHarness } from './mcp.helpers.test.js';

describe('errors name the MCP input field, not the SDK option', () => {
  let fx: Fixture;
  let h: MemHarness;
  before(async () => {
    fx = await createFixture({ graph: false });
    h = await connectMem(fx.dbPath);
  });
  after(async () => {
    await h.close();
    await fx.cleanup();
  });

  it('gcr_search: `conversation` combined with scope titles', async () => {
    const env = await h.env('gcr_search', { query: 'alpha', scope: 'titles', conversation: ID.linear });
    assert.equal(env.error?.code, 'INVALID_ARGUMENT');
    assert.equal(env.error?.details?.['field'], 'conversation');
    assert.match(env.error?.message ?? '', /"conversation"/);
    assert.doesNotMatch(env.error?.message ?? '', /conversationId/);
  });

  it('gcr_list: `titleQuery` without searchable terms', async () => {
    const env = await h.env('gcr_list', { titleQuery: '***' });
    assert.equal(env.error?.code, 'INVALID_ARGUMENT');
    assert.equal(env.error?.details?.['field'], 'titleQuery');
    assert.match(env.error?.message ?? '', /"titleQuery"/);
  });

  it('control: an error about a field that has the same name in the SDK keeps it', async () => {
    const env = await h.env('gcr_search', { query: 'alpha', scope: 'titles', role: 'user' });
    assert.equal(env.error?.details?.['field'], 'role');
    const stats = await h.env('gcr_stats', { groupBy: 'role', createdAfter: 'x' });
    assert.equal(stats.error?.details?.['field'], 'createdAfter');
  });
});
