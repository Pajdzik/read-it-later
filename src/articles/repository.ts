import type { Article, ArticleCopy, ArticleCursor } from "../contracts";
import { ValidationError } from "./validation";

export type ArticleStatus = "unread" | "read" | "all";

export interface SaveArticleInput {
  url: string;
  normalizedUrl: string;
  title?: string;
  fallbackTitle?: string;
  author?: string;
  description?: string;
  extractionRequested?: boolean;
  titleOrigin?: "fallback" | "supplied" | "extracted" | "protected";
}

export interface ListArticlesInput {
  status: ArticleStatus;
  q?: string;
  limit?: number;
  cursor?: string;
}

export interface UpdateArticleInput {
  read?: boolean;
  title?: string;
}

export interface SaveArticleCopyInput extends ArticleCopy {}

function mapArticleCopy(row: Record<string, unknown> | null): ArticleCopy | null {
  if (!row) return null;
  return {
    markdown: String(row.markdown),
    capturedAt: String(row.captured_at),
    source: String(row.source) as ArticleCopy["source"],
    revision: String(row.revision),
  };
}

export async function getArticleCopy(db: D1Database, id: string): Promise<ArticleCopy | null> {
  const row = await db.prepare("SELECT markdown,captured_at,source,revision FROM article_copies WHERE article_id = ?")
    .bind(id).first<Record<string, unknown>>();
  return mapArticleCopy(row);
}

export async function listArticlesForExport(
  db: D1Database,
  limit = 25,
  cursor?: string,
): Promise<{ items: Array<{ article: Article; copy: ArticleCopy | null }>; nextCursor: string | null }> {
  const values: unknown[] = [];
  const where = cursor ? " WHERE (a.created_at < ? OR (a.created_at = ? AND a.id < ?))" : "";
  if (cursor) {
    const decoded = decodeCursor(cursor);
    values.push(decoded.createdAt, decoded.createdAt, decoded.id);
  }
  values.push(limit + 1);
  const rows = await db.prepare(`SELECT a.id,a.url,a.title,a.author,a.description,a.created_at,a.updated_at,a.read_at,
      c.markdown AS copy_markdown,c.captured_at AS copy_captured_at,c.source AS copy_source,c.revision AS copy_revision
    FROM articles a LEFT JOIN article_copies c ON c.article_id = a.id${where}
    ORDER BY a.created_at DESC,a.id DESC LIMIT ?`).bind(...values).all<Record<string, unknown>>();
  const found = rows.results ?? [];
  const hasMore = found.length > limit;
  const page = found.slice(0, limit).map((row) => ({
    article: mapArticle(row)!,
    copy: row.copy_markdown == null ? null : mapArticleCopy({
      markdown: row.copy_markdown, captured_at: row.copy_captured_at,
      source: row.copy_source, revision: row.copy_revision,
    }),
  }));
  const last = page.at(-1)?.article;
  return {
    items: page,
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

export async function saveArticleCopy(
  db: D1Database,
  id: string,
  copy: SaveArticleCopyInput,
  expectedRevision: string | null,
): Promise<"saved" | "conflict" | "missing"> {
  const now = copy.capturedAt;
  const copyWrite = expectedRevision === null
    ? db.prepare(`INSERT INTO article_copies (article_id,markdown,captured_at,source,revision)
        SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM articles WHERE id = ?)
        ON CONFLICT(article_id) DO NOTHING`)
      .bind(id, copy.markdown, now, copy.source, copy.revision, id)
    : db.prepare(`UPDATE article_copies SET markdown = ?, captured_at = ?, source = ?, revision = ?
        WHERE article_id = ? AND revision = ? AND EXISTS (SELECT 1 FROM articles WHERE id = ?)`)
      .bind(copy.markdown, now, copy.source, copy.revision, id, expectedRevision, id);
  const satisfyJobs = db.prepare(`UPDATE article_extraction_jobs
      SET state = 'succeeded', lease_token = NULL, lease_expires_at = NULL,
          error_code = NULL, finished_at = ?, updated_at = ?
      WHERE article_id = ? AND state IN ('queued','running','retry_wait')
        AND EXISTS (SELECT 1 FROM article_copies c WHERE c.article_id = ? AND c.revision = ?)`)
    .bind(now, now, id, id, copy.revision);
  const [result] = await db.batch([copyWrite, satisfyJobs]);
  if ((result.meta.changes ?? 0) > 0) return "saved";
  const article = await db.prepare("SELECT 1 AS found FROM articles WHERE id = ?").bind(id).first();
  if (!article) return "missing";
  return "conflict";
}

function mapArticle(row: Record<string, unknown> | null): Article | null {
  if (!row) return null;
  return {
    id: String(row.id),
    url: String(row.url),
    title: String(row.title),
    author: row.author == null ? null : String(row.author),
    description: row.description == null ? null : String(row.description),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    readAt: row.read_at === null ? null : String(row.read_at),
  };
}

function encodeCursor(cursor: ArticleCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeCursor(value: string): ArticleCursor {
  if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new ValidationError("cursor is invalid");
  try {
    const raw = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(raw + "=".repeat((4 - (raw.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== "object") throw new Error();
    const cursor = parsed as Partial<ArticleCursor>;
    if (Object.keys(parsed).length !== 2 || typeof cursor.createdAt !== "string" ||
        typeof cursor.id !== "string" || !cursor.id || cursor.id.length > 128 ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(cursor.createdAt) ||
      new Date(cursor.createdAt).toISOString() !== cursor.createdAt) throw new Error();
    return { createdAt: cursor.createdAt, id: cursor.id };
  } catch {
    throw new ValidationError("cursor is invalid");
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export async function saveArticle(
  db: D1Database,
  input: SaveArticleInput,
): Promise<{ article: Article; duplicate: boolean; metadataUpdated: boolean }> {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const insertTitle = input.title?.trim() || input.fallbackTitle?.trim() || input.url;
  const titleOrigin = input.titleOrigin ?? (input.title?.trim() ? "supplied" : "fallback");
  const allowDuplicateMetadataTitle = input.fallbackTitle !== undefined || input.titleOrigin === "extracted";
  const extractionRequestedAt = input.extractionRequested ? now : null;
  const before = await db.prepare("SELECT id,title,author,description,created_at,updated_at,read_at FROM articles WHERE normalized_url = ?")
    .bind(input.normalizedUrl).first<Record<string, unknown>>();
  const insert = db.prepare(
    `INSERT INTO articles (id,url,normalized_url,title,author,description,created_at,updated_at,read_at,extraction_requested_at,title_origin)
     VALUES (?,?,?,?,?,?,?,?,NULL,?,?) ON CONFLICT(normalized_url) DO NOTHING`,
  ).bind(id, input.url, input.normalizedUrl, insertTitle, input.author ?? null, input.description ?? null, now, now, extractionRequestedAt, titleOrigin);
  // Duplicate metadata only fills empty fields. For older callers that still pass
  // fallbackTitle, a matching unprotected title can be upgraded to page metadata.
  const updateDuplicate = db.prepare(`UPDATE articles SET
      title = CASE WHEN ? AND title_origin != 'protected' AND
        (title_origin = 'fallback' OR title = ?) AND ? != '' THEN ? ELSE title END,
      title_origin = CASE WHEN ? AND title_origin != 'protected' AND
        (title_origin = 'fallback' OR title = ?) AND ? != '' THEN 'extracted' ELSE title_origin END,
      author = COALESCE(author, ?), description = COALESCE(description, ?),
      extraction_requested_at = CASE WHEN ? AND NOT EXISTS (
        SELECT 1 FROM article_copies c WHERE c.article_id = articles.id
      ) AND NOT EXISTS (
        SELECT 1 FROM article_extraction_jobs j WHERE j.article_id = articles.id AND j.state = 'failed'
      ) THEN COALESCE(extraction_requested_at, ?) ELSE extraction_requested_at END,
      updated_at = CASE WHEN
        (? AND title_origin != 'protected' AND (title_origin = 'fallback' OR title = ?) AND ? != '' AND title != ?) OR
        (author IS NULL AND ? IS NOT NULL) OR (description IS NULL AND ? IS NOT NULL)
        THEN ? ELSE updated_at END
    WHERE normalized_url = ? AND id != ?`)
    .bind(allowDuplicateMetadataTitle ? 1 : 0, input.fallbackTitle ?? "", input.title?.trim() ?? "", input.title?.trim() ?? "",
      allowDuplicateMetadataTitle ? 1 : 0, input.fallbackTitle ?? "", input.title?.trim() ?? "",
      input.author ?? null, input.description ?? null,
      input.extractionRequested ? 1 : 0, now,
      allowDuplicateMetadataTitle ? 1 : 0, input.fallbackTitle ?? "", input.title?.trim() ?? "", input.title?.trim() ?? "",
      input.author ?? null, input.description ?? null, now,
      input.normalizedUrl, id);
  await db.batch([insert, updateDuplicate]);
  const inserted = await db.prepare(
    "SELECT id,url,title,author,description,created_at,updated_at,read_at FROM articles WHERE id = ?",
  ).bind(id).first<Record<string, unknown>>();
  if (inserted) return { article: mapArticle(inserted)!, duplicate: false, metadataUpdated: false };
  const existing = await db.prepare("SELECT id,url,title,author,description,created_at,updated_at,read_at,title_origin FROM articles WHERE normalized_url = ?")
    .bind(input.normalizedUrl).first<Record<string, unknown>>();
  if (!existing) throw new Error("Duplicate article could not be read");
  const current = mapArticle(existing)!;
  const metadataUpdated = !!before && (
    String(before.title) !== current.title ||
    (before.author == null && current.author !== null) ||
    (before.description == null && current.description !== null)
  );
  return { article: current, duplicate: true, metadataUpdated };
}

export async function getArticle(db: D1Database, id: string): Promise<Article | null> {
  const row = await db.prepare("SELECT id,url,title,author,description,created_at,updated_at,read_at FROM articles WHERE id = ?")
    .bind(id).first<Record<string, unknown>>();
  return mapArticle(row);
}

export async function listArticles(
  db: D1Database,
  options: ListArticlesInput,
): Promise<{ items: Article[]; nextCursor: string | null }> {
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ValidationError("limit must be an integer from 1 to 100");
  if (!["unread", "read", "all"].includes(options.status)) throw new ValidationError("status must be unread, read, or all");
  const where: string[] = [];
  const values: unknown[] = [];
  if (options.status === "unread") where.push("read_at IS NULL");
  if (options.status === "read") where.push("read_at IS NOT NULL");
  if (options.q) {
    where.push("(title LIKE ? ESCAPE '\\' COLLATE NOCASE OR url LIKE ? ESCAPE '\\' COLLATE NOCASE)");
    const query = `%${escapeLike(options.q)}%`;
    values.push(query, query);
  }
  if (options.cursor) {
    const cursor = decodeCursor(options.cursor);
    where.push("(created_at < ? OR (created_at = ? AND id < ?))");
    values.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const sql = `SELECT id,url,title,author,description,created_at,updated_at,read_at FROM articles${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC,id DESC LIMIT ?`;
  values.push(limit + 1);
  const rows = await db.prepare(sql).bind(...values).all<Record<string, unknown>>();
  const found = rows.results ?? [];
  const hasMore = found.length > limit;
  const page = found.slice(0, limit).map((row) => mapArticle(row)!);
  const last = page.at(-1);
  return {
    items: page,
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

export async function updateArticle(
  db: D1Database,
  id: string,
  patch: UpdateArticleInput,
  now = new Date().toISOString(),
): Promise<Article | null> {
  const hasTitle = patch.title !== undefined;
  const title = patch.title?.trim() ?? "";
  const hasRead = patch.read !== undefined;
  const read = patch.read === true;
  await db.prepare(`UPDATE articles SET
    title = CASE WHEN ? THEN ? ELSE title END,
    title_origin = CASE WHEN ? THEN 'protected' ELSE title_origin END,
    read_at = CASE WHEN ? THEN CASE WHEN ? THEN COALESCE(read_at, ?) ELSE NULL END ELSE read_at END,
    updated_at = CASE WHEN
      (? AND (title != ? OR title_origin != 'protected')) OR
      (? AND ((? AND read_at IS NULL) OR (NOT ? AND read_at IS NOT NULL)))
      THEN ? ELSE updated_at END
    WHERE id = ?`)
    .bind(hasTitle ? 1 : 0, title, hasTitle ? 1 : 0, hasRead ? 1 : 0, read ? 1 : 0, now,
      hasTitle ? 1 : 0, title, hasRead ? 1 : 0, read ? 1 : 0, read ? 1 : 0, now, id).run();
  return getArticle(db, id);
}

export async function deleteArticle(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM articles WHERE id = ?").bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}
