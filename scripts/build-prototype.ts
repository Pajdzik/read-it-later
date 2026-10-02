import { build } from 'esbuild';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const output = 'dist/prototype';
await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, 'public'), { recursive: true });
for (const entry of await readdir('public', { withFileTypes: true })) {
  if (entry.name.endsWith('.ts') || entry.name === 'tsconfig.json') continue;
  await cp(path.join('public', entry.name), path.join(output, 'public', entry.name), { recursive: true });
}
await build({
  entryPoints: ['server.ts'],
  outfile: path.join(output, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
});
await build({
  entryPoints: ['public/app.ts'],
  outfile: path.join(output, 'public', 'app.js'),
  bundle: true,
  format: 'iife',
  target: 'es2022',
});
console.log(`Built prototype in ${output}.`);
