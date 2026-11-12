import type { Article, ArticleCopy, ArticleCursor, SavedArticleCopy } from "../contracts";
import { ValidationError } from "./validation";
import { isArticleId, newArticleId } from "./identity";
import { hydrateTags, normalizeTags } from "./tags";
import { estimateReadingTimeMinutes } from "./reading-time";

export type ArticleStatus = "unread" | "read" | "all";

export interface SaveArticleInput {
  url: string;
  normalizedUrl: string;
  title: string;
  author?: string;
  description?: string;
  copy?: ArticleCopy;
  extractionRequested?: boolean;
  enrichmentRequested?: boolean;
  enrichAfterCopy?: boolean;
  titleOrigin: "fallback" | "supplied";
}

export interface ListArticlesInput {
  status: ArticleStatus;
  q?: string;
  tag?: string;
  limit?: number;
  cursor?: string;
}

export interface UpdateArticleInput {
  read?: boolean;
  title?: string;
  author?: string | null;
  description?: string | null;
  tags?: string[];
}

export interface SaveArticleCopyInput extends ArticleCopy {}

const readingTimeColumn = "(SELECT reading_time_minutes FROM article_copies WHERE article_id = articles.id) AS reading_time_minutes";

export async function suggestArticle(db: D1Database, exclude?: string): Promise<{ article: Article | null; hasAlternative: boolean }> {
  // Prefer a different article on shuffle, but keep the sole unread article available.
  const { results } = await db.prepare(`SELECT id,url,title,author,description,description_origin,tags_manual,created_at,updated_at,read_at,${readingTimeColumn}
    FROM articles WHERE read_at IS NULL
    ORDER BY (id = ?) ASC, RANDOM() LIMIT 2`).bind(exclude ?? "").all<Record<string, unknown>>();
  const articles = await hydrateTags(db, results.map(row => mapArticle(row)!));
  return { article: articles[0] ?? null, hasAlternative: results.length > 1 };
}

function mapArticleCopy(row: Record<string, unknown> | null): SavedArticleCopy | null {
  if (!row) return null;
  return {
    markdown: String(row.markdown),
    capturedAt: String(row.captured_at),
    source: String(row.source) as ArticleCopy["source"],
    revision: String(row.revision),
    readingTimeMinutes: row.reading_time_minutes == null ? null : Number(row.reading_time_minutes),
  };
}

export async function getArticleCopy(db: D1Database, id: string): Promise<SavedArticleCopy | null> {
  const row = await db.prepare("SELECT markdown,captured_at,source,revision,reading_time_minutes FROM article_copies WHERE article_id = ?")
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
  const rows = await db.prepare(`SELECT a.id,a.url,a.title,a.author,a.description,a.description_origin,a.tags_manual,a.created_at,a.updated_at,a.read_at,
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
  const hydrated = await hydrateTags(db, page.map(item => item.article));
  page.forEach((item, index) => { item.article = hydrated[index]; });
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
): Promise<SavedArticleCopy | "conflict" | "missing"> {
  const now = copy.capturedAt;
  const readingTimeMinutes = estimateReadingTimeMinutes(copy.markdown);
  const copyWrite = expectedRevision === null
    ? db.prepare(`INSERT INTO article_copies (article_id,markdown,captured_at,source,revision,reading_time_minutes)
        SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM articles WHERE id = ?)
        ON CONFLICT(article_id) DO NOTHING`)
      .bind(id, copy.markdown, now, copy.source, copy.revision, readingTimeMinutes, id)
    : db.prepare(`UPDATE article_copies SET markdown = ?, captured_at = ?, source = ?, revision = ?, reading_time_minutes = ?
        WHERE article_id = ? AND revision = ? AND EXISTS (SELECT 1 FROM articles WHERE id = ?)`)
      .bind(copy.markdown, now, copy.source, copy.revision, readingTimeMinutes, id, expectedRevision, id);
  const [result] = await db.batch([copyWrite, satisfyExtractionJobs(db, 'id', id, copy)]);
  if ((result.meta.changes ?? 0) > 0) return { ...copy, readingTimeMinutes };
  const article = await db.prepare("SELECT 1 AS found FROM articles WHERE id = ?").bind(id).first();
  if (!article) return "missing";
  return "conflict";
}

function satisfyExtractionJobs(db: D1Database, column: 'id' | 'normalized_url', key: string, copy: ArticleCopy): D1PreparedStatement {
  return db.prepare(`UPDATE article_extraction_jobs
      SET state = CASE WHEN kind='recapture' THEN 'failed' ELSE 'succeeded' END,
          lease_token = NULL, lease_expires_at = NULL,
          error_code = CASE WHEN kind='recapture' THEN 'copy_changed' ELSE NULL END, finished_at = ?, updated_at = ?
      WHERE article_id = (SELECT id FROM articles WHERE ${column} = ?) AND state IN ('queued','running','retry_wait')
        AND EXISTS (SELECT 1 FROM article_copies c WHERE c.article_id = article_extraction_jobs.article_id AND c.revision = ?)`)
    .bind(copy.capturedAt, copy.capturedAt, key, copy.revision);
}

function mapArticle(row: Record<string, unknown> | null): Article | null {
  if (!row) return null;
  return {
    id: String(row.id),
    url: String(row.url),
    title: String(row.title),
    author: row.author == null ? null : String(row.author),
    description: row.description == null ? null : String(row.description),
    descriptionOrigin: row.description_origin == null ? null : row.description_origin as Article["descriptionOrigin"],
    tagsManuallyEdited: Number(row.tags_manual) === 1,
    tags: [],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    readAt: row.read_at === null ? null : String(row.read_at),
    readingTimeMinutes: row.reading_time_minutes == null ? null : Number(row.reading_time_minutes),
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
        !isArticleId(cursor.id) ||
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
  const insertTitle = input.title.trim();
  const readingTimeMinutes = input.copy ? estimateReadingTimeMinutes(input.copy.markdown) : null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = newArticleId();
    const insert = db.prepare(
      `INSERT INTO articles (id,url,normalized_url,title,author,description,created_at,updated_at,read_at,title_origin,enrichment_requested_at,description_origin,enrichment_wait_for_copy)
       VALUES (?,?,?,?,?,?,?,?,NULL,?,?,?,?) ON CONFLICT(normalized_url) DO NOTHING ON CONFLICT(id) DO NOTHING`,
    ).bind(id, input.url, input.normalizedUrl, insertTitle, input.author ?? null, input.description ?? null, now, now, input.titleOrigin, input.enrichmentRequested ? now : null, input.description ? "manual" : null, input.enrichAfterCopy ? 1 : 0);
    const updateDuplicate = db.prepare(`UPDATE articles SET
        author = COALESCE(author, ?),
        description = CASE WHEN description_origin IS NOT 'manual' THEN COALESCE(description, ?) ELSE description END,
        description_origin = CASE WHEN description IS NULL AND description_origin IS NOT 'manual' AND ? IS NOT NULL THEN 'manual' ELSE description_origin END,
        updated_at = ?
      WHERE normalized_url = ? AND changes() = 0
        AND ((author IS NULL AND ? IS NOT NULL) OR (description IS NULL AND description_origin IS NOT 'manual' AND ? IS NOT NULL))`)
      .bind(input.author ?? null, input.description ?? null, input.description ?? null, now, input.normalizedUrl,
        input.author ?? null, input.description ?? null);
    const statements = [insert, updateDuplicate];
    if (input.copy) {
      const { markdown, capturedAt, source, revision } = input.copy;
      // Resolve by URL in the same transaction and keep any copy already saved.
      statements.push(db.prepare(`INSERT INTO article_copies (article_id,markdown,captured_at,source,revision,reading_time_minutes)
        SELECT id,?,?,?,?,? FROM articles WHERE normalized_url = ?
        ON CONFLICT(article_id) DO NOTHING`)
        .bind(markdown, capturedAt, source, revision, readingTimeMinutes, input.normalizedUrl));
      statements.push(satisfyExtractionJobs(db, 'normalized_url', input.normalizedUrl, input.copy));
    }
    if (input.extractionRequested) {
      // Resolve by URL inside the transaction: an ID collision must never queue
      // work for the unrelated article occupying the generated ID.
      statements.push(db.prepare(`INSERT INTO article_extraction_jobs
          (article_id,generation,state,attempts,next_attempt_at,created_at,updated_at)
        SELECT a.id,1,'queued',0,?,?,? FROM articles a
        WHERE a.normalized_url = ?
          AND NOT EXISTS (SELECT 1 FROM article_copies c WHERE c.article_id = a.id)
          AND NOT EXISTS (SELECT 1 FROM article_extraction_jobs j WHERE j.article_id = a.id)
        ON CONFLICT(article_id) DO NOTHING`)
        .bind(now, now, now, input.normalizedUrl));
    }
    if (input.enrichmentRequested) statements.push(db.prepare(`INSERT INTO article_enrichment_jobs(article_id,next_attempt_at,created_at,updated_at)
      SELECT id,?,?,? FROM articles WHERE id=? AND normalized_url=? AND enrichment_requested_at=? ON CONFLICT DO NOTHING`)
      .bind(now, now, now, id, input.normalizedUrl, now));
    const [result, metadataResult] = await db.batch(statements);
    const existing = await db.prepare(`SELECT id,url,title,author,description,description_origin,tags_manual,created_at,updated_at,read_at,title_origin,${readingTimeColumn}
      FROM articles WHERE normalized_url = ?`)
      .bind(input.normalizedUrl).first<Record<string, unknown>>();
    if (!existing) continue; // The ID was occupied; retry only that conflict.
    const [current] = await hydrateTags(db, [mapArticle(existing)!]);
    if (result.meta.changes) return { article: current, duplicate: false, metadataUpdated: false };
    return { article: current, duplicate: true, metadataUpdated: (metadataResult.meta.changes ?? 0) > 0 };
  }
  throw new Error("Could not allocate an article ID. Please retry.");
}

export async function getArticle(db: D1Database, id: string): Promise<Article | null> {
  const row = await db.prepare(`SELECT id,url,title,author,description,description_origin,tags_manual,created_at,updated_at,read_at,${readingTimeColumn}
    FROM articles WHERE id = ?`)
    .bind(id).first<Record<string, unknown>>();
  return row ? (await hydrateTags(db, [mapArticle(row)!]))[0] : null;
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
  if (options.tag) {
    where.push("EXISTS (SELECT 1 FROM article_tags t WHERE t.article_id=articles.id AND t.tag=?)");
    values.push(options.tag);
  }
  if (options.cursor) {
    const cursor = decodeCursor(options.cursor);
    where.push("(created_at < ? OR (created_at = ? AND id < ?))");
    values.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const sql = `SELECT id,url,title,author,description,description_origin,tags_manual,created_at,updated_at,read_at,${readingTimeColumn}
    FROM articles${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC,id DESC LIMIT ?`;
  values.push(limit + 1);
  const rows = await db.prepare(sql).bind(...values).all<Record<string, unknown>>();
  const found = rows.results ?? [];
  const hasMore = found.length > limit;
  const page = await hydrateTags(db, found.slice(0, limit).map((row) => mapArticle(row)!));
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
  const hasAuthor = patch.author !== undefined;
  const hasDescription = patch.description !== undefined;
  const update = db.prepare(`UPDATE articles SET
    title = CASE WHEN ? THEN ? ELSE title END,
    title_origin = CASE WHEN ? THEN 'protected' ELSE title_origin END,
    read_at = CASE WHEN ? THEN CASE WHEN ? THEN COALESCE(read_at, ?) ELSE NULL END ELSE read_at END,
    author = CASE WHEN ? THEN ? ELSE author END,
    description = CASE WHEN ? THEN ? ELSE description END,
    description_origin = CASE WHEN ? THEN 'manual' ELSE description_origin END,
    tags_manual = CASE WHEN ? THEN 1 ELSE tags_manual END,
    updated_at = CASE WHEN
      (? AND (title != ? OR title_origin != 'protected')) OR
      (? AND ((? AND read_at IS NULL) OR (NOT ? AND read_at IS NOT NULL))) OR
      (? AND author IS NOT ?) OR (? AND (description IS NOT ? OR description_origin IS NOT 'manual')) OR ?
      THEN ? ELSE updated_at END
    WHERE id = ?`)
    .bind(hasTitle ? 1 : 0, title, hasTitle ? 1 : 0, hasRead ? 1 : 0, read ? 1 : 0, now,
      hasAuthor ? 1 : 0, patch.author ?? null, hasDescription ? 1 : 0, patch.description ?? null, hasDescription ? 1 : 0, patch.tags !== undefined ? 1 : 0,
      hasTitle ? 1 : 0, title, hasRead ? 1 : 0, read ? 1 : 0, read ? 1 : 0,
      hasAuthor ? 1 : 0, patch.author ?? null, hasDescription ? 1 : 0, patch.description ?? null, patch.tags !== undefined ? 1 : 0, now, id);
  const statements = [update];
  if (patch.tags !== undefined) {
    const tags = normalizeTags(patch.tags);
    statements.push(db.prepare('DELETE FROM article_tags WHERE article_id=?').bind(id));
    statements.push(db.prepare(`INSERT INTO article_tags(article_id,tag) SELECT ?,value FROM json_each(?) WHERE EXISTS(SELECT 1 FROM articles WHERE id=?)`)
      .bind(id, JSON.stringify(tags), id));
  }
  await db.batch(statements);
  return getArticle(db, id);
}

export async function deleteArticle(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM articles WHERE id = ?").bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}
