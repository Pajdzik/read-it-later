import type { Article, ArticleCopy, Env } from '../contracts.js';
import { errorResponse } from '../contracts.js';
import { exceptionResponse, jsonResponse, logUnexpectedError, PRIVATE_HEADERS } from '../http.js';
import { deleteArticle, getArticle, getArticleCopy, listArticles, listArticlesForExport, saveArticle, saveArticleCopy, updateArticle } from './repository.js';
import {
  BodyTooLargeError, defaultTitle, MAX_IMPORT_BYTES, MAX_IMPORT_ITEMS, MAX_TITLE_LENGTH,
  normalizeArticleUrl, parseObject, readJson, ValidationError, validateTitle,
} from './validation.js';
import { isResponse, requireSession, validateCaptureToken } from '../auth/core.js';
import { fetchArticleMetadata } from './metadata.js';

const PRIVATE = PRIVATE_HEADERS;
type ImportArticle = Article;
const MAX_COPY_BYTES = 256 * 1024;
const MAX_COPY_ENVELOPE_BYTES = 2 * 1024 * 1024;

function fail(status: number, code: string, message: string): Response { return errorResponse(status, code, message); }
const storageError = { status: 503, code: 'storage_unavailable', message: 'The service is temporarily unavailable. Please retry.' };

export async function handleArticles(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url); const method = request.method.toUpperCase();
  if (url.pathname === '/api/capture' && method === 'POST') return capture(request, env);
  const isArticlePath = url.pathname === '/api/articles' || /^\/api\/articles\/[^/]+(?:\/copy)?$/.test(url.pathname);
  if (!isArticlePath && url.pathname !== '/api/export' && url.pathname !== '/api/import') return null;
  const needsWrite = method !== 'GET';
  let session: Awaited<ReturnType<typeof requireSession>>;
  try { session = await requireSession(request, env, needsWrite); } catch (error) { return exceptionResponse(error, 'articles.auth', storageError); }
  if (isResponse(session)) return session;
  try {
    if (url.pathname === '/api/articles' && method === 'POST') return await createArticle(request, env);
    if (url.pathname === '/api/articles' && method === 'GET') return await listRoute(url, env);
    if (url.pathname === '/api/export' && method === 'GET') return await exportArticles(env);
    if (url.pathname === '/api/import' && method === 'POST') return await importArticles(request, env);
    const detail = /^\/api\/articles\/([^/]+)$/.exec(url.pathname);
    if (detail) {
      let id: string;
      try { id = decodeURIComponent(detail[1]); } catch { return fail(400, 'invalid_request', 'Article ID is invalid.'); }
      if (!id || id.length > 128) return fail(400, 'invalid_request', 'Article ID is invalid.');
      if (method === 'GET') {
        const article = await getArticle(env.DB, id);
        return article ? jsonResponse({ article }) : fail(404, 'not_found', 'Article not found.');
      }
      if (method === 'PATCH') return await patchArticle(request, env, id);
      if (method === 'DELETE') { await deleteArticle(env.DB, id); return new Response(null, { status: 204, headers: PRIVATE }); }
    }
    const copyRoute = /^\/api\/articles\/([^/]+)\/copy$/.exec(url.pathname);
    if (copyRoute) {
      let id: string;
      try { id = decodeURIComponent(copyRoute[1]); } catch { return fail(400, 'invalid_request', 'Article ID is invalid.'); }
      if (!id || id.length > 128) return fail(400, 'invalid_request', 'Article ID is invalid.');
      if (method === 'GET') {
        if (!(await getArticle(env.DB, id))) return fail(404, 'not_found', 'Article not found.');
        return jsonResponse({ copy: await getArticleCopy(env.DB, id) });
      }
      if (method === 'PUT') return await putArticleCopy(request, env, id);
    }
    return null;
  } catch (error) {
    return exceptionResponse(error, 'articles.request', storageError);
  }
}

async function putArticleCopy(request: Request, env: Env, id: string): Promise<Response> {
  const input = parseObject(await readJson(request, MAX_COPY_ENVELOPE_BYTES), ['markdown', 'source', 'expectedRevision'], ['markdown', 'source', 'expectedRevision']);
  if (typeof input.markdown !== 'string') throw new ValidationError('markdown must be text');
  const markdown = input.markdown;
  if (!markdown.trim()) throw new ValidationError('Markdown copy must not be blank');
  const encoded = new TextEncoder().encode(markdown);
  if (new TextDecoder('utf-8', { fatal: true }).decode(encoded) !== markdown) throw new ValidationError('Markdown copy must contain valid Unicode text');
  if (encoded.byteLength > MAX_COPY_BYTES) throw new BodyTooLargeError('Markdown copy must be at most 262144 UTF-8 bytes');
  if (input.source !== 'paste' && input.source !== 'upload') throw new ValidationError('source must be paste or upload');
  const expectedRevision = input.expectedRevision;
  if (expectedRevision !== null && (typeof expectedRevision !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(expectedRevision))) {
    throw new ValidationError('expectedRevision must be null or a valid revision');
  }
  const copy: ArticleCopy = { markdown, capturedAt: new Date().toISOString(), source: input.source, revision: crypto.randomUUID() };
  const result = await saveArticleCopy(env.DB, id, copy, expectedRevision as string | null);
  if (result === 'missing') return fail(404, 'not_found', 'Article not found.');
  if (result === 'conflict') return fail(409, 'revision_conflict', 'This copy changed since you opened it. Reload it before replacing.');
  return jsonResponse({ copy });
}

async function createArticle(request: Request, env: Env): Promise<Response> {
  const input = parseObject(await readJson(request), ['url', 'title'], ['url']);
  const normalized = normalizeArticleUrl(input.url);
  const fallbackTitle = defaultTitle(normalized.url);
  const suppliedTitle = input.title === undefined ? undefined : validateTitle(input.title, fallbackTitle);
  const metadata = await fetchArticleMetadata(normalized.url);
  const title = suppliedTitle || metadata.title || fallbackTitle;
  const result = await saveArticle(env.DB, {
    ...normalized, title, fallbackTitle: suppliedTitle ? undefined : fallbackTitle,
    author: metadata.author, description: metadata.description,
  });
  return jsonResponse(result, result.duplicate ? 200 : 201);
}

async function capture(request: Request, env: Env): Promise<Response> {
  if (request.headers.has('Cookie') || request.headers.has('Origin')) return fail(403, 'forbidden', 'Capture requests must use a bearer token without browser credentials.');
  let auth: Awaited<ReturnType<typeof validateCaptureToken>>;
  try { auth = await validateCaptureToken(request, env); } catch (error) { return exceptionResponse(error, 'articles.capture_auth', storageError); }
  if (isResponse(auth)) return auth;
  try {
    return await createArticle(request, env);
  } catch (error) {
    return exceptionResponse(error, 'articles.capture', storageError);
  }
}

async function listRoute(url: URL, env: Env): Promise<Response> {
  const allowed = new Set(['status', 'q', 'limit', 'cursor']);
  url.searchParams.forEach((_value, key) => { if (!allowed.has(key)) throw new ValidationError(`unknown query parameter: ${key}`); });
  for (const key of allowed) if (url.searchParams.getAll(key).length > 1) throw new ValidationError(`query parameter ${key} may only appear once`);
  const status = url.searchParams.get('status') || 'unread';
  if (status !== 'unread' && status !== 'read' && status !== 'all') throw new ValidationError('status must be unread, read, or all');
  const q = url.searchParams.get('q') || undefined;
  if (q !== undefined && q.length > 500) throw new ValidationError('search text must be at most 500 characters');
  const limitText = url.searchParams.get('limit');
  const limit = limitText === null ? 50 : (/^\d+$/.test(limitText) ? Number(limitText) : NaN);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ValidationError('limit must be an integer from 1 to 100');
  const cursor = url.searchParams.get('cursor') || undefined;
  if (cursor && cursor.length > 2048) throw new ValidationError('cursor is invalid');
  return jsonResponse(await listArticles(env.DB, { status, q, limit, cursor }));
}

async function patchArticle(request: Request, env: Env, id: string): Promise<Response> {
  const input = parseObject(await readJson(request), ['read', 'title']);
  if (!Object.keys(input).length) throw new ValidationError('at least one field is required');
  if ('read' in input && typeof input.read !== 'boolean') throw new ValidationError('read must be a boolean');
  const patch: { read?: boolean; title?: string } = {};
  if ('read' in input) patch.read = input.read as boolean;
  if ('title' in input) {
    if (typeof input.title !== 'string') throw new ValidationError('title must be a string');
    const title = input.title.trim();
    if (!title || title.length > MAX_TITLE_LENGTH) throw new ValidationError('title must contain 1 to 500 characters');
    patch.title = title;
  }
  const article = await updateArticle(env.DB, id, patch);
  return article ? jsonResponse({ article }) : fail(404, 'not_found', 'Article not found.');
}

async function exportArticles(env: Env): Promise<Response> {
  const exportedAt = new Date().toISOString();
  // Read before committing HTTP 200 so an initial storage outage returns 503.
  let page = await listArticlesForExport(env.DB, 25);
  let pageIndex = 0;
  let emitted = 0;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`{"version":2,"exportedAt":${JSON.stringify(exportedAt)},"articles":[`));
    },
    async pull(controller) {
      try {
        if (pageIndex >= page.items.length && page.nextCursor) {
          page = await listArticlesForExport(env.DB, 25, page.nextCursor);
          pageIndex = 0;
        }
        if (pageIndex < page.items.length) {
          const { article, copy } = page.items[pageIndex++];
          controller.enqueue(encoder.encode(`${emitted++ ? ',' : ''}${JSON.stringify({ ...article, ...(copy ? { copy } : {}) })}`));
          return;
        }
        controller.enqueue(encoder.encode(']}'));
        controller.close();
      } catch {
        logUnexpectedError('articles.export_stream');
        controller.error(new Error('Export could not be completed'));
      }
    },
  });
  return new Response(stream, { status: 200, headers: {
    ...PRIVATE, 'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="read-later-export-${exportedAt.slice(0, 10)}.json"`,
  } });
}

async function importArticles(request: Request, env: Env): Promise<Response> {
  const input = parseObject(await readJson(request, MAX_IMPORT_BYTES), ['version', 'exportedAt', 'articles'], ['version', 'exportedAt', 'articles']);
  if (input.version !== 1 && input.version !== 2) throw new ValidationError('unsupported import version');
  validTimestamp(input.exportedAt, 'exportedAt');
  if (!Array.isArray(input.articles) || input.articles.length > MAX_IMPORT_ITEMS) throw new ValidationError('articles must be an array with at most 1000 items');
  const seenIds = new Set<string>();
  const normalized: Array<ImportArticle & { normalizedUrl: string; copy?: ArticleCopy }> = [];
  for (const value of input.articles) {
    const item = parseObject(value, ['id', 'url', 'title', 'author', 'description', 'createdAt', 'updatedAt', 'readAt', ...(input.version === 2 ? ['copy'] : [])], ['id', 'url', 'title', 'createdAt', 'updatedAt', 'readAt']);
    if (typeof item.id !== 'string' || !item.id || item.id.length > 128) throw new ValidationError('article id is invalid');
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
  if (toInsert.length) {
    const statements: D1PreparedStatement[] = [];
    for (const item of toInsert) {
      statements.push(env.DB.prepare(`INSERT INTO articles (id,url,normalized_url,title,author,description,created_at,updated_at,read_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(normalized_url) DO NOTHING`)
        .bind(item.id, item.url, item.normalizedUrl, item.title, item.author, item.description, item.createdAt, item.updatedAt, item.readAt));
      if (item.copy) statements.push(env.DB.prepare(`INSERT INTO article_copies (article_id,markdown,captured_at,source,revision)
        SELECT ?,?,?,?,? WHERE changes() = 1 AND EXISTS (SELECT 1 FROM articles WHERE id = ?)
        ON CONFLICT(article_id) DO NOTHING`)
        .bind(item.id, item.copy.markdown, item.copy.capturedAt, item.copy.source, item.copy.revision, item.id));
    }
    const results = await env.DB.batch(statements);
    // A copy insertion follows its article insertion in the same D1 batch and
    // is gated by changes(), so a skipped duplicate can never receive a copy.
    imported = 0;
    let resultIndex = 0;
    for (const item of toInsert) {
      const articleResult = results[resultIndex++];
      const inserted = articleResult?.meta.changes ?? 0;
      imported += inserted;
      if (item.copy) resultIndex++;
      if (!inserted) skipped++;
    }
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
