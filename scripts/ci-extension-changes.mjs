import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const inputs = new Set([
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'src/integrations/contracts.ts',
  'scripts/build-extension.ts', 'scripts/ci-extension-changes.mjs',
  'scripts/ci-extension-changes.test.mjs', '.github/workflows/checks.yml',
]);

export function affectsExtension(file) {
  return file.startsWith('extension/') || inputs.has(file) || /^scripts\/extension-[^/]+\.mjs$/.test(file);
}

export function shouldRunExtension(eventName, event, git = (...args) => execFileSync('git', args, { encoding: 'utf8' })) {
  if (eventName === 'workflow_dispatch') return true;
  try {
    let base, head;
    if (eventName === 'pull_request') {
      base = event.pull_request?.base?.sha;
      head = event.pull_request?.head?.sha;
    } else if (eventName === 'push') {
      base = event.before;
      head = event.after;
      if (typeof head !== 'string' || !/^[a-f0-9]{40,64}$/.test(head) || /^0+$/.test(head)) return true;
      if (/^0+$/.test(base || '')) {
        // A newly pushed branch has no previous tip. Compare its changes with
        // the repository's default branch instead of testing every tracked file.
        base = git('rev-parse', `refs/remotes/origin/${event.repository.default_branch}`).trim();
        base = git('merge-base', base, head).trim();
      }
    } else return true;
    if (![base, head].every((sha) => typeof sha === 'string' && /^[a-f0-9]{40,64}$/.test(sha) && !/^0+$/.test(sha))) return true;
    if (eventName === 'pull_request') base = git('merge-base', base, head).trim();
    const files = git('diff', '--no-renames', '--name-only', '-z', `${base}..${head}`, '--').split('\0').filter(Boolean);
    return files.some(affectsExtension);
  } catch {
    // Missing history or an unavailable old force-push tip must not hide a
    // relevant change. Run the suite when the comparison cannot be established.
    return true;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const run = shouldRunExtension(process.env.GITHUB_EVENT_NAME, event);
  appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
  console.log(`Extension suite: ${run ? 'run' : 'skip'} (${process.env.GITHUB_EVENT_NAME}).`);
}
