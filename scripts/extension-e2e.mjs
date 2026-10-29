// Exercises the installed extension controller, bridge, real website, and local
// Worker/D1. Native toolbar activation is a separate release check: the fixture
// uses the permitted Potem host and a controller export in a test-only bundle.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { openExtensionOptions } from './extension-test-utils.mjs';

const scratch = await mkdtemp(path.join(os.tmpdir(), 'potem-extension-e2e-'));
const portServer = net.createServer();
await new Promise((resolve) => portServer.listen(0, '127.0.0.1', resolve));
const port = portServer.address().port;
await new Promise((resolve, reject) => portServer.close((error) => error ? reject(error) : resolve()));
const origin = `http://127.0.0.1:${port}`;
const environment = { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', WRANGLER_SEND_METRICS: 'false' };
const configFile = path.join(scratch, 'wrangler.json');
const storage = path.join(scratch, 'd1');
const extensionPath = path.join(scratch, 'extension');
const wrangler = path.resolve('node_modules/wrangler/bin/wrangler.js');
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { env: environment, stdio: 'pipe' });
  let output = '';
  child.stdout.on('data', (chunk) => output += chunk);
  child.stderr.on('data', (chunk) => output += chunk);
  child.once('error', reject);
  child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(output)));
});
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const destination = { id: 'kindle', name: 'Kindle', configured: true, destination: 'My reading device', description: 'Send the article to my Kindle delivery service.', destinationKey: 'kindle-device-one' };
let currentDestination = destination;
let failGitHub = false;
const githubCalls = [];
const copyWrites = [];
const pageErrors = [];
let context, server;
try {
  await run(['--import', 'tsx', 'scripts/build-web.ts']);
  await run(['--import', 'tsx', 'scripts/build-extension.ts']);
  await cp(path.resolve('dist/extension/chrome'), extensionPath, { recursive: true });
  await build({
    stdin: {
      contents: 'import { captureActive } from "./extension/background.ts"; globalThis.__captureForIntegration = captureActive;',
      resolveDir: process.cwd(), loader: 'ts',
    },
    outfile: path.join(extensionPath, 'background.js'), bundle: true,
    format: 'iife', platform: 'browser', target: 'chrome121',
    define: { __POTEM_ORIGIN__: JSON.stringify(origin) },
  });
  const manifest = JSON.parse(await readFile(path.join(extensionPath, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*']);
  await writeFile(configFile, JSON.stringify({
    name: 'potem-extension-e2e', main: path.resolve('src/worker.ts'), compatibility_date: '2026-08-01',
    vars: { APP_ORIGIN: origin, DEV_AUTH_BYPASS: 'true', BACKGROUND_CAPTURE_ENABLED: 'false' },
    assets: { directory: path.resolve('dist/web'), binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: ['/api', '/api/*', '/auth', '/auth/*', '/healthz'] },
    d1_databases: [{ binding: 'DB', database_name: 'extension-e2e', database_id: 'extension-e2e', migrations_dir: path.resolve('migrations') }],
  }));
  await run([wrangler, 'd1', 'migrations', 'apply', 'extension-e2e', '--local', '--config', configFile, '--persist-to', storage]);
  server = spawn(process.execPath, [wrangler, 'dev', '--config', configFile, '--port', String(port), '--persist-to', storage], { env: environment, stdio: 'pipe' });
  let serverOutput = '';
  server.stdout.on('data', (chunk) => serverOutput += chunk);
  server.stderr.on('data', (chunk) => serverOutput += chunk);
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = (await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(500) })).ok; } catch {}
    if (ready) break;
    if (server.exitCode !== null) throw new Error(serverOutput);
    await delay(100);
  }
  assert(ready, 'temporary Worker starts');
  context = await chromium.launchPersistentContext(path.join(scratch, 'profile'), {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  context.on('page', (page) => {
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('request', (request) => {
      if (request.method() === 'PUT' && /\/api\/articles\/[^/]+\/copy$/.test(request.url())) copyWrites.push(request.postDataJSON());
    });
  });
  await context.route(`${origin}/fixture/*`, async (route) => {
    const slug = new URL(route.request().url()).pathname.split('/').at(-1);
    const largeBody = slug === 'oversized' ? `<pre><code>${Array.from({ length: 12000 }, (_, index) => `${index}: A long preserved line for the Markdown limit.\n`).join('')}</code></pre>` : '';
    await route.fulfill({ contentType: 'text/html; charset=utf-8', headers: { 'Content-Security-Policy': "default-src 'none'; script-src 'none'" }, body: `<!doctype html><html><head><title>Fixture ${slug}</title><meta name="author" content="Ada"><meta name="description" content="Fixture lead"></head><body><nav>Navigation</nav><article><h1>Fixture ${slug}</h1><p>Preserved article content with Unicode 📰 and <strong>formatting</strong>.</p><p><a href="/relative">Relative link</a></p>${largeBody}</article><input value="private-form-sentinel"></body></html>` });
  });
  await context.route(`${origin}/api/integrations`, (route) => route.fulfill({ json: { integrations: currentDestination ? [currentDestination] : [] } }));
  await context.route(`${origin}/api/articles/*/integrations/*`, async (route) => {
    assert.equal(route.request().method(), 'POST');
    const body = route.request().postDataJSON();
    const copyUrl = route.request().url().replace(/\/integrations\/[^/]+$/, '/copy');
    const copy = (await (await fetch(copyUrl)).json()).copy;
    assert.equal(body.expectedRevision, copy.revision, 'publishing uses the persisted revision');
    githubCalls.push({ ...body, markdown: copy.markdown });
    if (failGitHub) await route.fulfill({ status: 503, json: { error: { code: 'github_unavailable', message: 'Fixture GitHub outage' } } });
    else await route.fulfill({ json: { integration: { configured: true, state: 'saved', ...currentDestination, url: 'https://github.com/Fixture/Archive/blob/main/Articles/fixture.md' } } });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const options = await openExtensionOptions(context, extensionId);
  await options.locator('#connect').click();
  await options.waitForFunction(async () => {
    const data = await chrome.storage.local.get('settings');
    return data.settings?.destinations?.[0]?.id === 'kindle';
  });
  await options.bringToFront();
  await options.reload();
  await options.locator('#integration').selectOption('kindle');
  await options.waitForFunction(() => document.querySelector('#destination').textContent.includes('My reading device'));
  await options.locator('#consent').check();
  await options.locator('#save-consent').click();
  await options.waitForFunction(() => document.querySelector('#mode').value === 'simple');

  const invoke = async (slug) => {
    const source = await context.newPage();
    await source.goto(`${origin}/fixture/${slug}`);
    const before = await source.evaluate(() => document.documentElement.outerHTML);
    const existing = new Set(context.pages());
    const newPage = context.waitForEvent('page', { predicate: (page) => !existing.has(page) });
    await worker.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      await globalThis.__captureForIntegration(tab);
    }, source.url());
    const target = await newPage;
    assert(target, 'controller opens a capture tab');
    await target.waitForFunction(() => Boolean(sessionStorage.getItem('later-extension-capture')) || document.querySelector('#notice')?.textContent?.startsWith('Saved'));
    assert.equal(await source.evaluate(() => document.documentElement.outerHTML), before, 'extraction leaves source DOM untouched');
    return { source, target };
  };
  const articles = async () => (await (await fetch(`${origin}/api/articles?status=all`)).json()).items;
  const copyOf = async (article) => (await (await fetch(`${origin}/api/articles/${article.id}/copy`)).json()).copy;

  // Automatic path: a genuine installed controller/bridge and real D1 writes.
  const automatic = await invoke('automatic');
  await automatic.target.locator('#notice').filter({ hasText: /^Saved/ }).waitFor();
  assert.equal(githubCalls.length, 1);
  assert.equal(githubCalls[0].expectedDestinationKey, destination.destinationKey);
  assert.match(githubCalls[0].markdown, /Unicode 📰/);
  assert(!githubCalls[0].markdown.includes('private-form-sentinel'));
  assert.equal((await articles()).length, 1);
  console.log('Automatic capture, persisted revision, Unicode, and unchanged source DOM passed.');
  await automatic.target.close();
  await automatic.source.close();

  const identical = await invoke('automatic');
  await identical.target.locator('#notice').filter({ hasText: /^Saved/ }).waitFor();
  assert.equal((await articles()).length, 1, 'duplicate URL keeps one article');
  assert.equal(copyWrites.length, 1, 'identical duplicate does not rewrite Markdown');
  await identical.target.close();
  await identical.source.close();

  // Review stays unsaved; editing and reloading must preserve all fields.
  await options.locator('#mode').selectOption('review');
  await options.waitForFunction(async () => (await chrome.storage.local.get('settings')).settings.mode === 'review');
  const review = await invoke('review');
  await review.target.locator('#extension-save-private').waitFor();
  assert.equal((await articles()).length, 1, 'review handoff does not save');
  const reviewRequestId = await review.target.evaluate(() => JSON.parse(sessionStorage.getItem('later-extension-capture')).requestId);
  const wrongTab = await context.newPage();
  await wrongTab.goto(`${origin}/add`);
  const wrongTabReply = await worker.evaluate(async ({ url, requestId }) => {
    const tabs = await chrome.tabs.query({ url });
    const tab = tabs.at(-1);
    return (await chrome.scripting.executeScript({ target: { tabId: tab.id },
      func: (requestId) => chrome.runtime.sendMessage({ version: 1, type: 'get-capture', requestId }), args: [requestId],
    }))[0].result;
  }, { url: `${origin}/add`, requestId: reviewRequestId });
  assert.deepEqual(wrongTabReply, { ok: false }, 'another tab cannot retrieve a known capture request');
  await wrongTab.close();
  await review.target.locator('#add-title').fill('Reviewed title');
  await review.target.locator('#capture-author').fill('Reviewed author');
  await review.target.locator('#capture-description').fill('Reviewed lead');
  await review.target.locator('#capture-markdown').fill('# Reviewed 📰\n\nPreserved edited body.');
  await review.target.reload();
  assert.equal(await review.target.locator('#add-title').inputValue(), 'Reviewed title');
  assert.equal(await review.target.locator('#capture-author').inputValue(), 'Reviewed author');
  assert.equal(await review.target.locator('#capture-description').inputValue(), 'Reviewed lead');
  assert.match(await review.target.locator('#capture-markdown').inputValue(), /Preserved edited body/);
  await review.target.screenshot({ path: '/tmp/potem-extension-review.png' });
  await review.source.close();
  const githubBeforePrivate = githubCalls.length;
  await review.target.locator('#extension-save-private').click();
  await review.target.locator('#notice').filter({ hasText: /^Saved/ }).waitFor();
  const reviewed = (await articles()).find((article) => article.title === 'Reviewed title');
  assert(reviewed);
  assert.equal(reviewed.author, 'Reviewed author');
  assert.equal(reviewed.description, 'Reviewed lead');
  assert.match((await copyOf(reviewed)).markdown, /Preserved edited body/);
  assert.equal(githubCalls.length, githubBeforePrivate, 'private save makes no integration request');
  console.log('Reviewed metadata/Markdown, reload, private save, wrong-tab rejection, and source closure passed.');
  await review.target.close();

  const conflict = await invoke('review');
  await conflict.target.locator('#extension-save-private').click();
  await conflict.target.locator('#extension-confirm-replacement').waitFor();
  assert.equal((await copyOf(reviewed)).markdown, '# Reviewed 📰\n\nPreserved edited body.', 'conflicting capture preserves saved Markdown');
  await conflict.target.locator('#extension-cancel').click();
  await conflict.target.locator('#add-open').click();
  assert.equal(await conflict.target.locator('#add-url').getAttribute('readonly'), null, 'cancel restores ordinary Add');
  await conflict.target.close();
  await conflict.source.close();

  const reviewPublish = await invoke('review-publish');
  await reviewPublish.target.locator('#extension-send-integration').click();
  await reviewPublish.target.locator('#notice').filter({ hasText: /^Saved/ }).waitFor();
  assert.equal(await reviewPublish.target.getByRole('link', { name: 'Open destination', exact: true }).getAttribute('href'),
    'https://github.com/Fixture/Archive/blob/main/Articles/fixture.md', 'review result uses the provider-confirmed destination URL');
  await reviewPublish.target.getByRole('link', { name: 'Read in Potem', exact: true }).click();
  await reviewPublish.target.locator('#reader-dialog').waitFor();
  assert.equal((await articles()).find((article) => article.url.endsWith('/fixture/review-publish')).readAt, null, 'opening the saved result does not mark it read');
  await reviewPublish.target.close();
  await reviewPublish.source.close();

  // Failure and explicit retry must keep and publish the same saved revision.
  await options.locator('#mode').selectOption('simple');
  await options.waitForFunction(async () => (await chrome.storage.local.get('settings')).settings.mode === 'simple');
  failGitHub = true;
  const outage = await invoke('outage');
  await outage.target.locator('#capture-integration-retry').waitFor();
  const writesBeforeRetry = copyWrites.length;
  await outage.target.reload();
  await outage.target.locator('#capture-integration-retry').waitFor();
  failGitHub = false;
  await outage.target.locator('#capture-integration-retry').click();
  await outage.target.locator('#notice').filter({ hasText: /Markdown copy saved in Potem and sent to Kindle\./ }).waitFor();
  assert.equal(copyWrites.length, writesBeforeRetry, 'GitHub retry never rewrites the D1 copy');
  const lastCalls = githubCalls.slice(-2);
  assert.equal(lastCalls[0].expectedRevision, lastCalls[1].expectedRevision);
  assert.equal(await outage.target.evaluate(() => [
    'later-extension-capture', 'later-extension-request', 'later-browser-capture-draft', 'later-add-draft',
  ].some((key) => sessionStorage.getItem(key) !== null)), false, 'successful retry clears capture session storage');
  const callsAfterRetry = githubCalls.length;
  const writesAfterRetry = copyWrites.length;
  await outage.target.reload();
  await outage.target.locator('#loading').waitFor({ state: 'hidden' });
  assert.equal(await outage.target.locator('#add-dialog').evaluate((dialog) => dialog.open), false, 'reload does not restore the completed capture dialog');
  assert.equal(await outage.target.locator('#capture-integration-retry').isVisible(), false, 'reload does not restore a completed GitHub retry');
  assert.equal(githubCalls.length, callsAfterRetry, 'reload does not issue another integration request');
  assert.equal(copyWrites.length, writesAfterRetry, 'reload does not write another saved copy');
  await outage.target.locator('#add-open').click();
  assert.equal(await outage.target.locator('#add-dialog').evaluate((dialog) => dialog.open), true, 'ordinary Add remains available after a capture completes');
  assert.equal(await outage.target.locator('#add-url').isEnabled(), true);
  await outage.target.close();
  await outage.source.close();

  const beforeOversized = (await articles()).length;
  const oversized = await invoke('oversized');
  const oversizedDraft = await oversized.target.evaluate(() => JSON.parse(sessionStorage.getItem('later-extension-capture')));
  assert.equal(oversizedDraft.extractionError, 'oversized');
  assert.equal((await articles()).length, beforeOversized, 'oversized extraction never saves automatically');
  await oversized.target.locator('#capture-markdown').fill('# Manually recovered\n\nReviewed recovery text.');
  assert.equal(await oversized.target.evaluate(() => JSON.parse(sessionStorage.getItem('later-extension-capture')).mode), 'review');
  await oversized.target.reload();
  assert.equal((await articles()).length, beforeOversized, 'reloading a pasted recovery cannot publish or save automatically');
  const githubBeforeRecovery = githubCalls.length;
  await oversized.target.locator('#extension-save-private').click();
  await oversized.target.locator('#notice').filter({ hasText: /^Saved/ }).waitFor();
  const recovered = (await articles()).find((article) => article.url.endsWith('/fixture/oversized'));
  assert.match((await copyOf(recovered)).markdown, /Reviewed recovery text/);
  assert.equal(githubCalls.length, githubBeforeRecovery);
  await oversized.target.close();
  await oversized.source.close();

  // Two controllers must retain separate request/draft records across awaits.
  await options.locator('#mode').selectOption('review');
  await options.waitForFunction(async () => (await chrome.storage.local.get('settings')).settings.mode === 'review');
  const concurrentSources = await Promise.all(['parallel-a', 'parallel-b'].map(async (slug) => {
    const page = await context.newPage(); await page.goto(`${origin}/fixture/${slug}`); return page;
  }));
  const existingPages = new Set(context.pages());
  await worker.evaluate(async (urls) => {
    const tabs = await chrome.tabs.query({});
    await Promise.all(urls.map((url) => globalThis.__captureForIntegration(tabs.find((tab) => tab.url === url))));
  }, concurrentSources.map((page) => page.url()));
  let concurrentTargets = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    concurrentTargets = context.pages().filter((page) => !existingPages.has(page));
    if (concurrentTargets.length === 2) break;
    await delay(50);
  }
  assert.equal(concurrentTargets.length, 2);
  const concurrentDrafts = await Promise.all(concurrentTargets.map(async (page) => {
    await page.waitForFunction(() => Boolean(sessionStorage.getItem('later-extension-capture')));
    return page.evaluate(() => JSON.parse(sessionStorage.getItem('later-extension-capture')));
  }));
  assert.deepEqual(concurrentDrafts.map((draft) => draft.sourceUrl).sort(), concurrentSources.map((page) => page.url()).sort());
  assert.equal(new Set(concurrentDrafts.map((draft) => draft.requestId)).size, 2);
  await Promise.all([...concurrentTargets, ...concurrentSources].map((page) => page.close()));

  await options.locator('#mode').selectOption('simple');
  await options.waitForFunction(async () => (await chrome.storage.local.get('settings')).settings.mode === 'simple');

  const beforeMismatch = (await articles()).length;
  currentDestination = { ...destination, destinationKey: 'kindle-device-two', destination: 'A different device' };
  const mismatch = await invoke('destination-changed');
  await mismatch.target.locator('#notice').filter({ hasText: /destination changed/ }).waitFor();
  assert.equal((await articles()).length, beforeMismatch, 'destination mismatch prevents an automatic save');
  await mismatch.target.close();
  await mismatch.source.close();
  currentDestination = null;
  await options.locator('#integration').selectOption('');
  await options.locator('#save-consent').click();
  await options.waitForFunction(async () => {
    const value = (await chrome.storage.local.get('settings')).settings;
    return value.mode === 'simple' && !value.destination;
  });
  const beforePrivateCalls = githubCalls.length;
  const privateAutomatic = await invoke('automatic-without-integrations');
  await privateAutomatic.target.locator('#notice').filter({ hasText: /^Saved/ }).waitFor();
  assert.equal(githubCalls.length, beforePrivateCalls, 'automatic private capture needs no integration');
  assert((await articles()).some(item => item.url.endsWith('/automatic-without-integrations')));
  await privateAutomatic.target.close();
  await privateAutomatic.source.close();
  assert.deepEqual(pageErrors, []);
  console.log(`Chromium ${context.browser().version()}: installed controller/bridge + real Worker/D1 automatic, review/private/integration saves, edited-draft reload, duplicate conflict, cancel, outage/retry, pasted recovery, concurrent captures, wrong-tab rejection, source closure, and destination guard passed.`);
  console.log('Chrome native toolbar activation, the full Firefox matrix, and minimum-version checks remain release checks; Firefox native private capture has separate recorded evidence.');
} finally {
  await context?.close();
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => server.once('exit', resolve)), delay(3000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  await rm(scratch, { recursive: true, force: true });
}
