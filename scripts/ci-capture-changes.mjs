import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { hasRelevantChanges } from './ci-changes.mjs';

const inputs = new Set([
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc',
  'Dockerfile.capture', 'Dockerfile.capture.dockerignore', '.dockerignore',
  'wrangler.jsonc', 'scripts/build-capture.ts',
]);

export function affectsCapture(file) {
  // Include all backend sources: the private Worker and the image both import
  // shared modules, and future imports must not silently bypass verification.
  return file.startsWith('capture/') || file.startsWith('src/') ||
    file.startsWith('migrations/') || file.startsWith('.github/') ||
    file.startsWith('scripts/ci-') || /^tsconfig[^/]*\.json$/.test(file) || inputs.has(file);
}

export function shouldRunCapture(eventName, event, git) {
  return hasRelevantChanges(eventName, event, affectsCapture, git);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const run = shouldRunCapture(process.env.GITHUB_EVENT_NAME, event);
  appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
  console.log(`Capture build: ${run ? 'run' : 'skip'} (${process.env.GITHUB_EVENT_NAME}).`);
}
