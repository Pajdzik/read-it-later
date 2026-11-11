import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/contracts';
import type { FeedDocument } from '../src/feeds/source';
import { refreshFeeds } from '../src/feeds/handler';
import worker from '../src/worker';

const origin = 'http://localhost:8787';
const fetchFeed = vi.fn<Fetcher['fetch']>();
const bindings: Env = {
  ...env, APP_ORIGIN: origin, DEV_AUTH_BYPASS: 'true', MANAGED_CONVERSION_ENABLED: 'false',
  ARTICLE_EXTRACTOR: { fetch: fetchFeed, connect() { throw new Error('Unexpected socket connection'); } },
};
const entries: FeedDocument['items'] = [
  { key: 'first', url: 'https://example.com/first', title: 'First', preview: 'Short preview', publishedAt: '2026-11-10T12:00:00.000Z' },
  { key: 'second', url: 'https://example.com/second', title: 'Second', preview: 'Another preview', publishedAt: '2026-11-09T12:00:00.000Z' },
];
type Item = { id: string; title: string; seen: boolean; saved: boolean; publishedAt: string };
function request(path: string, method = 'GET', body?: unknown) {
  return new Request(origin + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': 'dev-bypass' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function json<T = unknown>(path: string, method = 'GET', body?: unknown) {
  const response = await worker.fetch(request(path, method, body), bindings);
  return { response, data: await response.json<T>() };
}
const addFeed = (url = 'https://example.com/feed.xml') => json<{ feed: { id: string } }>('/api/feeds', 'POST', { url });
const timeline = (query = '') => json<{ items: Item[]; nextCursor: string | null }>(`/api/feeds/items${query}`);

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM feeds').run();
  await env.DB.prepare('DELETE FROM articles').run();
  fetchFeed.mockReset();
  fetchFeed.mockImplementation(async (url, init) => {
    expect(String(url)).toBe('https://capture.internal/feed');
    expect(init?.method).toBe('POST');
    return Response.json({ version: 1, ok: true, feed: { title: 'Test Feed', items: entries } });
  });
});

describe('feeds API', () => {
  it('subscribes, preserves seen state on refresh, filters timeline and joins saved articles by normalized URL', async () => {
    const added = await addFeed();
    expect(added.response.status).toBe(200);
    const feed = added.data.feed;
    expect(feed).toMatchObject({ title: 'Test Feed', lastFetchedAt: expect.any(String), lastError: null });
    const all = await timeline(`?status=all&feedId=${feed.id}`);
    expect(all.data.items.map(item => item.title)).toEqual(['First', 'Second']);
    const itemId = all.data.items[0].id;
    expect((await json(`/api/feeds/items/${itemId}`, 'PATCH', { seen: true })).response.status).toBe(200);
    await json('/api/articles', 'POST', { url: 'https://example.com/second?utm_source=feed' });
    await refreshFeeds(bindings);
    expect(fetchFeed).toHaveBeenCalledTimes(2);
    const newItems = await timeline();
    expect(newItems.data.items.map(item => item.title)).toEqual(['Second']);
    const refreshed = await timeline('?status=all');
    expect(refreshed.data.items.find(item => item.id === itemId)?.seen).toBe(true);
    expect(refreshed.data.items.find(item => item.title === 'Second')?.saved).toBe(true);
  });

  it('enforces write CSRF and removes feed entries with the subscription', async () => {
    const added = await addFeed();
    const id = added.data.feed.id;
    const noCsrf = await worker.fetch(new Request(origin + `/api/feeds/${id}`, { method: 'DELETE', headers: { Origin: origin } }), bindings);
    expect(noCsrf.status).toBe(403);
    expect((await json(`/api/feeds/${id}`, 'DELETE')).data).toEqual({ ok: true });
    expect((await timeline('?status=all')).data.items).toEqual([]);
  });

  it('keeps failed subscriptions out of the list and pages across identical dates', async () => {
    fetchFeed.mockImplementationOnce(async () => Response.json({ version: 1, ok: false, error: { code: 'invalid_feed', retryable: false } }));
    expect((await addFeed()).response.status).toBe(422);
    expect((await json('/api/feeds')).data).toEqual({ feeds: [] });

    const undated = Array.from({ length: 52 }, (_, i) => ({ ...entries[0], key: String(i), url: `https://example.com/${i}`, publishedAt: null }));
    fetchFeed.mockImplementation(async () => Response.json({ version: 1, ok: true, feed: { title: 'Undated entries', items: undated } }));
    expect((await addFeed()).response.status).toBe(200);
    const first = (await timeline()).data;
    expect(first.items).toHaveLength(50);
    const second = (await timeline(`?${new URLSearchParams({ cursor: first.nextCursor! })}`)).data;
    expect(second.items).toHaveLength(2);
    expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(52);
    await refreshFeeds(bindings);
    expect((await timeline()).data).toEqual(first);
  });
});
