import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { convertGitHubMarkdown } from "./github-convert.mjs";
import { validateBackupEnvelope } from "./archive-backup.mjs";

const project = process.cwd();
const wrangler = path.join(project, "node_modules/wrangler/bin/wrangler.js");
const active = new Set();
let temporary;
function cleanEnvironment() {
  const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "ComSpec", "LANG", "TZ"]
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false"; env.WRANGLER_SEND_METRICS = "false";
  return env;
}
function run(command, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "ignore", detached: true }); active.add(child);
    child.on("error", () => { active.delete(child); reject(new Error("Local Worker integration command failed.")); });
    child.on("exit", code => { active.delete(child); code === 0 ? resolve() : reject(new Error("Local Worker integration command failed.")); });
  });
}
function config(storage, port, entry) {
  return {
    $schema: path.join(project, "node_modules/wrangler/config-schema.json"), name: "github-recovery-integration", main: entry,
    compatibility_date: "2026-08-01", vars: { APP_ORIGIN: `http://127.0.0.1:${port}`, DEV_AUTH_BYPASS: "true" },
    assets: { directory: path.join(project, "dist/web"), binding: "ASSETS", not_found_handling: "single-page-application", run_worker_first: ["/api", "/api/*", "/auth", "/auth/*", "/healthz"] },
    d1_databases: [{ binding: "DB", database_name: "read-later", database_id: "00000000-0000-4000-8000-000000000000", migrations_dir: path.join(project, "migrations") }],
  };
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", error => error ? reject(error) : resolve()));
  const value = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return value;
}
async function waitReady(base, child) {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error("Local Worker failed to start.");
    try { if ((await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(500) })).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error("Local Worker did not become ready.");
}
function startWorker(configPath, storage, port, cwd, env) {
  const child = spawn(process.execPath, [wrangler, "dev", "--local", "--config", configPath, "--ip", "127.0.0.1", "--port", String(port), "--persist-to", storage], { cwd, env, stdio: "ignore", detached: true });
  active.add(child); return child;
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
  if (!response.ok) throw new Error(`Local Worker API integration failed with HTTP ${response.status}.`);
  return response;
}
async function importBatches(base, batches) {
  const output = [];
  for (const batch of batches) output.push(await (await api(base, "/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(batch) })).json());
  return output;
}
async function exportLibrary(base) {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await (await api(base, "/api/export")).arrayBuffer()));
  return validateBackupEnvelope(value);
}
function sorted(value) { return value.articles.slice().sort((a, b) => a.id.localeCompare(b.id)); }
function markdown(record, body) {
  return `---\npotem_backup_version: 1\n${Object.entries(record).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n${body}`;
}
async function put(root, name, content) {
  const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content);
}

async function main() {
  temporary = await mkdtemp(path.join(os.tmpdir(), "github-markdown-recovery-"));
  const source = path.join(temporary, "fixture-articles"); const output = path.join(temporary, "generated");
  const storage = path.join(temporary, "d1"); const configPath = path.join(temporary, "wrangler.jsonc"); const entry = path.join(temporary, "worker.mjs");
  const env = cleanEnvironment(); await mkdir(source);
  const records = [
    { id: "github-existing-conflict", url: "https://example.invalid/keep?utm_source=github", title: "Incoming Ω\n\"quoted\"", author: "Writer Ω", description: "Description\nline", savedAt: "2024-01-02T03:04:05.000Z", capturedAt: "2024-01-03T04:05:06.000Z", source: "paste", revision: "fixture-one" },
    { id: "github-fixture-read", url: "https://example.invalid/read?chapter=one", title: "Read \"article\" Ω\nsecond line", author: "Writer\nΩ", description: "Description: \"quoted\"\nsecond line", savedAt: "2024-02-03T04:05:06.000Z", capturedAt: "2024-02-04T05:06:07.000Z", source: "upload", revision: "fixture-two" },
    { id: "github-fixture-third", url: "https://example.invalid/third", title: "Third article", author: "A Name", description: "Third description", savedAt: "2024-03-04T05:06:07.000Z", capturedAt: "2024-03-05T06:07:08.000Z", source: "paste", revision: "fixture-three" },
  ];
  const bodies = ["# Existing candidate Ω\n\nExact body.\n", "# Read copy\r\n\r\n---\r\nNested frontmatter stays in the body. 📰\r\n", "# Third copy\n\nBody.\n"];
  for (let i = 0; i < records.length; i++) await put(source, `${i + 1}-${i}.md`, markdown(records[i], bodies[i]));
  await put(source, "4-duplicate.markdown", markdown({ ...records[1], id: "duplicate-id", url: "https://example.invalid/read?utm_campaign=duplicate&chapter=one" }, "Duplicate bytes\n"));
  const converted = await convertGitHubMarkdown(source, output, { now: new Date("2026-10-02T00:00:00.000Z") });
  assert.deepEqual([converted.report.eligible, converted.report.duplicates, converted.report.excluded], [3, 1, 0]);
  const batches = [];
  for (const name of (await readdir(output)).filter(name => name.startsWith("import-")).sort()) batches.push(JSON.parse(await readFile(path.join(output, name), "utf8")));
  await run(process.execPath, [path.join(project, "scripts/build-web.mjs")], project, env);
  const listenPort = await freePort(); const baseUrl = `http://127.0.0.1:${listenPort}`;
  await writeFile(entry, `import actual from ${JSON.stringify(path.join(project, "src/worker.ts"))};\nexport default { fetch(request, env, ctx) { return actual.fetch(request, env, ctx); } };\n`, { mode: 0o600 });
  await writeFile(configPath, JSON.stringify(config(storage, listenPort, entry)), { mode: 0o600 }); await mkdir(storage);
  await run(process.execPath, [wrangler, "d1", "migrations", "apply", "read-later", "--local", "--persist-to", storage, "--config", configPath], temporary, env);
  const worker = startWorker(configPath, storage, listenPort, temporary, env);
  try {
    await waitReady(baseUrl, worker);
    const preexisting = { version: 2, exportedAt: "2026-01-02T03:04:05.000Z", articles: [{
      id: "preexisting-record", url: "https://example.invalid/keep?utm_source=prior", title: "Preserved existing title Ω",
      author: "Original author", description: "Original description", createdAt: "2020-01-02T03:04:05.000Z",
      updatedAt: "2021-02-03T04:05:06.000Z", readAt: "2022-03-04T05:06:07.000Z",
      copy: { markdown: "Existing copy Ω\n", capturedAt: "2023-04-05T06:07:08.000Z", source: "paste", revision: "existing-copy" },
    }] };
    await importBatches(baseUrl, [preexisting]); const before = await exportLibrary(baseUrl);
    const first = await importBatches(baseUrl, batches);
    assert.equal(first.reduce((sum, result) => sum + result.imported, 0), 2);
    assert.equal(first.reduce((sum, result) => sum + result.skipped, 0), 1);
    const afterFirst = await exportLibrary(baseUrl);
    const expected = [preexisting.articles[0], ...converted.batches.flatMap(batch => batch.articles).filter(item => item.id !== "github-existing-conflict")];
    assert.deepEqual(sorted(afterFirst), expected.sort((a, b) => a.id.localeCompare(b.id)));
    assert.deepEqual(sorted(afterFirst).find(item => item.id === "preexisting-record"), before.articles[0]);
    const repeats = await importBatches(baseUrl, batches);
    assert.ok(repeats.every(result => result.imported === 0));
    assert.equal(repeats.reduce((sum, result) => sum + result.skipped, 0), 3);
    assert.deepEqual(sorted(await exportLibrary(baseUrl)), sorted(afterFirst));
    process.stdout.write(`${JSON.stringify({ result: "passed", eligible: converted.report.eligible, duplicates: converted.report.duplicates, excluded: converted.report.excluded, firstImport: first, repeatImport: repeats, existingNormalizedUrlPreserved: true, exportedArticleCount: afterFirst.articles.length })}\n`);
  } finally { await stop(worker); }
}
process.once("SIGINT", () => { for (const child of active) try { process.kill(-child.pid, "SIGTERM"); } catch {} });
process.once("SIGTERM", () => { for (const child of active) try { process.kill(-child.pid, "SIGTERM"); } catch {} });
try { await main(); }
catch (error) { process.stderr.write(`GitHub Markdown local Worker/D1 integration failed. ${error.message || "No detail available."}\n`); process.exitCode = 1; }
finally { await Promise.all([...active].map(stop)); if (temporary) await rm(temporary, { recursive: true, force: true }); }
