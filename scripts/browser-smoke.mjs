import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import net from "node:net";

const storage = await mkdtemp(path.join(os.tmpdir(), "read-later-smoke-"));
const portServer = net.createServer();
await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
const port = portServer.address().port;
await new Promise((resolve, reject) =>
  portServer.close((error) => (error ? reject(error) : resolve())),
);
const base = `http://127.0.0.1:${port}`;
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
  await run(["scripts/build-web.mjs"]);
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
  const seededAt = new Date().toISOString();
  const imported = await fetch(`${base}/api/import`, {
    method: "POST",
    headers: {
      Origin: base,
      "Content-Type": "application/json",
      "X-CSRF-Token": "dev-bypass",
    },
    body: JSON.stringify({
      version: 2,
      exportedAt: seededAt,
      articles: [{
        id: "editor-switch-smoke",
        url: "https://example.com/editor-switch-smoke",
        title: "Editor switch smoke article",
        createdAt: seededAt,
        updatedAt: seededAt,
        readAt: null,
      }],
    }),
  });
  assert.equal(imported.status, 200, "The editor-switch article must be seeded through the import API.");
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
  await page.unroute("**/api/session");
  await page.reload();
  await page.locator("#logout").waitFor();
  await page.locator("#add-open").click();
  await page
    .locator("#add-url")
    .fill("https://example.com/browser-smoke?utm_source=smoke");
  await page.locator("#add-title").fill("Browser smoke article");
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
  await page.reload();
  await page.locator("#logout").waitFor();
  await title.waitFor();
  await title.click();
  await page.locator("#detail-content .copy-status").getByText(/uploaded file/).waitFor();
  const reopenedMarkdown = page.locator("#detail-content").getByRole("textbox", { name: "Markdown copy" });
  assert.equal(await reopenedMarkdown.inputValue(), uploadedMarkdown, "Uploaded Markdown must survive reload.");
  const articleId = await article.getAttribute("data-id");
  const originalCopyResponse = await page.evaluate(async (id) => {
    const response = await fetch(`/api/articles/${encodeURIComponent(id)}/copy`);
    return response.json();
  }, articleId);
  const originalRevision = originalCopyResponse.copy.revision;
  await reopenedMarkdown.fill("# Draft based on the original revision");
  await page.locator("#detail-dialog .dialog-close button").click();
  await page.getByRole("button", { name: "Editor switch smoke article", exact: true }).click();
  const switchMarkdown = page.locator("#detail-content").getByRole("textbox", { name: "Markdown copy" });
  await page.locator("#detail-content").getByText("No Markdown copy saved yet.").waitFor();
  assert.equal(await switchMarkdown.inputValue(), "", "Opening another article must show its own copy editor.");
  await switchMarkdown.fill("# Draft started before any copy existed");
  await page.locator("#detail-dialog .dialog-close button").click();
  const switchArticle = page
    .locator(".article")
    .filter({ hasText: "Editor switch smoke article" });
  const switchArticleId = await switchArticle.getAttribute("data-id");
  const externalFirstWrite = await page.evaluate(async (id) => {
    const response = await fetch(`/api/articles/${encodeURIComponent(id)}/copy`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": "dev-bypass" },
      body: JSON.stringify({ markdown: "# Copy created on another device", source: "paste", expectedRevision: null }),
    });
    return response.status;
  }, switchArticleId);
  assert.equal(externalFirstWrite, 200, "The simulated other device must create a copy from the empty state.");
  await page.getByRole("button", { name: "Editor switch smoke article", exact: true }).click();
  await page.locator("#detail-content").getByText(/Unsaved draft/).waitFor();
  assert.equal(await switchMarkdown.inputValue(), "# Draft started before any copy existed", "A draft based on no copy must survive close and reopen.");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#detail-content").getByRole("button", { name: "Save Markdown copy" }).click();
  await page.getByText(/changed since you opened it/).waitFor();
  assert.equal(await switchMarkdown.inputValue(), "# Draft started before any copy existed", "A null-revision conflict must preserve its draft.");
  await page.locator("#detail-dialog .dialog-close button").click();
  await title.click();
  await page.locator("#detail-content").getByText(/Unsaved draft/).waitFor();
  assert.equal(await reopenedMarkdown.inputValue(), "# Draft based on the original revision", "Closing and reopening must preserve the pending draft.");
  const externalWrite = await page.evaluate(async ({ id, expectedRevision }) => {
    const response = await fetch(`/api/articles/${encodeURIComponent(id)}/copy`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": "dev-bypass" },
      body: JSON.stringify({ markdown: "# Newer copy from another device", source: "paste", expectedRevision }),
    });
    return { status: response.status, body: await response.json() };
  }, { id: articleId, expectedRevision: originalRevision });
  assert.equal(externalWrite.status, 200, "The simulated other device must successfully update the copy.");
  await page.locator("#detail-content").getByRole("button", { name: "Mark read" }).click();
  await page.locator("#detail-content").getByRole("button", { name: "Mark unread" }).waitFor();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#detail-content").getByRole("button", { name: "Save Markdown copy" }).click();
  await page.getByText(/changed since you opened it/).waitFor();
  assert.equal(await reopenedMarkdown.inputValue(), "# Draft based on the original revision", "A conflict must keep the pending draft.");
  await page.locator("#detail-dialog .dialog-close button").click();
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await title.click();
  await page.locator("#detail-content").getByText(/Unsaved draft/).waitFor();
  assert.equal(await reopenedMarkdown.inputValue(), "# Draft based on the original revision", "Reopening after a conflict must keep the pending draft.");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#detail-content").getByRole("button", { name: "Save Markdown copy" }).click();
  await page.getByText(/changed since you opened it/).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "Markdown editor must fit a narrow viewport.");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator("#detail-dialog .dialog-close button").click();
  await page.getByRole("button", { name: "All", exact: true }).click();
  await article.getByRole("button", { name: "Mark unread", exact: true }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await title.waitFor();
  await title.click();
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
  assert.match(
    await page.locator("#bookmarklet").getAttribute("href"),
    /^javascript:/,
  );
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
}
