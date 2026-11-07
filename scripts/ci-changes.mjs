import { execFileSync } from 'node:child_process';

// Compare the entire PR, but only the new commits of a push. Unknown events or
// incomplete history always run checks rather than hide a relevant change.
export function hasRelevantChanges(eventName, event, affects, git = (...args) => execFileSync('git', args, { encoding: 'utf8' })) {
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
        base = git('rev-parse', `refs/remotes/origin/${event.repository.default_branch}`).trim();
        base = git('merge-base', base, head).trim();
      }
    } else return true;
    if (![base, head].every((sha) => typeof sha === 'string' && /^[a-f0-9]{40,64}$/.test(sha) && !/^0+$/.test(sha))) return true;
    if (eventName === 'pull_request') base = git('merge-base', base, head).trim();
    const files = git('diff', '--no-renames', '--name-only', '-z', `${base}..${head}`, '--').split('\0').filter(Boolean);
    return files.some(affects);
  } catch {
    return true;
  }
}
