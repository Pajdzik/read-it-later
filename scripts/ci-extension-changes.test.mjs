import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { affectsExtension, shouldRunExtension } from './ci-extension-changes.mjs';

test('extension code, build/tests, dependencies, and CI wiring trigger the suite', () => {
  for (const file of ['extension/background.ts', 'extension/options.css', 'scripts/build-extension.ts',
    'scripts/extension-e2e.mjs', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'src/integrations/contracts.ts',
    '.github/workflows/checks.yml', 'scripts/ci-extension-changes.mjs']) assert(affectsExtension(file), file);
  for (const file of ['README.md', 'docs/browser-extension.md', 'src/worker.ts', 'web/app.ts', 'scripts/browser-smoke.mjs']) assert(!affectsExtension(file), file);
});

test('real Git history covers pushes, cumulative PR changes, new branches, deletions, and renames', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'extension-ci-filter-'));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' });
  const commit = (file, text) => {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(path.join(directory, file), text);
    git('add', '--', file); git('commit', '-qm', 'Fixture change');
    return git('rev-parse', 'HEAD').trim();
  };
  const push = (base, head) => shouldRunExtension('push', { before: base, after: head }, git);
  try {
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'commit.gpgsign', 'false'); git('config', 'core.hooksPath', '/dev/null');
    const base = commit('README.md', 'Initial');
    const docs = commit('README.md', 'Documentation only');
    assert.equal(push(base, docs), false);
    const extension = commit('extension/options.ts', 'Changed extension');
    assert.equal(push(docs, extension), true);
    const final = commit('README.md', 'More documentation');
    assert.equal(push(extension, final), false, 'push uses only the new commits');
    assert.equal(shouldRunExtension('pull_request', { pull_request: { base: { sha: docs }, head: { sha: final } } }, git), true, 'PR checks include its complete extension diff');
    git('update-ref', 'refs/remotes/origin/main', docs);
    assert.equal(shouldRunExtension('push', { before: '0'.repeat(40), after: final, repository: { default_branch: 'main' } }, git), true);
    assert.equal(shouldRunExtension('push', { before: '0'.repeat(40), after: docs, repository: { default_branch: 'main' } }, git), false);
    git('mv', 'extension/options.ts', 'moved-options.ts'); git('commit', '-qm', 'Move extension source');
    const moved = git('rev-parse', 'HEAD').trim();
    assert.equal(push(final, moved), true, 'renaming code out of extension still triggers');
    const restored = commit('extension/background.ts', 'New controller');
    git('rm', '-q', 'extension/background.ts'); git('commit', '-qm', 'Delete controller');
    assert.equal(push(restored, git('rev-parse', 'HEAD').trim()), true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('manual runs always include the suite and missing history runs it conservatively', () => {
  assert.equal(shouldRunExtension('workflow_dispatch', {}), true);
  assert.equal(shouldRunExtension('push', {}), true);
  assert.equal(shouldRunExtension('push', { before: 'a'.repeat(40), after: 'b'.repeat(40) }, () => { throw new Error('History unavailable'); }), true);
});
