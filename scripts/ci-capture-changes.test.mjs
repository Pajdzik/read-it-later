import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { affectsCapture, shouldRunCapture } from './ci-capture-changes.mjs';

test('capture builds cover shared backend inputs and skip website-only changes', () => {
  for (const file of [
    'capture/worker.ts', 'capture/executor.ts', 'capture/tests/executor.test.ts',
    'src/articles/pdf.ts', 'src/http.ts', 'src/contracts.ts', 'src/auth/core.ts',
    'migrations/0001.sql', 'Dockerfile.capture', 'Dockerfile.capture.dockerignore', '.dockerignore',
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', 'tsconfig.node.json',
    'wrangler.jsonc', 'capture/wrangler.jsonc', 'scripts/build-capture.ts',
    '.github/workflows/checks.yml', '.github/actions/capture-build/docker.mjs',
    'scripts/ci-changes.mjs', 'scripts/ci-capture-changes.test.mjs',
  ]) assert(affectsCapture(file), file);
  for (const file of ['web/app.ts', 'web/app.v1.css', 'web/icons/icon.png', 'extension/options.ts',
    'README.md', 'docs/ci.md', 'scripts/browser-smoke.mjs', 'scripts/build-web.ts']) assert(!affectsCapture(file), file);
});

test('capture filtering handles cumulative PR changes, advancing bases, pushes, renames and deletions', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'capture-ci-filter-'));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' });
  const commit = (file, text) => {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(path.join(directory, file), text);
    git('add', '--', file); git('commit', '-qm', 'Fixture change');
    return git('rev-parse', 'HEAD').trim();
  };
  const push = (base, head) => shouldRunCapture('push', { before: base, after: head }, git);
  const pr = (base, head) => shouldRunCapture('pull_request', { pull_request: { base: { sha: base }, head: { sha: head } } }, git);
  try {
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'commit.gpgsign', 'false'); git('config', 'core.hooksPath', '/dev/null');
    const base = commit('README.md', 'Initial');
    const web = commit('web/app.ts', 'UI only');
    assert.equal(push(base, web), false);
    const capture = commit('capture/executor.ts', 'Executor');
    const docs = commit('README.md', 'Follow-up');
    assert.equal(push(capture, docs), false);
    assert.equal(pr(web, docs), true, 'PR includes its earlier capture change');
    git('checkout', '-q', '--detach', base);
    const advancedBase = commit('src/http.ts', 'Unrelated base-branch change');
    assert.equal(pr(advancedBase, web), false, 'base-branch changes do not become PR changes');
    git('checkout', '-q', '--detach', docs);
    git('mv', 'capture/executor.ts', 'executor-retired.ts'); git('commit', '-qm', 'Move capture source');
    const moved = git('rev-parse', 'HEAD').trim();
    assert.equal(push(docs, moved), true, 'moving out of the capture directory still triggers');
    const shared = commit('src/http.ts', 'Shared module');
    git('rm', '-q', 'src/http.ts'); git('commit', '-qm', 'Delete shared module');
    assert.equal(push(shared, git('rev-parse', 'HEAD').trim()), true);
    git('update-ref', 'refs/remotes/origin/main', base);
    assert.equal(shouldRunCapture('push', { before: '0'.repeat(40), after: web, repository: { default_branch: 'main' } }, git), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('manual runs, malformed events and unavailable history always build capture', () => {
  assert.equal(shouldRunCapture('workflow_dispatch', {}), true);
  assert.equal(shouldRunCapture('unknown', {}), true);
  assert.equal(shouldRunCapture('pull_request', {}), true);
  assert.equal(shouldRunCapture('push', { before: 'a'.repeat(40), after: 'b'.repeat(40) }, () => { throw new Error('History unavailable'); }), true);
});
