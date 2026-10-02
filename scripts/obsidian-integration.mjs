import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { convertVault } from "./obsidian-convert.ts";
import { validateBackupEnvelope } from "./archive-backup.ts";

const project = process.cwd();
const wrangler = path.join(project, "node_modules/wrangler/bin/wrangler.js");
const active = new Set();
let temporary;

function cleanEnvironment() {
  const env = { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false", WRANGLER_SEND_METRICS: "false" };
  for (const key of Object.keys(env)) if (/^(?:GITHUB_|CLOUDFLARE_|CF_|AWS_|AZURE_|GOOGLE_|OAUTH_|OWNER_GITHUB_ID$)/i.test(key)) delete env[key];
  env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";
  env.WRANGLER_SEND_METRICS = "false";
  return env;
}
function run(command, args, cwd, env, quiet = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", quiet ? "ignore" : "pipe", quiet ? "ignore" : "pipe"], detached: true });
    active.add(child);
    let output = "";
    if (!quiet) {
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { output += chunk; });
    }
    child.on("error", () => { active.delete(child); reject(new Error("Local Worker integration command failed.")); });
    child.on("exit", code => { active.delete(child); code === 0 ? resolve(output) : reject(new Error("Local Worker integration command failed.")); });
  });
}
function config(storage, port, entry) {
  return {
    $schema: path.join(project, "node_modules/wrangler/config-schema.json"),
    name: "obsidian-import-integration",
    main: entry,
    compatibility_date: "2026-08-01",
    vars: { APP_ORIGIN: "http://127.0.0.1:" + port, DEV_AUTH_BYPASS: "true" },
    assets: { directory: path.join(project, "dist/web"), binding: "ASSETS", not_found_handling: "single-page-application", run_worker_first: ["/api", "/api/*", "/auth", "/auth/*", "/healthz"] },
    d1_databases: [{ binding: "DB", database_name: "read-later", database_id: "00000000-0000-4000-8000-000000000000", migrations_dir: path.join(project, "migrations") }],
  };
}
async function port() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", error => error ? reject(error) : resolve()));
  const result = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return result;
}
async function waitReady(base, child) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error("Local Worker failed to start.");
    try { if ((await fetch(base + "/healthz", { signal: AbortSignal.timeout(500) })).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error("Local Worker did not become ready.");
}
function startWorker(configPath, storage, listenPort, cwd, env) {
  const child = spawn(process.execPath, [wrangler, "dev", "--local", "--config", configPath, "--ip", "127.0.0.1", "--port", String(listenPort), "--persist-to", storage], { cwd, env, stdio: "ignore", detached: true });
  active.add(child);
  return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) { if (child) active.delete(child); return; }
  await new Promise(resolve => {
    const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } resolve(); }, 5000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  });
  active.delete(child);
}
async function api(base, route, init = {}) {
  const response = await fetch(base + route, { ...init, headers: { Origin: base, "X-CSRF-Token": "dev-bypass", ...(init.headers || {}) }, cache: "no-store", signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error("Local Worker API integration failed with HTTP " + response.status + ".");
  return response;
}
async function importBatches(base, batches) {
  const counts = [];
  for (const batch of batches) {
    const response = await api(base, "/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(batch) });
    counts.push(await response.json());
  }
  return counts;
}
async function exportLibrary(base) {
  const response = await api(base, "/api/export");
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await response.arrayBuffer()));
  return validateBackupEnvelope(value);
}
function sorted(value) { return value.articles.slice().sort((a, b) => a.id.localeCompare(b.id)); }
async function write(vault, name, value) {
  const file = path.join(vault, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, value);
}

async function main() {
  temporary = await mkdtemp(path.join(os.tmpdir(), "obsidian-import-integration-"));
  const vault = path.join(temporary, "fixture-vault");
  const output = path.join(temporary, "generated");
  const storage = path.join(temporary, "d1");
  const configPath = path.join(temporary, "wrangler.jsonc");
  const entry = path.join(temporary, "worker.mjs");
  const env = cleanEnvironment();
  await mkdir(vault);
  const conflictUrl = "https://example.invalid/keep?utm_source=obsidian";
  await write(vault, "01-conflict.md", "---\nsource: " + conflictUrl + "\ntitle: Converted title\ncreated: 2024-01-02\nread: false\n---\n# Converted copy\n\nNew copy.\n");
  await write(vault, "02-read.md", "---\nsource: https://example.invalid/read\ntitle: \"Read Ω\"\ncreated: 2024-03-04\nread: true\nreadAt: 2024-05-06T08:09:10+02:00\nauthor: \"[[A Name|Label]]\"\ndescription: Desc\n---\n# Saved body Ω\n\nText.\n");
  await write(vault, "03-link-only.md", "---\nsource: https://example.invalid/empty\nread: no\n---\n\n");
  await write(vault, "04-duplicate.md", "---\nsource: https://example.invalid/read?utm_campaign=duplicate\nread: false\n---\nwrong winner\n");
  await write(vault, "05-invalid.md", "---\nsource: not a URL\nread: false\n---\nExcluded.\n");
  const converted = await convertVault(vault, output);
  assert.deepEqual([converted.report.eligible, converted.report.duplicates, converted.report.excluded, converted.report.read, converted.report.unread, converted.report.copied, converted.report.linkOnly], [3, 1, 1, 1, 2, 2, 1]);
  const batchNames = (await readdir(output)).filter(name => name.startsWith("import-")).sort();
  const batches = [];
  for (const name of batchNames) batches.push(JSON.parse(await readFile(path.join(output, name), "utf8")));
  await run(process.execPath, ["--import", "tsx", path.join(project, "scripts/build-web.ts")], project, env, true);
  const listenPort = await port();
  const base = "http://127.0.0.1:" + listenPort;
  const wrapper = "import actual from " + JSON.stringify(path.join(project, "src/worker.ts")) + ";\nexport default { fetch(request, env, ctx) { return actual.fetch(request, env, ctx); } };\n";
  await writeFile(entry, wrapper, { mode: 0o600 });
  await writeFile(configPath, JSON.stringify(config(storage, listenPort, entry)), { mode: 0o600 });
  await mkdir(storage);
  await run(process.execPath, [wrangler, "d1", "migrations", "apply", "read-later", "--local", "--persist-to", storage, "--config", configPath], temporary, env, true);
  const worker = startWorker(configPath, storage, listenPort, temporary, env);
  try {
    await waitReady(base, worker);
    const preexisting = {
      version: 2, exportedAt: "2026-01-02T03:04:05.000Z", articles: [{
        id: "existing-conflict-id", url: "https://example.invalid/keep?utm_source=prior", title: "Preserved existing title",
        author: "Existing author", description: "Existing description", createdAt: "2020-01-01T00:00:00.000Z",
        updatedAt: "2021-02-03T04:05:06.000Z", readAt: "2022-03-04T05:06:07.000Z",
        copy: { markdown: "Existing bytes Ω\n", capturedAt: "2026-01-02T03:04:05.000Z", source: "paste", revision: "existing-revision" },
      }],
    };
    await importBatches(base, [preexisting]);
    const before = await exportLibrary(base);
    const firstCounts = await importBatches(base, batches);
    assert.equal(firstCounts.reduce((sum, count) => sum + count.imported, 0), 2);
    assert.equal(firstCounts.reduce((sum, count) => sum + count.skipped, 0), 1);
    const afterFirst = await exportLibrary(base);
    const expected = new Map();
    for (const item of preexisting.articles) expected.set(item.id, item);
    for (const batch of batches) for (const item of batch.articles) if (item.url.includes("/read") || item.url.includes("/empty")) expected.set(item.id, item);
    assert.deepEqual(sorted(afterFirst), [...expected.values()].sort((a, b) => a.id.localeCompare(b.id)));
    assert.deepEqual(sorted(afterFirst).find(item => item.id === "existing-conflict-id"), before.articles[0]);
    const repeatCounts = await importBatches(base, batches);
    assert.ok(repeatCounts.every(count => count.imported === 0));
    assert.equal(repeatCounts.reduce((sum, count) => sum + count.skipped, 0), 3);
    assert.deepEqual(sorted(await exportLibrary(base)), sorted(afterFirst));
    process.stdout.write(JSON.stringify({ result: "passed", eligible: converted.report.eligible, duplicates: converted.report.duplicates, excluded: converted.report.excluded, firstImport: firstCounts, repeatImport: repeatCounts, existingConflictPreserved: true, exportedArticleCount: afterFirst.articles.length }) + "\n");
  } finally { await stop(worker); }
}

process.once("SIGINT", () => { for (const child of active) try { process.kill(-child.pid, "SIGTERM"); } catch {} });
process.once("SIGTERM", () => { for (const child of active) try { process.kill(-child.pid, "SIGTERM"); } catch {} });
try { await main(); }
catch (error) {
  process.stderr.write("Obsidian local Worker/D1 integration failed. " + (error.message || "No detail available.") + "\n");
  process.exitCode = 1;
} finally {
  await Promise.all([...active].map(stop));
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
