import { SourceFetchError } from '../articles/capture-protocol';
import { normalizeArticleUrl, parseObject, readJson, ValidationError } from '../articles/validation';
import { isResponse, requireSession } from '../auth/core';
import type { Env } from '../contracts';
import { errorResponse, exceptionResponse, jsonResponse } from '../http';
import {
  expireFeedItems, FEED_HISTORY, MAX_RETENTION_DAYS, previewRetention, pruneFeedItems,
  trimPrunedHistory, updateRetention,
} from './retention';
import { fetchFeedDocument, type FeedDocument } from './source';

const MAX_FEEDS = 40;
const PAGE_SIZE = 50;
// Leave room in the hourly invocation for one more capture service timeout.
const REFRESH_BUDGET_MS = 10 * 60 * 1000;
const FEED_ID = /^[0-9a-f]{32}$/;
const FEED_COLUMNS = 'id, url, title, last_fetched_at, last_error, retention_days, retention_count';
const RETENTION_FIELDS = ['retentionDays', 'retentionCount'];
const storageError = { status: 503, code: 'storage_unavailable', message: 'Feeds are temporarily unavailable. Please retry.' };
const createId = () => crypto.randomUUID().replaceAll('-', '');

type FeedRow = {
  id: string; url: string; title: string; last_fetched_at: string | null; last_error: string | null;
  retention_days: number | null; retention_count: number | null;
};
type TimelineRow = { id: string; feed_id: string; url: string; title: string; preview: string; published_at: string; seen: number; saved: number };
type StoredItem = { id: string; key: string; url: string; normalizedUrl: string; title: string; preview: string; publishedAt: string | null };
type Cursor = { publishedAt: string; id: string };

function feedSummary(row: FeedRow) {
  return {
    id: row.id, url: row.url, title: row.title, lastFetchedAt: row.last_fetched_at, lastError: row.last_error,
    retentionDays: row.retention_days, retentionCount: row.retention_count,
  };
}

async function findFeed(db: D1Database, url: string) {
  return db.prepare(`SELECT ${FEED_COLUMNS} FROM feeds WHERE url = ?`).bind(url).first<FeedRow>();
}

async function feedLimitReached(db: D1Database) {
  const result = await db.prepare('SELECT COUNT(*) AS count FROM feeds').first<{ count: number }>();
  return (result?.count ?? 0) >= MAX_FEEDS;
}

function feedLimitError() {
  return errorResponse(429, 'feed_limit', `You can subscribe to up to ${MAX_FEEDS} feeds.`);
}

function storedItems(doc: FeedDocument): StoredItem[] {
  const items: StoredItem[] = [];
  for (const item of doc.items) {
    try {
      const { url, normalizedUrl } = normalizeArticleUrl(item.url);
      items.push({
        id: createId(), key: item.key, url, normalizedUrl,
        title: item.title.slice(0, 500), preview: item.preview.slice(0, 500),
        publishedAt: item.publishedAt ? new Date(item.publishedAt).toISOString() : null,
      });
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
    }
  }
  return items;
}

async function saveDocument(db: D1Database, feed: { id: string; url: string }, doc: FeedDocument, initial = false) {
  const now = new Date().toISOString();
  const title = doc.title.slice(0, 300) || new URL(feed.url).hostname;
  const statements = [initial
    ? db.prepare('INSERT INTO feeds(id, url, title, created_at, last_fetched_at, last_attempt_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(feed.id, feed.url, title, now, now, now)
    : db.prepare(`UPDATE feeds SET title = ?, last_fetched_at = ?, last_error = NULL,
        refresh_sequence = refresh_sequence + 1 WHERE id = ?`).bind(title, now, feed.id)];
  const items = storedItems(doc);
  // Batch rows through JSON so an hourly run stays within D1's query budget.
  for (let offset = 0; offset < items.length; offset += 20) {
    statements.push(db.prepare(`
      INSERT INTO feed_items(id, feed_id, entry_key, url, normalized_url, title, preview, published_at, seen)
      SELECT COALESCE(i.id, h.id, json_extract(j.value, '$.id')), f.id, json_extract(j.value, '$.key'),
        json_extract(j.value, '$.url'), json_extract(j.value, '$.normalizedUrl'),
        json_extract(j.value, '$.title'), json_extract(j.value, '$.preview'),
        COALESCE(json_extract(j.value, '$.publishedAt'), i.published_at, h.published_at, ?2),
        COALESCE(i.seen, h.seen, 0)
      FROM json_each(?3) j JOIN feeds f ON f.id = ?1
      LEFT JOIN feed_items i ON i.feed_id = f.id AND i.entry_key = json_extract(j.value, '$.key')
      LEFT JOIN feed_item_history h ON h.feed_id = f.id AND h.entry_key = json_extract(j.value, '$.key')
      WHERE 1
      ON CONFLICT(feed_id, entry_key) DO UPDATE SET
        url = excluded.url, normalized_url = excluded.normalized_url, title = excluded.title,
        preview = excluded.preview, published_at = excluded.published_at
      WHERE (feed_items.url, feed_items.normalized_url, feed_items.title, feed_items.preview, feed_items.published_at)
        IS NOT (excluded.url, excluded.normalized_url, excluded.title, excluded.preview, excluded.published_at)
    `).bind(feed.id, now, JSON.stringify(items.slice(offset, offset + 20))));
  }
  statements.push(pruneFeedItems(db, feed.id, now), trimPrunedHistory(db, feed.id));
  await db.batch(statements);
  return { ...feed, title, last_fetched_at: now, last_error: null };
}

export async function refreshFeeds(env: Env): Promise<void> {
  await expireFeedItems(env.DB, new Date().toISOString());
  if (!env.ARTICLE_EXTRACTOR) return;
  const startedAt = Date.now();
  const feeds = await env.DB.prepare('SELECT id, url FROM feeds ORDER BY COALESCE(last_attempt_at, created_at), id LIMIT ?')
    .bind(MAX_FEEDS).all<{ id: string; url: string }>();
  // The capture container processes one article, feed, or audio job at a time.
  for (const feed of feeds.results) {
    if (Date.now() - startedAt >= REFRESH_BUDGET_MS) break;
    const attempt = await env.DB.prepare('UPDATE feeds SET last_attempt_at = ? WHERE id = ?').bind(new Date().toISOString(), feed.id).run();
    if (!attempt.meta.changes) continue;
    try {
      await saveDocument(env.DB, feed, await fetchFeedDocument(env, feed.url));
    } catch (error) {
      if (error instanceof SourceFetchError && error.code === 'capture_busy') break;
      if (!(error instanceof SourceFetchError)) throw error;
      await env.DB.prepare('UPDATE feeds SET last_error = ? WHERE id = ?').bind(error.code, feed.id).run();
    }
  }
}

async function subscribe(request: Request, env: Env): Promise<Response> {
  const input = parseObject(await readJson(request), ['url'], ['url']);
  const { url } = normalizeArticleUrl(input.url);
  const target = new URL(url);
  target.hash = '';
  const existing = await findFeed(env.DB, target.href);
  if (existing) return jsonResponse({ feed: feedSummary(existing) });
  if (await feedLimitReached(env.DB)) return feedLimitError();

  let doc: FeedDocument;
  try {
    doc = await fetchFeedDocument(env, target.href);
  } catch (error) {
    if (error instanceof SourceFetchError && !error.retryable) {
      return errorResponse(422, 'invalid_feed', 'That URL did not return a readable RSS or Atom feed.');
    }
    return errorResponse(503, 'feed_unavailable', 'Couldn’t fetch the feed. Please try again.');
  }
  try {
    const feed = await saveDocument(env.DB, { id: createId(), url: target.href }, doc, true);
    return jsonResponse({ feed: feedSummary({ ...feed, retention_days: null, retention_count: null }) });
  } catch (error) {
    const concurrent = await findFeed(env.DB, target.href);
    if (concurrent) return jsonResponse({ feed: feedSummary(concurrent) });
    if (await feedLimitReached(env.DB)) return feedLimitError();
    throw error;
  }
}

function retentionNumber(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${label} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

async function handleRetention(request: Request, db: D1Database, feedId: string, preview: boolean): Promise<Response> {
  const fields = preview ? RETENTION_FIELDS : [...RETENTION_FIELDS, 'maxRemovals'];
  const input = parseObject(await readJson(request), fields, fields);
  const limits = {
    retentionDays: input.retentionDays === null ? null : retentionNumber(input.retentionDays, 'Days', 1, MAX_RETENTION_DAYS),
    retentionCount: input.retentionCount === null ? null : retentionNumber(input.retentionCount, 'Articles', 1, FEED_HISTORY),
  };
  const now = new Date().toISOString();
  const missingFeed = () => errorResponse(404, 'not_found', 'This feed is no longer available.');
  if (preview) {
    const plan = await previewRetention(db, feedId, now, limits);
    return plan ? jsonResponse(plan) : missingFeed();
  }
  const maxRemovals = retentionNumber(input.maxRemovals, 'Removal limit', 0, FEED_HISTORY);
  const [updated, removed, , selected] = await db.batch<FeedRow>([
    updateRetention(db, feedId, now, limits, maxRemovals),
    pruneFeedItems(db, feedId, now, true),
    trimPrunedHistory(db, feedId),
    db.prepare(`SELECT ${FEED_COLUMNS} FROM feeds WHERE id = ?`).bind(feedId),
  ]);
  const feed = selected.results[0];
  if (!feed) return missingFeed();
  if (!updated.meta.changes) {
    return errorResponse(409, 'retention_preview_changed', 'More articles would be removed now. Review the updated preview and try again.');
  }
  return jsonResponse({ feed: feedSummary(feed), removed: removed.results.length });
}

function parseCursor(value: string | null): Cursor | null {
  if (value === null) return null;
  try {
    if (value.length <= 256) {
      const cursor = JSON.parse(atob(value)) as Partial<Cursor> | null;
      if (typeof cursor?.id === 'string' && FEED_ID.test(cursor.id) &&
          typeof cursor.publishedAt === 'string' && new Date(cursor.publishedAt).toISOString() === cursor.publishedAt) {
        return { id: cursor.id, publishedAt: cursor.publishedAt };
      }
    }
  } catch { /* Invalid cursor. */ }
  throw new ValidationError('Invalid feed cursor.');
}

async function listItems(db: D1Database, params: URLSearchParams): Promise<Response> {
  const status = params.get('status') ?? 'new';
  if (status !== 'new' && status !== 'all') throw new ValidationError('Feed status must be new or all.');
  const feedId = params.get('feedId');
  if (feedId && !FEED_ID.test(feedId)) throw new ValidationError('Invalid feed ID.');
  const cursor = parseCursor(params.get('cursor'));
  const clauses = [status === 'new' ? 'i.seen = 0' : '1 = 1'];
  const values: string[] = [];
  if (feedId) {
    clauses.push('i.feed_id = ?');
    values.push(feedId);
  }
  if (cursor) {
    clauses.push('(i.published_at, i.id) < (?, ?)');
    values.push(cursor.publishedAt, cursor.id);
  }
  const rows = await db.prepare(`
    SELECT i.id, i.feed_id, i.url, i.title, i.preview, i.published_at, i.seen,
      EXISTS(SELECT 1 FROM articles a WHERE a.normalized_url = i.normalized_url) AS saved
    FROM feed_items i WHERE ${clauses.join(' AND ')}
    ORDER BY i.published_at DESC, i.id DESC LIMIT ?
  `).bind(...values, PAGE_SIZE + 1).all<TimelineRow>();
  const page = rows.results.slice(0, PAGE_SIZE);
  const last = page.at(-1);
  return jsonResponse({
    items: page.map(row => ({
      id: row.id, feedId: row.feed_id, url: row.url, title: row.title, preview: row.preview,
      publishedAt: row.published_at, seen: Boolean(row.seen), saved: Boolean(row.saved),
    })),
    nextCursor: rows.results.length > PAGE_SIZE && last ? btoa(JSON.stringify({ id: last.id, publishedAt: last.published_at })) : null,
  });
}

export async function handleFeeds(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const { pathname, searchParams } = url;
  const method = request.method;
  const feed = /^\/api\/feeds\/([0-9a-f]{32})$/.exec(pathname);
  const item = /^\/api\/feeds\/items\/([0-9a-f]{32})$/.exec(pathname);
  const retentionPreview = /^\/api\/feeds\/([0-9a-f]{32})\/retention-preview$/.exec(pathname);
  if (pathname !== '/api/feeds' && pathname !== '/api/feeds/items' && !feed && !item && !retentionPreview) return null;
  try {
    const session = await requireSession(request, env, method !== 'GET');
    if (isResponse(session)) return session;
    if (pathname === '/api/feeds' && method === 'GET') {
      const result = await env.DB.prepare(`SELECT ${FEED_COLUMNS} FROM feeds ORDER BY created_at, id`).all<FeedRow>();
      return jsonResponse({ feeds: result.results.map(feedSummary) });
    }
    if (pathname === '/api/feeds' && method === 'POST') return await subscribe(request, env);
    if (pathname === '/api/feeds/items' && method === 'GET') return await listItems(env.DB, searchParams);
    if (retentionPreview && method === 'POST') return await handleRetention(request, env.DB, retentionPreview[1], true);
    if (feed && method === 'PATCH') return await handleRetention(request, env.DB, feed[1], false);
    if (feed && method === 'DELETE') {
      await env.DB.prepare('DELETE FROM feeds WHERE id = ?').bind(feed[1]).run();
      return jsonResponse({ ok: true });
    }
    if (item && method === 'PATCH') {
      const input = parseObject(await readJson(request), ['seen'], ['seen']);
      if (typeof input.seen !== 'boolean') throw new ValidationError('Seen must be a boolean.');
      const updated = await env.DB.prepare('UPDATE feed_items SET seen = ? WHERE id = ?').bind(input.seen ? 1 : 0, item[1]).run();
      return updated.meta.changes ? jsonResponse({ ok: true }) : errorResponse(404, 'not_found', 'This feed item is no longer available.');
    }
    return errorResponse(405, 'method_not_allowed', 'This feed action is not supported.');
  } catch (error) {
    return exceptionResponse(error, 'feeds.request', storageError);
  }
}
