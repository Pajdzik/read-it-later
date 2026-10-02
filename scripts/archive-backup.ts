import { Buffer } from "node:buffer";

export const MAX_BACKUP_BYTES = 64 * 1024 * 1024;
export const MAX_IMPORT_BYTES = 1024 * 1024;
export const MAX_IMPORT_ITEMS = 1000;

export type BackupCopy = {
  markdown: string;
  capturedAt: string;
  source: "paste" | "upload";
  revision: string;
};

export type BackupArticle = {
  id: string;
  url: string;
  title: string;
  author?: string | null;
  description?: string | null;
  createdAt: string;
  updatedAt: string;
  readAt: string | null;
  copy?: BackupCopy;
};

export type BackupEnvelope = {
  version: 1 | 2;
  exportedAt: string;
  articles: BackupArticle[];
};

export type BackupSummary = {
  articleCount: number;
  readCount: number;
  unreadCount: number;
  copyCount: number;
  pasteCopyCount: number;
  uploadCopyCount: number;
  compactJsonBytes: number;
  markdownBytes: number;
  maximumMarkdownBytes: number;
};

function record(value: unknown, allowed: readonly string[], required: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}.`);
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) if (!allowed.includes(key)) throw new Error(`Invalid ${label}.`);
  for (const key of required) if (!Object.hasOwn(object, key)) throw new Error(`Invalid ${label}.`);
  return object;
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** Validate the portable envelope and all persisted fields without retaining auth data. */
export function validateBackupEnvelope(input: unknown): BackupEnvelope {
  const backup = record(input, ["version", "exportedAt", "articles"], ["version", "exportedAt", "articles"], "backup");
  if ((backup.version !== 1 && backup.version !== 2) || !timestamp(backup.exportedAt) || !Array.isArray(backup.articles)) {
    throw new Error("Invalid backup.");
  }
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_BACKUP_BYTES) throw new Error("Invalid backup.");
  const articles = backup.articles;
  const seenIds = new Set();
  for (const candidate of articles) {
    const item = record(candidate, ["id", "url", "title", "author", "description", "createdAt", "updatedAt", "readAt", ...(backup.version === 2 ? ["copy"] : [])], ["id", "url", "title", "createdAt", "updatedAt", "readAt"], "article");
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
      const copy = record(item.copy, ["markdown", "capturedAt", "source", "revision"], ["markdown", "capturedAt", "source", "revision"], "copy");
      if (typeof copy.markdown !== "string" || !copy.markdown.trim() ||
        Buffer.byteLength(copy.markdown, "utf8") > 262144 || !timestamp(copy.capturedAt) ||
        (copy.source !== "paste" && copy.source !== "upload") || typeof copy.revision !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(copy.revision)) throw new Error("Invalid backup.");
      if (new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(copy.markdown, "utf8")) !== copy.markdown) throw new Error("Invalid backup.");
    }
  }
  return input as BackupEnvelope;
}

/** Split a validated envelope into byte-bounded API envelopes without splitting a record. */
export function splitImportBatches(input: unknown, { maxBytes = MAX_IMPORT_BYTES, maxItems = MAX_IMPORT_ITEMS }: { maxBytes?: number; maxItems?: number } = {}): BackupEnvelope[] {
  const validated = validateBackupEnvelope(input);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxItems) || maxItems < 1) throw new Error("Invalid batch limits.");
  const batches = [];
  let current = [];
  const envelope = (articles: BackupArticle[]): BackupEnvelope => ({ version: validated.version, exportedAt: validated.exportedAt, articles });
  const emptyEnvelopeBytes = Buffer.byteLength(JSON.stringify(envelope([])), "utf8");
  let currentBytes = emptyEnvelopeBytes;
  for (const item of validated.articles) {
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
export function summarizeBackup(input: unknown): BackupSummary {
  const validated = validateBackupEnvelope(input);
  const articles = validated.articles;
  const copyBytes = articles.reduce((sum, item) => sum + (item.copy ? Buffer.byteLength(item.copy.markdown, "utf8") : 0), 0);
  return {
    articleCount: articles.length,
    readCount: articles.filter(item => item.readAt !== null).length,
    unreadCount: articles.filter(item => item.readAt === null).length,
    copyCount: articles.filter(item => item.copy).length,
    pasteCopyCount: articles.filter(item => item.copy?.source === "paste").length,
    uploadCopyCount: articles.filter(item => item.copy?.source === "upload").length,
    compactJsonBytes: Buffer.byteLength(JSON.stringify(validated), "utf8"),
    markdownBytes: copyBytes,
    maximumMarkdownBytes: articles.reduce((max, item) => Math.max(max, item.copy ? Buffer.byteLength(item.copy.markdown, "utf8") : 0), 0),
  };
}
