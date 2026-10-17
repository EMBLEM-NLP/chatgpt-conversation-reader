import test from 'node:test'; // Exercise the command boundary without a browser.
import assert from 'node:assert/strict'; // Verify invalid invocations fail before host loading.
import { parseArgs } from './host-capture.ts'; // Test the runnable entry point's argument contract.

test('host capture requires an explicit host, conversation and output', () => { // Prevent implicit browser or destination selection.
  assert.throws(() => parseArgs([]), /Required: --host/);
  assert.throws(() => parseArgs(['--host', 'host.mjs', '--conversation', 'mountain']), /Required: --out/);
});

test('host capture rejects duplicate and unknown flags', () => { // Keep one unambiguous local host and target.
  assert.throws(() => parseArgs(['--host', 'a.mjs', '--host', 'b.mjs', '--conversation', 'mountain', '--out', 'run']), /Expected one value for --host/);
  assert.throws(() => parseArgs(['--host', 'a.mjs', '--conversation', 'mountain', '--out', 'run', '--engine', 'webkit']), /Unknown argument/);
});

test('host capture resolves paths and keeps conversation selection explicit', () => { // Confirm config defaults remain package-local.
  const parsed = parseArgs(['--host', './host.mjs', '--conversation', 'street', '--out', './runs/street']);
  assert.equal(parsed.conversationId, 'street');
  assert.ok(parsed.host.endsWith('/host.mjs'));
  assert.ok(parsed.output.endsWith('/runs/street'));
  assert.ok(parsed.configPath.endsWith('/scroll-config.json'));
});
