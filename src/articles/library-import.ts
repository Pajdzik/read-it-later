import type { Article, ArticleCopy, Env } from '../contracts';
import { errorResponse, jsonResponse } from '../http';
import { isArticleId } from './identity';
import { MAX_IMPORT_BYTES, MAX_IMPORT_ITEMS, MAX_TITLE_LENGTH, normalizeArticleUrl, parseObject, readJson, ValidationError } from './validation';
const MAX_COPY_BYTES = 256 * 1024;
type ImportArticle = Article;
export function validateLibrary(value: unknown) {
  const input = parseObject(value, ['version', 'exportedAt', 'articles'], ['version', 'exportedAt', 'articles']);
  if (input.version !== 1 && input.version !== 2) throw new ValidationError('unsupported import version');
  validTimestamp(input.exportedAt, 'exportedAt');
  if (!Array.isArray(input.articles) || input.articles.length > MAX_IMPORT_ITEMS) throw new ValidationError('articles must be an array with at most 1000 items');
  const seenIds = new Set<string>();
  const normalized: Array<ImportArticle & { normalizedUrl: string; copy?: ArticleCopy }> = [];
  for (const value of input.articles) {
    const item = parseObject(value, ['id', 'url', 'title', 'author', 'description', 'createdAt', 'updatedAt', 'readAt', ...(input.version === 2 ? ['copy'] : [])], ['id', 'url', 'title', 'createdAt', 'updatedAt', 'readAt']);
    if (!isArticleId(item.id)) throw new ValidationError('article id must contain eight lowercase letters or digits; convert legacy backups before importing');
    if (seenIds.has(item.id)) throw new ValidationError('import contains duplicate article IDs');
    seenIds.add(item.id);
    const url = normalizeArticleUrl(item.url);
    if (typeof item.title !== 'string' || !item.title.trim() || item.title.trim().length > MAX_TITLE_LENGTH) throw new ValidationError('article title is invalid');
    const createdAt = validTimestamp(item.createdAt, 'createdAt'); const updatedAt = validTimestamp(item.updatedAt, 'updatedAt');
    const readAt = item.readAt === null ? null : validTimestamp(item.readAt, 'readAt');
    const author = optionalImportText(item.author, 'author', 200);
    const description = optionalImportText(item.description, 'description', 500);
    let copy: ArticleCopy | undefined;
    if (item.copy !== undefined) {
      const value = parseObject(item.copy, ['markdown', 'capturedAt', 'source', 'revision'], ['markdown', 'capturedAt', 'source', 'revision']);
      if (typeof value.markdown !== 'string' || !value.markdown.trim()) throw new ValidationError('article copy markdown is invalid');
      const bytes = new TextEncoder().encode(value.markdown);
      if (new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== value.markdown) throw new ValidationError('article copy markdown must contain valid Unicode text');
      if (bytes.byteLength > MAX_COPY_BYTES) throw new ValidationError('article copy exceeds 262144 UTF-8 bytes');
      if (value.source !== 'paste' && value.source !== 'upload') throw new ValidationError('article copy source is invalid');
      const capturedAt = validTimestamp(value.capturedAt, 'copy capturedAt');
      if (typeof value.revision !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.revision)) throw new ValidationError('article copy revision is invalid');
      copy = { markdown: value.markdown, capturedAt, source: value.source, revision: value.revision };
    }
    normalized.push({ id: item.id, url: url.url, normalizedUrl: url.normalizedUrl, title: item.title.trim(), author, description, createdAt, updatedAt, readAt, ...(copy ? { copy } : {}) });
  }
  return normalized;
}
interface ImportOptions {
  assets?: Map<string,string>;
  maxBytes?: number;
  archiveSessionId?: string;
}
export async function importArticles(request: Request, env: Env, options: ImportOptions = {}): Promise<Response> {
  const { assets = new Map<string,string>(), maxBytes = MAX_IMPORT_BYTES, archiveSessionId } = options;
  const normalized = validateLibrary(await readJson(request, maxBytes));
  const existingIds = new Map<string, string>();
  for (const group of chunks(normalized, 80)) {
    const idRows = await env.DB.prepare(`SELECT id, normalized_url FROM articles WHERE id IN (${group.map(() => '?').join(',')})`).bind(...group.map((x) => x.id)).all<{ id: string; normalized_url: string }>();
    for (const row of idRows.results || []) existingIds.set(row.id, row.normalized_url);
  }
  const seenUrls = new Set<string>(); const toInsert: typeof normalized = [];
  let skipped = 0;
  for (const item of normalized) {
    const idUrl = existingIds.get(item.id);
    if (idUrl !== undefined && idUrl !== item.normalizedUrl) throw new ValidationError('an article ID already belongs to a different URL');
    if (seenUrls.has(item.normalizedUrl) || idUrl !== undefined) { skipped++; seenUrls.add(item.normalizedUrl); continue; }
    seenUrls.add(item.normalizedUrl);
    toInsert.push(item);
  }
  let imported = 0;
  if (toInsert.length || archiveSessionId) {
    const statements: D1PreparedStatement[] = [];
    const token = archiveSessionId ? crypto.randomUUID() : undefined;
    if (archiveSessionId) statements.push(env.DB.prepare(`UPDATE archive_sessions SET commit_token=?
      WHERE id=? AND kind='import' AND completed=1 AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
      .bind(token!,archiveSessionId));
    const guard = `EXISTS(SELECT 1 FROM archive_records r JOIN archive_sessions s ON s.id=r.session_id
      WHERE r.session_id=? AND r.article_id=? AND r.committed=0 AND s.completed=1 AND s.commit_token=?)`;
    for (const item of toInsert) {
      statements.push(env.DB.prepare(`INSERT INTO articles (id,url,normalized_url,title,author,description,created_at,updated_at,read_at,pdf_asset_id)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? ${archiveSessionId ? `WHERE ${guard}` : ''} ON CONFLICT(normalized_url) DO NOTHING`)
        .bind(item.id, item.url, item.normalizedUrl, item.title, item.author, item.description, item.createdAt, item.updatedAt, item.readAt, assets.get(item.id) ?? null,
          ...(archiveSessionId ? [archiveSessionId,item.id,token!] : [])));
      if (item.copy) statements.push(env.DB.prepare(`INSERT INTO article_copies (article_id,markdown,captured_at,source,revision)
        SELECT ?,?,?,?,? WHERE changes() = 1 AND EXISTS (SELECT 1 FROM articles WHERE id = ?)
        ON CONFLICT(article_id) DO NOTHING`)
        .bind(item.id, item.copy.markdown, item.copy.capturedAt, item.copy.source, item.copy.revision, item.id));
    }
    const markerStart = statements.length;
    if (archiveSessionId) for (const item of normalized) statements.push(env.DB.prepare(`UPDATE archive_records SET committed=1
      WHERE session_id=? AND article_id=? AND committed=0
      AND EXISTS(SELECT 1 FROM archive_sessions s WHERE s.id=archive_records.session_id AND s.completed=1 AND s.commit_token=?)`)
      .bind(archiveSessionId,item.id,token!));
    const results = await env.DB.batch(statements);
    if (archiveSessionId && !results[0].meta.changes) return errorResponse(404,'not_found','Import session expired or was not found.');
    // A copy insertion follows its article insertion in the same D1 batch and
    // is gated by changes(), so a skipped duplicate can never receive a copy.
    imported = 0;
    let resultIndex = archiveSessionId ? 1 : 0;
    for (const item of toInsert) {
      const articleResult = results[resultIndex++];
      const inserted = articleResult?.meta.changes ?? 0;
      imported += inserted;
      if (item.copy) resultIndex++;
      if (!inserted) skipped++;
    }
    // Only the transaction that consumes a staged record reports it. A stale
    // concurrent request cannot recreate a subsequently deleted article.
    if (archiveSessionId) skipped=results.slice(markerStart).reduce((count,r)=>count+(r.meta.changes ?? 0),0)-imported;
  }
  return jsonResponse({ imported, skipped }, 200);
}

function validTimestamp(value: unknown, field: string): string {
  let valid = false;
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) {
    try { valid = new Date(value).toISOString() === value; } catch { valid = false; }
  }
  if (!valid || typeof value !== 'string') {
    throw new ValidationError(`${field} must be a UTC ISO timestamp`);
  }
  return value;
}
function optionalImportText(value: unknown, field: string, limit: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > limit || !value.trim()) throw new ValidationError(`article ${field} is invalid`);
  return value.trim();
}
function* chunks<T>(values: T[], size: number): Generator<T[]> {
  for (let i = 0; i < values.length; i += size) yield values.slice(i, i + size);
}
