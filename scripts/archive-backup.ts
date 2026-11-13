import { Buffer } from "node:buffer";
import { isPortableTimestamp, validatePortableArticle } from "../src/articles/portable-format.ts";

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
  tags?: string[];
  descriptionOrigin?: 'manual' | 'extracted' | 'generated' | null;
  tagsManuallyEdited?: boolean;
  createdAt: string;
  updatedAt: string;
  readAt: string | null;
  rating?: "up" | "down" | null;
  favorite?: boolean;
  copy?: BackupCopy;
};

export type BackupEnvelope = {
  version: 3;
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

const timestamp = isPortableTimestamp;

/** Validate the portable envelope and all persisted fields without retaining auth data. */
export function validateBackupEnvelope(input: unknown): BackupEnvelope {
  const backup = record(input, ["version", "exportedAt", "articles"], ["version", "exportedAt", "articles"], "backup");
  if (backup.version !== 3 || !timestamp(backup.exportedAt) || !Array.isArray(backup.articles)) {
    throw new Error("Invalid backup.");
  }
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_BACKUP_BYTES) throw new Error("Invalid backup.");
  const articles = backup.articles;
  const seenIds = new Set<string>();
  for (const candidate of articles) {
    try { validatePortableArticle(candidate); } catch { throw new Error("Invalid backup."); }
    const item = candidate as BackupArticle;
    if (seenIds.has(item.id)) throw new Error("Invalid backup.");
    seenIds.add(item.id);
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
