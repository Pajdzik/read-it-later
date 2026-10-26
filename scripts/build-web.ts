import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const commitSha = process.env.BUILD_COMMIT_SHA;
const builtAt = process.env.BUILD_TIMESTAMP;
if ((commitSha === undefined) !== (builtAt === undefined)) {
  throw new Error('BUILD_COMMIT_SHA and BUILD_TIMESTAMP must be supplied together.');
}
if (commitSha !== undefined && !/^(?:[\da-f]{40}|[\da-f]{64})$/i.test(commitSha)) {
  throw new Error('BUILD_COMMIT_SHA must be a full 40- or 64-character hexadecimal commit SHA.');
}
if (builtAt !== undefined) {
  const isoUtcTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
  const parsedTimestamp = Date.parse(builtAt);
  const parsedIsoSeconds = Number.isNaN(parsedTimestamp) ? '' : new Date(parsedTimestamp).toISOString().slice(0, 19);
  if (!isoUtcTimestamp.test(builtAt) || Number.isNaN(parsedTimestamp) || parsedIsoSeconds !== builtAt.slice(0, 19)) {
    throw new Error('BUILD_TIMESTAMP must be a valid ISO 8601 UTC timestamp ending in Z.');
  }
}
const buildInfo = commitSha === undefined ? null : { commitSha, builtAt: builtAt! };

const output = 'dist/web';
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const bundle = async (entry: string, format: 'esm' | 'iife' = 'esm', minify = true): Promise<string> => {
  const result = await build({
    entryPoints: [entry], bundle: true, format, target: 'es2022', minify, write: false,
    define: entry === 'web/app.ts' ? { __BUILD_INFO__: JSON.stringify(buildInfo) } : undefined,
  });
  if (!result.outputFiles?.[0]) throw new Error(`No build output for ${entry}.`);
  return result.outputFiles[0].text;
};
const javascript = await bundle('web/app.ts');
const defuddle = await bundle('scripts/defuddle-entry.ts', 'iife');
// Keep the bookmarklet function self-contained when it is serialized with toString().
const capture = await bundle('web/capture.ts', 'esm', false);
const serviceWorker = await bundle('web/sw.ts');
const css = await readFile('web/app.v1.css', 'utf8');
const hash = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 12);
const jsName = `app.${hash(javascript)}.js`;
const cssName = `app.${hash(css)}.css`;
const cacheVersion = hash(javascript + css + capture + defuddle + serviceWorker);
const replaceAssetNames = (content: string): string => content
  .replaceAll('app.v1.js', jsName)
  .replaceAll('app.v1.css', cssName)
  .replaceAll('later-public-v1', `later-public-${cacheVersion}`);
for (const entry of await readdir('web', { withFileTypes: true })) {
  if (entry.name.endsWith('.ts') || entry.name.endsWith('.json') || ['app.v1.js', 'app.v1.css', 'capture.js', 'sw.js'].includes(entry.name)) continue;
  if (entry.isDirectory()) {
    await cp(path.join('web', entry.name), path.join(output, entry.name), { recursive: true });
    continue;
  }
  await writeFile(path.join(output, entry.name), replaceAssetNames(await readFile(path.join('web', entry.name), 'utf8')));
}
await writeFile(path.join(output, jsName), javascript);
await writeFile(path.join(output, cssName), css);
await writeFile(path.join(output, 'capture.js'), capture);
await writeFile(path.join(output, 'sw.js'), replaceAssetNames(serviceWorker));
await writeFile(path.join(output, 'defuddle.js'), defuddle);
console.log(`Built website with ${jsName} and ${cssName}.`);
