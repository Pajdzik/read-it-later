import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { migrateBackups } from "./backup-migrate.ts";
import { parseGitHubMarkdown } from "./github-convert.ts";
import { validateBackupEnvelope } from "./archive-backup.ts";

const exportedAt = "2026-10-18T12:00:00.000Z";
const savedAt = "2026-01-02T03:04:05.000Z";
const legacyId = "550e8400-e29b-41d4-a716-446655440000";
const validId = "k7m2q9x4";
const body = "# exact body\r\n\r\n雪 Ω\r\n";
function markdown(id, url, title, copy = body) {
  return `---\r\npotem_backup_version: 1\r\nid: ${JSON.stringify(id)}\r\ntitle: ${JSON.stringify(title)}\r\nurl: ${JSON.stringify(url)}\r\nauthor: "Writer"\r\ndescription: null\r\nsavedAt: ${JSON.stringify(savedAt)}\r\ncapturedAt: ${JSON.stringify(savedAt)}\r\nsource: "upload"\r\nrevision: "revision-one"\r\n---\r\n${copy}`;
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "potem-backup-migrate-"));
  const source = path.join(root, "Articles");
  await mkdir(source);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, source };
}

test("migrates JSON and matching GitHub files with one reserved mapping and readable paths", async t => {
  const { root, source } = await fixture(t);
  const md = markdown(legacyId, "https://example.com/article", "Why We Read");
  await writeFile(path.join(source, "old-name.md"), md);
  const jsonPath = path.join(root, "backup.json");
  const input = { version: 2, exportedAt, articles: [
    { id: legacyId, url: "https://example.com/article", title: "Why We Read", author: "Writer", description: null, createdAt: savedAt, updatedAt: savedAt, readAt: savedAt,
      copy: { markdown: body, capturedAt: savedAt, source: "upload", revision: "revision-one" } },
    { id: validId, url: "https://example.com/other", title: "Existing Short ID", createdAt: savedAt, updatedAt: savedAt, readAt: null },
  ] };
  await writeFile(jsonPath, JSON.stringify(input));
  const output = path.join(root, "converted");
  const result = await migrateBackups({ jsonPath, githubDirectory: source, outputPath: output });
  const mapped = result.idMappings.find(item => item.oldId === legacyId).newId;
  assert.match(mapped, /^[a-z0-9]{8}$/);
  assert.equal(result.idMappings.find(item => item.oldId === validId).newId, validId);
  assert.equal(result.idMappings.find(item => item.oldId === legacyId).sourcePaths.length, 2);
  assert.deepEqual(result.markdownPaths, [{ oldPath: "old-name.md", newPath: "Articles/why-we-read.md", id: mapped }]);
  const migratedEnvelope = validateBackupEnvelope(JSON.parse(await readFile(path.join(output, "import-001.json"), "utf8")));
  assert.equal(migratedEnvelope.version, 2);
  assert.equal(migratedEnvelope.articles[0].id, mapped);
  assert.equal(migratedEnvelope.articles[0].copy.markdown, body);
  const migratedMd = await readFile(path.join(output, "Articles", "why-we-read.md"));
  const parsed = parseGitHubMarkdown(migratedMd);
  assert.equal(parsed.item.id, mapped);
  assert.equal(parsed.item.title, "Why We Read");
  assert.equal(parsed.item.copy.markdown, body);
  assert.equal(migratedMd.toString().replace(`id: ${JSON.stringify(mapped)}`, `id: ${JSON.stringify(legacyId)}`), md);
  assert.equal(await readFile(path.join(source, "old-name.md"), "utf8"), md);
  assert.equal(JSON.parse(await readFile(jsonPath, "utf8")).articles[0].id, legacyId);
});

test("rejects an ID claimed by inconsistent normalized URLs before writing output", async t => {
  const { root, source } = await fixture(t);
  await writeFile(path.join(source, "one.md"), markdown(legacyId, "https://example.com/one", "One"));
  await writeFile(path.join(source, "two.md"), markdown(legacyId, "https://example.com/two", "Two"));
  const output = path.join(root, "converted");
  await assert.rejects(migrateBackups({ githubDirectory: source, outputPath: output }), /duplicate_markdown_article_id|conflicting_identity/);
  await assert.rejects(readdir(output), { code: "ENOENT" });
});

test("rejects distinct IDs for the same normalized source URL instead of guessing", async t => {
  const { root, source } = await fixture(t);
  await writeFile(path.join(source, "one.md"), markdown(legacyId, "https://example.com/one?utm_source=a", "One"));
  await writeFile(path.join(source, "two.md"), markdown("legacy-second-id", "https://example.com/one?utm_source=b", "One"));
  await assert.rejects(migrateBackups({ githubDirectory: source, outputPath: path.join(root, "converted") }), /conflicting_normalized_url_identity/);
});

test("Markdown-only migration emits import batches and preserves an existing short ID and BOM", async t => {
  const { root, source } = await fixture(t);
  const md = `\uFEFF${markdown(validId, "https://example.com/markdown-only", "Short ID Article")}`;
  await writeFile(path.join(source, "old.md"), md);
  const output = path.join(root, "converted");
  const result = await migrateBackups({ githubDirectory: source, outputPath: output });
  assert.equal(result.markdownOnlyReadStateUnavailable, true);
  assert.equal(result.articleCount, 1);
  assert.equal(result.batchCount, 1);
  assert.equal(result.idMappings[0].newId, validId);
  const envelope = validateBackupEnvelope(JSON.parse(await readFile(path.join(output, "import-001.json"), "utf8")));
  assert.equal(envelope.articles[0].id, validId);
  assert.equal(envelope.articles[0].readAt, null);
  const converted = await readFile(path.join(output, "Articles", "short-id-article.md"), "utf8");
  assert.equal(converted, md);
});

test("rejects duplicate Markdown frontmatter IDs even when their URLs match", async t => {
  const { root, source } = await fixture(t);
  await writeFile(path.join(source, "one.md"), markdown(legacyId, "https://example.com/same", "One"));
  await writeFile(path.join(source, "two.md"), markdown(legacyId, "https://example.com/same", "Two"));
  await assert.rejects(migrateBackups({ githubDirectory: source, outputPath: path.join(root, "converted") }), /duplicate_markdown_article_id/);
});

test("resolves the output parent before rejecting a symlink that points into the source", async t => {
  const { root, source } = await fixture(t);
  await writeFile(path.join(source, "one.md"), markdown(legacyId, "https://example.com/one", "One"));
  const alias = path.join(root, "source-alias");
  const { symlink } = await import("node:fs/promises");
  await symlink(source, alias, "dir");
  await assert.rejects(migrateBackups({ githubDirectory: source, outputPath: path.join(alias, "converted") }), /output_must_be_outside_sources/);
});
