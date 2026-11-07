import { hasRelevantChanges } from './ci-changes.mjs';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const inputs = new Set([
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'src/integrations/contracts.ts',
  'scripts/build-extension.ts', 'scripts/ci-extension-changes.mjs',
  'scripts/ci-extension-changes.test.mjs', 'scripts/ci-changes.mjs', '.github/workflows/checks.yml',
]);

export function affectsExtension(file) {
  return file.startsWith('extension/') || inputs.has(file) || /^scripts\/extension-[^/]+\.mjs$/.test(file);
}

export function shouldRunExtension(eventName, event, git) {
  return hasRelevantChanges(eventName, event, affectsExtension, git);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const run = shouldRunExtension(process.env.GITHUB_EVENT_NAME, event);
  appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
  console.log(`Extension suite: ${run ? 'run' : 'skip'} (${process.env.GITHUB_EVENT_NAME}).`);
}
