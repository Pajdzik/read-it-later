import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import net from "node:net";
import { createServer } from "node:http";

const storage = await mkdtemp(path.join(os.tmpdir(), "read-later-smoke-"));
const portServer = net.createServer();
await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
const port = portServer.address().port;
await new Promise((resolve, reject) =>
  portServer.close((error) => (error ? reject(error) : resolve())),
);
const base = `http://127.0.0.1:${port}`;
const sourceServer = createServer((request, response) => {
  const pathname = new URL(request.url, "http://source.invalid").pathname;
  if (pathname === "/unavailable") {
    response.writeHead(403, { "Content-Type": "text/plain" });
    response.end("Source unavailable");
    return;
  }
  const title = pathname === "/blocked" ? "Blocked source article" : `Captured ${pathname.slice(1) || "article"}`;
  if (pathname === "/blocked") response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'");
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html><html><head><title>${title}</title><meta name="author" content="Smoke Author"><meta name="description" content="A useful lead for the browser reader smoke test."></head><body><nav>Navigation clutter</nav><main><article><h1>${title}</h1><p>This browser clip keeps <strong>important formatting</strong> and source text.</p><pre><code class="language-js">const clipped = true;</code></pre></article></main></body></html>`);
});
await new Promise((resolve) => sourceServer.listen(0, "127.0.0.1", resolve));
const sourceBase = `http://127.0.0.1:${sourceServer.address().port}`;
const environment = {
  ...process.env,
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
  WRANGLER_SEND_METRICS: "false",
};
const wrangler = path.resolve("node_modules/wrangler/bin/wrangler.js");
const run = (args) =>
  new Promise((resolve, reject) => {
    const processHandle = spawn(process.execPath, args, {
      env: environment,
      stdio: "pipe",
    });
    let output = "";
    processHandle.stdout.on("data", (chunk) => (output += chunk));
    processHandle.stderr.on("data", (chunk) => (output += chunk));
    processHandle.on("error", reject);
    processHandle.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(output)),
    );
  });
let server, browser;
try {
  await run(["--import", "tsx", "scripts/build-web.ts"]);
  await run([
    wrangler,
    "d1",
    "migrations",
    "apply",
    "read-later",
    "--local",
    "--persist-to",
    storage,
  ]);
  server = spawn(
    process.execPath,
    [
      wrangler,
      "dev",
      "--port",
      String(port),
      "--persist-to",
      storage,
      "--var",
      `APP_ORIGIN:${base}`,
      "--var",
      "DEV_AUTH_BYPASS:true",
      "--var",
      "GITHUB_BACKUP_TOKEN:browser-smoke-only-token",
    ],
    { env: environment, stdio: "ignore" },
  );
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const [health, home] = await Promise.all([
        fetch(base + "/healthz", { signal: AbortSignal.timeout(500) }),
        fetch(base + "/", { signal: AbortSignal.timeout(500) }),
      ]);
      const html = await home.text();
      ready =
        health.ok && home.ok && html.includes("potem — your reading list");
    } catch {}
    if (ready) break;
    if (server.exitCode !== null)
      throw new Error("Local Worker failed to start.");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(ready, "Local Worker did not become ready.");
  browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_EXECUTABLE
      ? { executablePath: process.env.BROWSER_EXECUTABLE }
      : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/session", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { message: "Simulated session outage" } }),
    }),
  );
  await page.goto(base);
  await page.getByText(/Couldn’t check your session/).waitFor();
  assert.equal(
    await page.locator(".sign-in-prompt").count(),
    0,
    "A session outage must not look like a sign-in prompt.",
  );
  assert.equal(await page.locator("#library-sign-in").isHidden(), true);
  await page.unroute("**/api/session");
  await page.route("**/api/session", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ authenticated: false }),
  }));
  await page.reload();
  const signIn = page.locator("#library-sign-in");
  await signIn.waitFor({ state: "visible" });
  assert.equal(await page.locator("#add-dialog").evaluate((dialog) => dialog.open), false,
    "A fresh browser must be able to sign in without opening Add article.");
  await page.route("**/auth/github", (route) => route.fulfill({
    status: 200, contentType: "text/plain", body: "Sign-in reached",
  }));
  await signIn.click();
  await page.waitForURL(base + "/auth/github");
  assert.equal(await page.locator("body").innerText(), "Sign-in reached");
  await page.unroute("**/auth/github");
  await page.goto(base);
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn.waitFor({ state: "visible" });
  const signInBounds = await signIn.boundingBox();
  assert.ok(signInBounds && signInBounds.x >= 0 && signInBounds.x + signInBounds.width <= 390,
    "Sign-in must fit on a phone screen.");
  await page.screenshot({ path: path.join(os.tmpdir(), "potem-anonymous-sign-in-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: path.join(os.tmpdir(), "potem-anonymous-sign-in-desktop.png") });
  await page.unroute("**/api/session");
  await page.reload();
  await page.locator("#logout").waitFor();
  assert.equal(await signIn.isHidden(), true, "Signed-in owners must not see the sign-in prompt.");
  await page.locator("#add-open").click();
  await page
    .locator("#add-url")
    .fill("https://example.com/browser-smoke?utm_source=smoke");
  await page.locator("#add-title").fill("Browser smoke article");
  await page.locator("#add-capture-markdown").uncheck();
  await page.locator("#add-form button").click();
  const title = page.getByRole("button", {
    name: "Browser smoke article",
    exact: true,
  });
  await title.waitFor();
  const article = page
    .locator(".article")
    .filter({ hasText: "Browser smoke article" });
  await title.click();
  const detail = page.locator("#detail-content");
  const markdown = detail.getByRole("textbox", { name: "Markdown copy" });
  await detail.getByText("No Markdown copy saved yet.").waitFor();
  assert.equal(await detail.getByRole("button", { name: "Read saved copy" }).isHidden(), true, "A missing copy must not show reader actions.");
  assert.equal(await detail.getByRole("button", { name: "Download Markdown" }).isHidden(), true, "A missing copy must not show download actions.");
  const githubCheckbox = detail.getByRole("checkbox", { name: "Also save to GitHub" });
  await detail.getByText(/Pajdzik\/Kamilpedia/).waitFor();
  assert.equal(await githubCheckbox.isChecked(), false, "GitHub saving must start unchecked.");
  assert.equal(await githubCheckbox.isDisabled(), false, "Configured GitHub saving should be available as an opt-in.");
  await markdown.fill("# Browser copy\n\nPasted draft.");
  await page.route("**/api/articles/*/copy", async (route) => {
    if (route.request().method() === "PUT")
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "Simulated copy outage" } }) });
    else await route.continue();
  });
  await detail.getByRole("button", { name: "Save Markdown copy" }).click();
  await detail.getByText(/Simulated copy outage/).waitFor();
  assert.equal(await markdown.inputValue(), "# Browser copy\n\nPasted draft.", "A failed copy save must keep the draft.");
  await page.unroute("**/api/articles/*/copy");
  await detail.getByRole("button", { name: "Save Markdown copy" }).click();
  await detail.getByText(/pasted Markdown/).waitFor();
  await markdown.fill("# Cancelled replacement");
  page.once("dialog", (dialog) => dialog.dismiss());
  await detail.getByRole("button", { name: "Save Markdown copy" }).click();
  assert.equal(await markdown.inputValue(), "# Cancelled replacement", "Canceling replacement must preserve the draft.");
  const uploadedMarkdown = "# Uploaded copy\n\nLoaded from a Markdown file.";
  await detail.locator('input[type="file"]').setInputFiles({ name: "clipped.md", mimeType: "text/markdown", buffer: Buffer.from(uploadedMarkdown) });
  await detail.getByText(/clipped\.md loaded/).waitFor();
  page.once("dialog", (dialog) => dialog.accept());
  await detail.getByRole("button", { name: "Save Markdown copy" }).click();
  await detail.getByText(/uploaded file/).waitFor();
  await page.locator("#detail-dialog .dialog-close button").click();
  let githubRequests = 0;
  let githubFailure = true;
  let githubState = "not_saved";
  const githubDestination = {
    configured: true, repository: "Pajdzik/Kamilpedia", branch: "main",
    path: "Articles/browser-smoke.md", url: "https://github.com/Pajdzik/Kamilpedia/blob/main/Articles/browser-smoke.md",
  };
  await page.route("**/api/articles/*/github", async (route) => {
    if (route.request().method() === "POST") {
      githubRequests++;
      const copyUrl = route.request().url().replace(/\/github$/, "/copy");
      const currentCopy = (await (await fetch(copyUrl)).json()).copy;
      assert.equal(route.request().postDataJSON().expectedRevision, currentCopy.revision, "GitHub must receive the persisted copy revision.");
      assert.equal(currentCopy.markdown, "# GitHub checkbox copy\n\nStill saved if GitHub fails.");
      if (githubFailure) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "Simulated GitHub outage" } }) });
        return;
      }
      githubState = "saved";
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ backup: {
      ...githubDestination, state: githubState, ...(githubState === "saved" ? { backedUpAt: "2026-10-01T00:00:00.000Z" } : {}),
    } }) });
  });
  await page.reload();
  await page.locator("#logout").waitFor();
  await title.waitFor();
  await article.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator("#detail-content .copy-status").getByText(/uploaded file/).waitFor();
  assert.equal(await page.locator("#detail-content").getByRole("textbox", { name: "Markdown copy" }).inputValue(), uploadedMarkdown, "Uploaded Markdown must survive reload.");
  await detail.getByText(/Not saved to GitHub yet/).waitFor();
  assert.equal(await githubCheckbox.isChecked(), false, "The GitHub checkbox must remain opt-in on reopen.");
  assert.equal(githubRequests, 0, "Unchecked local saves must not trigger a GitHub write.");
  await markdown.fill("# Unchecked GitHub save");
  page.once("dialog", (dialog) => dialog.accept());
  await detail.getByRole("button", { name: "Save Markdown copy" }).click();
  await detail.locator(".copy-status").getByText(/pasted Markdown/).waitFor();
  assert.equal(githubRequests, 0, "Saving with a configured, unchecked checkbox must only save to D1.");
  await githubCheckbox.check();
  await markdown.fill("# GitHub checkbox copy\n\nStill saved if GitHub fails.");
  page.once("dialog", (dialog) => dialog.accept());
  await detail.getByRole("button", { name: "Save Markdown copy" }).click();
  await detail.getByText(/Simulated GitHub outage/).waitFor();
  assert.equal(githubRequests, 1);
  assert.equal(await markdown.inputValue(), "# GitHub checkbox copy\n\nStill saved if GitHub fails.", "GitHub failure must leave the local copy in the editor.");
  githubFailure = false;
  await detail.getByRole("button", { name: "Save saved copy to GitHub" }).click();
  await detail.getByText(/Saved to GitHub/).waitFor();
  assert.equal(githubRequests, 2, "GitHub retry must not require resaving or replacing the local copy.");
  await page.locator("#detail-dialog .dialog-close button").click();
  await page.reload();
  await title.waitFor();
  await article.getByRole("button", { name: "Edit", exact: true }).click();
  await detail.getByText(/Saved to GitHub/).waitFor();
  assert.equal(await githubCheckbox.isChecked(), false);
  assert.equal(await markdown.inputValue(), "# GitHub checkbox copy\n\nStill saved if GitHub fails.");
  const preservedMarkdown = [
    "# Preserved **copy** — Ω",
    "",
    "Raw HTML is literal: <img src=\"https://image-marker.invalid/should-not-load\" onerror=\"alert(1)\"> and <svg onload=\"alert(2)\">.",
    "",
    "[Relative](../chapter?q=1#part) · [Root](/reference) · [Fragment](#inside)",
    "[Unsafe](javascript:alert(1)) · [Encoded](%6a%61%76%61%73%63%72%69%70%74:alert(2)) · [Credentials](https://user:pass@bad.invalid/)",
    "",
    "![Remote marker](https://image-marker.invalid/pixel.png)",
    "",
    "```js",
    "const value = '<script>alert(3)</script>';",
    "```",
    "",
    "| Column | Wide value |",
    "| --- | --- |",
    `| Unicode | ${"wide-text-".repeat(30)} |`,
    "",
    "A paragraph with **strong**, *emphasis*, and a [valid HTTPS link](https://example.net/read).",
    "",
    "## inside",
    "",
    "Long text: " + "long-text-".repeat(80),
  ].join("\n");
  await markdown.fill(preservedMarkdown);
  page.once("dialog", (dialog) => dialog.accept());
  await detail.getByRole("button", { name: "Save Markdown copy" }).click();
  await detail.locator(".copy-status").getByText(/pasted Markdown/).waitFor();
  const articleId = await article.getAttribute("data-id");
  const entryFixture = await page.evaluate(async ({ url }) => {
    const session = await (await fetch("/api/session")).json();
    const headers = { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken };
    const created = await fetch("/api/articles", {
      method: "POST", headers,
      body: JSON.stringify({ url, title: "Reader entry smoke" }),
    });
    if (!created.ok) throw new Error(`Couldn’t create reader-entry fixture: ${created.status}`);
    const { article: item } = await created.json();
    const saved = await fetch(`/api/articles/${encodeURIComponent(item.id)}/copy`, {
      method: "PUT", headers,
      body: JSON.stringify({ markdown: "# Reader entry copy\n\nRendered from the saved copy.", source: "paste", expectedRevision: null }),
    });
    if (!saved.ok) throw new Error(`Couldn’t save reader-entry fixture: ${saved.status}`);
    return { id: item.id };
  }, { url: `${sourceBase}/reader-entry-smoke` });
  await page.route("**/api/articles?*", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    const entry = data.items?.find((item) => item.id === entryFixture.id);
    if (entry) entry.description = "A lead used to test opening the saved copy.";
    await route.fulfill({ response, body: JSON.stringify(data) });
  });
  await page.reload();
  await page.locator("#logout").waitFor();
  const entryArticle = page.locator(".article").filter({ hasText: "Reader entry smoke" });
  const entryTitle = entryArticle.getByRole("button", { name: "Reader entry smoke", exact: true });
  await entryTitle.waitFor();
  const entryActions = entryArticle.locator(".article-actions");
  const entryRead = entryActions.getByRole("button", { name: "Mark read", exact: true });
  const entryEdit = entryActions.getByRole("button", { name: "Edit", exact: true });
  const entryOriginal = entryActions.getByRole("link", { name: "Open original" });
  const assertActionRow = async () => {
    assert.equal(await entryActions.locator("button, a").count(), 3, "Open original, Mark read, and Edit must share one action container.");
    const centers = await Promise.all([entryRead, entryEdit, entryOriginal].map(async (control) => {
      const bounds = await control.boundingBox();
      assert.ok(bounds, "Each article action must be visible.");
      return bounds.y + bounds.height / 2;
    }));
    assert.ok(Math.max(...centers) - Math.min(...centers) <= 3, "Article actions must stay on one row.");
  };
  const entryReadState = await page.evaluate(async (id) => (await (await fetch(`/api/articles/${id}`)).json()).article.readAt, entryFixture.id);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await assertActionRow();
  await page.screenshot({ path: "/tmp/potem-article-actions-desktop.png" });
  await entryTitle.click();
  const reader = page.locator("#reader-dialog");
  await reader.getByRole("heading", { name: "Reader entry smoke" }).waitFor();
  await reader.locator("#reader-body").getByText("Rendered from the saved copy.").waitFor();
  assert.equal(await page.evaluate(async (id) => (await (await fetch(`/api/articles/${id}`)).json()).article.readAt, entryFixture.id), entryReadState, "Opening a title must not change read state.");
  await reader.getByRole("button", { name: "Close saved copy" }).click();
  const entryLead = entryArticle.getByRole("button", { name: "Read saved copy of Reader entry smoke" });
  await entryLead.waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await assertActionRow();
  await page.screenshot({ path: "/tmp/potem-article-actions-mobile.png" });
  await entryLead.click();
  await reader.getByRole("heading", { name: "Reader entry smoke" }).waitFor();
  await reader.locator("#reader-body").getByText("Rendered from the saved copy.").waitFor();
  assert.equal(await page.evaluate(async (id) => (await (await fetch(`/api/articles/${id}`)).json()).article.readAt, entryFixture.id), entryReadState, "Opening a lead must not change read state.");
  await reader.getByRole("button", { name: "Close saved copy" }).click();
  const removeEntryFixture = await page.evaluate(async (id) => {
    const session = await (await fetch("/api/session")).json();
    const response = await fetch(`/api/articles/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "X-CSRF-Token": session.csrfToken } });
    return response.status;
  }, entryFixture.id);
  assert.equal(removeEntryFixture, 204, "Reader-entry fixture should be removed after the regression check.");
  await page.unroute("**/api/articles?*");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await page.locator("#logout").waitFor();
  await title.waitFor();
  let releasePendingCopy;
  let signalPendingCopy;
  const pendingCopyStarted = new Promise((resolve) => { signalPendingCopy = resolve; });
  const pendingCopyRelease = new Promise((resolve) => { releasePendingCopy = resolve; });
  let delayedCopyRead = false;
  await page.route(`**/api/articles/${articleId}/copy`, async (route) => {
    if (route.request().method() === "GET" && !delayedCopyRead) {
      delayedCopyRead = true;
      signalPendingCopy();
      await pendingCopyRelease;
    }
    await route.continue();
  });
  await title.click();
  await pendingCopyStarted;
  await article.getByRole("button", { name: "Edit", exact: true }).click();
  releasePendingCopy();
  await detail.getByRole("textbox", { name: "Markdown copy" }).waitFor();
  await detail.locator(".copy-status").getByText(/pasted Markdown/).waitFor();
  assert.equal(await page.locator("#reader-dialog").isHidden(), true, "Opening Edit during a pending title read must suppress the stale reader.");
  await page.unroute(`**/api/articles/${articleId}/copy`);
  await page.locator("#detail-dialog .dialog-close button").click();
  const readStateBefore = await page.evaluate(async (id) => (await (await fetch(`/api/articles/${id}`)).json()).article.readAt, articleId);
  let imageMarkerRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("image-marker.invalid")) imageMarkerRequests++;
  });
  const originalUrl = await article.locator(".original-link").getAttribute("href");
  await page.route(originalUrl, (route) => route.abort());
  await title.click();
  await reader.getByRole("heading", { name: "Browser smoke article" }).waitFor();
  const readerBody = reader.locator("#reader-body");
  await readerBody.getByRole("heading", { name: "Preserved copy — Ω" }).waitFor();
  await readerBody.getByRole("link", { name: "Relative" }).waitFor();
  const relativeUrl = await readerBody.getByRole("link", { name: "Relative" }).getAttribute("href");
  assert.equal(new URL(relativeUrl).href, "https://example.com/chapter?q=1#part");
  assert.equal(await readerBody.getByRole("link", { name: "Root" }).getAttribute("href"), "https://example.com/reference");
  assert.equal(await readerBody.getByRole("link", { name: "Fragment" }).getAttribute("href"), "https://example.com/browser-smoke?utm_source=smoke#inside");
  assert.equal(await readerBody.locator("pre code").textContent(), "const value = '<script>alert(3)</script>';\n");
  assert.equal(await readerBody.locator("table tbody tr").count(), 1, "Markdown tables should render as tables.");
  assert.match(await readerBody.textContent(), /Unsafe.*Encoded.*Credentials/, "Dangerous destinations should remain readable text.");
  assert.equal(await readerBody.locator("img, iframe, video, audio, source, svg, math, form, style, script").count(), 0, "Reader must contain no active or resource-loading nodes.");
  const activeMarkup = await readerBody.evaluate((root) => {
    const attrs = [];
    for (const node of root.querySelectorAll("*")) {
      for (const attr of node.attributes) {
        if (["href", "target", "rel", "start"].includes(attr.name)) continue;
        attrs.push(`${node.tagName.toLowerCase()}[${attr.name}]`);
      }
      if (node instanceof HTMLAnchorElement) {
        if (!/^https?:$/.test(new URL(node.href).protocol) || new URL(node.href).username || new URL(node.href).password) attrs.push("unsafe href");
        if (node.target !== "_blank" || !node.rel.includes("noopener") || !node.rel.includes("noreferrer")) attrs.push("unsafe link target");
      }
    }
    return attrs;
  });
  assert.deepEqual(activeMarkup, [], "Sanitized reader DOM must contain only allowed attributes and safe links.");
  assert.match(await readerBody.textContent(), /<img src=/, "Raw HTML should display as literal text.");
  assert.match(await readerBody.textContent(), /Image reference: Remote marker/);
  const validLink = readerBody.getByRole("link", { name: "valid HTTPS link" });
  assert.equal(await validLink.getAttribute("href"), "https://example.net/read");
  assert.equal(imageMarkerRequests, 0, "Markdown images and hostile HTML must not trigger network requests.");
  assert.equal(await page.evaluate(async (id) => (await (await fetch(`/api/articles/${id}`)).json()).article.readAt, articleId), readStateBefore, "Reading a copy must not change read state.");
  await page.screenshot({ path: "/tmp/potem-a03-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "Reader must fit a 390px viewport.");
  await page.screenshot({ path: "/tmp/potem-a03-mobile.png" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await reader.getByRole("button", { name: "Close saved copy" }).click();
  assert.equal(await reader.locator("#reader-body").textContent(), "", "Closing the reader must discard its private DOM.");
  await article.getByRole("button", { name: "Edit", exact: true }).click();
  await detail.locator(".copy-status").getByText(/pasted Markdown/).waitFor();
  await detail.getByRole("textbox", { name: "Markdown copy" }).fill("Unsaved draft stays in the editor.");
  const downloadButton = detail.getByRole("button", { name: "Download Markdown" });
  assert.equal(await downloadButton.isVisible(), true, "A successfully loaded copy should enable its download action.");
  const [downloadEvent] = await Promise.all([
    page.waitForEvent("download", { timeout: 5000 }),
    downloadButton.click(),
  ]);
  await downloadEvent.saveAs(path.join(storage, "copy.md"));
  const downloaded = await readFile(path.join(storage, "copy.md"), "utf8");
  assert.equal(downloadEvent.suggestedFilename(), `potem-${articleId}.md`);
  assert.match(downloaded, /^---\ntitle: "Browser smoke article"\nurl: "https:\/\/example\.com\/browser-smoke\?utm_source=smoke"\ncapturedAt: "[^\n]+"\nsource: "paste"\nrevision: "[^"]+"\n---\n\n/);
  assert.equal(downloaded.slice(downloaded.indexOf("\n\n", downloaded.indexOf("\n---\n") + 1) + 2), preservedMarkdown, "Markdown download must preserve the saved body byte-for-byte and ignore the unsaved draft.");
  assert.equal(await page.evaluate(async (id) => (await (await fetch(`/api/articles/${id}`)).json()).article.readAt, articleId), readStateBefore, "Downloading a copy must not change read state.");
  await detail.getByRole("button", { name: "Read saved copy" }).click();
  await reader.getByRole("heading", { name: "Browser smoke article" }).waitFor();
  await reader.getByRole("button", { name: "Close saved copy" }).click();
  assert.equal(await detail.getByRole("textbox", { name: "Markdown copy" }).inputValue(), "Unsaved draft stays in the editor.", "Reading must preserve an unsaved editor draft.");
  await page.locator("#detail-dialog .dialog-close button").click();
  await page.reload();
  await title.waitFor();
  await article.getByRole("button", { name: "Edit", exact: true }).click();
  await detail.locator(".copy-status").getByText(/pasted Markdown/).waitFor();
  await detail.getByRole("button", { name: "Read saved copy" }).click();
  await readerBody.getByRole("heading", { name: "Preserved copy — Ω" }).waitFor();
  await reader.getByRole("button", { name: "Close saved copy" }).click();
  await page.locator("#detail-dialog .dialog-close button").click();
  await page.unroute(originalUrl);
  await page.route("**/api/articles/*/copy", async (route) => {
    if (route.request().method() === "GET")
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "Simulated copy read outage" } }) });
    else await route.continue();
  });
  await title.click();
  await detail.getByText(/Simulated copy read outage/).waitFor();
  assert.equal(await detail.getByText("No Markdown copy saved yet.").count(), 0, "A failed request must not look like a missing copy.");
  assert.equal(await detail.getByRole("button", { name: "Read saved copy" }).isHidden(), true, "A failed request must hide reader actions.");
  await page.locator("#detail-dialog .dialog-close button").click();
  await page.unroute("**/api/articles/*/copy");
  const injectedTitle = 'Quoted metadata: "Ω"\n---\nrevision: forged';
  await page.evaluate(async ({ id, title: nextTitle }) => {
    const session = await (await fetch("/api/session")).json();
    const response = await fetch(`/api/articles/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
      body: JSON.stringify({ title: nextTitle }),
    });
    if (!response.ok) throw new Error(`Couldn’t set frontmatter fixture: ${response.status}`);
  }, { id: articleId, title: injectedTitle });
  await page.reload();
  await page.locator(".article").filter({ hasText: "Quoted metadata" }).getByRole("button", { name: "Edit", exact: true }).click();
  await detail.locator(".copy-status").getByText(/pasted Markdown/).waitFor();
  const injectedDownloadPromise = page.waitForEvent("download");
  await detail.getByRole("button", { name: "Download Markdown" }).click();
  const injectedDownload = await injectedDownloadPromise;
  await injectedDownload.saveAs(path.join(storage, "quoted.md"));
  const quotedMarkdown = await readFile(path.join(storage, "quoted.md"), "utf8");
  assert.ok(quotedMarkdown.startsWith(`---\ntitle: ${JSON.stringify(injectedTitle)}\nurl:`), "Quotes, Unicode, and newline frontmatter must remain a single quoted scalar.");
  assert.equal(quotedMarkdown.slice(quotedMarkdown.indexOf("\n\n", quotedMarkdown.indexOf("\n---\n") + 1) + 2), preservedMarkdown);
  await page.locator("#detail-dialog .dialog-close button").click();
  await page.evaluate(async (id) => {
    const session = await (await fetch("/api/session")).json();
    const response = await fetch(`/api/articles/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
      body: JSON.stringify({ title: "Browser smoke article" }),
    });
    if (!response.ok) throw new Error(`Couldn’t restore browser smoke title: ${response.status}`);
  }, articleId);
  await page.reload();
  await title.waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "Markdown editor must fit a narrow viewport.");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "All", exact: true }).click();
  await article.getByRole("button", { name: "Mark read", exact: true }).click();
  await article
    .getByRole("button", { name: "Mark unread", exact: true })
    .waitFor();
  await page.reload();
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await title.waitFor();
  await article.getByRole("button", { name: "Edit", exact: true }).click();
  await page.route("**/api/articles/*", async (route) => {
    if (route.request().method() === "PATCH")
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "Simulated edit outage" } }),
      });
    else await route.continue();
  });
  await page.locator("#detail-content .edit-form input").fill("Failed edit");
  await page
    .locator("#detail-content")
    .getByRole("button", { name: "Save title" })
    .click();
  await page
    .locator("#detail-error")
    .getByText("Simulated edit outage")
    .waitFor();
  await page.unroute("**/api/articles/*");
  await page
    .locator("#detail-content")
    .getByRole("button", { name: "Mark unread", exact: true })
    .click();
  await page
    .locator("#detail-dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.getByRole("button", { name: "Unread", exact: true }).click();
  await title.waitFor();
  assert(
    await page.locator("#more").isHidden(),
    "Show more should be hidden on the last page.",
  );
  const original = article.getByRole("link", { name: "Open original" });
  assert.equal(await original.getAttribute("target"), "_blank");
  assert.match(await original.getAttribute("rel"), /noopener/);
  await page.route("**/api/articles", async (route) => {
    if (route.request().method() === "POST")
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { message: "Simulated storage outage" },
        }),
      });
    else await route.continue();
  });
  await page.locator("#add-open").click();
  await page.locator("#add-url").fill("https://example.com/unsaved");
  await page.locator("#add-form button").click();
  await page.getByText(/Couldn’t save this link/).waitFor();
  assert.equal(
    await page.locator("#add-url").inputValue(),
    "https://example.com/unsaved",
  );
  await page
    .locator("#add-dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.unroute("**/api/articles");
  await page.route("**/api/articles?*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { message: "Simulated list outage" } }),
    }),
  );
  await page.locator("#search").fill("no-match");
  await page.getByText("Simulated list outage").waitFor();
  await page.unroute("**/api/articles?*");
  await page.locator("#search").fill("no-match-again");
  await page.locator("#empty h3").getByText("Nothing here yet").waitFor();
  await page.locator("#search").fill("");
  for (const route of ["/api", "/api/unknown", "/auth/unknown"]) {
    const response = await context.request.get(base + route, {
      headers: { Accept: "text/html" },
    });
    assert.equal(response.status(), 404);
    assert.match(response.headers()["content-type"], /application\/json/);
  }
  await page.locator("#settings-open").click();
  await page.locator("#token-label").fill("Smoke device");
  await page.locator("#token-form button").click();
  await page.locator("#new-token code").waitFor();
  await page
    .locator("#settings-dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelector("#new-token").textContent === "",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
    "Mobile horizontal overflow.",
  );
  await page.goto(
    base +
      "/add?text=" +
      encodeURIComponent(
        "Two https://example.com/first https://example.com/second",
      ),
  );
  await page.locator("#logout").waitFor();
  assert.equal(
    await page.locator("#add-url").inputValue(),
    "",
    "Ambiguous shared text must not silently choose a URL.",
  );
  await page.goto(
    base +
      "/add?url=" +
      encodeURIComponent("https://example.com/draft") +
      "&title=Draft",
  );
  await page.locator("#logout").waitFor();
  assert.equal(
    await page.locator("#add-url").inputValue(),
    "https://example.com/draft",
  );
  await page.reload();
  assert.equal(
    await page.locator("#add-title").inputValue(),
    "Draft",
    "A recovered draft should survive a reload until saved.",
  );
  assert.equal(new URL(page.url()).search, "");
  await page.goto(base + "/capture");
  await page.getByRole("heading", { name: "Desktop bookmarklet" }).waitFor();
  const bookmarklet = await page.locator("#bookmarklet").getAttribute("href");
  assert.match(bookmarklet, /^javascript:/);
  const captureFrom = async (pathname) => {
    const source = await context.newPage();
    const unexpectedRequests = [];
    source.on("request", (request) => {
      const url = new URL(request.url());
      if (![sourceBase, base].includes(url.origin)) unexpectedRequests.push(url.href);
    });
    await source.goto(`${sourceBase}${pathname}`);
    const popupPromise = source.waitForEvent("popup");
    await source.evaluate((href) => (0, eval)(href.slice("javascript:".length)), bookmarklet);
    const popup = await popupPromise;
    await popup.locator("#logout").waitFor();
    await popup.locator("#add-url").waitFor();
    return { source, popup, unexpectedRequests };
  };
  const [successfulClip] = await Promise.all([captureFrom("/article")]);
  await successfulClip.popup.locator("#capture-copy").waitFor({ state: "visible" });
  await successfulClip.popup.waitForFunction(() => {
    const checkbox = document.querySelector("#capture-github-enabled");
    return checkbox && !checkbox.disabled && document.querySelector("#capture-github-status").textContent.includes("Pajdzik/Kamilpedia");
  });
  assert.equal(await successfulClip.popup.locator("#capture-github-enabled").isChecked(), false, "GitHub publishing must start unchecked.");
  assert.match(await successfulClip.popup.locator(".capture-copy .copy-explainer").textContent(), /production destination.*is public/i);
  let defaultGithubPosts = 0;
  await successfulClip.popup.route("**/api/articles/*/github", async (route) => {
    if (route.request().method() === "POST") defaultGithubPosts++;
    await route.continue();
  });
  const capturedText = await successfulClip.popup.locator("#capture-markdown").inputValue();
  assert.match(capturedText, /important formatting/);
  assert.doesNotMatch(capturedText, /<p>|<article>/, "Defuddle must return Markdown text rather than source HTML.");
  assert.equal(await successfulClip.popup.locator("#add-url").inputValue(), `${sourceBase}/article`);
  await successfulClip.popup.screenshot({ path: "/tmp/potem-browser-capture-desktop.png" });
  await successfulClip.popup.setViewportSize({ width: 390, height: 844 });
  assert.equal(await successfulClip.popup.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "Capture review must fit a narrow viewport.");
  await successfulClip.popup.screenshot({ path: "/tmp/potem-browser-capture-mobile.png" });
  await successfulClip.popup.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(await successfulClip.popup.evaluate(async (url) => (await (await fetch("/api/articles?status=all")).json()).items.some((item) => item.url === url), `${sourceBase}/article`), false, "Opening the handoff must not save before confirmation.");
  await successfulClip.popup.locator("#add-form button").click();
  await successfulClip.popup.getByText("Link and Markdown copy saved privately in Potem.").waitFor();
  assert.equal(defaultGithubPosts, 0, "An unchecked capture must not publish to GitHub.");
  let captureArticles = await successfulClip.popup.evaluate(async () => (await (await fetch("/api/articles?status=all")).json()).items);
  let capturedArticle = captureArticles.find((item) => item.url === `${sourceBase}/article`);
  assert.ok(capturedArticle, "Confirmed browser capture must save the URL.");
  let savedClip = await successfulClip.popup.evaluate(async (id) => (await (await fetch(`/api/articles/${id}/copy`)).json()).copy, capturedArticle.id);
  assert.match(savedClip.markdown, /important formatting/);
  assert.deepEqual(successfulClip.unexpectedRequests, [], "Browser extraction must not call third-party services.");
  await successfulClip.source.close();
  await successfulClip.popup.close();

  const optedInClip = await captureFrom("/opted-in");
  await optedInClip.popup.locator("#capture-copy").waitFor({ state: "visible" });
  await optedInClip.popup.waitForFunction(() => {
    const checkbox = document.querySelector("#capture-github-enabled");
    return checkbox && !checkbox.disabled;
  });
  let optedInCopyWrites = 0;
  let optedInRevision = "";
  let optedInGithubPosts = 0;
  await optedInClip.popup.route("**/api/articles/*/copy", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    optedInCopyWrites++;
    assert.equal(route.request().postDataJSON().expectedRevision, null);
    const response = await route.fetch();
    const body = await response.json();
    optedInRevision = body.copy.revision;
    await route.fulfill({ response, body: JSON.stringify(body) });
  });
  await optedInClip.popup.route("**/api/articles/*/github", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    optedInGithubPosts++;
    assert.equal(route.request().postDataJSON().expectedRevision, optedInRevision, "GitHub must receive the revision returned by D1.");
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ backup: {
      configured: true, repository: "Pajdzik/Kamilpedia", branch: "main", path: "Articles/opted-in.md",
      url: "https://github.com/Pajdzik/Kamilpedia/blob/main/Articles/opted-in.md", state: "saved", backedUpAt: "2026-10-02T00:00:00.000Z",
    } }) });
  });
  await optedInClip.popup.locator("#capture-github-enabled").check();
  await optedInClip.popup.locator("#add-form button").click();
  await optedInClip.popup.getByText("Link and Markdown copy saved to Potem and GitHub.").waitFor();
  assert.equal(optedInCopyWrites, 1);
  assert.equal(optedInGithubPosts, 1);
  await optedInClip.source.close();
  await optedInClip.popup.close();

  const githubRetryClip = await captureFrom("/github-retry");
  await githubRetryClip.popup.locator("#capture-copy").waitFor({ state: "visible" });
  await githubRetryClip.popup.waitForFunction(() => !document.querySelector("#capture-github-enabled").disabled);
  let retryCopyWrites = 0;
  let retryCopyRevision = "";
  const retryRevisions = [];
  let failFirstGitHubSave = true;
  await githubRetryClip.popup.route("**/api/articles/*/copy", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    retryCopyWrites++;
    const response = await route.fetch();
    const body = await response.json();
    retryCopyRevision = body.copy.revision;
    await route.fulfill({ response, body: JSON.stringify(body) });
  });
  await githubRetryClip.popup.route("**/api/articles/*/github", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const expectedRevision = route.request().postDataJSON().expectedRevision;
    retryRevisions.push(expectedRevision);
    assert.equal(expectedRevision, retryCopyRevision);
    if (failFirstGitHubSave) {
      failFirstGitHubSave = false;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "Simulated GitHub failure" } }) });
    } else {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ backup: {
        configured: true, repository: "Pajdzik/Kamilpedia", branch: "main", path: "Articles/github-retry.md",
        url: "https://github.com/Pajdzik/Kamilpedia/blob/main/Articles/github-retry.md", state: "saved", backedUpAt: "2026-10-02T00:00:00.000Z",
      } }) });
    }
  });
  await githubRetryClip.popup.locator("#capture-github-enabled").check();
  await githubRetryClip.popup.locator("#add-form button").click();
  await githubRetryClip.popup.locator("#capture-github-retry").waitFor({ state: "visible" });
  await githubRetryClip.popup.locator("#add-notice").getByText(/GitHub save failed/).waitFor();
  assert.equal(retryCopyWrites, 1, "The Markdown copy must be saved before the GitHub attempt.");
  await githubRetryClip.popup.reload();
  await githubRetryClip.popup.locator("#capture-github-retry").waitFor({ state: "visible" });
  assert.equal(await githubRetryClip.popup.locator("#capture-github-enabled").isChecked(), false, "A GitHub publishing choice must not be restored as checked.");
  await githubRetryClip.popup.locator("#capture-github-retry").click();
  await githubRetryClip.popup.getByText("Markdown copy saved to Potem and GitHub.").waitFor();
  assert.equal(retryCopyWrites, 1, "GitHub retry must not PUT the Markdown copy again.");
  assert.deepEqual(retryRevisions, [retryCopyRevision, retryCopyRevision], "Retry must reuse the same saved revision.");
  await githubRetryClip.source.close();
  await githubRetryClip.popup.close();

  const githubDoneClip = await captureFrom("/github-done");
  await githubDoneClip.popup.locator("#capture-copy").waitFor({ state: "visible" });
  await githubDoneClip.popup.waitForFunction(() => !document.querySelector("#capture-github-enabled").disabled);
  await githubDoneClip.popup.route("**/api/articles/*/github", async (route) => {
    if (route.request().method() === "POST")
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "Simulated persistent GitHub failure" } }) });
    else await route.continue();
  });
  await githubDoneClip.popup.locator("#capture-github-enabled").check();
  await githubDoneClip.popup.locator("#add-form button").click();
  await githubDoneClip.popup.locator("#capture-github-done").waitFor({ state: "visible" });
  const doneArticleUrl = await githubDoneClip.popup.locator("#add-url").inputValue();
  await githubDoneClip.popup.locator("#capture-github-done").click();
  assert.equal(await githubDoneClip.popup.locator("#add-dialog").evaluate((dialog) => dialog.open), false);
  captureArticles = await githubDoneClip.popup.evaluate(async () => (await (await fetch("/api/articles?status=all")).json()).items);
  capturedArticle = captureArticles.find((item) => item.url === doneArticleUrl);
  assert.ok(capturedArticle, "Done must keep the locally saved article.");
  assert.ok((await githubDoneClip.popup.evaluate(async (id) => (await (await fetch(`/api/articles/${id}/copy`)).json()).copy, capturedArticle.id)), "Done must keep the locally saved Markdown copy.");
  await githubDoneClip.source.close();
  await githubDoneClip.popup.close();

  const existingUrl = `${sourceBase}/existing`;
  let protectedCopy = "# Owner's existing copy\n\nKeep these bytes.";
  const existingFixture = await page.evaluate(async ({ url, markdown }) => {
    const session = await (await fetch("/api/session")).json();
    const headers = { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken };
    const created = await fetch("/api/articles", { method: "POST", headers, body: JSON.stringify({ url, title: "Existing source copy" }) });
    const article = (await created.json()).article;
    const saved = await fetch(`/api/articles/${article.id}/copy`, { method: "PUT", headers, body: JSON.stringify({ markdown, source: "paste", expectedRevision: null }) });
    if (!saved.ok) throw new Error(`Could not seed existing copy: ${saved.status}`);
    return article.id;
  }, { url: existingUrl, markdown: protectedCopy });
  await page.goto(base + "/capture");
  const existingCapture = await captureFrom("/existing");
  await existingCapture.popup.locator("#capture-copy").waitFor({ state: "visible" });
  await existingCapture.popup.waitForFunction(() => !document.querySelector("#capture-github-enabled").disabled);
  await existingCapture.popup.locator("#capture-github-enabled").check();
  let existingGithubPosts = 0;
  await existingCapture.popup.route("**/api/articles/*/github", async (route) => {
    if (route.request().method() === "POST") existingGithubPosts++;
    await route.continue();
  });
  await existingCapture.popup.locator("#add-form button").click();
  await existingCapture.popup.locator("#add-notice").getByText(/Link saved\. Markdown copy was not changed/).waitFor();
  assert.equal(await existingCapture.popup.locator("#add-dialog").evaluate((dialog) => dialog.open), true, "A copy conflict should keep the draft open for a choice.");
  let stillProtected = await existingCapture.popup.evaluate(async (id) => (await (await fetch(`/api/articles/${id}/copy`)).json()).copy, existingFixture);
  assert.equal(stillProtected.markdown, protectedCopy, "Capture must never replace an existing copy silently.");
  assert.equal(existingGithubPosts, 0, "A failed local-copy create must not publish to GitHub.");
  await existingCapture.popup.locator("#capture-copy-enabled").uncheck();
  await existingCapture.popup.locator("#add-form button").click();
  await existingCapture.popup.locator("#add-dialog").waitFor({ state: "hidden" });
  stillProtected = await existingCapture.popup.evaluate(async (id) => (await (await fetch(`/api/articles/${id}/copy`)).json()).copy, existingFixture);
  assert.equal(stillProtected.markdown, protectedCopy);
  await existingCapture.source.close();
  await existingCapture.popup.close();

  const retryClip = await captureFrom("/retry");
  await retryClip.popup.locator("#capture-markdown").waitFor();
  let failOneCopySave = true;
  await retryClip.popup.route("**/api/articles/*/copy", async (route) => {
    if (route.request().method() === "PUT" && failOneCopySave) {
      failOneCopySave = false;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "Simulated capture copy failure" } }) });
    } else await route.continue();
  });
  await retryClip.popup.locator("#add-form button").click();
  await retryClip.popup.locator("#add-notice").getByText(/Simulated capture copy failure/).waitFor();
  assert.equal(await retryClip.popup.locator("#capture-markdown").inputValue(), capturedText, "A failed copy write must retain the editable draft.");
  await retryClip.popup.reload();
  await retryClip.popup.locator("#capture-copy").waitFor({ state: "visible" });
  assert.equal(await retryClip.popup.locator("#capture-markdown").inputValue(), capturedText, "The captured draft must survive reload.");
  await retryClip.popup.locator("#add-form button").click();
  await retryClip.popup.locator("#add-dialog").waitFor({ state: "hidden" });
  captureArticles = await retryClip.popup.evaluate(async () => (await (await fetch("/api/articles?status=all")).json()).items);
  capturedArticle = captureArticles.find((item) => item.url === `${sourceBase}/retry`);
  savedClip = await retryClip.popup.evaluate(async (id) => (await (await fetch(`/api/articles/${id}/copy`)).json()).copy, capturedArticle.id);
  assert.match(savedClip.markdown, /important formatting/);
  await retryClip.source.close();
  await retryClip.popup.close();

  const changedClip = await captureFrom("/changed");
  await changedClip.popup.locator("#capture-copy").waitFor({ state: "visible" });
  await changedClip.popup.locator("#add-url").fill(`${sourceBase}/another-page`);
  assert.equal(await changedClip.popup.locator("#capture-copy").isHidden(), true, "A changed URL must detach the source copy.");
  await changedClip.popup.locator("#add-form button").click();
  await changedClip.popup.getByText(/captured Markdown was not attached because the URL changed/).waitFor();
  captureArticles = await changedClip.popup.evaluate(async () => (await (await fetch("/api/articles?status=all")).json()).items);
  capturedArticle = captureArticles.find((item) => item.url === `${sourceBase}/another-page`);
  assert.ok(capturedArticle);
  assert.equal((await changedClip.popup.evaluate(async (id) => (await (await fetch(`/api/articles/${id}/copy`)).json()).copy, capturedArticle.id)), null);
  await changedClip.source.close();
  await changedClip.popup.close();

  const blockedClip = await captureFrom("/blocked");
  await blockedClip.popup.locator("#add-notice").getByText(/blocked the extractor/).waitFor();
  assert.equal(await blockedClip.popup.locator("#add-url").inputValue(), `${sourceBase}/blocked`, "Extraction failure must retain the URL.");
  assert.equal(await blockedClip.popup.locator("#capture-copy").isHidden(), true);
  await blockedClip.popup.locator("#add-form button").click();
  await blockedClip.popup.getByText("Saved for later.").waitFor();
  captureArticles = await blockedClip.popup.evaluate(async () => (await (await fetch("/api/articles?status=all")).json()).items);
  capturedArticle = captureArticles.find((item) => item.url === `${sourceBase}/blocked`);
  assert.ok(capturedArticle);
  assert.equal((await blockedClip.popup.evaluate(async (id) => (await (await fetch(`/api/articles/${id}/copy`)).json()).copy, capturedArticle.id)), null);
  await blockedClip.source.close();
  await blockedClip.popup.close();

  const urlContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const urlPage = await urlContext.newPage();
  urlPage.on("pageerror", (error) => errors.push(error.message));
  await urlPage.goto(base);
  await urlPage.locator("#logout").waitFor();
  const asyncFixture = await urlPage.evaluate(async ({ url }) => {
    const session = await (await fetch("/api/session")).json();
    const response = await fetch("/api/articles", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
      body: JSON.stringify({ url, title: "Background capture smoke", captureMarkdown: false }),
    });
    if (!response.ok) throw new Error(`Couldn’t create background-capture fixture: ${response.status}`);
    return (await response.json()).article;
  }, { url: `${sourceBase}/async-smoke` });
  const failedFixture = await urlPage.evaluate(async ({ url }) => {
    const session = await (await fetch("/api/session")).json();
    const response = await fetch("/api/articles", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken },
      body: JSON.stringify({ url, title: "Failed capture smoke", captureMarkdown: false }),
    });
    if (!response.ok) throw new Error(`Couldn’t create failed-capture fixture: ${response.status}`);
    return (await response.json()).article;
  }, { url: `${sourceBase}/failed-smoke` });
  let asyncState = "queued";
  let extractionReads = 0;
  const asyncCopy = { markdown: "# Background copy\n\nReady without replacing the editor draft.", capturedAt: "2026-10-06T00:00:00.000Z", source: "paste", revision: "smoke-background-revision" };
  await urlPage.route("**/api/articles?*", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    const item = data.items?.find((candidate) => candidate.id === asyncFixture.id);
    if (item) item.extraction = { state: asyncState, attempts: 0, errorCode: null, nextAttemptAt: null, paused: false };
    const failedItem = data.items?.find((candidate) => candidate.id === failedFixture.id);
    if (failedItem) failedItem.extraction = { state: "failed", attempts: 3, errorCode: "source_unavailable", nextAttemptAt: null, paused: false };
    await route.fulfill({ response, body: JSON.stringify(data) });
  });
  await urlPage.route(`**/api/articles/${asyncFixture.id}/copy`, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ copy: asyncState === "ready" ? asyncCopy : null }) });
      return;
    }
    await route.continue();
  });
  await urlPage.route(`**/api/articles/${failedFixture.id}/copy`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ copy: null }) }));
  await urlPage.route(`**/api/articles/${failedFixture.id}/extraction/retry`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ extraction: { state: "queued", attempts: 0, errorCode: null, nextAttemptAt: null, paused: false } }) }));
  await urlPage.route(`**/api/articles/${asyncFixture.id}/extraction`, async (route) => {
    extractionReads++;
    if (extractionReads >= 1) asyncState = "ready";
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ extraction: { state: asyncState, attempts: 1, errorCode: null, nextAttemptAt: null, paused: false } }) });
  });
  await urlPage.locator("#add-open").click();
  assert.equal(await urlPage.locator("#add-capture-markdown").isChecked(), true, "Pasted URLs should capture Markdown by default.");
  await urlPage.locator("#add-url").fill(asyncFixture.url);
  await urlPage.route("**/api/articles", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const submitted = route.request().postDataJSON();
    assert.equal(submitted.captureMarkdown, true, "The Add form must request background Markdown capture by default.");
    const response = await route.fetch({ postData: JSON.stringify({ ...submitted, captureMarkdown: false }) });
    const data = await response.json();
    await route.fulfill({ response, body: JSON.stringify({ ...data, extraction: { state: "queued", attempts: 0, errorCode: null, nextAttemptAt: null, paused: false } }) });
  });
  await urlPage.locator("#add-form button").click();
  await urlPage.locator("#notice").getByText(/Link saved\. Capturing Markdown in the background/).waitFor();
  const asyncArticle = urlPage.locator(`.article[data-id="${asyncFixture.id}"]`);
  await asyncArticle.locator(".extraction-badge").getByText("Capturing Markdown").waitFor();
  const urlReader = urlPage.locator("#reader-dialog");
  await asyncArticle.getByRole("button", { name: "Background capture smoke", exact: true }).click();
  await urlReader.locator("#reader-pending").waitFor({ state: "visible" });
  await urlReader.getByText(/being prepared in the background/).waitFor();
  await urlPage.setViewportSize({ width: 390, height: 844 });
  assert.equal(await urlPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "The pending reader must fit a phone screen.");
  const pendingBounds = await urlReader.locator("#reader-pending").boundingBox();
  assert.ok(pendingBounds && pendingBounds.x >= 0 && pendingBounds.x + pendingBounds.width <= 390, "Pending reader actions must fit a narrow viewport.");
  await urlPage.screenshot({ path: path.join(os.tmpdir(), "potem-pending-reader-mobile.png") });
  await urlReader.getByRole("button", { name: "Paste or upload Markdown" }).click();
  const asyncDetail = urlPage.locator("#detail-content");
  const draftBox = asyncDetail.getByRole("textbox", { name: "Markdown copy" });
  await draftBox.fill("# My manual draft\n\nKeep this while background capture finishes.");
  await asyncDetail.locator("#detail-extraction-status").getByText("Capturing Markdown").waitFor();
  await asyncDetail.locator(".copy-status").getByText(/Unsaved draft/).waitFor();
  await urlPage.waitForFunction(() => document.querySelector("#detail-extraction-status")?.textContent === "Markdown ready", null, { timeout: 10000 });
  assert.equal(await draftBox.inputValue(), "# My manual draft\n\nKeep this while background capture finishes.", "Polling must preserve the user's unsaved Markdown draft.");
  await asyncDetail.getByRole("button", { name: "Read saved copy" }).click();
  await urlReader.locator("#reader-body").getByText("Ready without replacing the editor draft.").waitFor();
  await urlReader.getByRole("button", { name: "Close saved copy" }).click();
  await urlPage.locator("#detail-dialog .dialog-close button").click();
  const failedArticle = urlPage.locator(`.article[data-id="${failedFixture.id}"]`);
  await failedArticle.locator(".extraction-badge").getByText("Capture failed").waitFor();
  await failedArticle.getByRole("button", { name: "Failed capture smoke", exact: true }).click();
  await urlReader.getByText(/The source site could not be reached/).waitFor();
  await urlReader.getByRole("button", { name: "Retry capture" }).click();
  await urlReader.getByText(/being prepared in the background/).waitFor();
  await urlReader.getByRole("button", { name: "Close saved copy" }).click();
  // A successful server retry must not reopen a closed view or replace another
  // article when its response arrives after navigation.
  const retryPattern = `**/api/articles/${failedFixture.id}/extraction/retry`;
  await urlPage.unroute(retryPattern);
  let releaseRetry, observeRetry;
  const retryStarted = new Promise((resolve) => { observeRetry = resolve; });
  const retryGate = new Promise((resolve) => { releaseRetry = resolve; });
  await urlPage.route(retryPattern, async (route) => {
    observeRetry();
    await retryGate;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ extraction: { state: "queued", attempts: 0, errorCode: null, nextAttemptAt: null, paused: false } }) });
  });
  await failedArticle.getByRole("button", { name: "Failed capture smoke", exact: true }).click();
  const lateReaderResponse = urlPage.waitForResponse((response) => response.url().endsWith(`/articles/${failedFixture.id}/extraction/retry`));
  await urlReader.getByRole("button", { name: "Retry capture" }).click();
  await retryStarted;
  await urlReader.getByRole("button", { name: "Close saved copy" }).click();
  releaseRetry();
  await (await lateReaderResponse).finished();
  await urlPage.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await urlReader.evaluate((dialog) => dialog.open), false, "A late retry must not reopen a closed reader.");

  await urlPage.unroute(retryPattern);
  let releaseDetailRetry, observeDetailRetry;
  const detailRetryStarted = new Promise((resolve) => { observeDetailRetry = resolve; });
  const detailRetryGate = new Promise((resolve) => { releaseDetailRetry = resolve; });
  await urlPage.route(retryPattern, async (route) => {
    observeDetailRetry();
    await detailRetryGate;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ extraction: { state: "queued", attempts: 0, errorCode: null, nextAttemptAt: null, paused: false } }) });
  });
  await failedArticle.getByRole("button", { name: "Edit", exact: true }).click();
  const lateDetailResponse = urlPage.waitForResponse((response) => response.url().endsWith(`/articles/${failedFixture.id}/extraction/retry`));
  await urlPage.locator("#detail-content").getByRole("button", { name: "Retry capture" }).click();
  await detailRetryStarted;
  await urlPage.locator("#detail-dialog .dialog-close button").click();
  await asyncArticle.getByRole("button", { name: "Edit", exact: true }).click();
  releaseDetailRetry();
  await (await lateDetailResponse).finished();
  await urlPage.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await urlPage.locator("#detail-content h2").textContent(), "Background capture smoke", "A late retry must not replace another article's details.");
  await urlPage.locator("#detail-dialog .dialog-close button").click();
  await failedArticle.getByRole("button", { name: "Edit", exact: true }).click();
  await urlPage.locator("#detail-content .edit-form input").fill("Keep my unsaved title");
  await urlPage.locator("#detail-content").getByRole("button", { name: "Retry capture" }).click();
  await urlPage.locator("#detail-extraction-status").getByText("Capturing Markdown").waitFor();
  assert.equal(await urlPage.locator("#detail-content .edit-form input").inputValue(), "Keep my unsaved title", "Retry acknowledgment must preserve an unsaved title draft.");
  await urlPage.locator("#detail-dialog .dialog-close button").click();
  await urlPage.unroute("**/api/articles");
  await urlPage.unroute(`**/api/articles/${asyncFixture.id}/extraction`);
  await urlPage.unroute(`**/api/articles/${asyncFixture.id}/copy`);
  await urlPage.unroute(`**/api/articles/${failedFixture.id}/copy`);
  await urlPage.unroute(`**/api/articles/${failedFixture.id}/extraction/retry`);
  await urlPage.unroute("**/api/articles?*");
  await urlContext.close();
  const cachedPaths = await page.evaluate(async () => {
    const paths = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      paths.push(
        ...(await cache.keys()).map((request) => new URL(request.url).pathname),
      );
    }
    return paths;
  });
  assert(
    cachedPaths.every(
      (path) =>
        /^\/app\.[a-f0-9]+\.(js|css)$/.test(path) || path.startsWith("/icons/"),
    ),
    "Private route cached by service worker.",
  );
  assert.deepEqual(errors, [], "Browser runtime errors.");
  console.log(
    "Browser smoke passed: persistence, desktop/mobile layout, last-page controls, and capture drafts.",
  );
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  await rm(storage, { recursive: true, force: true });
  await new Promise((resolve) => sourceServer.close(resolve));
}
