import assert from "node:assert/strict";
import { after, test } from "node:test";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseGitHubMarkdown, convertGitHubMarkdown, MAX_SOURCE_FILE_BYTES } from "./github-convert.mjs";
import { splitImportBatches, validateBackupEnvelope } from "./archive-backup.mjs";

const temporaryDirs = [];
async function temp() { const dir = await mkdtemp(path.join(os.tmpdir(), "potem-github-convert-")); temporaryDirs.push(dir); return dir; }
after(async () => Promise.all(temporaryDirs.map(dir => rm(dir, { recursive: true, force: true }))));
const base = {
  id: "opaque/ID/%2e%2e-01", title: "title with \"quotes\", newline\nand Ω",
  url: "https://Example.com:443/path?q=one%20two&utm_source=test#fragment", author: "A\nName Ω", description: null,
  savedAt: "2026-01-02T03:04:05.000Z", capturedAt: "2026-02-03T04:05:06.000Z", source: "upload", revision: "rev_01-A",
};
function writerText(meta = base, body = "# exact Ω body\r\n\r\n---\r\nbody frontmatter\n") {
  return `---\npotem_backup_version: 1\n${Object.entries(meta).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n${body}`;
}
function paths(root, name = "a.md") { return path.join(root, name); }
async function put(root, name, value) { const file = paths(root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, value); return file; }
function cli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("scripts/github-convert.mjs"), ...args], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR } });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject); child.on("exit", code => resolve({ code, stdout, stderr }));
  });
}

test("recovers exact JSON scalar metadata and body, including BOM, CRLF headers and nested frontmatter", () => {
  const source = writerText();
  const split = source.indexOf("\n---\n", 4);
  const text = source.slice(0, split + 1).replaceAll("\n", "\r\n") + source.slice(split + 1);
  const parsed = parseGitHubMarkdown(Buffer.from(`\uFEFF${text}`, "utf8"));
  assert.equal(parsed.item.id, base.id);
  assert.equal(parsed.item.title, base.title);
  assert.equal(parsed.item.author, base.author);
  assert.equal(parsed.item.description, null);
  assert.equal(parsed.item.createdAt, base.savedAt);
  assert.equal(parsed.item.updatedAt, base.savedAt);
  assert.equal(parsed.item.readAt, null);
  assert.equal(parsed.item.copy.markdown, "# exact Ω body\r\n\r\n---\r\nbody frontmatter\n");
  assert.equal(parsed.item.copy.capturedAt, base.capturedAt);
  assert.equal(parsed.item.copy.source, base.source);
  assert.equal(parsed.item.copy.revision, base.revision);
  assert.equal(parsed.normalizedUrl, "https://example.com/path?q=one%20two");
});

test("rejects missing, duplicate, unknown, malformed, non-scalar and unsupported headers", () => {
  for (const text of [
    "plain text",
    writerText().replace("revision: \"rev_01-A\"\n", ""),
    writerText().replace("revision: \"rev_01-A\"", "revision: \"one\"\nrevision: \"two\""),
    writerText().replace("revision: \"rev_01-A\"", "extra: \"unknown\"\nrevision: \"rev_01-A\""),
    writerText().replace("title: \"title with \\\"quotes\\\", newline\\nand Ω\"", "title: [not, scalar]"),
    writerText().replace("potem_backup_version: 1", "potem_backup_version: 2"),
    "---\npotem_backup_version: 1\nid: \"no close\"\n",
  ]) assert.throws(() => parseGitHubMarkdown(text));
  assert.throws(() => parseGitHubMarkdown(Buffer.from([0xff, 0xfe])), /invalid_utf8/);
});

test("enforces metadata, canonical timestamps, URL safety and Markdown limits", () => {
  for (const meta of [
    { ...base, id: "" }, { ...base, id: "x".repeat(129) }, { ...base, title: "  " }, { ...base, title: "x".repeat(501) },
    { ...base, author: " " }, { ...base, author: "x".repeat(201) }, { ...base, description: "x".repeat(501) },
    { ...base, url: "javascript:alert(1)" }, { ...base, url: "https://user:pass@example.com/" },
    { ...base, url: `https://example.com/${"x".repeat(8200)}` }, { ...base, savedAt: "2026-02-30T00:00:00.000Z" },
    { ...base, savedAt: "2026-01-02T03:04:05Z" }, { ...base, capturedAt: "2026-01-02T03:04:05.001+00:00" },
    { ...base, source: "github" }, { ...base, revision: "bad revision" },
  ]) assert.throws(() => parseGitHubMarkdown(writerText(meta)), undefined, JSON.stringify(meta));
  assert.throws(() => parseGitHubMarkdown(writerText(base, "\n \t")), /empty_copy_body/);
  assert.throws(() => parseGitHubMarkdown(writerText(base, "é".repeat(131073))), /copy_body_too_large/);
});

test("uses sorted normalized URL winner, then excludes a conflicting ID on a different URL", async () => {
  const root = await temp(); const source = path.join(root, "source"); const output = path.join(root, "out"); await mkdir(source);
  await put(source, "z-duplicate.markdown", writerText({ ...base, id: "another-id", url: "https://example.com/path?q=one%20two&utm_campaign=x" }));
  await put(source, "b-conflict.md", writerText({ ...base, url: "https://different.example/a" }));
  await put(source, "a-winner.md", writerText());
  const { report, batches } = await convertGitHubMarkdown(source, output, { now: new Date("2026-10-02T00:00:00.000Z") });
  assert.deepEqual([report.discovered, report.eligible, report.duplicates, report.excluded, report.copied, report.unread, report.batchCount], [3, 1, 1, 1, 1, 1, 1]);
  assert.deepEqual(report.outcomes.map(item => [item.path, item.outcome, item.winner]), [
    ["a-winner.md", "eligible", undefined], ["b-conflict.md", "excluded", "a-winner.md"], ["z-duplicate.markdown", "duplicate", "a-winner.md"],
  ]);
  assert.deepEqual(report.outcomes[0].warnings, ["read_state_not_backed_up"]);
  assert.deepEqual(batches[0].articles[0], parseGitHubMarkdown(writerText()).item);
  assert.equal(JSON.stringify(report).includes("example.com"), false);
  assert.equal(JSON.stringify(report).includes("title with"), false);
});

test("invalid or oversized records never claim IDs or URLs", async () => {
  const root = await temp(); const source = path.join(root, "source"); const output = path.join(root, "out"); await mkdir(source);
  await put(source, "a-invalid.md", writerText({ ...base, title: "" }));
  await put(source, "b-good.md", writerText());
  const result = await convertGitHubMarkdown(source, output);
  assert.equal(result.report.eligible, 1);
  assert.equal(result.report.excluded, 1);
});

test("skips hidden directories, records symlinks, preserves source and writes private bounded batches", async () => {
  const root = await temp(); const source = path.join(root, "source"); const output = path.join(root, "out"); await mkdir(source);
  const original = writerText(); await put(source, "nested/a.md", original); await put(source, ".hidden/hidden.md", writerText({ ...base, id: "hidden" }));
  await symlink(paths(source, "nested/a.md"), paths(source, "link.md"));
  const before = await readFile(paths(source, "nested/a.md"));
  const result = await convertGitHubMarkdown(source, output);
  assert.equal((await readFile(paths(source, "nested/a.md"))).compare(before), 0);
  assert.deepEqual(result.report.skippedSymlinks, ["link.md"]);
  const outStat = await stat(output); assert.equal(outStat.mode & 0o777, 0o700);
  for (const name of await readdir(output)) assert.equal((await stat(paths(output, name))).mode & 0o777, 0o600);
  const batch = JSON.parse(await readFile(paths(output, "import-001.json"), "utf8"));
  validateBackupEnvelope(batch); assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= 1024 * 1024);
});

test("refuses existing destinations and any output overlapping the source tree", async () => {
  const root = await temp(); const source = path.join(root, "source"); await mkdir(source); await put(source, "a.md", writerText());
  await assert.rejects(convertGitHubMarkdown(source, path.join(source, "out")), /outside_source_tree/);
  const existing = path.join(root, "existing"); await mkdir(existing);
  await assert.rejects(convertGitHubMarkdown(source, existing), /destination_exists/);
  const link = path.join(root, "output-link"); await symlink(existing, link);
  await assert.rejects(convertGitHubMarkdown(source, link), /destination_exists/);
});

test("handles empty conversion and per-file source size bounds", async () => {
  const root = await temp(); const source = path.join(root, "source"); const output = path.join(root, "out"); await mkdir(source);
  await put(source, "empty.md", "\xff");
  await put(source, "large.md", "x".repeat(MAX_SOURCE_FILE_BYTES + 1));
  const result = await convertGitHubMarkdown(source, output);
  assert.deepEqual([result.report.discovered, result.report.eligible, result.report.excluded, result.report.batchCount], [2, 0, 2, 0]);
  assert.deepEqual((await readdir(output)).sort(), ["report.json"]);
});

test("aborts before publishing output at candidate and aggregate read bounds", async () => {
  const root = await temp(); const source = path.join(root, "many"); const output = path.join(root, "many-output"); await mkdir(source);
  for (let i = 0; i <= 10_000; i++) await writeFile(paths(source, `${String(i).padStart(5, "0")}.md`), "");
  await assert.rejects(convertGitHubMarkdown(source, output), /candidate_file_limit_exceeded/);
  await assert.rejects(stat(output));

  const source2 = path.join(root, "aggregate"); const output2 = path.join(root, "aggregate-output"); await mkdir(source2);
  const chunk = Buffer.alloc(MAX_SOURCE_FILE_BYTES, 0x20);
  for (let i = 0; i < 65; i++) await writeFile(paths(source2, `${String(i).padStart(2, "0")}.md`), chunk);
  await assert.rejects(convertGitHubMarkdown(source2, output2), /aggregate_source_size_limit_exceeded/);
  await assert.rejects(stat(output2));
});

test("splits output at limits without splitting records and excludes an individually oversized JSON record", async () => {
  const root = await temp(); const source = path.join(root, "source"); const output = path.join(root, "out"); await mkdir(source);
  for (let i = 0; i < 6; i++) await put(source, `item-${i}.md`, writerText({ ...base, id: `article-${i}`, url: `https://example.com/${i}` }, "x".repeat(190_000)));
  await put(source, "oversized-escaped.md", writerText({ ...base, id: "too-large", url: "https://example.com/big" }, "\0".repeat(200_000)));
  const result = await convertGitHubMarkdown(source, output);
  assert.equal(result.report.eligible, 6); assert.equal(result.report.excluded, 1); assert.equal(result.report.batchCount, 2);
  assert.ok(result.batches.every(batch => batch.articles.length <= 1000 && Buffer.byteLength(JSON.stringify(batch)) <= 1024 * 1024));
  assert.deepEqual(result.batches.flatMap(batch => batch.articles.map(item => item.id)), ["article-0", "article-1", "article-2", "article-3", "article-4", "article-5"]);
  assert.ok(result.report.outcomes.find(item => item.path === "oversized-escaped.md").reasons.includes("import_record_too_large"));
});

test("round trips the actual articleMarkdown writer through the converter parser", async () => {
  const root = await temp();
  const bundlePath = path.join(root, "github-writer.mjs");
  await build({
    entryPoints: [path.resolve("src/articles/github.ts")], bundle: true, platform: "node", format: "esm", outfile: bundlePath,
    plugins: [{ name: "worker-import-stubs", setup(builder) {
      builder.onResolve({ filter: /^\.\.\/auth\/core$/ }, () => ({ path: "auth-core", namespace: "test-stub" }));
      builder.onResolve({ filter: /^\.\/repository$/ }, () => ({ path: "repository", namespace: "test-stub" }));
      builder.onLoad({ filter: /.*/, namespace: "test-stub" }, args => ({ contents: args.path === "auth-core" ? "export async function digest() { return ''; }" : "export async function getArticle() {} export async function getArticleCopy() {}", loader: "js" }));
    } }],
  });
  const { articleMarkdown } = await import(pathToFileURL(bundlePath).href);
  const article = { id: base.id, url: base.url, title: base.title, author: base.author, description: base.description, createdAt: base.savedAt, updatedAt: base.savedAt, readAt: null };
  const copy = { markdown: "# body\n\n---\ninner frontmatter\né 📰\n", capturedAt: base.capturedAt, source: "upload", revision: base.revision };
  const parsed = parseGitHubMarkdown(articleMarkdown(article, copy));
  assert.equal(parsed.item.id, article.id); assert.equal(parsed.item.title, article.title); assert.equal(parsed.item.author, article.author);
  assert.equal(parsed.item.description, null); assert.equal(parsed.item.createdAt, article.createdAt); assert.equal(parsed.item.copy.markdown, copy.markdown);
  assert.equal(parsed.item.copy.capturedAt, copy.capturedAt); assert.equal(parsed.item.copy.source, copy.source); assert.equal(parsed.item.copy.revision, copy.revision);
  assert.equal(parsed.item.readAt, null);
  const batch = { version: 2, exportedAt: "2026-10-02T00:00:00.000Z", articles: [parsed.item] };
  validateBackupEnvelope(batch); assert.equal(splitImportBatches(batch).length, 1);
});

test("CLI prints fixed usage on bad arguments and counts only on success", async () => {
  const invalid = await cli([]);
  assert.equal(invalid.code, 1);
  assert.equal(invalid.stdout, "");
  assert.equal(invalid.stderr.trim(), "usage: pnpm github:convert --source /absolute/Articles --output /absolute/new-directory");
  const root = await temp(); const source = path.join(root, "source"); const output = path.join(root, "out"); await mkdir(source);
  await put(source, "private-title.md", writerText());
  const success = await cli(["--source", source, "--output", output]);
  assert.equal(success.code, 0, success.stderr);
  assert.deepEqual(JSON.parse(success.stdout), { discovered: 1, eligible: 1, duplicates: 0, excluded: 0, copied: 1, unread: 1, batchCount: 1 });
  assert.equal(success.stdout.includes(base.title), false);
  assert.equal(success.stdout.includes(base.url), false);
});
