import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { chromium } from "playwright";

const temporary = await mkdtemp(path.join(os.tmpdir(), "potem-prototype-"));
let server, browser;
try {
  // Copy the build to an isolated root so the real .env and article folder are never loaded.
  const bundle = path.join(temporary, "dist", "prototype");
  await cp(path.resolve("dist/prototype"), bundle, { recursive: true });
  const articles = path.join(temporary, "articles");
  await mkdir(articles);
  const fixture = path.join(articles, "typescript.md");
  await writeFile(fixture, '---\ntitle: "TypeScript fixture"\ncategory: "Engineering"\nsource: "https://example.test/article"\nread: false\n---\n# Typed reader\n\nThis **Markdown** stays readable.\n');
  const portServer = net.createServer();
  portServer.listen(0, "127.0.0.1");
  await once(portServer, "listening");
  const port = portServer.address().port;
  await new Promise((resolve, reject) => portServer.close(error => error ? reject(error) : resolve()));
  const base = `http://127.0.0.1:${port}`;
  let output = "";
  server = spawn(process.execPath, [path.join(bundle, "server.mjs")], {
    cwd: temporary,
    env: { PATH: process.env.PATH, NODE_ENV: "test", STORAGE_MODE: "local", HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", chunk => { output += chunk; });
  server.stderr.on("data", chunk => { output += chunk; });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(500) });
      ready = response.ok;
    } catch {}
    if (ready) break;
    if (server.exitCode !== null) throw new Error(`Prototype failed to start: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, "Prototype did not become ready.");
  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { ok: true });
  const session = await (await fetch(`${base}/api/session`)).json();
  assert.equal(session.auth.enabled, false);
  const { articles: listed } = await (await fetch(`${base}/api/articles`)).json();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].title, "TypeScript fixture");
  assert.equal(listed[0].read, false);
  const articlePath = `/api/articles/${encodeURIComponent(listed[0].id)}`;
  const detail = await (await fetch(base + articlePath)).json();
  assert.match(detail.article.content, /\*\*Markdown\*\*/);
  const patch = read => fetch(base + articlePath + "/read", {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ read }),
  });
  const changed = await (await patch(true)).json();
  assert.equal(changed.state.read, true);
  assert.equal(typeof changed.state.readAt, "string");
  assert.match(await readFile(fixture, "utf8"), /read: true/);
  assert.equal((await patch("invalid")).status, 400);
  await patch(false);
  for (const asset of ["/", "/app.js", "/styles.css", "/manifest.webmanifest"]) {
    assert.equal((await fetch(base + asset)).status, 200, `Missing asset ${asset}`);
  }
  assert.equal((await fetch(base + "/app.ts")).status, 404);
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(base);
  await page.getByRole("button", { name: /TypeScript fixture/ }).click();
  await page.locator("#articleContent strong").waitFor();
  assert.equal(await page.locator("#articleContent strong").textContent(), "Markdown");
  await page.locator("#readButton").click();
  await page.waitForFunction(() => document.querySelector("#readButton span")?.textContent === "Mark unread");
  assert.equal((await (await fetch(base + articlePath)).json()).article.read, true);
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#readButton span")?.textContent === "Mark unread");
  assert.deepEqual(errors, []);
  console.log("Prototype smoke passed: isolated default storage, health, article listing/reading, persisted state, assets, and browser reload.");
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill("SIGTERM");
    await exited;
  }
  await rm(temporary, { recursive: true, force: true });
}
