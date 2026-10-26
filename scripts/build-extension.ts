import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const productionOrigin = 'https://read.pajdzik.pl';
const args = process.argv.slice(2);
const production = args.includes('--production');
const originArg = args.find((value) => value.startsWith('--origin='))?.slice('--origin='.length);
const origin = production ? productionOrigin : originArg || 'http://127.0.0.1:8787';
const parsedOrigin = new URL(origin);
if (parsedOrigin.pathname !== '/' || parsedOrigin.search || parsedOrigin.hash || parsedOrigin.username || parsedOrigin.password ||
    (!production && !(parsedOrigin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsedOrigin.hostname))) ||
    (production && origin !== productionOrigin)) {
  throw new Error('Development extension builds must use an HTTP loopback origin. Use --production only for the fixed production origin.');
}
const output = path.resolve('dist/extension');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const bundles = [
  ['background.ts', 'background.js'], ['bridge.ts', 'bridge.js'], ['extractor.ts', 'extractor.js'], ['options.ts', 'options.js'],
] as const;
for (const browserName of ['chrome', 'firefox'] as const) {
  const directory = path.join(output, browserName);
  await mkdir(directory, { recursive: true });
  for (const [entry, outfile] of bundles) {
    await build({ entryPoints: [`extension/${entry}`], outfile: path.join(directory, outfile), bundle: true,
      format: 'iife', platform: 'browser', target: browserName === 'chrome' ? 'chrome121' : 'firefox140',
      minify: true, define: { __POTEM_ORIGIN__: JSON.stringify(origin) } });
  }
  await cp('extension/options.html', path.join(directory, 'options.html'));
  await cp('extension/options.css', path.join(directory, 'options.css'));
  const icons = path.join(directory, 'icons'); await mkdir(icons);
  const icon = await readFile('web/icons/icon-512.v3.png');
  for (const size of [16, 32, 48, 128]) {
    await sharp(icon).resize(size, size).png().toFile(path.join(icons, `icon-${size}.png`));
  }
  const matchPattern = `${parsedOrigin.protocol}//${parsedOrigin.hostname}/*`;
  const manifest = {
    manifest_version: 3,
    name: 'Potem — Read it later',
    version: '0.1.0',
    description: 'Save the current page and a local Markdown copy to Potem.',
    permissions: ['activeTab', 'scripting', 'storage'],
    host_permissions: [matchPattern],
    action: { default_title: 'Save page to Potem', default_icon: { '16': 'icons/icon-16.png', '32': 'icons/icon-32.png' } },
    options_ui: { page: 'options.html', open_in_tab: true },
    content_scripts: [{ matches: [matchPattern], js: ['bridge.js'], run_at: 'document_start', all_frames: false }],
    incognito: 'not_allowed',
    icons: { '16': 'icons/icon-16.png', '32': 'icons/icon-32.png', '48': 'icons/icon-48.png', '128': 'icons/icon-128.png' },
    ...(browserName === 'chrome'
      ? { background: { service_worker: 'background.js' }, minimum_chrome_version: '121' }
      : { background: { scripts: ['background.js'] }, browser_specific_settings: {
          gecko: { id: 'potem@pajdzik', strict_min_version: '140.0', data_collection_permissions: { required: ['browsingActivity', 'websiteContent'] } },
        } }),
  };
  await writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const archive = path.join(output, `potem-${browserName}.zip`);
  execFileSync('/usr/bin/zip', ['-qr', archive, '.'], { cwd: directory });
}
await writeFile(path.join(output, 'BUILD-INFO.txt'), `${production ? 'production' : 'development'}\n${origin}\n`);
console.log(`Built Chrome and Firefox packages for ${origin}${production ? ' (production)' : ' (loopback development)'}.`);
