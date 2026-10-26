import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const extensionPath = path.resolve('dist/extension/chrome');
const manifest = JSON.parse(await readFile(path.join(extensionPath, 'manifest.json'), 'utf8'));
assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'storage']);
assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*']);
assert.equal(manifest.background.service_worker, 'background.js');
assert.equal(manifest.incognito, 'not_allowed');

const context = await chromium.launchPersistentContext(`/tmp/potem-extension-chromium-${process.pid}`, {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});
try {
  await context.waitForEvent('serviceworker', { timeout: 10000 }).catch(() => {});
  const worker = context.serviceWorkers().find((item) => item.url().endsWith('/background.js'));
  assert.ok(worker, 'unpacked MV3 service worker starts in Chromium');
  const extensionId = new URL(worker.url()).host;
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.waitForFunction(() => document.querySelector('#origin')?.textContent === 'http://127.0.0.1:8787');
  assert.equal(await options.locator('#mode').inputValue(), 'review');
  assert.match(await options.locator('#destination').textContent(), /not configured/);
  await options.locator('#mode').selectOption('simple');
  await options.waitForFunction(() => document.querySelector('#status')?.textContent.includes('confirm the current destination'));
  assert.equal(await options.locator('#mode').inputValue(), 'review');
  assert.match(await options.locator('#status').textContent(), /confirm the current destination/);
  console.log(`Chromium ${context.browser().version()}: unpacked MV3 worker and Options page loaded; permissions and unconfigured Simple-mode guard passed.`);
} finally {
  await context.close();
}
