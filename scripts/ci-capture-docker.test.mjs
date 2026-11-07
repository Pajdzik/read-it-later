import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const action = fileURLToPath(new URL('../.github/actions/capture-build/index.mjs', import.meta.url));
const wrapper = fileURLToPath(new URL('../.github/actions/capture-build/docker.mjs', import.meta.url));

function fixture(run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'capture-docker-'));
  const executable = `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify({
  command: path.basename(process.argv[1]), args: process.argv.slice(2),
  stdin: readFileSync(0, 'utf8'), wrapper: process.env.WRANGLER_DOCKER_BIN,
  runtime: process.env.ACTIONS_RUNTIME_TOKEN === 'fixture-runtime-token',
}) + '\\n');
process.exit(Number(process.env.FIXTURE_EXIT || 0));
`;
  for (const command of ['docker', 'pnpm']) writeFileSync(path.join(directory, command), executable, { mode: 0o755 });
  const callsFile = path.join(directory, 'calls.jsonl');
  const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, FIXTURE_CALLS: callsFile,
    CAPTURE_BUILDX_BUILDER: 'fixture-builder', ACTIONS_RUNTIME_TOKEN: 'fixture-runtime-token',
    ACTIONS_RESULTS_URL: 'https://cache.example.invalid/', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' };
  const calls = () => readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse);
  try { run(env, calls); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('Docker routing preserves stdin, image/platform arguments and command failures', () => fixture((env, calls) => {
  const args = ['--load', '-t', 'capture:fixture', '--platform', 'linux/amd64', '--provenance=false', '-f', '-', '/workspace with spaces'];
  const dockerfile = 'FROM node:22-bookworm-slim\nRUN echo fixture\n';
  const result = spawnSync(process.execPath, [wrapper, 'build', ...args], { env, input: dockerfile, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const call = calls()[0];
  assert.deepEqual(call.args.slice(0, 4), ['buildx', 'build', '--builder', 'fixture-builder']);
  assert.deepEqual(call.args.slice(-args.length), args);
  assert.equal(call.stdin, dockerfile, 'Wrangler streams its Dockerfile to Docker');
  assert(call.args.includes('--pull'), 'refresh mutable base images');
  assert(call.args.includes('type=gha,version=2,scope=capture-amd64'));
  assert(call.args.some(arg => arg.startsWith('type=gha,version=2,scope=capture-amd64,mode=max,')));
  assert.equal(call.runtime, true, 'Buildx receives the runtime token through its environment');
  for (const command of [['info'], ['image', 'inspect', 'capture:fixture'], ['push', 'capture:fixture']]) {
    const passthrough = spawnSync(process.execPath, [wrapper, ...command], { env, encoding: 'utf8' });
    assert.equal(passthrough.status, 0, passthrough.stderr);
    assert.deepEqual(calls().at(-1).args, command);
  }
  const failed = spawnSync(process.execPath, [wrapper, 'build', ...args], { env: { ...env, FIXTURE_EXIT: '17' }, encoding: 'utf8' });
  assert.equal(failed.status, 17, 'a failed image build must fail CI');
}));

test('action selects the existing staging dry run and production deploy without logging cache credentials', () => fixture((env, calls) => {
  for (const [environment, dryRun] of [['staging', 'true'], ['production', 'false']]) {
    const result = spawnSync(process.execPath, [action], { env: { ...env, INPUT_ENVIRONMENT: environment, 'INPUT_DRY-RUN': dryRun }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const [builder, wrangler] = calls().slice(-2);
    assert.deepEqual(builder.args, ['buildx', 'create', '--name', 'capture-123-2', '--driver', 'docker-container']);
    assert.equal(wrangler.command, 'pnpm');
    assert.deepEqual(wrangler.args, ['exec', 'wrangler', 'deploy', '--config', 'capture/wrangler.jsonc', '--env', environment,
      ...(dryRun === 'true' ? ['--dry-run', '--outdir', 'dist/capture-worker'] : [])]);
    assert.equal(wrangler.wrapper, wrapper);
    assert.equal(wrangler.runtime, true);
    assert(!result.stdout.includes(env.ACTIONS_RUNTIME_TOKEN));
    assert(!result.stderr.includes(env.ACTIONS_RUNTIME_TOKEN));
  }
  const failed = spawnSync(process.execPath, [action], { env: { ...env, INPUT_ENVIRONMENT: 'production', 'INPUT_DRY-RUN': 'false', FIXTURE_EXIT: '23' }, encoding: 'utf8' });
  assert.equal(failed.status, 23, 'do not deploy when builder setup fails');
  assert.equal(calls().at(-1).command, 'docker');
  const missingRuntime = spawnSync(process.execPath, [action], { env: { ...env, INPUT_ENVIRONMENT: 'staging', 'INPUT_DRY-RUN': 'true', ACTIONS_RUNTIME_TOKEN: '' }, encoding: 'utf8' });
  assert.notEqual(missingRuntime.status, 0);
  assert.match(missingRuntime.stderr, /requires the GitHub Actions cache runtime/);
}));
