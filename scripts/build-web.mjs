import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const output = 'dist/web';
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const result = await build({ entryPoints: ['web/app.ts'], bundle: true, format: 'esm', target: 'es2022', minify: true, write: false });
const javascript = result.outputFiles[0].text;
const defuddle = await build({ entryPoints: ['scripts/defuddle-entry.js'], bundle: true, format: 'iife', target: 'es2022', minify: true, write: false });
const css = await readFile('web/app.v1.css', 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 12);
const jsName = `app.${hash(javascript)}.js`;
const cssName = `app.${hash(css)}.css`;
const cacheVersion = hash(javascript + css);
for (const entry of await readdir('web', { withFileTypes: true })) {
  if (entry.name.endsWith('.ts') || entry.name.endsWith('.json') || ['app.v1.js', 'app.v1.css'].includes(entry.name)) continue;
  if (entry.isDirectory()) { await cp(path.join('web', entry.name), path.join(output, entry.name), { recursive: true }); continue; }
  let content = await readFile(path.join('web', entry.name), 'utf8');
  content = content.replaceAll('app.v1.js', jsName).replaceAll('app.v1.css', cssName).replaceAll('later-public-v1', `later-public-${cacheVersion}`);
  await writeFile(path.join(output, entry.name), content);
}
await writeFile(path.join(output, jsName), javascript);
await writeFile(path.join(output, cssName), css);
await writeFile(path.join(output, 'defuddle.js'), defuddle.outputFiles[0].text);
console.log(`Built website with ${jsName} and ${cssName}.`);
