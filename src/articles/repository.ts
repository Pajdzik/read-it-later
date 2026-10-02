import type { Article, ArticleCopy, ArticleCursor, ArticleStatus } from "../contracts";
import { ValidationError } from "./validation";

export type { ArticleStatus } from "../shared/contracts";

export interface SaveArticleInput {
  url: string;
  normalizedUrl: string;
  title?: string;
  fallbackTitle?: string;
  author?: string;
  description?: string;
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

export interface ImportArticleInput extends Article {
  normalizedUrl: string;
  copy?: ArticleCopy;
}

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
  copy: ArticleCopy,
  expectedRevision: string | null,
): Promise<"saved" | "conflict" | "missing"> {
  const now = copy.capturedAt;
  const result = expectedRevision === null
    ? await db.prepare(`INSERT INTO article_copies (article_id,markdown,captured_at,source,revision)
        SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM articles WHERE id = ?)
        ON CONFLICT(article_id) DO NOTHING`)
      .bind(id, copy.markdown, now, copy.source, copy.revision, id).run()
    : await db.prepare(`UPDATE article_copies SET markdown = ?, captured_at = ?, source = ?, revision = ?
        WHERE article_id = ? AND revision = ? AND EXISTS (SELECT 1 FROM articles WHERE id = ?)`)
      .bind(copy.markdown, now, copy.source, copy.revision, id, expectedRevision, id).run();
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
  const insertTitle = input.title?.trim() || input.url;
  const inserted = await db.prepare(
    "INSERT INTO articles (id,url,normalized_url,title,author,description,created_at,updated_at,read_at) VALUES (?,?,?,?,?,?,?,?,NULL) ON CONFLICT(normalized_url) DO NOTHING RETURNING id,url,title,author,description,created_at,updated_at,read_at",
  ).bind(id, input.url, input.normalizedUrl, insertTitle, input.author ?? null, input.description ?? null, now, now).first<Record<string, unknown>>();
  if (inserted) return { article: mapArticle(inserted)!, duplicate: false, metadataUpdated: false };
  const titleCanReplaceFallback = Boolean(input.fallbackTitle && input.title);
  const updated = await db.prepare(`UPDATE articles SET
      title = CASE WHEN ? AND title = ? AND title != ? THEN ? ELSE title END,
      author = COALESCE(author, ?),
      description = COALESCE(description, ?),
      updated_at = ?
    WHERE normalized_url = ? AND (
      (? AND title = ? AND title != ?) OR
      (author IS NULL AND ? IS NOT NULL) OR
      (description IS NULL AND ? IS NOT NULL)
    )
    RETURNING id,url,title,author,description,created_at,updated_at,read_at`)
    .bind(titleCanReplaceFallback ? 1 : 0, input.fallbackTitle ?? "", input.title ?? "", input.title ?? "",
      input.author ?? null, input.description ?? null, now, input.normalizedUrl,
      titleCanReplaceFallback ? 1 : 0, input.fallbackTitle ?? "", input.title ?? "", input.author ?? null, input.description ?? null)
    .first<Record<string, unknown>>();
  if (updated) return { article: mapArticle(updated)!, duplicate: true, metadataUpdated: true };
  const current = await db.prepare("SELECT id,url,title,author,description,created_at,updated_at,read_at FROM articles WHERE normalized_url = ?")
    .bind(input.normalizedUrl).first<Record<string, unknown>>();
  if (!current) throw new Error("Duplicate article could not be read");
  return { article: mapArticle(current)!, duplicate: true, metadataUpdated: false };
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
  const row = await db.prepare(`UPDATE articles SET
    title = CASE WHEN ? THEN ? ELSE title END,
    read_at = CASE WHEN ? THEN CASE WHEN ? THEN COALESCE(read_at, ?) ELSE NULL END ELSE read_at END,
    updated_at = CASE WHEN
      (? AND title != ?) OR
      (? AND ((? AND read_at IS NULL) OR (NOT ? AND read_at IS NOT NULL)))
      THEN ? ELSE updated_at END
    WHERE id = ?
    RETURNING id,url,title,author,description,created_at,updated_at,read_at`)
    .bind(hasTitle ? 1 : 0, title, hasRead ? 1 : 0, read ? 1 : 0, now,
      hasTitle ? 1 : 0, title, hasRead ? 1 : 0, read ? 1 : 0, read ? 1 : 0, now, id)
    .first<Record<string, unknown>>();
  return mapArticle(row);
}

export async function importArticles(
  db: D1Database,
  articles: ImportArticleInput[],
): Promise<{ imported: number; skipped: number }> {
  const existingIds = new Map<string, string>();
  for (const group of chunks(articles, 80)) {
    const rows = await db.prepare(`SELECT id, normalized_url FROM articles WHERE id IN (${group.map(() => "?").join(",")})`)
      .bind(...group.map((item) => item.id)).all<{ id: string; normalized_url: string }>();
    for (const row of rows.results ?? []) existingIds.set(row.id, row.normalized_url);
  }
  const seenUrls = new Set<string>();
  const toInsert: ImportArticleInput[] = [];
  let skipped = 0;
  for (const item of articles) {
    const idUrl = existingIds.get(item.id);
    if (idUrl !== undefined && idUrl !== item.normalizedUrl) {
      throw new ValidationError("an article ID already belongs to a different URL");
    }
    if (seenUrls.has(item.normalizedUrl) || idUrl !== undefined) {
      skipped++;
      seenUrls.add(item.normalizedUrl);
      continue;
    }
    seenUrls.add(item.normalizedUrl);
    toInsert.push(item);
  }

  if (!toInsert.length) return { imported: 0, skipped };
  const statements: D1PreparedStatement[] = [];
  for (const item of toInsert) {
    statements.push(db.prepare(`INSERT INTO articles (id,url,normalized_url,title,author,description,created_at,updated_at,read_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(normalized_url) DO NOTHING`)
      .bind(item.id, item.url, item.normalizedUrl, item.title, item.author, item.description, item.createdAt, item.updatedAt, item.readAt));
    if (item.copy) statements.push(db.prepare(`INSERT INTO article_copies (article_id,markdown,captured_at,source,revision)
      SELECT ?,?,?,?,? WHERE changes() = 1 AND EXISTS (SELECT 1 FROM articles WHERE id = ?)
      ON CONFLICT(article_id) DO NOTHING`)
      .bind(item.id, item.copy.markdown, item.copy.capturedAt, item.copy.source, item.copy.revision, item.id));
  }
  const results = await db.batch(statements);
  let imported = 0;
  let resultIndex = 0;
  for (const item of toInsert) {
    const inserted = results[resultIndex++]?.meta.changes ?? 0;
    imported += inserted;
    if (item.copy) resultIndex++;
    if (!inserted) skipped++;
  }
  return { imported, skipped };
}

function* chunks<T>(values: T[], size: number): Generator<T[]> {
  for (let i = 0; i < values.length; i += size) yield values.slice(i, i + size);
}

export async function deleteArticle(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM articles WHERE id = ?").bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}
