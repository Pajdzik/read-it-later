import { Buffer } from "node:buffer";

export const MAX_BACKUP_BYTES = 64 * 1024 * 1024;
export const MAX_IMPORT_BYTES = 1024 * 1024;
export const MAX_IMPORT_ITEMS = 1000;

function record(value, allowed, required, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Invalid ${label}.`);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`Invalid ${label}.`);
  return value;
}

function timestamp(value) {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** Validate the portable envelope and all persisted fields without retaining auth data. */
export function validateBackupEnvelope(input) {
  record(input, ["version", "exportedAt", "articles"], ["version", "exportedAt", "articles"], "backup");
  if ((input.version !== 1 && input.version !== 2) || !timestamp(input.exportedAt) || !Array.isArray(input.articles)) {
    throw new Error("Invalid backup.");
  }
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_BACKUP_BYTES) throw new Error("Invalid backup.");
  const seenIds = new Set();
  for (const item of input.articles) {
    const allowed = ["id", "url", "title", "author", "description", "createdAt", "updatedAt", "readAt", ...(input.version === 2 ? ["copy"] : [])];
    record(item, allowed, ["id", "url", "title", "createdAt", "updatedAt", "readAt"], "article");
    if (typeof item.id !== "string" || !item.id || item.id.length > 128 || seenIds.has(item.id) ||
      typeof item.url !== "string" || !item.url || item.url.length > 8192 ||
      typeof item.title !== "string" || !item.title.trim() || item.title.length > 500 ||
      !timestamp(item.createdAt) || !timestamp(item.updatedAt) || !(item.readAt === null || timestamp(item.readAt)) ||
      !(item.author === undefined || item.author === null || (typeof item.author === "string" && !!item.author.trim() && item.author.length <= 200)) ||
      !(item.description === undefined || item.description === null || (typeof item.description === "string" && !!item.description.trim() && item.description.length <= 500))) {
      throw new Error("Invalid backup.");
    }
    seenIds.add(item.id);
    if (item.copy !== undefined) {
      record(item.copy, ["markdown", "capturedAt", "source", "revision"], ["markdown", "capturedAt", "source", "revision"], "copy");
      if (typeof item.copy.markdown !== "string" || !item.copy.markdown.trim() ||
        Buffer.byteLength(item.copy.markdown, "utf8") > 262144 || !timestamp(item.copy.capturedAt) ||
        !["paste", "upload"].includes(item.copy.source) || typeof item.copy.revision !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(item.copy.revision)) throw new Error("Invalid backup.");
      if (new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(item.copy.markdown, "utf8")) !== item.copy.markdown) throw new Error("Invalid backup.");
    }
  }
  return input;
}

/** Split a validated envelope into byte-bounded API envelopes without splitting a record. */
export function splitImportBatches(input, { maxBytes = MAX_IMPORT_BYTES, maxItems = MAX_IMPORT_ITEMS } = {}) {
  validateBackupEnvelope(input);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxItems) || maxItems < 1) throw new Error("Invalid batch limits.");
  const batches = [];
  let current = [];
  const envelope = articles => ({ version: input.version, exportedAt: input.exportedAt, articles });
  const emptyEnvelopeBytes = Buffer.byteLength(JSON.stringify(envelope([])), "utf8");
  let currentBytes = emptyEnvelopeBytes;
  for (const item of input.articles) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    const addedBytes = itemBytes + (current.length ? 1 : 0);
    if (emptyEnvelopeBytes + itemBytes > maxBytes) throw new Error("A backup record exceeds the import limit.");
    if (current.length && (current.length >= maxItems || currentBytes + addedBytes > maxBytes)) {
      batches.push(envelope(current));
      current = [];
      currentBytes = emptyEnvelopeBytes;
    }
    current.push(item);
    currentBytes += itemBytes + (current.length > 1 ? 1 : 0);
  }
  if (current.length) batches.push(envelope(current));
  return batches;
}

/** Safe count/byte summary. It deliberately has no record values or input path. */
export function summarizeBackup(input) {
  validateBackupEnvelope(input);
  const articles = input.articles;
  const copyBytes = articles.reduce((sum, item) => sum + (item.copy ? Buffer.byteLength(item.copy.markdown, "utf8") : 0), 0);
  return {
    articleCount: articles.length,
    readCount: articles.filter(item => item.readAt !== null).length,
    unreadCount: articles.filter(item => item.readAt === null).length,
    copyCount: articles.filter(item => item.copy).length,
    pasteCopyCount: articles.filter(item => item.copy?.source === "paste").length,
    uploadCopyCount: articles.filter(item => item.copy?.source === "upload").length,
    compactJsonBytes: Buffer.byteLength(JSON.stringify(input), "utf8"),
    markdownBytes: copyBytes,
    maximumMarkdownBytes: articles.reduce((max, item) => Math.max(max, item.copy ? Buffer.byteLength(item.copy.markdown, "utf8") : 0), 0),
  };
}
