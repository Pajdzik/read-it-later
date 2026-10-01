import type { Article, ArticleCursor } from "../contracts";

export type ArticleStatus = "unread" | "read" | "all";

export interface SaveArticleInput {
  url: string;
  normalizedUrl: string;
  title?: string;
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

function mapArticle(row: Record<string, unknown> | null): Article | null {
  if (!row) return null;
  return {
    id: String(row.id),
    url: String(row.url),
    title: String(row.title),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    readAt: row.read_at === null ? null : String(row.read_at),
  };
}

function encodeCursor(cursor: ArticleCursor): string {
  return btoa(JSON.stringify(cursor)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeCursor(value: string): ArticleCursor {
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid article cursor");
  try {
    const raw = value.replace(/-/g, "+").replace(/_/g, "/");
    const parsed: unknown = JSON.parse(atob(raw + "=".repeat((4 - (raw.length % 4)) % 4)));
    if (!parsed || typeof parsed !== "object") throw new Error();
    const cursor = parsed as Partial<ArticleCursor>;
    if (Object.keys(parsed).length !== 2 || typeof cursor.createdAt !== "string" ||
        typeof cursor.id !== "string" || !cursor.id || cursor.id.length > 128 ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(cursor.createdAt) ||
        new Date(cursor.createdAt).toISOString() !== cursor.createdAt) throw new Error();
    return { createdAt: cursor.createdAt, id: cursor.id };
  } catch {
    throw new Error("Invalid article cursor");
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export async function saveArticle(
  db: D1Database,
  input: SaveArticleInput,
): Promise<{ article: Article; duplicate: boolean }> {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const title = input.title?.trim() || input.url;
  try {
    await db.prepare(
      "INSERT INTO articles (id,url,normalized_url,title,created_at,updated_at,read_at) VALUES (?,?,?,?,?,?,NULL)",
    ).bind(id, input.url, input.normalizedUrl, title, now, now).run();
    const article = await getArticle(db, id);
    if (!article) throw new Error("Inserted article could not be read");
    return { article, duplicate: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/unique constraint failed: articles\.normalized_url/i.test(message)) throw error;
    const existing = await db.prepare("SELECT id,url,title,created_at,updated_at,read_at FROM articles WHERE normalized_url = ?")
      .bind(input.normalizedUrl).first<Record<string, unknown>>();
    if (!existing) throw error;
    return { article: mapArticle(existing)!, duplicate: true };
  }
}

export async function getArticle(db: D1Database, id: string): Promise<Article | null> {
  const row = await db.prepare("SELECT id,url,title,created_at,updated_at,read_at FROM articles WHERE id = ?")
    .bind(id).first<Record<string, unknown>>();
  return mapArticle(row);
}

export async function listArticles(
  db: D1Database,
  options: ListArticlesInput,
): Promise<{ items: Article[]; nextCursor: string | null }> {
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid page size");
  if (!["unread", "read", "all"].includes(options.status)) throw new Error("Invalid article status");
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
  const sql = `SELECT id,url,title,created_at,updated_at,read_at FROM articles${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC,id DESC LIMIT ?`;
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
    read_at = CASE WHEN ? THEN CASE WHEN ? THEN COALESCE(read_at, ?) ELSE NULL END ELSE read_at END,
    updated_at = CASE WHEN
      (? AND title != ?) OR
      (? AND ((? AND read_at IS NULL) OR (NOT ? AND read_at IS NOT NULL)))
      THEN ? ELSE updated_at END
    WHERE id = ?`)
    .bind(hasTitle ? 1 : 0, title, hasRead ? 1 : 0, read ? 1 : 0, now,
      hasTitle ? 1 : 0, title, hasRead ? 1 : 0, read ? 1 : 0, read ? 1 : 0, now, id).run();
  return getArticle(db, id);
}

export async function deleteArticle(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM articles WHERE id = ?").bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}
