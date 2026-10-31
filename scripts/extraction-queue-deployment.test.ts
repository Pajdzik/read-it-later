import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureExtractionQueue, extractionQueueName, type QueueCommandRunner } from './extraction-queue-deployment';

function runner(results: { status: number; output: string }[]) {
  const calls: string[][] = [];
  const run: QueueCommandRunner = args => {
    calls.push(args);
    const result = results.shift();
    assert.ok(result, 'unexpected remote command');
    return result;
  };
  return { run, calls };
}
const missing = { status: 1, output: 'Queue "read-it-later-extraction-staging" does not exist. To create it, run: wrangler queues create' };

test('dry runs validate environment and never invoke remote commands', () => {
  const stub = runner([]);
  assert.match(ensureExtractionQueue('production', 'wrangler.jsonc', false, stub.run), /inspect queue, create only if missing/);
  assert.equal(stub.calls.length, 0);
  assert.throws(() => extractionQueueName('preview'), /staging or production/);
});
test('existing queues are reused with the selected environment and config', () => {
  const stub = runner([{ status: 0, output: 'Queue information' }]);
  assert.match(ensureExtractionQueue('production', 'custom.jsonc', true, stub.run), /already exists/);
  assert.deepEqual(stub.calls, [['queues', 'info', 'read-it-later-extraction-production', '--config', 'custom.jsonc', '--env', 'production']]);
});
test('creates only a missing queue and tolerates a concurrent creator', () => {
  const stub = runner([missing, { status: 0, output: '' }]);
  ensureExtractionQueue('staging', 'wrangler.jsonc', true, stub.run);
  assert.equal(stub.calls[1][1], 'create');
  const raced = runner([missing, { status: 1, output: 'Already exists' }, { status: 0, output: 'Exists' }]);
  assert.match(ensureExtractionQueue('staging', 'wrangler.jsonc', true, raced.run), /ready/);
});
test('authentication, network, and creation failures stop provisioning', () => {
  for (const output of ['Authentication error', 'Request failed', 'Queue "another-queue" does not exist.']) {
    const stub = runner([{ status: 1, output }]);
    assert.throws(() => ensureExtractionQueue('staging', 'wrangler.jsonc', true, stub.run), /Cannot inspect/);
    assert.equal(stub.calls.length, 1);
  }
  const failed = runner([missing, { status: 1, output: 'Denied' }, missing]);
  assert.throws(() => ensureExtractionQueue('staging', 'wrangler.jsonc', true, failed.run), /Could not provision/);
});
