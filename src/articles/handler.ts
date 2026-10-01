import type { Article, Env } from '../contracts.js';
import { errorResponse } from '../contracts.js';
import { deleteArticle, getArticle, listArticles, saveArticle, updateArticle } from './repository.js';
import {
  BodyTooLargeError, defaultTitle, MAX_IMPORT_BYTES, MAX_IMPORT_ITEMS, MAX_TITLE_LENGTH,
  normalizeArticleUrl, parseObject, readJson, ValidationError, validateTitle,
} from './validation.js';
import { isResponse, requireSession, validateCaptureToken } from '../auth/core.js';

const PRIVATE = { 'Cache-Control': 'private, no-store', 'Pragma': 'no-cache' };
type ImportArticle = Article;

function fail(status: number, code: string, message: string): Response { return errorResponse(status, code, message); }
function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(value, { status, headers: { ...PRIVATE, ...headers } });
}
function storageFailure(): Response { return fail(503, 'storage_unavailable', 'The service is temporarily unavailable. Please retry.'); }

export async function handleArticles(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url); const method = request.method.toUpperCase();
  if (url.pathname === '/api/capture' && method === 'POST') return capture(request, env);
  const isArticlePath = url.pathname === '/api/articles' || /^\/api\/articles\/[^/]+$/.test(url.pathname);
  if (!isArticlePath && url.pathname !== '/api/export' && url.pathname !== '/api/import') return null;
  const needsWrite = method !== 'GET';
  let session: Awaited<ReturnType<typeof requireSession>>;
  try { session = await requireSession(request, env, needsWrite); } catch { return storageFailure(); }
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
        return article ? json({ article }) : fail(404, 'not_found', 'Article not found.');
      }
      if (method === 'PATCH') return await patchArticle(request, env, id);
      if (method === 'DELETE') { await deleteArticle(env.DB, id); return new Response(null, { status: 204, headers: PRIVATE }); }
    }
    return null;
  } catch (error) {
    if (error instanceof BodyTooLargeError) return fail(413, 'body_too_large', error.message);
    if (error instanceof ValidationError) return fail(400, 'invalid_request', error.message);
    return storageFailure();
  }
}

async function createArticle(request: Request, env: Env): Promise<Response> {
  const input = parseObject(await readJson(request), ['url', 'title'], ['url']);
  const normalized = normalizeArticleUrl(input.url);
  const title = validateTitle(input.title, defaultTitle(normalized.url));
  const result = await saveArticle(env.DB, { ...normalized, title });
  return json(result, result.duplicate ? 200 : 201);
}

async function capture(request: Request, env: Env): Promise<Response> {
  if (request.headers.has('Cookie') || request.headers.has('Origin')) return fail(403, 'forbidden', 'Capture requests must use a bearer token without browser credentials.');
  let auth: Awaited<ReturnType<typeof validateCaptureToken>>;
  try { auth = await validateCaptureToken(request, env); } catch { return storageFailure(); }
  if (isResponse(auth)) return auth;
  try {
    return await createArticle(request, env);
  } catch (error) {
    if (error instanceof BodyTooLargeError) return fail(413, 'body_too_large', error.message);
    if (error instanceof ValidationError) return fail(400, 'invalid_request', error.message);
    return storageFailure();
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
  return json(await listArticles(env.DB, { status, q, limit, cursor }));
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
  return article ? json({ article }) : fail(404, 'not_found', 'Article not found.');
}

async function exportArticles(env: Env): Promise<Response> {
  const exportedAt = new Date().toISOString();
  // Read before committing HTTP 200 so an initial storage outage returns 503.
  let page = await listArticles(env.DB, { status: 'all', limit: 100 });
  let first = true;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`{"version":1,"exportedAt":${JSON.stringify(exportedAt)},"articles":[`));
    },
    async pull(controller) {
      try {
        if (!first && page.nextCursor) {
          page = await listArticles(env.DB, { status: 'all', limit: 100, cursor: page.nextCursor });
        }
        if (page.items.length) {
          controller.enqueue(encoder.encode((first ? '' : ',') + page.items.map(article => JSON.stringify(article)).join(',')));
        }
        first = false;
        if (!page.nextCursor) { controller.enqueue(encoder.encode(']}')); controller.close(); }
      } catch { controller.error(new Error('Export could not be completed')); }
    },
  });
  return new Response(stream, { status: 200, headers: {
    ...PRIVATE, 'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="read-later-export-${exportedAt.slice(0, 10)}.json"`,
  } });
}

async function importArticles(request: Request, env: Env): Promise<Response> {
  const input = parseObject(await readJson(request, MAX_IMPORT_BYTES), ['version', 'exportedAt', 'articles'], ['version', 'exportedAt', 'articles']);
  if (input.version !== 1) throw new ValidationError('unsupported import version');
  validTimestamp(input.exportedAt, 'exportedAt');
  if (!Array.isArray(input.articles) || input.articles.length > MAX_IMPORT_ITEMS) throw new ValidationError('articles must be an array with at most 1000 items');
  const seenIds = new Set<string>();
  const normalized: Array<ImportArticle & { normalizedUrl: string }> = [];
  for (const value of input.articles) {
    const item = parseObject(value, ['id', 'url', 'title', 'createdAt', 'updatedAt', 'readAt'], ['id', 'url', 'title', 'createdAt', 'updatedAt', 'readAt']);
    if (typeof item.id !== 'string' || !item.id || item.id.length > 128) throw new ValidationError('article id is invalid');
    if (seenIds.has(item.id)) throw new ValidationError('import contains duplicate article IDs');
    seenIds.add(item.id);
    const url = normalizeArticleUrl(item.url);
    if (typeof item.title !== 'string' || !item.title.trim() || item.title.trim().length > MAX_TITLE_LENGTH) throw new ValidationError('article title is invalid');
    const createdAt = validTimestamp(item.createdAt, 'createdAt'); const updatedAt = validTimestamp(item.updatedAt, 'updatedAt');
    const readAt = item.readAt === null ? null : validTimestamp(item.readAt, 'readAt');
    normalized.push({ id: item.id, url: url.url, normalizedUrl: url.normalizedUrl, title: item.title.trim(), createdAt, updatedAt, readAt });
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
    const statements = toInsert.map((item) => env.DB.prepare(`INSERT INTO articles (id,url,normalized_url,title,created_at,updated_at,read_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(normalized_url) DO NOTHING`)
      .bind(item.id, item.url, item.normalizedUrl, item.title, item.createdAt, item.updatedAt, item.readAt));
    const results = await env.DB.batch(statements);
    skipped += results.reduce((count, result) => count + ((result.meta.changes ?? 0) === 0 ? 1 : 0), 0);
    imported = results.reduce((count, result) => count + (result.meta.changes ?? 0), 0);
  }
  return json({ imported, skipped }, 200);
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
function* chunks<T>(values: T[], size: number): Generator<T[]> {
  for (let i = 0; i < values.length; i += size) yield values.slice(i, i + size);
}
