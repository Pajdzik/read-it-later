import test from "node:test";
import assert from "node:assert/strict";
import { MAX_IMPORT_BYTES, splitImportBatches, summarizeBackup, validateBackupEnvelope } from "./archive-backup.ts";

const stamp = "2026-01-02T03:04:05.000Z";
function article(id, markdown = "") {
  return {
    id, url: `https://example.invalid/${id}`, title: `Ω quoted: \"${id}\"`, author: null, description: null,
    createdAt: stamp, updatedAt: stamp, readAt: null,
    ...(markdown ? { copy: { markdown, capturedAt: stamp, source: "paste", revision: `rev-${id}` } } : {}),
  };
}
function backup(articles = [], version = 2) {
  return { version, exportedAt: stamp, articles };
}

test("splits by exact UTF-8 JSON byte size, including escapes and envelope overhead", () => {
  const input = backup([article("one", "Ω \\\"quote\\\"\n".repeat(120)), article("two", "雪 \\\"quote\\\"\n".repeat(120))]);
  const one = Buffer.byteLength(JSON.stringify(backup([input.articles[0]])));
  const two = Buffer.byteLength(JSON.stringify(backup([input.articles[1]])));
  const batches = splitImportBatches(input, { maxBytes: Math.max(one, two), maxItems: 10 });
  assert.equal(batches.length, 2);
  assert.deepEqual(batches.flatMap(batch => batch.articles), input.articles);
  for (const batch of batches) assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= Math.max(one, two));
  const exact = backup([input.articles[0]]);
  const exactBytes = Buffer.byteLength(JSON.stringify(exact));
  assert.equal(splitImportBatches(exact, { maxBytes: exactBytes }).length, 1);
  assert.throws(() => splitImportBatches(exact, { maxBytes: exactBytes - 1 }), /record exceeds/);
});

test("honors item boundaries and the API byte ceiling", () => {
  const articles = Array.from({ length: 1001 }, (_, i) => article(String(i)));
  const batches = splitImportBatches(backup(articles));
  assert.deepEqual(batches.map(batch => batch.articles.length), [1000, 1]);
  assert.ok(batches.every(batch => Buffer.byteLength(JSON.stringify(batch)) <= MAX_IMPORT_BYTES));
});

test("rejects a single record too large for the import envelope", () => {
  const input = backup([article("big", "x".repeat(200))]);
  assert.throws(() => splitImportBatches(input, { maxBytes: 100 }), /record exceeds/);
});

test("rejects API-sized records whose JSON escaping exceeds the import byte bound", () => {
  const input = backup([article("escaped", "\u0000".repeat(200000))]);
  assert.ok(Buffer.byteLength(input.articles[0].copy.markdown) < 262144);
  assert.throws(() => splitImportBatches(input), /record exceeds/);
});

test("rejects malformed Unicode before a copy can lose bytes during restoration", () => {
  assert.throws(() => validateBackupEnvelope(backup([article("surrogate", "body\ud800")])), /Invalid/);
});

test("accepts empty libraries and preserves version-1 envelopes", () => {
  assert.deepEqual(splitImportBatches(backup()), []);
  const v1 = backup([article("legacy")], 1);
  const [batch] = splitImportBatches(v1);
  assert.equal(batch.version, 1);
  assert.deepEqual(batch.articles, v1.articles);
  assert.equal(validateBackupEnvelope(v1), v1);
});

test("rejects authentication fields, unknown envelope fields, and malformed article/copy fields", () => {
  for (const value of [
    { ...backup(), auth: { token: "private" } },
    { ...backup(), sessions: [] },
    { ...backup([article("a")]), articles: [{ ...article("a"), accessToken: "secret" }] },
    { ...backup([article("a")]), articles: [{ ...article("a"), copy: { markdown: "x", capturedAt: stamp, source: "paste", revision: "abc", token: "secret" } }] },
  ]) assert.throws(() => validateBackupEnvelope(value), /Invalid/);
});

test("summaries retain content-independent counts and byte totals only", () => {
  const input = backup([
    { ...article("private-id", "Ω\n"), url: "https://secret.invalid/path", title: "private title" },
    { ...article("read", "body\n"), readAt: stamp, copy: { markdown: "body\n", capturedAt: stamp, source: "upload", revision: "rev-read" } },
    article("empty-copy-article"),
  ]);
  const summary = summarizeBackup(input);
  assert.deepEqual(summary, {
    articleCount: 3, readCount: 1, unreadCount: 2, copyCount: 2, pasteCopyCount: 1, uploadCopyCount: 1,
    compactJsonBytes: Buffer.byteLength(JSON.stringify(input)), markdownBytes: 8, maximumMarkdownBytes: 5,
  });
  const serialized = JSON.stringify(summary);
  for (const privateValue of ["private-id", "secret.invalid", "private title", "Ω", "body", "rev-read"]) assert.equal(serialized.includes(privateValue), false);
});
