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
        health.ok && home.ok && html.includes("Potem — your reading list");
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
  await article.getByRole("button", { name: "Mark read", exact: true }).click();
  await article
    .getByRole("button", { name: "Mark unread", exact: true })
    .waitFor();
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
  await page.locator("#detail-content input").fill("Failed edit");
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
