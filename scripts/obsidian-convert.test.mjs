import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { convertVault, MAX_COPY_BYTES, MAX_MARKDOWN_TOTAL_BYTES, MAX_SOURCE_FILE_BYTES, parseExplicitDate } from "./obsidian-convert.mjs";
import { MAX_BACKUP_BYTES, MAX_IMPORT_BYTES, MAX_IMPORT_ITEMS, validateBackupEnvelope } from "./archive-backup.mjs";

const fixedNow = new Date("2026-10-02T09:00:00.000Z");
async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "obsidian-convert-test-"));
  const vault = path.join(root, "vault");
  const output = path.join(root, "output");
  await mkdir(vault);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, vault, output };
}
function markdown(options = {}) {
  const source = options.source === undefined ? "https://example.com/a" : options.source;
  const title = options.title === undefined ? "A title" : options.title;
  const created = options.created === undefined ? "2024-02-29" : options.created;
  const read = options.read === undefined ? "false" : options.read;
  const body = options.body === undefined ? "# Body\n\nline\r\n" : options.body;
  const fields = ["source: " + JSON.stringify(source)];
  if (title !== null) fields.push("title: " + JSON.stringify(title));
  if (created !== null) fields.push("created: " + JSON.stringify(created));
  fields.push("read: " + JSON.stringify(read));
  if (options.readAt !== undefined) fields.push("readAt: " + JSON.stringify(options.readAt));
  if (options.author !== undefined) fields.push("author: " + (options.author.startsWith("[") ? options.author : JSON.stringify(options.author)));
  else fields.push("author: " + JSON.stringify("[[Ada Lovelace|Ada]]"));
  if (options.description !== undefined) fields.push("description: " + JSON.stringify(options.description));
  else fields.push("description: " + JSON.stringify("A note"));
  return "---\r\n" + fields.join("\r\n") + "\r\n---\r\n" + body;
}
async function write(vault, file, value) {
  const destination = path.join(vault, file);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, value);
  return destination;
}
async function convert(vault, output) { return convertVault(vault, output, { now: fixedNow }); }

test("converts sorted nested Markdown without changing source bytes; handles Unicode, CRLF and sequences", async t => {
  const { vault, output } = await setup(t);
  const earlyText = "---\nsource:\n  - https://example.com/sequence\nread: yes\nreadAt: 2024-03-02T03:04:05+02:00\nauthor:\n  - \"[[Ada Lovelace]]\"\n  - \"[[Grace|Grace Hopper]]\"\n---\n# Heading Ω\r\n";
  const early = await write(vault, "2024-03-01. Fallback.markdown", earlyText);
  const first = await write(vault, "nested/2024-01-02. First.md", "\uFEFF" + markdown({ source: "HTTPS://EXAMPLE.COM/a?utm_campaign=x&keep=%20#frag", body: "# Ω\r\n\r\n雪\r\n" }));
  const originalEarly = await readFile(early);
  const originalFirst = await readFile(first);
  const result = await convert(vault, output);
  assert.deepEqual([result.report.discovered, result.report.eligible, result.report.read, result.report.unread, result.report.copied, result.report.batchCount], [2, 2, 1, 1, 2, 1]);
  assert.equal(result.report.outcomes[0].path, "2024-03-01. Fallback.markdown");
  assert.equal(result.report.outcomes[0].dateSource, "filename_date");
  const fallback = result.batches[0].articles.find(item => item.url.endsWith("/sequence"));
  assert.equal(fallback.title, "Heading Ω");
  assert.equal(fallback.author, "Ada Lovelace, Grace Hopper");
  assert.equal(fallback.readAt, "2024-03-02T01:04:05.000Z");
  assert.equal(fallback.createdAt, "2024-03-01T00:00:00.000Z");
  const copied = result.batches[0].articles.find(item => item.url.includes("/a?"));
  assert.equal(copied.url, "HTTPS://EXAMPLE.COM/a?utm_campaign=x&keep=%20#frag");
  assert.equal(copied.copy.markdown, "# Ω\r\n\r\n雪\r\n");
  assert.match(copied.id, /^obsidian-[a-f0-9]{64}$/);
  assert.deepEqual(await readFile(first), originalFirst);
  assert.deepEqual(await readFile(early), originalEarly);
});

test("uses title fallbacks and stable IDs/revisions", async t => {
  const { root, vault, output } = await setup(t);
  await write(vault, "2025-04-03. From file.md", markdown({ title: null, created: null, body: "plain\n" }));
  await write(vault, "Nested/no-title.md", "---\nsource: https://example.com/fallback\nread: false\n---\ntext\n");
  const first = (await convert(vault, output)).batches[0].articles;
  assert.equal(first.find(item => item.url.endsWith("/a")).title, "From file");
  assert.equal(first.find(item => item.url.endsWith("/fallback")).title, "no-title");
  const second = (await convert(vault, path.join(root, "output-two"))).batches[0].articles;
  for (const item of first) {
    const again = second.find(value => value.url === item.url);
    assert.equal(again.id, item.id);
    assert.equal(again.copy?.revision, item.copy?.revision);
  }
});

test("tracking duplicates use the first sorted path", async t => {
  const { vault, output } = await setup(t);
  await write(vault, "z.md", markdown({ source: "https://example.com/x?utm_source=z#tail" }));
  await write(vault, "a.md", markdown({ source: "https://example.com/x?fbclid=tracking" }));
  const { report, batches } = await convert(vault, output);
  assert.equal(report.eligible, 1);
  assert.equal(report.duplicates, 1);
  assert.equal(report.outcomes[1].winner, "a.md");
  assert.equal(batches[0].articles[0].url, "https://example.com/x?fbclid=tracking");
});

test("reports missing/invalid URLs, malformed YAML, duplicates, aliases, tags and invalid UTF-8 per file", async t => {
  const { vault, output } = await setup(t);
  await write(vault, "01-missing.md", "---\nread: false\n---\nx");
  await write(vault, "02-invalid-url.md", markdown({ source: "javascript:alert(1)" }));
  await write(vault, "03-bad-yaml.md", "---\nsource: [\nread: false\n---\nx");
  await write(vault, "04-duplicate-key.md", "---\nsource: https://example.com\nsource: https://other.example\nread: false\n---\nx");
  await write(vault, "05-alias.md", "---\nanchor: &a ignored\nsource: *a\nread: false\n---\nx");
  await write(vault, "06-tag.md", "---\nextra: !custom tagged\nsource: https://example.com/tagged\nread: false\n---\nx");
  await write(vault, "07-invalid-utf8.md", Buffer.from([0xff, 0xfe]));
  const { report } = await convert(vault, output);
  assert.equal(report.eligible, 0);
  assert.equal(report.excluded, 7);
  assert.deepEqual(report.outcomes.map(item => item.reasons[0]), ["missing_source_url", "invalid_source_url", "invalid_frontmatter_yaml", "invalid_frontmatter_yaml", "invalid_frontmatter_yaml", "invalid_frontmatter_yaml", "invalid_utf8"]);
});

test("rejects an unquoted wiki-link author parsed as a nested YAML sequence", async t => {
  const { vault, output } = await setup(t);
  await write(vault, "unquoted-author.md", "---\nsource: https://example.com/author\nread: false\nauthor: [[Ada Lovelace]]\n---\nbody\n");
  const { report } = await convert(vault, output);
  assert.equal(report.excluded, 1);
  assert.equal(report.outcomes[0].reasons[0], "invalid_author");
});

test("does not infer ambiguous read state or invalid dates", async t => {
  const { vault, output } = await setup(t);
  await write(vault, "01-unknown.md", markdown({ source: "https://example.com/1", read: "maybe" }));
  await write(vault, "02-no-date.md", markdown({ source: "https://example.com/2", read: "true" }));
  await write(vault, "03-date-only.md", markdown({ source: "https://example.com/3", read: true, readAt: "2024-01-02" }));
  await write(vault, "04-conflict.md", markdown({ source: "https://example.com/4", read: false, readAt: "2024-01-02T00:00:00Z" }));
  await write(vault, "05-created.md", markdown({ source: "https://example.com/5", created: "2024-02-30" }));
  await write(vault, "06-filename-date.md", markdown({ source: "https://example.com/6", created: null }).replace("2024-02-29", "2024-02-29"));
  const { report } = await convert(vault, output);
  assert.deepEqual(report.outcomes.map(item => item.reasons[0]), ["unrecognized_read_flag", "missing_or_invalid_read_date", "missing_or_invalid_read_date", "conflicting_read_date", "invalid_created_date", undefined]);
  assert.equal(parseExplicitDate("2024-02-29"), "2024-02-29T00:00:00.000Z");
  assert.equal(parseExplicitDate("2024-02-30"), null);
  assert.equal(parseExplicitDate("2024-01-01T00:00:00Z", { dateOnly: false }), "2024-01-01T00:00:00.000Z");
  assert.equal(parseExplicitDate("2024-01-01", { dateOnly: false }), null);
});

test("enforces metadata, source-file and copied-body boundaries; keeps empty bodies link-only", async t => {
  const { vault, output } = await setup(t);
  await write(vault, "01-title.md", markdown({ source: "https://example.com/title", title: "t".repeat(501) }));
  await write(vault, "02-author.md", markdown({ source: "https://example.com/author", author: "a".repeat(201) }));
  await write(vault, "03-description.md", markdown({ source: "https://example.com/description", description: "d".repeat(501) }));
  await write(vault, "04-source-too-large.md", Buffer.alloc(MAX_SOURCE_FILE_BYTES + 1, 0x61));
  await write(vault, "05-copy-too-large.md", markdown({ source: "https://example.com/copy", body: "x".repeat(MAX_COPY_BYTES + 1) }));
  await write(vault, "06-empty.md", markdown({ source: "https://example.com/empty", body: "\r\n" }));
  const { report } = await convert(vault, output);
  assert.deepEqual(report.outcomes.map(item => item.reasons[0]), ["title_too_long", "author_too_long", "description_too_long", "source_file_too_large", "copy_body_too_large", undefined]);
  assert.equal(report.linkOnly, 1);
  assert.equal(report.outcomes[5].warnings[0], "empty_body_link_only");
  assert.ok(MAX_IMPORT_BYTES > MAX_COPY_BYTES && MAX_IMPORT_ITEMS === 1000 && MAX_BACKUP_BYTES === 64 * 1024 * 1024);
});

test("excludes JSON-escaped single records over the API limit while preserving other eligible records", async t => {
  const { vault, output } = await setup(t);
  await write(vault, "01-valid.md", markdown({ source: "https://example.com/valid" }));
  await write(vault, "02-escaped-large.md", markdown({ source: "https://example.com/escaped", body: "\u0000".repeat(200_000) }));
  const { report, batches } = await convert(vault, output);
  assert.equal(report.eligible, 1);
  assert.equal(report.excluded, 1);
  assert.equal(report.outcomes[1].reasons[0], "import_record_too_large");
  assert.equal(batches[0].articles[0].url, "https://example.com/valid");
});

test("skips hidden directories and symlinks and refuses unsafe output destinations", async t => {
  const { root, vault, output } = await setup(t);
  await write(vault, "visible.md", markdown());
  await write(vault, ".obsidian/hidden.md", markdown({ source: "https://example.com/hidden" }));
  const outside = await write(root, "outside.md", markdown({ source: "https://example.com/outside" }));
  await symlink(outside, path.join(vault, "linked.md"));
  await symlink(path.join(vault, ".obsidian"), path.join(vault, "linked-dir"));
  const { report } = await convert(vault, output);
  assert.equal(report.discovered, 1);
  assert.deepEqual(report.skippedSymlinks, ["linked-dir", "linked.md"]);
  await assert.rejects(convert(vault, path.join(vault, "bad-output")), /output_must_be_outside_source_tree/);
  await assert.rejects(convert(vault, output), /output_destination_exists/);
  const alias = path.join(root, "vault-alias");
  await symlink(vault, alias);
  await assert.rejects(convert(alias, path.join(alias, "child")), /output_must_be_outside_source_tree/);
  const parentAlias = path.join(root, "inside-vault");
  await symlink(vault, parentAlias);
  await assert.rejects(convert(vault, path.join(parentAlias, "converted")), /output_must_be_outside_source_tree/);
  const outlink = path.join(root, "outlink");
  await symlink(output, outlink);
  await assert.rejects(convert(vault, outlink), /output_destination_exists/);
});

test("aborts aggregate overflow before output and writes batches within shared API limits", async t => {
  const { vault, output } = await setup(t);
  await write(vault, "big.md", Buffer.alloc(MAX_MARKDOWN_TOTAL_BYTES + 1));
  await assert.rejects(convert(vault, output), /aggregate_markdown_size_limit_exceeded/);
  await assert.rejects(readFile(path.join(output, "report.json")));
  await rm(path.join(vault, "big.md"));
  for (let index = 0; index < 1002; index++) await write(vault, "nested/" + String(index).padStart(4, "0") + ".md", markdown({ source: "https://example.com/" + index, body: "# " + index + "\n" }));
  const result = await convert(vault, output);
  assert.deepEqual(result.batches.map(batch => batch.articles.length), [1000, 2]);
  assert.equal(result.report.batchCount, 2);
  for (const batch of result.batches) {
    validateBackupEnvelope(batch);
    assert.ok(Buffer.byteLength(JSON.stringify(batch), "utf8") <= MAX_IMPORT_BYTES);
    assert.ok(batch.articles.length <= MAX_IMPORT_ITEMS);
  }
  const listed = await readdir(output);
  assert.deepEqual(listed, ["import-001.json", "import-002.json", "report.json"]);
});
