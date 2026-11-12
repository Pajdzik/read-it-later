import { importArticles } from "./library-import";
import { handleArchive } from "../archive/handler";
import { getOriginalPdf, originalPdfSummaries, servePdf } from "./pdf";
import type { Article, ArticleCopy, Env } from '../contracts.js';
import type { ArticlePreview } from './preview-contract.js';
import { errorResponse } from '../contracts.js';
import { exceptionResponse, jsonResponse, logUnexpectedError, PRIVATE_HEADERS } from '../http.js';
import { deleteArticle, getArticle, getArticleCopy, listArticles, listArticlesForExport, saveArticle, saveArticleCopy, suggestArticle, updateArticle } from './repository.js';
import {
  BodyTooLargeError, defaultTitle, MAX_TITLE_LENGTH,
  normalizeArticleUrl, parseObject, readJson, ValidationError, validateTitle,
} from './validation.js';
import { isResponse, requireSession, validateCaptureToken } from '../auth/core.js';
import { getExtractionStatus, getExtractionStatuses, retryExtractionJob } from './jobs.js';
import { scheduleExtraction } from './extraction-queue';
import { captureArticlePreview, isBackgroundCapturePaused } from './capture-client.js';
import { MAX_MARKDOWN_BYTES, SourceFetchError } from './capture-protocol.js';
import { isArticleId } from './identity.js';
import { deliverArticle, integrationConfigurations, integrationStatuses } from '../integrations/registry';
import { IntegrationError } from '../integrations/types';
import { enrichmentEnabled, enrichmentStatuses, scheduleEnrichment } from "./enrichment";
import { listTags, normalizeTags } from "./tags";
import { requestRecapture, undoRecapture } from './recovery.js';
import { getPodcastFitStatuses } from '../audio';

const PRIVATE = PRIVATE_HEADERS;
const MAX_COPY_ENVELOPE_BYTES = 2 * 1024 * 1024;

function fail(status: number, code: string, message: string): Response { return errorResponse(status, code, message); }
const storageError = { status: 503, code: 'storage_unavailable', message: 'The service is temporarily unavailable. Please retry.' };

export async function handleArticles(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url); const method = request.method.toUpperCase();
  if (url.pathname === '/api/capture' && method === 'POST') return capture(request, env, ctx);
  const isArticlePath = url.pathname === '/api/articles' || /^\/api\/articles\/[^/]+(?:\/pdf|\/copy|\/integrations(?:\/[a-z][a-z0-9-]{0,47})?|\/extraction(?:\/(?:retry|recapture|undo))?)?$/.test(url.pathname);
  if (!url.pathname.startsWith('/api/archive') && !isArticlePath && !['/api/export', '/api/import', '/api/integrations', '/api/tags'].includes(url.pathname)) return null;
  const needsWrite = method !== 'GET';
  let session: Awaited<ReturnType<typeof requireSession>>;
  try { session = await requireSession(request, env, needsWrite); } catch (error) { return exceptionResponse(error, 'articles.auth', storageError); }
  if (isResponse(session)) return session;
  try {
    if (url.pathname === '/api/tags' && method === 'GET') return jsonResponse({ tags: await listTags(env.DB) });
    if (url.pathname.startsWith('/api/archive')) return await handleArchive(request, env);
    const pdfRoute = /^\/api\/articles\/([^/]+)\/pdf$/.exec(url.pathname);
    if (pdfRoute && method === 'GET') {
      if (!isArticleId(pdfRoute[1])) throw new ValidationError('Article ID must contain eight lowercase letters or digits.');
      return await servePdf(request, env, pdfRoute[1]);
    }
    if (url.pathname === '/api/integrations' && method === 'GET') return jsonResponse({ integrations: integrationConfigurations(env) });
    const integrationRoute = /^\/api\/articles\/([^/]+)\/integrations(?:\/([a-z][a-z0-9-]{0,47}))?$/.exec(url.pathname);
    if (integrationRoute) {
      let id: string;
      try { id = decodeURIComponent(integrationRoute[1]); } catch { return fail(400, 'invalid_request', 'Article ID is invalid.'); }
      if (!isArticleId(id)) return fail(400, 'invalid_request', 'Article ID must contain eight lowercase letters or digits.');
      if (method === 'GET' && !integrationRoute[2]) return jsonResponse({ integrations: await integrationStatuses(env, id) });
      if (method === 'POST' && integrationRoute[2]) {
        const input = parseObject(await readJson(request), ['expectedRevision', 'expectedDestinationKey'], ['expectedRevision', 'expectedDestinationKey']);
        if (typeof input.expectedRevision !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.expectedRevision)) throw new ValidationError('expectedRevision must be a valid saved copy revision');
        if (typeof input.expectedDestinationKey !== 'string' || !input.expectedDestinationKey || input.expectedDestinationKey.length > 2048) throw new ValidationError('expectedDestinationKey is invalid');
        return jsonResponse(await deliverArticle(env, id, integrationRoute[2], input.expectedRevision, input.expectedDestinationKey));
      }
      return fail(405, 'method_not_allowed', 'This integration action is not supported.');
    }
    if (url.pathname === '/api/articles' && method === 'POST') return await createArticle(request, env, false, ctx);
    if (url.pathname === '/api/articles' && method === 'GET') return await listRoute(url, env);
    if (url.pathname === '/api/articles/preview' && method === 'POST') return await previewArticle(request, env);
    if (url.pathname === '/api/articles/suggestion' && method === 'GET') {
      const exclude = url.searchParams.get('exclude');
      if (exclude !== null && !isArticleId(exclude)) throw new ValidationError('exclude must be a valid article ID');
      return jsonResponse(await suggestArticle(env.DB, exclude ?? undefined));
    }
    if (url.pathname === '/api/export' && method === 'GET') return await exportArticles(env);
    if (url.pathname === '/api/import' && method === 'POST') return await importArticles(request, env);
    const extractionRoute = /^\/api\/articles\/([^/]+)\/extraction(\/(?:retry|recapture|undo))?$/.exec(url.pathname);
    if (extractionRoute) {
      let id: string;
      try { id = decodeURIComponent(extractionRoute[1]); } catch { return fail(400, 'invalid_request', 'Article ID is invalid.'); }
      if (!isArticleId(id)) return fail(400, 'invalid_request', 'Article ID must contain eight lowercase letters or digits.');
      if (method === 'GET' && !extractionRoute[2]) {
        const extraction = await getExtractionStatus(env.DB, id, isBackgroundCapturePaused(env));
        return extraction ? jsonResponse({ extraction }) : fail(404, 'not_found', 'Article not found.');
      }
      if (method === 'POST' && (extractionRoute[2] === '/recapture' || extractionRoute[2] === '/undo')) {
        const undo = extractionRoute[2] === '/undo';
        const input = parseObject(await readJson(request), undo ? ['expectedRevision'] : ['expectedRevision', 'refreshMetadata'], ['expectedRevision']);
        const expected = input.expectedRevision;
        if ((expected !== null || undo) && (typeof expected !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(expected))) {
          throw new ValidationError('expectedRevision must be a valid revision' + (undo ? '' : ' or null'));
        }
        if (input.refreshMetadata !== undefined && typeof input.refreshMetadata !== 'boolean') throw new ValidationError('refreshMetadata must be boolean');
        const result = undo
          ? await undoRecapture(env.DB, id, expected as string)
          : await requestRecapture(env.DB, id, expected as string | null, input.refreshMetadata === true);
        if (result === 'missing') return fail(404, 'not_found', 'Article not found.');
        if (result === 'revision_conflict' || result === 'conflict') return fail(409, 'revision_conflict', 'The saved copy or article details changed. Reload before trying again.');
        if (result === 'capture_active') return fail(409, 'capture_active', 'Another capture is already queued or running for this article.');
        if (result === 'cooldown') {
          const response = fail(429, 'retry_cooldown', 'Wait one minute before starting another capture.');
          response.headers.set('Retry-After', '60');
          return response;
        }
        if (!undo && result === 'queued') await scheduleExtraction(env, id, ctx);
        return jsonResponse({ extraction: await getExtractionStatus(env.DB, id, isBackgroundCapturePaused(env)) }, result === 'queued' ? 202 : 200);
      }
      if (method === 'POST' && extractionRoute[2] === '/retry') {
        // Accept an empty body or an empty object; retries cannot select another
        // source, publish a copy, or change a saved revision.
        if (request.body) parseObject(await readJson(request), []);
        const result = await retryExtractionJob(env.DB, id);
        if (result === 'missing') return fail(404, 'not_found', 'Article not found.');
        if (result === 'cooldown') {
          const response = fail(429, 'retry_cooldown', 'Wait one minute before retrying Markdown capture.');
          response.headers.set('Retry-After', '60');
          return response;
        }
        if (result === 'queued') await scheduleExtraction(env, id, ctx);
        return jsonResponse({ extraction: await getExtractionStatus(env.DB, id, isBackgroundCapturePaused(env)) });
      }
    }
    const detail = /^\/api\/articles\/([^/]+)$/.exec(url.pathname);
    if (detail) {
      let id: string;
      try { id = decodeURIComponent(detail[1]); } catch { return fail(400, 'invalid_request', 'Article ID is invalid.'); }
      if (!isArticleId(id)) return fail(400, 'invalid_request', 'Article ID must contain eight lowercase letters or digits.');
      if (method === 'GET') {
        const article = await getArticle(env.DB, id);
        if (!article) return fail(404, 'not_found', 'Article not found.');
        const extraction = await getExtractionStatus(env.DB, id, isBackgroundCapturePaused(env));
        return jsonResponse({ article: { ...article, originalPdf: await getOriginalPdf(env.DB, article.id), hasCopy: extraction?.state === 'ready', extraction, enrichment: (await enrichmentStatuses(env, [id])).get(id) } });
      }
      if (method === 'PATCH') return await patchArticle(request, env, id);
      if (method === 'DELETE') { await deleteArticle(env.DB, id); return new Response(null, { status: 204, headers: PRIVATE }); }
    }
    const copyRoute = /^\/api\/articles\/([^/]+)\/copy$/.exec(url.pathname);
    if (copyRoute) {
      let id: string;
      try { id = decodeURIComponent(copyRoute[1]); } catch { return fail(400, 'invalid_request', 'Article ID is invalid.'); }
      if (!isArticleId(id)) return fail(400, 'invalid_request', 'Article ID must contain eight lowercase letters or digits.');
      if (method === 'GET') {
        if (!(await getArticle(env.DB, id))) return fail(404, 'not_found', 'Article not found.');
        return jsonResponse({ copy: await getArticleCopy(env.DB, id) });
      }
      if (method === 'PUT') return await putArticleCopy(request, env, id, ctx);
    }
    return null;
  } catch (error) {
    if (error instanceof IntegrationError) return fail(error.status, error.code, error.message);
    return exceptionResponse(error, 'articles.request', storageError);
  }
}

async function previewArticle(request: Request, env: Env): Promise<Response> {
  const input = parseObject(await readJson(request), ['url'], ['url']);
  const { url } = normalizeArticleUrl(input.url);
  try {
    const { markdown, metadata, sourceUrl } = await captureArticlePreview(url, env, request.signal);
    const article: ArticlePreview = {
      url: sourceUrl ?? url,
      title: metadata.title?.trim() || defaultTitle(sourceUrl ?? url),
      author: metadata.author?.trim() || null,
      description: metadata.description?.trim() || null,
      markdown,
    };
    return jsonResponse({ article });
  } catch (error) {
    if (!(error instanceof SourceFetchError)) throw error;
    switch (error.code) {
      case 'capture_paused':
      case 'capture_busy':
      case 'capture_unavailable':
      case 'converter_unavailable':
        return fail(503, error.code, 'Reader previews are temporarily unavailable. Try again or open the website.');
      case 'timeout':
      case 'conversion_timeout':
        return fail(504, error.code, 'The preview took too long. Try again or open the website.');
      case 'invalid_url':
      case 'unsafe_destination':
        return fail(422, error.code, 'This link cannot be opened in the reader.');
      default:
        return fail(502, error.code, 'This page could not be loaded in the reader. You can still open the website.');
    }
  }
}

function validateCopyMarkdown(markdown: unknown): string {
  if (typeof markdown !== 'string') throw new ValidationError('markdown must be text');
  if (!markdown.trim()) throw new ValidationError('Markdown copy must not be blank');
  const encoded = new TextEncoder().encode(markdown);
  if (new TextDecoder('utf-8', { fatal: true }).decode(encoded) !== markdown) throw new ValidationError('Markdown copy must contain valid Unicode text');
  if (encoded.byteLength > MAX_MARKDOWN_BYTES) throw new BodyTooLargeError(`Markdown copy must be at most ${MAX_MARKDOWN_BYTES} UTF-8 bytes`);
  return markdown;
}

async function putArticleCopy(request: Request, env: Env, id: string, ctx?: ExecutionContext): Promise<Response> {
  const input = parseObject(await readJson(request, MAX_COPY_ENVELOPE_BYTES), ['markdown', 'source', 'expectedRevision'], ['markdown', 'source', 'expectedRevision']);
  const markdown = validateCopyMarkdown(input.markdown);
  if (input.source !== 'paste' && input.source !== 'upload') throw new ValidationError('source must be paste or upload');
  const expectedRevision = input.expectedRevision;
  if (expectedRevision !== null && (typeof expectedRevision !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(expectedRevision))) {
    throw new ValidationError('expectedRevision must be null or a valid revision');
  }
  const copy: ArticleCopy = { markdown, capturedAt: new Date().toISOString(), source: input.source, revision: crypto.randomUUID() };
  const result = await saveArticleCopy(env.DB, id, copy, expectedRevision as string | null);
  if (result === 'missing') return fail(404, 'not_found', 'Article not found.');
  if (result === 'conflict') return fail(409, 'revision_conflict', 'This copy changed since you opened it. Reload it before replacing.');
  await scheduleEnrichment(env, id, ctx);
  return jsonResponse({ copy: result });
}

async function createArticle(request: Request, env: Env, tokenCapture = false, ctx?: ExecutionContext): Promise<Response> {
  const fields = ['url', 'title', 'author', 'description', 'captureMarkdown', 'enrichAfterCopy'];
  if (!tokenCapture) fields.push('previewMarkdown');
  const input = parseObject(await readJson(request, tokenCapture ? undefined : MAX_COPY_ENVELOPE_BYTES), fields, ['url']);
  if (tokenCapture && ('author' in input || 'description' in input || 'enrichAfterCopy' in input)) throw new ValidationError('capture tokens cannot set article metadata');
  if (input.enrichAfterCopy !== undefined && typeof input.enrichAfterCopy !== 'boolean') throw new ValidationError('enrichAfterCopy must be a boolean');
  if (input.captureMarkdown !== undefined && typeof input.captureMarkdown !== 'boolean') throw new ValidationError('captureMarkdown must be a boolean');
  const extractionRequested = input.captureMarkdown === true || (tokenCapture && input.captureMarkdown !== false);
  const copy: ArticleCopy | undefined = 'previewMarkdown' in input
    ? { markdown: validateCopyMarkdown(input.previewMarkdown), capturedAt: new Date().toISOString(), source: 'paste', revision: crypto.randomUUID() }
    : undefined;
  if (copy && extractionRequested) throw new ValidationError('A preview copy does not need background capture.');
  const normalized = normalizeArticleUrl(input.url);
  const fallbackTitle = defaultTitle(normalized.url);
  const suppliedTitle = input.title === undefined ? undefined : validateTitle(input.title, fallbackTitle);
  const title = suppliedTitle || fallbackTitle;
  const author = input.author === undefined ? undefined : optionalMetadata(input.author, 'author', 200);
  const description = input.description === undefined ? undefined : optionalMetadata(input.description, 'description', 500);
  const result = await saveArticle(env.DB, {
    ...normalized, title, author: author ?? undefined, description: description ?? undefined, copy, extractionRequested, enrichmentRequested: enrichmentEnabled(env), enrichAfterCopy: input.enrichAfterCopy === true,
    titleOrigin: suppliedTitle ? 'supplied' : 'fallback',
  });
  if (extractionRequested) await scheduleExtraction(env, result.article.id, ctx);
  if (!result.duplicate || copy) await scheduleEnrichment(env, result.article.id, ctx);
  // Capture tokens can confirm that work was accepted, but cannot learn
  // whether a URL already exists or inspect any stored article metadata.
  if (tokenCapture) return jsonResponse({ ok: true, extractionRequested });
  return jsonResponse({ ...result, enrichment: (await enrichmentStatuses(env, [result.article.id])).get(result.article.id), extraction: await getExtractionStatus(env.DB, result.article.id, isBackgroundCapturePaused(env)) }, result.duplicate ? 200 : 201);
}

async function capture(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  if (request.headers.has('Cookie') || request.headers.has('Origin')) return fail(403, 'forbidden', 'Capture requests must use a bearer token without browser credentials.');
  let auth: Awaited<ReturnType<typeof validateCaptureToken>>;
  try { auth = await validateCaptureToken(request, env); } catch (error) { return exceptionResponse(error, 'articles.capture_auth', storageError); }
  if (isResponse(auth)) return auth;
  try {
    return await createArticle(request, env, true, ctx);
  } catch (error) {
    return exceptionResponse(error, 'articles.capture', storageError);
  }
}

async function listRoute(url: URL, env: Env): Promise<Response> {
  const allowed = new Set(['status', 'q', 'tag', 'limit', 'cursor']);
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
  const rawTag = url.searchParams.get('tag');
  const tag = rawTag === null ? undefined : normalizeTags([rawTag])[0];
  const page = await listArticles(env.DB, { status, q, tag, limit, cursor });
  const paused = isBackgroundCapturePaused(env);
  const statuses = await getExtractionStatuses(env.DB, page.items.map(article => article.id), paused);
  const enrichments = await enrichmentStatuses(env, page.items.map(a => a.id));
  const pdfs = await originalPdfSummaries(env.DB, page.items.map(a => a.id));
  const podcastFits = env.ARTICLE_AUDIO_ENABLED === 'true'
    ? await getPodcastFitStatuses(env.DB, page.items.map(article => article.id))
    : new Map();
  return jsonResponse({ ...page, capture: { paused }, items: page.items.map(article => {
    const extraction = statuses.get(article.id);
    return { ...article, enrichment: enrichments.get(article.id), originalPdf: pdfs.get(article.id), hasCopy: extraction?.state === 'ready', extraction,
      ...(podcastFits.has(article.id) ? { podcastFit: podcastFits.get(article.id) } : {}) };
  }) });
}

async function patchArticle(request: Request, env: Env, id: string): Promise<Response> {
  const input = parseObject(await readJson(request), ['read', 'title', 'author', 'description', 'tags']);
  if (!Object.keys(input).length) throw new ValidationError('at least one field is required');
  if ('read' in input && typeof input.read !== 'boolean') throw new ValidationError('read must be a boolean');
  const patch: { read?: boolean; title?: string; author?: string | null; description?: string | null; tags?: string[] } = {};
  if ('read' in input) patch.read = input.read as boolean;
  if ('title' in input) {
    if (typeof input.title !== 'string') throw new ValidationError('title must be a string');
    const title = input.title.trim();
    if (!title || title.length > MAX_TITLE_LENGTH) throw new ValidationError('title must contain 1 to 500 characters');
    patch.title = title;
  }
  if ('author' in input) patch.author = input.author === null ? null : optionalMetadata(input.author, 'author', 200);
  if ('tags' in input) patch.tags = normalizeTags(input.tags);
  if ('description' in input) patch.description = input.description === null ? null : optionalMetadata(input.description, 'description', 500);
  const article = await updateArticle(env.DB, id, patch);
  if (!article) return fail(404, 'not_found', 'Article not found.');
  const extraction = await getExtractionStatus(env.DB, id, isBackgroundCapturePaused(env));
  return jsonResponse({ article: { ...article, originalPdf: await getOriginalPdf(env.DB, article.id), hasCopy: extraction?.state === 'ready', extraction, enrichment: (await enrichmentStatuses(env, [id])).get(id) } });
}

function optionalMetadata(value: unknown, field: string, limit: number): string | null {
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > limit) throw new ValidationError(`${field} must be at most ${limit} characters`);
  return trimmed || null;
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
      controller.enqueue(encoder.encode(`{"version":3,"exportedAt":${JSON.stringify(exportedAt)},"articles":[`));
    },
    async pull(controller) {
      try {
        if (pageIndex >= page.items.length && page.nextCursor) {
          page = await listArticlesForExport(env.DB, 25, page.nextCursor);
          pageIndex = 0;
        }
        if (pageIndex < page.items.length) {
          const { article, copy } = page.items[pageIndex++];
          const portable = { id: article.id, url: article.url, title: article.title, author: article.author, description: article.description,
            tags: article.tags, descriptionOrigin: article.descriptionOrigin, tagsManuallyEdited: article.tagsManuallyEdited,
            createdAt: article.createdAt, updatedAt: article.updatedAt, readAt: article.readAt,
            ...(copy ? { copy: { markdown: copy.markdown, capturedAt: copy.capturedAt, source: copy.source, revision: copy.revision } } : {}) };
          controller.enqueue(encoder.encode(`${emitted++ ? ',' : ''}${JSON.stringify(portable)}`));
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
