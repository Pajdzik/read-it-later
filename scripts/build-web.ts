import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const output = 'dist/web';
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const bundle = async (entry: string, format: 'esm' | 'iife' = 'esm', minify = true): Promise<string> => {
  const result = await build({ entryPoints: [entry], bundle: true, format, target: 'es2022', minify, write: false });
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
