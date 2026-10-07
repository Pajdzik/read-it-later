import { chromium, webkit, devices } from "playwright";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import net from "node:net";
import { createServer } from "node:http";

const temporary = await mkdtemp(path.join(os.tmpdir(), "read-later-mobile-"));
const storage = path.join(temporary, "d1");
const portServer = net.createServer();
await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
const port = portServer.address().port;
await new Promise((resolve, reject) => portServer.close((error) => error ? reject(error) : resolve()));
const base = `http://127.0.0.1:${port}`;
const sourceServer = createServer((request, response) => {
  const title = `Local fixture ${new URL(request.url, "http://fixture.invalid").pathname.slice(1)}`;
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html><head><title>${title}</title><meta name="author" content="Fixture Author"></head><body><nav>Navigation clutter</nav><main><article><h1>${title}</h1><p>This local fixture preserves <strong>important formatting</strong>.</p><table><tr><td>Fixture</td><td>wide table content</td></tr></table></article></main></body></html>`);
});
await new Promise((resolve) => sourceServer.listen(0, "127.0.0.1", resolve));
const sourceBase = `http://127.0.0.1:${sourceServer.address().port}`;
const project = process.cwd();
const wrangler = path.join(project, "node_modules/wrangler/bin/wrangler.js");
const configPath = path.join(temporary, "wrangler.jsonc");
const workerEntry = path.join(temporary, "worker.mjs");
await mkdir(storage);
const environment = Object.fromEntries(["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "ComSpec", "LANG", "TZ"]
  .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
environment.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";
environment.WRANGLER_SEND_METRICS = "false";
await writeFile(workerEntry, `import actual from ${JSON.stringify(path.join(project, "src/worker.ts"))};\nexport default { fetch(request, env, ctx) { return actual.fetch(request, env, ctx); } };\n`, { mode: 0o600 });
await writeFile(configPath, JSON.stringify({
  $schema: path.join(project, "node_modules/wrangler/config-schema.json"),
  name: "read-it-later-mobile-smoke", main: workerEntry, compatibility_date: "2026-08-01",
  vars: {
    APP_ORIGIN: base, DEV_AUTH_BYPASS: "true", GITHUB_CLIENT_ID: "mobile-smoke-dummy-client",
    GITHUB_CLIENT_SECRET: "mobile-smoke-dummy-secret", GITHUB_BACKUP_TOKEN: "mobile-smoke-dummy-token",
    OWNER_GITHUB_ID: "123456",
  },
  assets: {
    directory: path.join(project, "dist/web"), binding: "ASSETS", not_found_handling: "single-page-application",
    run_worker_first: ["/api", "/api/*", "/auth", "/auth/*", "/healthz"],
  },
  d1_databases: [{
    binding: "DB", database_name: "read-later", database_id: "00000000-0000-4000-8000-000000000000",
    migrations_dir: path.join(project, "migrations"),
  }],
}), { mode: 0o600 });
const active = new Set();
const run = (args, cwd = temporary) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"], detached: true });
  active.add(child);
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.on("error", () => { active.delete(child); reject(new Error(`Mobile smoke command failed: ${args.slice(0, 3).join(" ")}`)); });
  child.on("exit", (code) => { active.delete(child); code === 0 ? resolve() : reject(new Error(output || `Mobile smoke command exited ${code}: ${args.slice(0, 3).join(" ")}`)); });
});
let server;
let serverOutput = "";
const browsers = [];
let cleanupPromise;

async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    for (const browser of browsers) await browser.close().catch(() => {});
    for (const child of active) await stop(child);
    await rm(temporary, { recursive: true, force: true });
    await new Promise((resolve) => sourceServer.close(resolve));
  })();
  return cleanupPromise;
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) { if (child) active.delete(child); return; }
  await new Promise((resolve) => {
    const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } resolve(); }, 5000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  });
  active.delete(child);
}

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(code));
  });
}

async function waitForWorker() {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const [health, home] = await Promise.all([
        fetch(`${base}/healthz`, { signal: AbortSignal.timeout(500) }),
        fetch(base, { signal: AbortSignal.timeout(500) }),
      ]);
      if (health.ok && home.ok && (await home.text()).includes("potem — your reading list")) return;
    } catch {}
    if (server.exitCode !== null) throw new Error("Local Worker failed to start.");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Local Worker did not become ready. ${serverOutput}`);
}

async function runProfile(name, browserType, device) {
  const executablePath = browserType === chromium
    ? process.env.BROWSER_EXECUTABLE
    : process.env.WEBKIT_EXECUTABLE;
  const browser = await browserType.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  browsers.push(browser);
  const context = await browser.newContext({ ...device, serviceWorkers: "allow" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const screenshot = (suffix) => `/tmp/read-it-later-mobile-${name}-${suffix}.png`;

  // A share target is safe navigation: the manifest values prefill the form,
  // normalize the URL out of the address bar, and never submit it implicitly.
  const manifestResponse = await page.request.get(`${base}/manifest.webmanifest`);
  assert.equal(manifestResponse.status(), 200);
  const manifest = await manifestResponse.json();
  const shareParams = manifest.share_target.params;
  assert.deepEqual(manifest.share_target, {
    action: "/add", method: "GET", enctype: "application/x-www-form-urlencoded",
    params: { title: "title", text: "text", url: "url" },
  }, `${name}: share-target configuration changed; update this smoke from the manifest contract.`);
  for (const icon of manifest.icons) {
    const response = await page.request.get(`${base}${icon.src}`);
    assert.equal(response.status(), 200, `${name}: manifest icon ${icon.src} is unavailable.`);
    assert.ok((response.headers()["content-type"] || "").includes(icon.type),
      `${name}: manifest icon ${icon.src} has the wrong content type.`);
    const bytes = Buffer.from(await response.body());
    assert.ok(bytes.byteLength > 0, `${name}: manifest icon ${icon.src} is empty.`);
    if (icon.sizes === "192x192" || icon.sizes === "512x512") {
      assert.equal(icon.type, "image/png");
      assert.equal(bytes.toString("hex", 0, 8), "89504e470d0a1a0a");
      assert.equal(bytes.readUInt32BE(16), Number(icon.sizes.split("x")[0]));
      assert.equal(bytes.readUInt32BE(20), Number(icon.sizes.split("x")[1]));
    } else {
      const svg = bytes.toString("utf8");
      assert.match(svg, /<svg\b/i);
      assert.match(svg, /viewBox=/i);
    }
  }

  // Start anonymous and verify the visible sign-in action at the device size.
  await context.route("**/api/session", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ authenticated: false }),
  }));
  await page.goto(base);
  const signIn = page.locator("#library-sign-in");
  await signIn.waitFor({ state: "visible" });
  const signInBounds = await signIn.boundingBox();
  assert.ok(signInBounds && signInBounds.x >= 0 && signInBounds.x + signInBounds.width <= page.viewportSize().width,
    `${name}: anonymous sign-in is outside the viewport.`);
  await page.screenshot({ path: screenshot("portrait-anonymous") });
  const logoutDraftUrl = `${sourceBase}/logged-out-${name}`;
  const loggedOutQuery = new URLSearchParams({
    [shareParams.url]: logoutDraftUrl,
    [shareParams.title]: "Logged out draft",
  });
  const logoutContext = await browser.newContext({ ...device, serviceWorkers: "block" });
  const logoutPage = await logoutContext.newPage();
  logoutPage.on("pageerror", (error) => errors.push(error.message));
  await logoutContext.route("**/api/session", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ authenticated: false }),
  }));
  await logoutPage.goto(`${base}${manifest.share_target.action}?${loggedOutQuery}`);
  await logoutPage.locator("#add-url").waitFor({ state: "attached" });
  assert.equal(await logoutPage.locator("#add-url").inputValue(), logoutDraftUrl);
  await logoutPage.locator("#sign-in-prompt").waitFor({ state: "visible" });
  await logoutPage.screenshot({ path: screenshot("portrait-logged-out-draft") });
  await logoutPage.reload();
  assert.equal(await logoutPage.locator("#add-title").inputValue(), "Logged out draft");
  await logoutPage.locator("#sign-in-prompt").waitFor({ state: "visible" });
  await logoutContext.close();
  await context.unroute("**/api/session");
  await page.goto(base);
  await page.locator("#logout").waitFor();

  // Exercise the manifest's exact GET parameter names. The review dialog must
  // stay open with the candidate URL, and a reload before Save writes nothing.
  const shareUrl = `${sourceBase}/shared-${name}?utm_source=mobile%20smoke`;
  const shareTitle = `Shared from ${name}`;
  const shareQuery = new URLSearchParams({
    [shareParams.url]: shareUrl,
    [shareParams.title]: shareTitle,
    [shareParams.text]: `${shareTitle} ${shareUrl}`,
  });
  await page.goto(`${base}${manifest.share_target.action}?${shareQuery}`);
  await page.locator("#logout").waitFor();
  assert.equal(await page.locator("#add-dialog").evaluate((dialog) => dialog.open), true);
  assert.equal(await page.locator("#add-url").inputValue(), shareUrl);
  assert.equal(await page.locator("#add-title").inputValue(), shareTitle);
  assert.equal(await page.locator("#add-capture-markdown").isChecked(), true,
    `${name}: capture from URL should default on for a new review form.`);
  assert.equal(new URL(page.url()).search, "", "Share input should be removed from history after recovery.");
  await page.screenshot({ path: screenshot("portrait-add-review") });
  const noEarlySave = await page.evaluate(async (url) => {
    const result = await fetch("/api/articles?status=all", { cache: "no-store" }).then((r) => r.json());
    return result.items.some((item) => item.url === url);
  }, shareUrl);
  assert.equal(noEarlySave, false, `${name}: GET share target saved before confirmation.`);

  const ambiguousQuery = new URLSearchParams({
    [shareParams.text]: "Compare https://example.com/first and https://example.com/second",
  });
  await page.goto(`${base}${manifest.share_target.action}?${ambiguousQuery}`);
  await page.locator("#add-dialog").waitFor({ state: "visible" });
  assert.equal(await page.locator("#add-url").inputValue(), "");
  await page.locator("#add-notice").waitFor({ state: "visible" });
  await page.screenshot({ path: screenshot("portrait-ambiguous-share") });
  assert.match((await page.locator("#add-notice").textContent()) || "", /clear link/i,
    `${name}: ambiguous share notice was missing.`);
  await page.goto(`${base}${manifest.share_target.action}?${shareQuery}`);
  await page.locator("#logout").waitFor();

  await page.locator("#add-capture-markdown").check();
  const captureSaveResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/articles" && response.request().method() === "POST");
  await page.locator("#add-form button").tap();
  const captureSaveResponse = await captureSaveResponsePromise;
  assert.equal(captureSaveResponse.status(), 201, `${name}: requested capture did not acknowledge the saved link.`);
  const captureSave = await captureSaveResponse.json();
  assert.equal(captureSave.extraction?.state, "queued", `${name}: requested capture must persist a queued extraction intent.`);
  assert.equal(captureSave.extraction?.paused, true, `${name}: local runtime should report its disabled capture processor.`);
  assert.equal(Object.hasOwn(captureSave, "copy"), false, `${name}: save response must not include synchronous Markdown.`);
  await page.locator("#notice").getByText(/Link saved\. Capture is paused/).waitFor();
  const titleButton = page.getByRole("button", { name: shareTitle, exact: true });
  await titleButton.waitFor();
  const article = page.locator(".article").filter({ hasText: shareTitle });
  await article.locator(".extraction-badge").getByText("Capture paused").waitFor();
  const shareArticleId = await article.getAttribute("data-id");
  const persistedIntent = await page.evaluate(async (id) => (await (await fetch(`/api/articles/${id}`)).json()).article, shareArticleId);
  assert.equal(persistedIntent.extraction.state, "queued", `${name}: capture intent was not persisted with the article.`);
  assert.equal(persistedIntent.extraction.paused, true, `${name}: disabled processor state was not exposed.`);
  assert.equal(persistedIntent.hasCopy, false, `${name}: link-save acknowledgement must not claim a copy exists.`);
  assert.equal((await page.evaluate(async (id) => (await (await fetch(`/api/articles/${id}/copy`)).json()).copy, shareArticleId)), null,
    `${name}: a queued extraction must not expose a premature Markdown copy.`);
  await titleButton.tap();
  const pendingReader = page.locator("#reader-dialog");
  await pendingReader.locator("#reader-pending").waitFor({ state: "visible" });
  await pendingReader.getByText(/Capture is paused/).waitFor();
  assert.equal(await pendingReader.locator("#reader-original").getAttribute("href"), shareUrl,
    `${name}: pending reader should preserve the source link.`);
  await pendingReader.getByRole("button", { name: "Paste or upload Markdown" }).tap();
  const shareDetail = page.locator("#detail-content");
  const markdownDraft = `# ${shareTitle}\n\nManually saved while the background processor is paused. **Important formatting** stays readable.\n\n| Fixture | State |\n| --- | --- |\n| Mobile | paused |`;
  await shareDetail.getByRole("textbox", { name: "Markdown copy" }).fill(markdownDraft);
  await shareDetail.getByRole("button", { name: "Save Markdown copy" }).tap();
  await shareDetail.getByText(/pasted Markdown/).waitFor();
  await shareDetail.getByRole("button", { name: "Read saved copy" }).tap();
  await page.locator("#reader-dialog #reader-body").getByRole("heading", { name: shareTitle }).waitFor();
  assert.equal(await page.locator("#reader-dialog #reader-body table tbody tr").count(), 1,
    `${name}: manually persisted Markdown should remain readable while extraction is paused.`);
  await page.locator("#reader-dialog .reader-close button").tap();
  await page.locator("#detail-dialog .dialog-close button").tap();

  // A duplicate normalized URL keeps its original record and state.
  await page.locator("#add-open").tap();
  await page.locator("#add-url").fill(`${sourceBase}/shared-${name}?utm_source=other`);
  await page.locator("#add-title").fill("Duplicate must not replace title");
  await page.locator("#add-capture-markdown").uncheck();
  const duplicateResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/articles" && response.request().method() === "POST");
  await page.locator("#add-form button").tap();
  const duplicateResponse = await duplicateResponsePromise;
  assert.equal(duplicateResponse.status(), 200);
  assert.equal((await duplicateResponse.json()).duplicate, true);
  await page.locator("#add-dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: shareTitle, exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Duplicate must not replace title", exact: true }).count(), 0);

  // Save failure leaves both URL and title in the dialog for retry.
  await page.locator("#add-open").tap();
  const longDraftUrl = `${sourceBase}/${"mobile-path-".repeat(640)}`;
  const longDraftTitle = "M".repeat(500);
  assert.equal(longDraftTitle.length, 500);
  await page.locator("#add-url").fill(longDraftUrl);
  await page.locator("#add-title").fill(longDraftTitle);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
    `${name}: long URL/title causes page-level horizontal overflow.`);
  const addControls = await Promise.all([page.locator("#add-url").boundingBox(), page.locator("#add-form button").boundingBox()]);
  assert.ok(addControls.every((bounds) => bounds && bounds.x >= 0 && bounds.x + bounds.width <= page.viewportSize().width),
    `${name}: Add controls are not reachable with long URL/title.`);
  await page.locator("#add-url").fill(`${sourceBase}/retry-${name}`);
  await page.locator("#add-title").fill("Retry mobile draft");
  const retryUrl = `${sourceBase}/retry-${name}`;
  const retryTitle = `Retry mobile draft ${name}`;
  await page.locator("#add-url").fill(retryUrl);
  await page.locator("#add-title").fill(retryTitle);
  await page.locator("#add-capture-markdown").uncheck();
  await context.setOffline(true);
  await page.locator("#add-form button").tap();
  await page.waitForFunction(() => document.querySelector("#add-notice")?.textContent?.includes("Couldn’t save this link"));
  assert.match((await page.locator("#add-notice").textContent()) || "", /Couldn’t save this link/i,
    `${name}: network failure was not reported in the Add dialog.`);
  assert.equal(await page.locator("#add-url").inputValue(), retryUrl);
  assert.equal(await page.locator("#add-title").inputValue(), retryTitle);
  await context.setOffline(false);
  await page.locator("#add-form button").tap();
  await page.getByRole("button", { name: retryTitle, exact: true }).waitFor();
  await page.locator("#settings-open").tap();
  await page.locator("#theme-toggle").selectOption("dark");
  await page.locator("#settings-dialog .dialog-close button").tap();

  // Explicit read state persists after a reload; opening the saved title does
  // not itself mark it read. Search and status filters navigate the real list.
  await article.getByRole("button", { name: "Mark read" }).tap();
  await article.getByRole("button", { name: "Mark unread" }).waitFor();
  const articleId = await article.getAttribute("data-id");
  const readAtAfterSave = await page.evaluate(async (id) => {
    const pageData = await fetch("/api/articles?status=all", { cache: "no-store" }).then((response) => response.json());
    return pageData.items.find((item) => item.id === id)?.readAt;
  }, articleId);
  assert.ok(readAtAfterSave);
  await page.reload();
  await page.locator("#logout").waitFor();
  await page.locator('[data-status="read"]').tap();
  await page.getByRole("button", { name: shareTitle, exact: true }).waitFor();
  await page.locator("#search").fill(shareTitle);
  await page.getByRole("button", { name: shareTitle, exact: true }).waitFor();
  await page.locator("#search").fill("missing mobile result");
  await page.getByText("Nothing here yet").waitFor();
  await page.locator("#search").fill("");
  await page.locator('[data-status="unread"]').tap();
  await page.locator('[data-status="all"]').tap();
  await article.getByRole("button", { name: "Mark unread" }).tap();
  await article.getByRole("button", { name: "Mark read" }).waitFor();
  await page.reload();
  await page.locator("#logout").waitFor();
  await page.locator('[data-status="unread"]').tap();
  await article.getByRole("button", { name: "Mark read" }).waitFor();
  assert.equal(await page.evaluate(async (id) => {
    const pageData = await fetch("/api/articles?status=all", { cache: "no-store" }).then((response) => response.json());
    return pageData.items.find((item) => item.id === id)?.readAt;
  }, articleId), null, `${name}: explicit unread state did not survive reload.`);

  // Long content checks control reachability and no page-level horizontal
  // overflow. Paste the copy through article details, then open the title.
  await article.getByRole("button", { name: "Edit", exact: true }).tap();
  const detail = page.locator("#detail-content");
  await detail.getByRole("textbox", { name: "Markdown copy" }).fill(`# Wide reader check\n\n${"word-without-breaks-".repeat(24)}\n\n| left | ${"column-header-".repeat(8)} |\n| --- | --- |\n| text | ${"wide-cell-".repeat(24)} |`);
  page.once("dialog", (dialog) => dialog.accept());
  await detail.getByRole("button", { name: "Save Markdown copy" }).tap();
  await detail.getByText(/pasted Markdown/).waitFor();
  await detail.getByRole("button", { name: "Read saved copy" }).tap();
  await page.locator("#reader-body").getByRole("heading", { name: "Wide reader check" }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
    `${name}: reader page has horizontal overflow.`);
  const readerMetrics = await page.locator("#reader-dialog").evaluate((dialog) => ({
    clientWidth: dialog.clientWidth, scrollWidth: dialog.scrollWidth,
    bounds: dialog.getBoundingClientRect().toJSON(),
    wideBlocks: [...dialog.querySelectorAll("pre, table")].map((element) => ({
      tag: element.tagName, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
      bounds: element.getBoundingClientRect().toJSON(),
    })),
  }));
  await page.screenshot({ path: screenshot("portrait-reader") });
  assert.ok(readerMetrics.scrollWidth <= readerMetrics.clientWidth + 1,
    `${name}: reader dialog content exceeds its scrollport: ${JSON.stringify(readerMetrics)}`);
  assert.equal(await page.evaluate(async (id) => {
    const pageData = await fetch("/api/articles?status=all", { cache: "no-store" }).then((response) => response.json());
    return pageData.items.find((item) => item.id === id)?.readAt;
  }, articleId), null, `${name}: opening the saved title changed read state.`);
  await page.locator("#reader-dialog .reader-close button").tap();
  await page.reload();
  await page.locator("#logout").waitFor();
  await page.locator('[data-status="unread"]').tap();
  await titleButton.waitFor();
  await titleButton.tap();
  await page.locator("#reader-dialog").waitFor({ state: "visible" });
  await page.locator("#reader-body").getByRole("heading", { name: "Wide reader check" }).waitFor();
  assert.equal(await page.evaluate(async (id) => {
    const pageData = await fetch("/api/articles?status=all", { cache: "no-store" }).then((response) => response.json());
    return pageData.items.find((item) => item.id === id)?.readAt;
  }, articleId), null, `${name}: reopening a persisted reader changed read state.`);
  await page.locator("#reader-dialog .reader-close button").tap();

  // Narrow and short landscape layouts must keep the Add and navigation
  // controls reachable by touch without document-level horizontal scrolling.
  await page.setViewportSize({ width: 844, height: 390 });
  await page.locator("#add-open").waitFor({ state: "visible" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
    `${name}: landscape layout has horizontal overflow.`);
  const addBounds = await page.locator("#add-open").boundingBox();
  assert.ok(addBounds && addBounds.x >= 0 && addBounds.x + addBounds.width <= 844 && addBounds.y < 390,
    `${name}: Add control is not reachable in short landscape.`);
  await page.screenshot({ path: screenshot("landscape-short") });
  await page.locator("#add-open").tap();
  await page.locator("#add-dialog").waitFor({ state: "visible" });
  await page.screenshot({ path: screenshot("landscape-add-review") });
  await page.locator("#add-dialog .dialog-close button").tap();
  await page.locator("#add-open").tap();
  await page.locator("#add-url").fill(`${sourceBase}/unsaved-${name}`);
  await page.locator("#add-title").fill("Unsaved close recovery");
  await page.locator("#add-dialog .dialog-close button").tap();
  await page.locator("#add-open").tap();
  assert.equal(await page.locator("#add-url").inputValue(), `${sourceBase}/unsaved-${name}`,
    `${name}: closing and reopening Add lost the unsaved draft.`);
  await page.locator("#add-dialog .dialog-close button").tap();

  // Worker activation and an actually populated public cache are prerequisites
  // for checking the private-cache boundary. Exercise private GETs first.
  await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 10000 });
  await page.evaluate(async () => {
    await fetch("/api/articles?status=all", { cache: "no-store" });
    await fetch("/api/session", { cache: "no-store" });
  });
  const privateResponse = await page.request.get(`${base}/api/articles?status=all`);
  assert.match(privateResponse.headers()["cache-control"] || "", /no-store/i);
  assert.match((await page.request.get(`${base}/api/session`)).headers()["cache-control"] || "", /no-store/i);
  const cacheEvidence = await page.evaluate(async () => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    const active = registrations.some((registration) => registration.active?.state === "activated");
    const entries = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      entries.push(...(await cache.keys()).map((request) => ({ name, path: new URL(request.url).pathname })));
    }
    return { active, entries };
  });
  assert.equal(cacheEvidence.active, true, `${name}: service worker did not activate.`);
  assert.ok(cacheEvidence.entries.length >= 4, `${name}: public asset cache was empty or incomplete.`);
  assert.ok(cacheEvidence.entries.some(({ path }) => /^\/app\.[a-f0-9]+\.js$/.test(path)), `${name}: cached app JS missing.`);
  assert.ok(cacheEvidence.entries.some(({ path }) => /^\/app\.[a-f0-9]+\.css$/.test(path)), `${name}: cached app CSS missing.`);
  assert.ok(cacheEvidence.entries.every(({ path }) => path.startsWith("/icons/") || /^\/app\.[a-f0-9]+\.(js|css)$/.test(path)),
    `${name}: cache contains a non-public route: ${JSON.stringify(cacheEvidence.entries)}`);
  assert.ok(cacheEvidence.entries.every(({ path }) => !path.startsWith("/api/") && !path.startsWith("/add")),
    `${name}: a private route or share draft was cached.`);

  // Check short portrait after cache assertions and retain the profile image.
  await page.setViewportSize({ width: 360, height: 560 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
    `${name}: short portrait layout has horizontal overflow.`);
  const settingsButton = page.locator("#settings-open");
  await settingsButton.scrollIntoViewIfNeeded();
  await settingsButton.tap();
  await page.locator("#settings-dialog").waitFor({ state: "visible" });
  await page.screenshot({ path: screenshot("short-portrait-settings") });
  await page.locator("#settings-dialog .dialog-close button").tap();

  assert.deepEqual(errors, [], `${name}: browser runtime errors.`);
  console.log(`${name}: ${browser.version()} passed (${device.viewport.width}x${device.viewport.height} device profile, touch, portrait/landscape/short viewports).`);
  await context.close();
}

try {
  await run(["--import", "tsx", path.join(project, "scripts/build-web.ts")], project);
  await run([wrangler, "d1", "migrations", "apply", "read-later", "--local", "--env=", "--persist-to", storage, "--config", configPath]);
  server = spawn(process.execPath, [
    wrangler, "dev", "--local", "--env=", "--config", configPath, "--ip", "127.0.0.1",
    "--port", String(port), "--persist-to", storage,
  ], { cwd: temporary, env: environment, stdio: ["ignore", "pipe", "pipe"], detached: true });
  server.stdout.on("data", (chunk) => { serverOutput += chunk; });
  server.stderr.on("data", (chunk) => { serverOutput += chunk; });
  active.add(server);
  await waitForWorker();

  // Exercise the iOS Shortcut's bearer-token contract directly against the
  // local API. This validates HTTP behavior, not the Shortcuts app itself.
  const ownerHeaders = { Origin: base, "X-CSRF-Token": "dev-bypass", "Content-Type": "application/json" };
  const tokenResponse = await fetch(`${base}/api/capture-tokens`, {
    method: "POST", headers: ownerHeaders, body: JSON.stringify({ label: "Temporary mobile smoke" }),
  });
  assert.equal(tokenResponse.status, 201);
  assert.match(tokenResponse.headers.get("cache-control") || "", /no-store/i);
  const token = await tokenResponse.json();
  assert.match(token.token, /^rlcap_/);
  const capture = () => fetch(`${base}/api/capture`, {
    method: "POST", headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url: `${sourceBase}/shortcut-contract`, title: "Shortcut contract" }),
  });
  const captured = await capture();
  assert.equal(captured.status, 201);
  assert.match(captured.headers.get("cache-control") || "", /no-store/i);
  const captureResult = await captured.json();
  assert.equal(captureResult.extractionRequested, true, "Token capture should request background extraction by default.");
  assert.equal(Object.hasOwn(captureResult, "copy"), false, "Token acknowledgment must not include a synchronous Markdown copy.");
  assert.equal(Object.hasOwn(captureResult, "job"), false, "Token acknowledgment must not expose extraction job history.");
  assert.equal(Object.hasOwn(captureResult, "jobHistory"), false, "Token acknowledgment must not expose extraction job history.");
  assert.equal(Object.hasOwn(captureResult, "extraction"), false, "Token acknowledgment exposes intent only; owners read status through the authenticated API.");
  assert.equal(Object.hasOwn(captureResult.article, "extraction"), false, "Token acknowledgment must not expose internal job status on the article record.");
  const tokenArticle = await fetch(`${base}/api/articles/${encodeURIComponent(captureResult.article.id)}`, { headers: { Origin: base } }).then((response) => response.json());
  assert.equal(tokenArticle.article.extraction.state, "queued", "Token capture should persist extraction intent with the link.");
  assert.equal(tokenArticle.article.extraction.paused, true, "The local runtime should report that extraction is paused.");
  assert.equal(tokenArticle.article.hasCopy, false, "Token capture should persist the link before a Markdown copy exists.");
  const tokenCopy = await fetch(`${base}/api/articles/${encodeURIComponent(captureResult.article.id)}/copy`, { headers: { Origin: base } }).then((response) => response.json());
  assert.equal(tokenCopy.copy, null, "Token capture must not synchronously create a Markdown copy.");
  const duplicate = await capture();
  assert.equal(duplicate.status, 200);
  const duplicateResult = await duplicate.json();
  assert.equal(duplicateResult.duplicate, true);
  assert.equal(duplicateResult.extractionRequested, true, "Duplicate token shares should retain the existing extraction request.");
  const linkOnly = await fetch(`${base}/api/capture`, {
    method: "POST", headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url: `${sourceBase}/shortcut-link-only`, captureMarkdown: false }),
  });
  assert.equal(linkOnly.status, 201);
  const linkOnlyResult = await linkOnly.json();
  assert.equal(linkOnlyResult.extractionRequested, false, "Token capture should honor explicit link-only opt-out.");
  const linkOnlyArticle = await fetch(`${base}/api/articles/${encodeURIComponent(linkOnlyResult.article.id)}`).then((response) => response.json());
  assert.equal(linkOnlyArticle.article.extraction.state, "none", "Explicit false should not persist an extraction intent.");
  const revoked = await fetch(`${base}/api/capture-tokens/${encodeURIComponent(token.id)}`, {
    method: "DELETE", headers: { ...ownerHeaders },
  });
  assert.equal(revoked.status, 204);
  const denied = await capture();
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get("cache-control") || "", /no-store/i);
  console.log("local capture-token HTTP contract: success, duplicate, and revoked-token rejection passed with dummy local auth configuration.");

  await runProfile("chromium-android", chromium, devices["Pixel 7"]);
  await runProfile("webkit-iphone", webkit, devices["iPhone 13"]);
} finally {
  await cleanup();
}
