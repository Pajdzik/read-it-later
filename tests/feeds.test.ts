import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
type Retention = { retentionDays: number | null; retentionCount: number | null };
type Feed = Retention & { id: string; lastError: string | null };
function request(path: string, method = 'GET', body?: unknown) {
  return new Request(origin + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': 'dev-bypass' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function json<T = unknown>(path: string, method = 'GET', body?: unknown) {
  const response = await worker.fetch(request(path, method, body), bindings);
  return { response, data: await response.json<T>() };
}
const addFeed = (url = 'https://example.com/feed.xml') => json<{ feed: Feed }>('/api/feeds', 'POST', { url });
const timeline = (query = '') => json<{ items: Item[]; nextCursor: string | null }>(`/api/feeds/items${query}`);
const feeds = () => json<{ feeds: Feed[] }>('/api/feeds');
const previewRetention = (id: string, retention: Retention) =>
  json<{ total: number; removed: number }>(`/api/feeds/${id}/retention-preview`, 'POST', retention);
const applyRetention = (id: string, retention: Retention, maxRemovals: number) =>
  json<{ feed: Feed; removed: number }>(`/api/feeds/${id}`, 'PATCH', { ...retention, maxRemovals });
const feedResponse = (items: FeedDocument['items']) =>
  Response.json({ version: 1, ok: true, feed: { title: 'Test Feed', items } });

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM feeds').run();
  await env.DB.prepare('DELETE FROM articles').run();
  fetchFeed.mockReset();
  fetchFeed.mockImplementation(async (url, init) => {
    expect(String(url)).toBe('https://capture.internal/feed');
    expect(init?.method).toBe('POST');
    return feedResponse(entries);
  });
});

afterEach(() => vi.useRealTimers());

describe('feeds API', () => {
  it('subscribes, preserves seen state on refresh, filters timeline and joins saved articles by normalized URL', async () => {
    const added = await addFeed();
    expect(added.response.status).toBe(200);
    const feed = added.data.feed;
    expect(feed).toMatchObject({
      title: 'Test Feed', lastFetchedAt: expect.any(String), lastError: null, retentionDays: null, retentionCount: null,
    });
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
    for (const [method, path] of [['PATCH', `/api/feeds/${id}`], ['POST', `/api/feeds/${id}/retention-preview`]]) {
      const forbidden = await worker.fetch(new Request(origin + path, { method, headers: { Origin: origin } }), bindings);
      expect(forbidden.status).toBe(403);
    }
    expect((await json(`/api/feeds/${id}`, 'DELETE')).data).toEqual({ ok: true });
    expect((await timeline('?status=all')).data.items).toEqual([]);
  });

  it('keeps failed subscriptions out of the list and pages across identical dates', async () => {
    fetchFeed.mockImplementationOnce(async () => Response.json({ version: 1, ok: false, error: { code: 'invalid_feed', retryable: false } }));
    expect((await addFeed()).response.status).toBe(422);
    expect((await json('/api/feeds')).data).toEqual({ feeds: [] });

    const undated = Array.from({ length: 52 }, (_, i) => ({ ...entries[0], key: String(i), url: `https://example.com/${i}`, publishedAt: null }));
    fetchFeed.mockImplementation(async () => feedResponse(undated));
    expect((await addFeed()).response.status).toBe(200);
    const first = (await timeline()).data;
    expect(first.items).toHaveLength(50);
    const second = (await timeline(`?${new URLSearchParams({ cursor: first.nextCursor! })}`)).data;
    expect(second.items).toHaveLength(2);
    expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(52);
    await refreshFeeds(bindings);
    expect((await timeline()).data).toEqual(first);
  });

  it('previews both limits, clears one feed, and keeps saved reading list articles', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-10T18:00:00.000Z'));
    const third = { ...entries[0], key: 'third', url: 'https://example.com/third', title: 'Third', publishedAt: '2026-11-08T12:00:00.000Z' };
    fetchFeed.mockImplementation(async () => feedResponse([...entries, third]));
    const { data: { feed } } = await addFeed();
    const { data: { feed: untouched } } = await addFeed('https://example.com/other-feed.xml');
    const { data: { article: saved } } = await json<{ article: { id: string } }>('/api/articles', 'POST', { url: third.url });
    const feedItems = () => timeline(`?status=all&feedId=${feed.id}`);
    const original = (await feedItems()).data.items;
    expect(original[2]).toMatchObject({ title: 'Third', saved: true });
    const retention = { retentionDays: 2, retentionCount: 1 };

    const preview = await previewRetention(feed.id, retention);
    expect(preview.response.status).toBe(200);
    expect(preview.data).toEqual({ total: 3, removed: 2 });
    expect((await feedItems()).data.items).toEqual(original);
    expect((await feeds()).data.feeds.find(candidate => candidate.id === feed.id)).toMatchObject({ retentionDays: null, retentionCount: null });

    const applied = await applyRetention(feed.id, retention, preview.data.removed);
    expect(applied.response.status).toBe(200);
    expect(applied.data).toMatchObject({ feed: { id: feed.id, ...retention }, removed: 2 });
    expect((await feedItems()).data.items).toEqual([original[0]]);
    expect((await timeline(`?feedId=${feed.id}`)).data.items).toEqual([original[0]]);
    expect((await timeline(`?status=all&feedId=${untouched.id}`)).data.items.map(item => item.title)).toEqual(['First', 'Second', 'Third']);
    expect((await timeline('?status=all')).data.items.map(item => item.title)).toEqual(['First', 'First', 'Second', 'Third']);
    expect((await feeds()).data.feeds.find(candidate => candidate.id === untouched.id)).toMatchObject({ retentionDays: null, retentionCount: null });
    expect((await json(`/api/articles/${saved.id}`)).response.status).toBe(200);

    const restored = await applyRetention(feed.id, { retentionDays: null, retentionCount: null }, 0);
    expect(restored.data).toMatchObject({ feed: { retentionDays: null, retentionCount: null }, removed: 0 });
  });

  it('requires a new confirmation when more entries would be removed after a refresh', async () => {
    const { data: { feed } } = await addFeed();
    const retention = { retentionDays: null, retentionCount: 1 };
    const preview = await previewRetention(feed.id, retention);
    expect(preview.data).toEqual({ total: 2, removed: 1 });

    const newest = { ...entries[0], key: 'newest', url: 'https://example.com/newest', title: 'Newest', publishedAt: '2026-11-11T12:00:00.000Z' };
    fetchFeed.mockImplementationOnce(async () => feedResponse([newest, ...entries]));
    await refreshFeeds(bindings);
    const conflict = await applyRetention(feed.id, retention, preview.data.removed);
    expect(conflict.response.status).toBe(409);
    expect(conflict.data).toMatchObject({ error: { code: 'retention_preview_changed' } });
    expect((await timeline('?status=all')).data.items.map(item => item.title)).toEqual(['Newest', 'First', 'Second']);
    expect((await feeds()).data.feeds[0]).toMatchObject({ retentionDays: null, retentionCount: null });

    const updated = await previewRetention(feed.id, retention);
    expect(updated.data).toEqual({ total: 3, removed: 2 });
    const confirmed = await applyRetention(feed.id, retention, updated.data.removed);
    expect(confirmed.data).toMatchObject({ feed: retention, removed: 2 });
    expect((await timeline('?status=all')).data.items.map(item => item.title)).toEqual(['Newest']);
  });

  it('expires posts during failed refreshes and remembers when expired undated posts first appeared', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-10T18:00:00.000Z'));
    const undated = { ...entries[1], publishedAt: null, title: 'Undated' };
    fetchFeed.mockImplementationOnce(async () => feedResponse([entries[0], undated]));
    const { data: { feed } } = await addFeed();
    const retention = { retentionDays: 1, retentionCount: null };
    expect((await applyRetention(feed.id, retention, 0)).data).toMatchObject({ feed: retention, removed: 0 });

    vi.setSystemTime(new Date('2026-11-11T18:00:00.000Z'));
    fetchFeed.mockImplementationOnce(async () => Response.json({ version: 1, ok: false, error: { code: 'upstream_http', retryable: true } }));
    await refreshFeeds(bindings);
    expect((await feeds()).data.feeds[0].lastError).toBe('upstream_http');
    expect((await timeline('?status=all')).data.items).toEqual([]);

    const newPost = { ...undated, key: 'new', url: 'https://example.com/new', title: 'New post' };
    fetchFeed.mockImplementationOnce(async () => feedResponse([entries[0], undated, newPost]));
    await refreshFeeds(bindings);
    expect((await timeline('?status=all')).data.items.map(item => item.title)).toEqual(['New post']);

    vi.setSystemTime(new Date('2026-11-12T19:00:00.000Z'));
    await refreshFeeds({ ...bindings, ARTICLE_EXTRACTOR: undefined });
    expect((await timeline('?status=all')).data.items).toEqual([]);
  });

  it('preserves the newest timeline entries and seen state when repeated posts share a date', async () => {
    const sameDate = entries.map(entry => ({ ...entry, publishedAt: entries[0].publishedAt }));
    fetchFeed.mockImplementation(async () => feedResponse(sameDate));
    const { data: { feed } } = await addFeed();
    const [first] = (await timeline('?status=all')).data.items;
    await json(`/api/feeds/items/${first.id}`, 'PATCH', { seen: true });
    expect((await applyRetention(feed.id, { retentionDays: null, retentionCount: 1 }, 1)).data.removed).toBe(1);

    await refreshFeeds(bindings);
    expect((await timeline('?status=all')).data.items).toEqual([{ ...first, seen: true }]);
    expect((await timeline()).data.items).toEqual([]);
  });

  it('validates retention limits and the confirmed removal count before writing', async () => {
    const { data: { feed } } = await addFeed();
    for (const retention of [
      { retentionDays: 0, retentionCount: null },
      { retentionDays: 36_501, retentionCount: null },
      { retentionDays: null, retentionCount: 1.5 },
      { retentionDays: null, retentionCount: 501 },
    ]) {
      expect((await previewRetention(feed.id, retention)).response.status).toBe(400);
      expect((await applyRetention(feed.id, retention, 0)).response.status).toBe(400);
    }
    expect((await applyRetention(feed.id, { retentionDays: 1, retentionCount: 1 }, -1)).response.status).toBe(400);
    expect((await feeds()).data.feeds[0]).toMatchObject({ retentionDays: null, retentionCount: null });
    expect((await timeline('?status=all')).data.items).toHaveLength(2);
  });
});
