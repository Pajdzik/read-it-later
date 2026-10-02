import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { chromium } from "playwright";
import { MAX_BACKUP_BYTES, splitImportBatches, summarizeBackup, validateBackupEnvelope } from "./archive-backup.mjs";

const project = process.cwd();
const wrangler = path.join(project, "node_modules/wrangler/bin/wrangler.js");
const fixedTime = "2026-09-30T12:00:00.000Z";
const activeWorkers = new Set();
let activeTemp;
let diagnosticStage = "input validation";

function fixture() {
  const articles = [];
  const paragraph = "Preserved archive rehearsal — naïve café 雪 Ω. Quotes: \\\"quoted text\\\"; line break follows.\n".repeat(440);
  for (let i = 0; i < 30; i++) {
    const n = String(i).padStart(3, "0");
    const item = {
      id: `archive-fixture-${n}`,
      url: `https://archive-fixture.invalid/articles/${n}`,
      title: `Restore rehearsal ${n} — Ω`,
      author: i % 3 === 0 ? "Writer Ω" : null,
      description: i % 4 === 0 ? "Quoted description: \"archive\"" : null,
      createdAt: new Date(Date.parse(fixedTime) - i * 60000).toISOString(),
      updatedAt: new Date(Date.parse(fixedTime) - i * 30000).toISOString(),
      readAt: i % 3 === 0 ? fixedTime : null,
    };
    if (i < 28) {
      const source = i % 2 === 0 ? "paste" : "upload";
      item.copy = {
        markdown: `# Preserved Unicode Ω — ${n}\n\n${paragraph}\n| Item | Value |\n| --- | --- |\n| ${n} | 雪 |\n`,
        capturedAt: fixedTime,
        source,
        revision: `revision-${n}`,
      };
    }
    articles.push(item);
  }
  return { version: 2, exportedAt: fixedTime, articles };
}

function parseArgs(args) {
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!["--backup", "--report"].includes(key) || values[key]) throw new Error("Invalid command options.");
    const value = args[++i];
    if (!value || value.startsWith("--") || !path.isAbsolute(value)) throw new Error("Invalid command options.");
    values[key] = value;
  }
  return values;
}

function cleanEnvironment() {
  const env = { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false", WRANGLER_SEND_METRICS: "false" };
  for (const key of Object.keys(env)) {
    if (/^(?:GITHUB_|CLOUDFLARE_|CF_|AWS_|AZURE_|GOOGLE_|OAUTH_|OWNER_GITHUB_ID$)/i.test(key)) delete env[key];
  }
  env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";
  env.WRANGLER_SEND_METRICS = "false";
  return env;
}

function command(args, cwd, env, { quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrangler, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    activeWorkers.add(child);
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.on("error", () => { activeWorkers.delete(child); reject(new Error("Local rehearsal command failed.")); });
    child.on("exit", code => { activeWorkers.delete(child); code === 0 ? resolve(quiet ? undefined : output) : reject(new Error("Local rehearsal command failed.")); });
  });
}

function makeFixtureConfig(storage, port, wrapperPath) {
  return {
    $schema: path.join(project, "node_modules/wrangler/config-schema.json"),
    name: "archive-restore-rehearsal",
    main: wrapperPath,
    compatibility_date: "2026-08-01",
    vars: { APP_ORIGIN: `http://127.0.0.1:${port}`, DEV_AUTH_BYPASS: "true" },
    assets: {
      directory: path.join(project, "dist/web"), binding: "ASSETS",
      not_found_handling: "single-page-application",
      run_worker_first: ["/api", "/api/*", "/auth", "/auth/*", "/healthz", "/_local/*"],
    },
    d1_databases: [{ binding: "DB", database_name: "read-later", database_id: "00000000-0000-4000-8000-000000000000", migrations_dir: path.join(project, "migrations") }],
  };
}

async function getPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", error => error ? reject(error) : resolve()));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForWorker(base, child) {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error("Local Worker failed to start.");
    try {
      const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error("Local Worker did not become ready.");
}

function runNodeScript(script, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(project, script)], { cwd, env, stdio: "ignore", detached: true });
    activeWorkers.add(child);
    child.on("error", () => { activeWorkers.delete(child); reject(new Error("Local rehearsal setup failed.")); });
    child.on("exit", code => { activeWorkers.delete(child); code === 0 ? resolve() : reject(new Error("Local rehearsal setup failed.")); });
  });
}

function startWorker(configPath, storage, port, cwd, env) {
  const child = spawn(process.execPath, [wrangler, "dev", "--local", "--config", configPath, "--ip", "127.0.0.1", "--port", String(port), "--persist-to", storage], {
    cwd, env, stdio: "ignore", detached: true,
  });
  activeWorkers.add(child);
  return child;
}

async function stopWorker(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) { if (child) activeWorkers.delete(child); return; }
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      resolve();
    }, 5000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  });
  activeWorkers.delete(child);
}

async function handleSignal(code) {
  await Promise.all([...activeWorkers].map(stopWorker));
  if (activeTemp) await rm(activeTemp, { recursive: true, force: true }).catch(() => {});
  process.exit(code);
}
process.once("SIGINT", () => { void handleSignal(130); });
process.once("SIGTERM", () => { void handleSignal(143); });

async function migrate(configPath, storage, cwd, env) {
  await command(["d1", "migrations", "apply", "read-later", "--local", "--persist-to", storage, "--config", configPath], cwd, env, { quiet: true });
}

async function api(base, route, init = {}) {
  const response = await fetch(`${base}${route}`, {
    ...init,
    headers: { Origin: base, "X-CSRF-Token": "dev-bypass", ...(init.headers || {}) },
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("Local archive API check failed.");
  return response;
}

async function importAll(base, input, batches) {
  let imported = 0;
  let skipped = 0;
  for (const batch of batches) {
    const response = await api(base, "/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(batch) });
    const result = await response.json();
    if (!Number.isSafeInteger(result.imported) || !Number.isSafeInteger(result.skipped)) throw new Error("Local archive import failed.");
    imported += result.imported;
    skipped += result.skipped;
  }
  if (imported + skipped !== input.articles.length || skipped !== 0) throw new Error("Archive import was incomplete.");
  return { imported, skipped };
}

async function exportLibrary(base) {
  const response = await api(base, "/api/export");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_BACKUP_BYTES) throw new Error("Canonical export exceeds the supported backup size.");
  let parsed;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("Canonical export could not be read."); }
  return { bytes, envelope: validateBackupEnvelope(parsed) };
}

function sortedLibrary(envelope) {
  return envelope.articles.slice().sort((a, b) => a.id.localeCompare(b.id));
}

async function measuredDatabaseBytes(base) {
  const response = await fetch(`${base}/_local/archive-rehearsal-size`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error("Local D1 did not return storage measurement metadata.");
  const result = await response.json();
  const size = result.sizeAfter;
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Local D1 did not return storage measurement metadata.");
  return size;
}

async function verifyReader(base, envelope, temporary) {
  const copies = [];
  for (const source of ["paste", "upload"]) {
    const sample = envelope.articles.find(item => item.copy?.source === source);
    if (sample) copies.push(sample);
  }
  if (!copies.length) return 0;
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
    const blocked = [];
    await context.route("**/*", async route => {
      if (new URL(route.request().url()).origin === base) return route.continue();
      blocked.push(route.request().url());
      return route.abort();
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(base);
    await page.locator("#logout").waitFor();
    await page.getByRole("button", { name: "All", exact: true }).click();
    for (let index = 0; index < copies.length; index++) {
      const sample = copies[index];
      const searchTerm = sample.title.split(/\r?\n/).find(line => line.trim())?.trim() || sample.title.trim();
      diagnosticStage = "reader list search";
      const searchWait = page.waitForResponse(response => {
        if (!response.url().includes("/api/articles?")) return false;
        try { return new URL(response.url()).searchParams.get("q") === searchTerm; } catch { return false; }
      });
      await page.locator("#search").fill(searchTerm);
      await searchWait;
      await page.locator("#loading").waitFor({ state: "hidden" });
      let rowIndex = await page.locator("#articles .article").evaluateAll((rows, id) => rows.findIndex(row => row.dataset.id === id), sample.id);
      while (rowIndex < 0 && !(await page.locator("#more").isHidden())) {
        const pageWait = page.waitForResponse(response => {
          if (!response.url().includes("/api/articles?")) return false;
          const url = new URL(response.url());
          return url.searchParams.get("q") === searchTerm && url.searchParams.has("cursor");
        });
        await page.locator("#more").click();
        await pageWait;
        await page.locator("#loading").waitFor({ state: "hidden" });
        rowIndex = await page.locator("#articles .article").evaluateAll((rows, id) => rows.findIndex(row => row.dataset.id === id), sample.id);
      }
      assert.ok(rowIndex >= 0, "The copied article should be reachable through the reader list.");
      const row = page.locator("#articles .article").nth(rowIndex);
      const title = row.locator(".article-title");
      const originalReadClass = await row.getAttribute("class");
      const articleBefore = await (await api(base, `/api/articles/${encodeURIComponent(sample.id)}`)).json();
      await title.click();
      diagnosticStage = "reader open";
      const detail = page.locator("#detail-content");
      await detail.getByRole("button", { name: "Read saved copy", exact: true }).waitFor();
      const savedActions = detail.getByRole("button", { name: "Read saved copy", exact: true });
      await savedActions.click();
      const reader = page.locator("#reader-dialog");
      await reader.locator("#reader-title").waitFor();
      assert.equal(await reader.locator("#reader-title").textContent(), sample.title);
      assert.ok(await reader.locator("#reader-body").evaluate(body => body.childElementCount > 0 || body.textContent.trim().length > 0), "Persisted Markdown should render readable content.");
      await page.keyboard.press("Escape");
      await reader.waitFor({ state: "hidden" });
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Read saved copy", "Escape should return focus to the reader trigger.");
      const downloadPromise = page.waitForEvent("download");
      diagnosticStage = "Markdown download";
      await detail.getByRole("button", { name: "Download Markdown", exact: true }).click();
      const download = await downloadPromise;
      const downloadPath = path.join(temporary, `reader-sample-${index}.md`);
      await download.saveAs(downloadPath);
      const content = await readFile(downloadPath, "utf8");
      const metadata = [
        "---",
        `title: ${JSON.stringify(sample.title)}`,
        `url: ${JSON.stringify(sample.url)}`,
        `capturedAt: ${JSON.stringify(sample.copy.capturedAt)}`,
        `source: ${JSON.stringify(sample.copy.source)}`,
        `revision: ${JSON.stringify(sample.copy.revision)}`,
        "---", "", "",
      ].join("\n");
      assert.equal(content, metadata + sample.copy.markdown, "Downloaded frontmatter and Markdown body should exactly match the persisted copy.");
      await page.locator("#detail-dialog .dialog-close button").click();
      await title.waitFor();
      assert.equal(await row.getAttribute("class"), originalReadClass, "Reading or downloading must not change read state.");
      const articleAfter = await (await api(base, `/api/articles/${encodeURIComponent(sample.id)}`)).json();
      assert.equal(articleAfter.article.readAt, articleBefore.article.readAt, "Reading and downloading must preserve readAt in D1.");
      await page.locator("#search").fill("");
    }
    assert.deepEqual(blocked, [], "The restore reader should not request external resources.");
    assert.deepEqual(errors, [], "The restored reader should not raise browser errors.");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "The restored reader should fit a phone viewport.");
    await context.close();
    return copies.length;
  } finally {
    await browser.close();
  }
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  let input;
  let inputBytes;
  if (options["--backup"]) {
    const backupPath = options["--backup"];
    const info = await stat(backupPath);
    if (!info.isFile() || info.size > MAX_BACKUP_BYTES) throw new Error("Invalid backup file.");
    const bytes = await readFile(backupPath);
    if (bytes.byteLength > MAX_BACKUP_BYTES) throw new Error("Invalid backup file.");
    inputBytes = bytes.byteLength;
    try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new Error("Invalid backup file."); }
    validateBackupEnvelope(input);
  } else {
    input = fixture();
    inputBytes = Buffer.byteLength(JSON.stringify(input), "utf8");
    validateBackupEnvelope(input);
  }
  const inputSummary = summarizeBackup(input);
  const sourceBatches = splitImportBatches(input);
  const temp = await mkdtemp(path.join(os.tmpdir(), "read-later-archive-rehearsal-"));
  activeTemp = temp;
  const env = cleanEnvironment();
  let sourceWorker;
  let reportHandle;
  try {
    const sourceStorage = path.join(temp, "source");
    const restoreStorage = path.join(temp, "restore");
    const sourceConfig = path.join(temp, "source.wrangler.jsonc");
    const restoreConfig = path.join(temp, "restore.wrangler.jsonc");
    const sourceWorkerEntry = path.join(temp, "source-worker.mjs");
    const restoreWorkerEntry = path.join(temp, "restore-worker.mjs");
    await runNodeScript("scripts/build-web.mjs", project, env);
    diagnosticStage = "temporary Worker and D1 setup";
    const sourcePort = await getPort();
    const restorePort = await getPort();
    const sourceBase = `http://127.0.0.1:${sourcePort}`;
    const restoreBase = `http://127.0.0.1:${restorePort}`;
    const workerWrapper = `import actual from ${JSON.stringify(path.join(project, "src/worker.ts"))};\nexport default { async fetch(request, env, ctx) { if (new URL(request.url).pathname === "/_local/archive-rehearsal-size") { const result = await env.DB.prepare("SELECT 1 AS archive_rehearsal_probe").all(); return Response.json({ sizeAfter: result.meta?.size_after ?? null }); } return actual.fetch(request, env, ctx); } };\n`;
    await writeFile(sourceWorkerEntry, workerWrapper, { mode: 0o600 });
    await writeFile(restoreWorkerEntry, workerWrapper, { mode: 0o600 });
    await writeFile(sourceConfig, JSON.stringify(makeFixtureConfig(sourceStorage, sourcePort, sourceWorkerEntry)), { mode: 0o600 });
    await writeFile(restoreConfig, JSON.stringify(makeFixtureConfig(restoreStorage, restorePort, restoreWorkerEntry)), { mode: 0o600 });
    await Promise.all([mkdir(sourceStorage), mkdir(restoreStorage)]);
    await Promise.all([migrate(sourceConfig, sourceStorage, temp, env), migrate(restoreConfig, restoreStorage, temp, env)]);
    sourceWorker = startWorker(sourceConfig, sourceStorage, sourcePort, temp, env);
    await waitForWorker(sourceBase, sourceWorker);
    diagnosticStage = "source backup import";
    await importAll(sourceBase, input, sourceBatches);
    const canonical = await exportLibrary(sourceBase);
    const canonicalBatches = splitImportBatches(canonical.envelope);
    await stopWorker(sourceWorker);
    sourceWorker = undefined;
    let restoreWorker = startWorker(restoreConfig, restoreStorage, restorePort, temp, env);
    try {
      await waitForWorker(restoreBase, restoreWorker);
      diagnosticStage = "fresh D1 restore";
      const restoreResult = await importAll(restoreBase, canonical.envelope, canonicalBatches);
      const restored = await exportLibrary(restoreBase);
      assert.equal(restored.envelope.version, canonical.envelope.version);
      assert.deepEqual(sortedLibrary(restored.envelope), sortedLibrary(canonical.envelope));
      let reimported = 0;
      for (const batch of canonicalBatches) {
        const result = await (await api(restoreBase, "/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(batch) })).json();
        reimported += result.imported;
        if (result.imported !== 0 || result.skipped !== batch.articles.length) throw new Error("Archive repeat-import idempotency failed.");
      }
      const afterRepeatImport = await exportLibrary(restoreBase);
      assert.deepEqual(sortedLibrary(afterRepeatImport.envelope), sortedLibrary(restored.envelope));
      diagnosticStage = "restored reader verification";
      const readerSamples = await verifyReader(restoreBase, restored.envelope, temp);
      const restoredDatabaseBytes = await measuredDatabaseBytes(restoreBase);
      diagnosticStage = "report";
      const output = {
        result: "passed",
        articleCount: inputSummary.articleCount,
        readCount: inputSummary.readCount,
        unreadCount: inputSummary.unreadCount,
        copyCount: inputSummary.copyCount,
        pasteCopyCount: inputSummary.pasteCopyCount,
        uploadCopyCount: inputSummary.uploadCopyCount,
        actualInputBytes: inputBytes,
        compactInputJsonBytes: inputSummary.compactJsonBytes,
        canonicalJsonBytes: canonical.bytes.byteLength,
        markdownBytes: inputSummary.markdownBytes,
        maximumMarkdownBytes: inputSummary.maximumMarkdownBytes,
        inputBatchCount: sourceBatches.length,
        canonicalBatchCount: canonicalBatches.length,
        readerSampleCount: readerSamples,
        importedArticleCount: restoreResult.imported,
        repeatImportCount: reimported,
        restoredLocalD1SizeAfterBytes: restoredDatabaseBytes,
        measurement: "Local D1 result metadata size_after; rehearsal measurement only.",
        checks: { importsComplete: true, canonicalFieldsMatch: true, repeatImportIdempotent: true, readerDownload: readerSamples ? "passed" : "skipped-no-copies" },
      };
      if (options["--report"]) {
        const reportPath = options["--report"];
        if (options["--backup"] && path.resolve(reportPath) === path.resolve(options["--backup"])) throw new Error("Report path conflicts with input.");
        try { reportHandle = await open(reportPath, "wx", 0o600); }
        catch { throw new Error("Report file could not be created safely."); }
        await reportHandle.writeFile(`${JSON.stringify(output, null, 2)}\n`, "utf8");
        await reportHandle.close();
        reportHandle = undefined;
      }
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    } finally {
      await stopWorker(restoreWorker);
    }
  } finally {
    await stopWorker(sourceWorker);
    await Promise.all([...activeWorkers].map(stopWorker));
    if (reportHandle) await reportHandle.close().catch(() => {});
    await rm(temp, { recursive: true, force: true });
    activeTemp = undefined;
  }
}

run().catch(() => {
  process.stderr.write(`Archive rehearsal failed during ${diagnosticStage}. No backup content or paths were displayed.\n`);
  process.exitCode = 1;
});
