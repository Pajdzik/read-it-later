import { env as testEnv } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/contracts';
import { handleArticles } from '../src/articles/handler';
import { handleAuth } from '../src/auth/handler';
import { normalizeArticleUrl, readJson, BodyTooLargeError } from '../src/articles/validation';
import { digest } from '../src/auth/core';

const env = { DB: testEnv.DB, ASSETS: testEnv.ASSETS, APP_ORIGIN: 'http://localhost:8787', DEV_AUTH_BYPASS: 'true' } as Env;
const origin = 'http://localhost:8787';
const ownerEnv = {
  DB: testEnv.DB, ASSETS: testEnv.ASSETS, APP_ORIGIN: 'https://service.example', GITHUB_CLIENT_ID: 'client',
  GITHUB_CLIENT_SECRET: 'secret', OWNER_GITHUB_ID: '123456',
} as Env;
function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${origin}${path}`, { method, headers: {
    ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin, 'X-CSRF-Token': 'dev-bypass' }),
    ...headers,
  }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function route(req: Request): Promise<Response> {
  return (await handleAuth(req, env)) || (await handleArticles(req, env)) || new Response(null, { status: 404 });
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM articles').run();
  await env.DB.prepare('DELETE FROM sessions').run();
  await env.DB.prepare('DELETE FROM oauth_states').run();
  await env.DB.prepare('DELETE FROM capture_rate_buckets').run();
  await env.DB.prepare('DELETE FROM capture_tokens').run();
});

describe('article HTTP handlers', () => {
  it('normalizes only tracking details and keeps the submitted URL unchanged', async () => {
    const first = normalizeArticleUrl('HTTPS://Example.COM:443/a/B/?q=one%20two&utm_source=x#section');
    const second = normalizeArticleUrl('https://example.com/a/B/?q=one%20two&gclid=y');
    expect(first.url).toBe('HTTPS://Example.COM:443/a/B/?q=one%20two&utm_source=x#section');
    expect(first.normalizedUrl).toBe(second.normalizedUrl);
    expect(normalizeArticleUrl('https://example.com/go?next=https://target.example/a?mode=1').normalizedUrl)
      .not.toBe(normalizeArticleUrl('https://example.com/go?next=https://target.example/a?mode=2').normalizedUrl);
    expect(normalizeArticleUrl('https://example.com/a/B?q=one+two').normalizedUrl).not.toBe(first.normalizedUrl);
    expect(() => normalizeArticleUrl('https://user:pass@example.com/a')).toThrow();
    expect(() => normalizeArticleUrl('file:///tmp/a')).toThrow();
    expect(normalizeArticleUrl('https://example.com/?a=1&&b=2').normalizedUrl).toBe('https://example.com/?a=1&&b=2');
  });

  it('saves duplicates without changing title/read state and rejects cross-origin writes', async () => {
    const created = await route(request('/api/articles', 'POST', { url: 'https://example.com/a?utm_source=x', title: 'Saved' }));
    expect(created.status).toBe(201);
    const article = (await created.json() as { article: { id: string; title: string } }).article;
    await route(request(`/api/articles/${article.id}`, 'PATCH', { read: true }));
    const duplicate = await route(request('/api/articles', 'POST', { url: 'https://example.com/a?fbclid=x', title: 'Changed' }));
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json() as { article: { title: string; readAt: string | null } }).article).toMatchObject({ title: 'Saved', readAt: expect.any(String) });
    const hostile = request('/api/articles', 'POST', { url: 'https://elsewhere.example/' }, { Origin: 'https://attacker.example', 'X-CSRF-Token': 'dev-bypass' });
    expect((await route(hostile)).status).toBe(403);
  });

  it('stores private Markdown copies with atomic revisions and independent article state', async () => {
    await env.DB.prepare('INSERT INTO articles(id,url,normalized_url,title,created_at,updated_at,read_at) VALUES(?,?,?,?,?,?,?)')
      .bind('copy-article', 'https://example.com/copy', 'https://example.com/copy', 'Copy test', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-03T00:00:00.000Z').run();
    const get = () => route(request('/api/articles/copy-article/copy'));
    expect(await (await get()).json()).toEqual({ copy: null });
    const prefix = '# Unicode 📰\n\n';
    const markdown = prefix + 'é'.repeat((262144 - new TextEncoder().encode(prefix).byteLength) / 2);
    expect(new TextEncoder().encode(markdown).byteLength).toBe(262144);
    const first = await route(request('/api/articles/copy-article/copy', 'PUT', { markdown, source: 'paste', expectedRevision: null }));
    expect(first.status).toBe(200);
    const copy = (await first.json() as { copy: { revision: string; capturedAt: string; source: string; markdown: string } }).copy;
    expect(copy).toMatchObject({ markdown, source: 'paste', capturedAt: expect.any(String), revision: expect.any(String) });
    expect((await route(request('/api/articles/copy-article/copy', 'PUT', { markdown: 'stale replacement', source: 'paste', expectedRevision: 'stale-revision' }))).status).toBe(409);
    await expect((await get()).json()).resolves.toMatchObject({ copy: { markdown } });
    const boundary = await route(request('/api/articles/copy-article/copy', 'PUT', { markdown: `${markdown}é`, source: 'upload', expectedRevision: copy.revision }));
    expect(boundary.status).toBe(413);
    const replaced = await route(request('/api/articles/copy-article/copy', 'PUT', { markdown: '## Uploaded', source: 'upload', expectedRevision: copy.revision }));
    expect(replaced.status).toBe(200);
    const current = (await replaced.json() as { copy: { revision: string } }).copy;
    const concurrent = await Promise.all([
      route(request('/api/articles/copy-article/copy', 'PUT', { markdown: '## Concurrent A', source: 'paste', expectedRevision: current.revision })),
      route(request('/api/articles/copy-article/copy', 'PUT', { markdown: '## Concurrent B', source: 'upload', expectedRevision: current.revision })),
    ]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([200, 409]);
    const article = await env.DB.prepare('SELECT title,updated_at,read_at FROM articles WHERE id = ?').bind('copy-article').first<{ title: string; updated_at: string; read_at: string }>();
    expect(article).toEqual({ title: 'Copy test', updated_at: '2026-01-02T00:00:00.000Z', read_at: '2026-01-03T00:00:00.000Z' });
    expect((await route(request('/api/articles/copy-article', 'DELETE', undefined, { Origin: origin, 'X-CSRF-Token': 'dev-bypass' }))).status).toBe(204);
    expect(await env.DB.prepare('SELECT article_id FROM article_copies WHERE article_id = ?').bind('copy-article').first()).toBeNull();
  });

  it('rejects invalid copy envelopes, unknown fields, origin failures, and copy access outside owner sessions', async () => {
    await env.DB.prepare('INSERT INTO articles(id,url,normalized_url,title,created_at,updated_at,read_at) VALUES(?,?,?,?,?,?,NULL)')
      .bind('private-copy', 'https://example.com/private', 'https://example.com/private', 'Private', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z').run();
    expect((await route(request('/api/articles/private-copy/copy', 'PUT', { markdown: ' ', source: 'paste', expectedRevision: null }))).status).toBe(400);
    const missing = await route(request('/api/articles/no-such-article/copy'));
    expect(missing.status).toBe(404);
    expect(missing.headers.get('Cache-Control')).toContain('no-store');
    expect((await route(request('/api/articles/private-copy/copy', 'PUT', { markdown: '# Valid', source: 'paste', expectedRevision: null, other: true }))).status).toBe(400);
    expect((await route(request('/api/articles/private-copy/copy', 'PUT', { markdown: '# Valid', source: 'paste', expectedRevision: null }, { Origin: 'https://attacker.example' }))).status).toBe(403);
    const missingCsrf = new Request(origin + '/api/articles/private-copy/copy', { method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ markdown: '# Missing CSRF', source: 'paste', expectedRevision: null }) });
    expect((await route(missingCsrf)).status).toBe(403);
    const tokenRequest = new Request('https://service.example/api/articles/private-copy/copy', { headers: { Authorization: 'Bearer capture-token' } });
    expect((await handleArticles(tokenRequest, ownerEnv))?.status).toBe(401);
    const anonymous = await handleArticles(new Request('https://service.example/api/articles/private-copy/copy'), { ...ownerEnv, APP_ORIGIN: undefined } as Env);
    expect(anonymous?.status).toBe(503);
  });

  it('does not claim similarly prefixed article routes', async () => {
    const unavailableDb = { ...env, DB: { prepare() { throw new Error('should not query storage'); } } } as unknown as Env;
    expect(await handleArticles(new Request(`${origin}/api/articlesfoo`), unavailableDb)).toBeNull();
  });

  it('keeps capture tokens save-only, rate limited durably, and revocable', async () => {
    const sessionToken = 'saved-session-token'; const csrf = 'saved-csrf';
    await env.DB.prepare('INSERT INTO sessions(token_hash,csrf_token,expires_at,created_at) VALUES(?,?,?,?)')
      .bind(await digest(sessionToken), csrf, '2099-01-01T00:00:00.000Z', new Date().toISOString()).run();
    const adminCreate = new Request('https://service.example/api/capture-tokens', { method: 'POST', headers: {
      Cookie: `read_later_session=${sessionToken}`, Origin: 'https://service.example', 'X-CSRF-Token': csrf, 'Content-Type': 'application/json',
    }, body: JSON.stringify({ label: 'Phone' }) });
    const created = await handleAuth(adminCreate, ownerEnv);
    expect(created?.status).toBe(201);
    const createdData = await created!.json() as { id: string; token: string };
    const token = createdData.token;
    const captureRequest = () => new Request('https://service.example/api/capture', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com/from-phone' }) });
    const saved = await handleArticles(captureRequest(), ownerEnv);
    expect(saved?.status).toBe(201);
    const forbiddenList = await handleArticles(new Request('https://service.example/api/articles', { headers: { Authorization: `Bearer ${token}` } }), ownerEnv);
    expect(forbiddenList?.status).toBe(401);
    const revokeRequest = new Request(`https://service.example/api/capture-tokens/${createdData.id}`, { method: 'DELETE', headers: { Cookie: `read_later_session=${sessionToken}`, Origin: 'https://service.example', 'X-CSRF-Token': csrf } });
    expect((await handleAuth(revokeRequest, ownerEnv))?.status).toBe(204);
    const revoked = await handleArticles(captureRequest(), ownerEnv);
    expect(revoked?.status).toBe(401);
    for (const [path, method] of [['/api/articles', 'GET'], ['/api/export', 'GET'], ['/api/import', 'POST'], [`/api/articles/${createdData.id}`, 'PATCH']] as const) {
      const denied = await handleArticles(new Request(`https://service.example${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: method === 'POST' || method === 'PATCH' ? '{}' : undefined }), ownerEnv);
      expect(denied?.status).toBe(401);
    }
    expect((await handleAuth(new Request('https://service.example/api/capture-tokens', { headers: { Authorization: `Bearer ${token}` } }), ownerEnv))?.status).toBe(401);
    const bucket = await env.DB.prepare('SELECT window_start FROM capture_rate_buckets WHERE token_id = ?').bind(createdData.id).first<{ window_start: number }>();
    await env.DB.prepare('INSERT INTO capture_rate_buckets(token_id,window_start,count) VALUES(?,?,60) ON CONFLICT(token_id,window_start) DO UPDATE SET count=60')
      .bind(createdData.id, bucket?.window_start ?? Math.floor(Date.now() / 60_000)).run();
    // Revocation is checked before the limiter, so use a second live token to exercise the shared durable bucket.
    const token2Result = await handleAuth(new Request('https://service.example/api/capture-tokens', { method: 'POST', headers: {
      Cookie: `read_later_session=${sessionToken}`, Origin: 'https://service.example', 'X-CSRF-Token': csrf, 'Content-Type': 'application/json',
    }, body: JSON.stringify({ label: 'Rate test' }) }), ownerEnv);
    const token2 = (await token2Result!.json() as { id: string; token: string });
    await env.DB.prepare('INSERT INTO capture_rate_buckets(token_id,window_start,count) VALUES(?,?,60)')
      .bind(token2.id, Math.floor(Date.now() / 60_000)).run();
    const limited = await handleArticles(new Request('https://service.example/api/capture', { method: 'POST', headers: { Authorization: `Bearer ${token2.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com/rate-limited' }) }), ownerEnv);
    expect(limited?.status).toBe(429);
  });

  it('binds OAuth to its initiating browser, accepts only the configured numeric owner, and consumes state once', async () => {
    const providerFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/login/oauth/access_token')) return Response.json({ access_token: 'provider-access' });
      return Response.json({ id: 123456 });
    });
    vi.stubGlobal('fetch', providerFetch);
    try {
      const start = await handleAuth(new Request('https://service.example/auth/github'), ownerEnv);
      expect(start?.status).toBe(302);
      const authorization = new URL(start!.headers.get('Location')!);
      const state = authorization.searchParams.get('state')!;
      const binding = start!.headers.get('Set-Cookie')!.split(';', 1)[0];
      const callback = () => new Request(`https://service.example/auth/github/callback?state=${state}&code=one-time`, { headers: { Cookie: binding } });
      const unbound = await handleAuth(new Request(`https://service.example/auth/github/callback?state=${state}&code=one-time`), ownerEnv);
      expect(unbound?.status).toBe(403);
      const success = await handleAuth(callback(), ownerEnv);
      expect(success?.status).toBe(302);
      const replay = await handleAuth(callback(), ownerEnv);
      expect(replay?.status).toBe(403);
      expect(providerFetch).toHaveBeenCalledTimes(2);
      const cookies = success!.headers.get('Set-Cookie')!;
      expect(cookies).toContain('read_later_session=');
      const next = await handleAuth(new Request('https://service.example/auth/github'), ownerEnv);
      const expiredUrl = new URL(next!.headers.get('Location')!);
      const expiredState = expiredUrl.searchParams.get('state')!;
      await env.DB.prepare('UPDATE oauth_states SET expires_at = ? WHERE state_hash = ?')
        .bind('2000-01-01T00:00:00.000Z', await digest(expiredState)).run();
      const expired = await handleAuth(new Request(`https://service.example/auth/github/callback?state=${expiredState}&code=expired`, {
        headers: { Cookie: next!.headers.get('Set-Cookie')!.split(';', 1)[0] },
      }), ownerEnv);
      expect(expired?.status).toBe(403);
    } finally { vi.unstubAllGlobals(); }
  });

  it('rejects a different GitHub numeric owner and provider failures', async () => {
    const providerFetch = vi.fn(async (input: RequestInfo | URL) => String(input).includes('/login/oauth/access_token')
      ? Response.json({ access_token: 'provider-access' }) : Response.json({ id: 999999 }));
    vi.stubGlobal('fetch', providerFetch);
    try {
      const start = await handleAuth(new Request('https://service.example/auth/github'), ownerEnv);
      const state = new URL(start!.headers.get('Location')!).searchParams.get('state')!;
      const binding = start!.headers.get('Set-Cookie')!.split(';', 1)[0];
      const denied = await handleAuth(new Request(`https://service.example/auth/github/callback?state=${state}&code=wrong-owner`, { headers: { Cookie: binding } }), ownerEnv);
      expect(denied?.status).toBe(403);
      const count = await env.DB.prepare('SELECT count(*) AS count FROM sessions').first<{ count: number }>();
      expect(count?.count).toBe(0);
    } finally { vi.unstubAllGlobals(); }
    const failedProvider = vi.fn(async () => new Response('unavailable', { status: 500 }));
    vi.stubGlobal('fetch', failedProvider);
    try {
      const start = await handleAuth(new Request('https://service.example/auth/github'), ownerEnv);
      const state = new URL(start!.headers.get('Location')!).searchParams.get('state')!;
      const binding = start!.headers.get('Set-Cookie')!.split(';', 1)[0];
      const failed = await handleAuth(new Request(`https://service.example/auth/github/callback?state=${state}&code=provider-error`, { headers: { Cookie: binding } }), ownerEnv);
      expect(failed?.status).toBe(403);
    } finally { vi.unstubAllGlobals(); }
  });

  it('fails closed for non-loopback bypass, missing configuration, expired sessions, and logout', async () => {
    const remote = await handleArticles(new Request('http://attacker.example/api/articles'), env);
    expect(remote?.status).toBe(503);
    const otherLoopback = await handleArticles(new Request('http://localhost:9999/api/articles'), env);
    expect(otherLoopback?.status).toBe(503);
    const missing = await handleArticles(new Request('https://service.example/api/articles'), { DB: testEnv.DB, ASSETS: testEnv.ASSETS } as Env);
    expect(missing?.status).toBe(503);
    const rawSession = 'expired-session';
    await env.DB.prepare('INSERT INTO sessions(token_hash,csrf_token,expires_at,created_at) VALUES(?,?,?,?)')
      .bind(await digest(rawSession), 'old-csrf', '2000-01-01T00:00:00.000Z', '1999-01-01T00:00:00.000Z').run();
    const expired = await handleAuth(new Request('https://service.example/auth/logout', { method: 'POST', headers: {
      Cookie: `read_later_session=${rawSession}`, Origin: 'https://service.example', 'X-CSRF-Token': 'old-csrf',
    } }), ownerEnv);
    expect(expired?.status).toBe(401);
    const active = 'logout-session';
    await env.DB.prepare('INSERT INTO sessions(token_hash,csrf_token,expires_at,created_at) VALUES(?,?,?,?)')
      .bind(await digest(active), 'logout-csrf', '2099-01-01T00:00:00.000Z', new Date().toISOString()).run();
    const loggedOut = await handleAuth(new Request('https://service.example/auth/logout', { method: 'POST', headers: {
      Cookie: `read_later_session=${active}`, Origin: 'https://service.example', 'X-CSRF-Token': 'logout-csrf',
    } }), ownerEnv);
    expect(loggedOut?.status).toBe(204);
    const later = await handleAuth(new Request('https://service.example/api/session', { headers: { Cookie: `read_later_session=${active}` } }), ownerEnv);
    expect(await later?.json()).toEqual({ authenticated: false });
  });

  it('enforces the streamed import size limit before parsing', async () => {
    const request = new Request('https://service.example/api/import', { method: 'POST', headers: { 'Content-Length': '1048577' }, body: '{}' });
    await expect(readJson(request, 1024 * 1024)).rejects.toBeInstanceOf(BodyTooLargeError);
    const brokenDb = { ...env, DB: { prepare() { throw new Error('simulated storage failure'); } } } as unknown as Env;
    const unavailable = await handleArticles(new Request(`${origin}/api/articles`), brokenDb);
    expect(unavailable?.status).toBe(503);
  });

  it('exports more than one page and imports idempotently with read state and Unicode intact', async () => {
    for (let i = 0; i < 105; i++) {
      await env.DB.prepare('INSERT INTO articles(id,url,normalized_url,title,created_at,updated_at,read_at) VALUES(?,?,?,?,?,?,?)')
        .bind(`exp-${i}`, `https://example.com/${i}`, `https://example.com/${i}`, i === 0 ? '日本語 📰' : `Title ${i}`,
          new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), i === 0 ? '2026-01-02T00:00:00.000Z' : null).run();
    }
    await env.DB.prepare('INSERT INTO article_copies(article_id,markdown,captured_at,source,revision) VALUES(?,?,?,?,?)')
      .bind('exp-0', '# Backup 📰\n\nescaped \u0000\t content', '2026-01-04T00:00:00.000Z', 'upload', 'copy-revision-1').run();
    const exported = await route(request('/api/export'));
    const document = await exported.json() as { version: number; articles: Array<{ id: string; copy?: { markdown: string; capturedAt: string; source: string; revision: string } }> };
    expect(document.version).toBe(2); expect(document.articles).toHaveLength(105);
    expect(document.articles.find((article) => article.id === 'exp-0')?.copy).toEqual({ markdown: '# Backup 📰\n\nescaped \u0000\t content', capturedAt: '2026-01-04T00:00:00.000Z', source: 'upload', revision: 'copy-revision-1' });
    await env.DB.prepare('DELETE FROM articles').run();
    const first = await route(request('/api/import', 'POST', document));
    expect(first.status).toBe(200); expect(await first.json()).toEqual({ imported: 105, skipped: 0 });
    const second = await route(request('/api/import', 'POST', document));
    expect(await second.json()).toEqual({ imported: 0, skipped: 105 });
    const item = await env.DB.prepare('SELECT title,read_at FROM articles WHERE id = ?').bind('exp-0').first<{ title: string; read_at: string }>();
    expect(item).toEqual({ title: '日本語 📰', read_at: '2026-01-02T00:00:00.000Z' });
    expect(await env.DB.prepare('SELECT markdown,captured_at,source,revision FROM article_copies WHERE article_id = ?').bind('exp-0').first())
      .toEqual({ markdown: '# Backup 📰\n\nescaped \u0000\t content', captured_at: '2026-01-04T00:00:00.000Z', source: 'upload', revision: 'copy-revision-1' });
  });

  it('paginates opaque Unicode article IDs up to the import length limit', async () => {
    for (const id of ['界'.repeat(128), 'second']) {
      await env.DB.prepare('INSERT INTO articles(id,url,normalized_url,title,created_at,updated_at,read_at) VALUES(?,?,?,?,?,?,NULL)')
        .bind(id, `https://example.com/${encodeURIComponent(id)}`, `https://example.com/${encodeURIComponent(id)}`, id,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z').run();
    }
    const page = await route(request('/api/articles?status=all&limit=1'));
    expect(page.status).toBe(200);
    const result = await page.json() as { items: Array<{ id: string }>; nextCursor: string };
    expect(result.items).toHaveLength(1);
    const next = await route(request(`/api/articles?status=all&limit=1&cursor=${encodeURIComponent(result.nextCursor)}`));
    expect(next.status).toBe(200);
    expect((await next.json() as { items: Array<{ id: string }> }).items).toHaveLength(1);
  });

  it('validates the full import before writing and rolls back a failed batch', async () => {
    const badDate = { version: 1, exportedAt: '2026-01-01T00:00:00.000Z', articles: [{ id: 'bad', url: 'https://example.com/bad', title: 'Bad', createdAt: 'not-date', updatedAt: '2026-01-01T00:00:00.000Z', readAt: null }] };
    expect((await route(request('/api/import', 'POST', badDate))).status).toBe(400);
    await env.DB.prepare(`CREATE TRIGGER fail_backend_import BEFORE INSERT ON articles WHEN NEW.url = 'https://example.com/fail' BEGIN SELECT RAISE(ABORT, 'forced failure'); END`).run();
    const document = { version: 1, exportedAt: '2026-01-01T00:00:00.000Z', articles: [
      { id: 'okay', url: 'https://example.com/okay', title: 'Okay', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', readAt: null },
      { id: 'fail', url: 'https://example.com/fail', title: 'Fail', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', readAt: null },
    ] };
    expect((await route(request('/api/import', 'POST', document))).status).toBe(503);
    const count = await env.DB.prepare('SELECT count(*) AS count FROM articles').first<{ count: number }>();
    expect(count?.count).toBe(0);
    await env.DB.prepare('DROP TRIGGER fail_backend_import').run();
  });

  it('validates imported copies before writing and rolls article plus copy back on copy storage failure', async () => {
    const exportedAt = '2026-01-01T00:00:00.000Z';
    const item = { id: 'copy-import', url: 'https://example.com/copy-import', title: 'Copy import', createdAt: exportedAt, updatedAt: exportedAt, readAt: null };
    const invalid = { version: 2, exportedAt, articles: [{ ...item, copy: { markdown: ' ', capturedAt: exportedAt, source: 'paste', revision: 'revision' } }] };
    expect((await route(request('/api/import', 'POST', invalid))).status).toBe(400);
    await env.DB.prepare(`CREATE TRIGGER fail_copy_import BEFORE INSERT ON article_copies BEGIN SELECT RAISE(ABORT, 'forced copy failure'); END`).run();
    const document = { version: 2, exportedAt, articles: [{ ...item, copy: { markdown: '# Copy', capturedAt: exportedAt, source: 'paste', revision: 'revision' } }] };
    expect((await route(request('/api/import', 'POST', document))).status).toBe(503);
    expect(await env.DB.prepare('SELECT id FROM articles WHERE id = ?').bind('copy-import').first()).toBeNull();
    await env.DB.prepare('DROP TRIGGER fail_copy_import').run();
  });

  it('rejects oversized escaped JSON envelopes and preserves an existing copy when storage fails', async () => {
    await env.DB.prepare('INSERT INTO articles(id,url,normalized_url,title,created_at,updated_at,read_at) VALUES(?,?,?,?,?,?,NULL)')
      .bind('copy-failure', 'https://example.com/copy-failure', 'https://example.com/copy-failure', 'Copy failure', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z').run();
    const create = await route(request('/api/articles/copy-failure/copy', 'PUT', { markdown: '# Prior', source: 'paste', expectedRevision: null }));
    const prior = (await create.json() as { copy: { revision: string } }).copy;
    const maxEnvelope = '\u0001'.repeat(262144);
    expect((await route(request('/api/articles/copy-failure/copy', 'PUT', { markdown: maxEnvelope, source: 'paste', expectedRevision: prior.revision }))).status).toBe(200);
    const tooLargeEscapedEnvelope = '\u0001'.repeat(400000);
    expect((await route(request('/api/articles/copy-failure/copy', 'PUT', { markdown: tooLargeEscapedEnvelope, source: 'paste', expectedRevision: prior.revision }))).status).toBe(413);
    const current = await env.DB.prepare('SELECT revision FROM article_copies WHERE article_id = ?').bind('copy-failure').first<{ revision: string }>();
    await env.DB.prepare("CREATE TRIGGER fail_copy_update BEFORE UPDATE ON article_copies BEGIN SELECT RAISE(ABORT, 'forced copy update failure'); END").run();
    expect((await route(request('/api/articles/copy-failure/copy', 'PUT', { markdown: '# Failed write', source: 'upload', expectedRevision: current!.revision }))).status).toBe(503);
    await env.DB.prepare('DROP TRIGGER fail_copy_update').run();
    expect(await env.DB.prepare('SELECT markdown FROM article_copies WHERE article_id = ?').bind('copy-failure').first()).toEqual({ markdown: maxEnvelope });
  });

  it('rejects conflicting imported IDs even when another record shares that normalized URL', async () => {
    await env.DB.prepare('INSERT INTO articles(id,url,normalized_url,title,created_at,updated_at,read_at) VALUES(?,?,?,?,?,?,NULL)')
      .bind('owned-id', 'https://example.com/original', 'https://example.com/original', 'Original', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z').run();
    const document = { version: 1, exportedAt: '2026-01-01T00:00:00.000Z', articles: [
      { id: 'other-id', url: 'https://example.com/original', title: 'Duplicate URL', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', readAt: null },
      { id: 'owned-id', url: 'https://example.com/different', title: 'ID conflict', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', readAt: null },
    ] };
    const response = await route(request('/api/import', 'POST', document));
    expect(response.status).toBe(400);
  });

  it('skips a concurrent imported URL without overwriting the winning article', async () => {
    const exportedAt = '2026-01-01T00:00:00.000Z';
    const importDocument = (id: string, title: string) => ({ version: 1, exportedAt, articles: [
      { id, url: 'https://example.com/race', title, createdAt: exportedAt, updatedAt: exportedAt, readAt: null },
    ] });
    const responses = await Promise.all([
      route(request('/api/import', 'POST', importDocument('race-one', 'First'))),
      route(request('/api/import', 'POST', importDocument('race-two', 'Second'))),
    ]);
    const counts = await Promise.all(responses.map(async (response) => response.json() as Promise<{ imported: number; skipped: number }>));
    expect(counts.reduce((sum, count) => sum + count.imported, 0)).toBe(1);
    expect(counts.reduce((sum, count) => sum + count.skipped, 0)).toBe(1);
    const row = await env.DB.prepare('SELECT id,title FROM articles WHERE normalized_url = ?')
      .bind('https://example.com/race').first<{ id: string; title: string }>();
    expect(row?.id).toMatch(/race-one|race-two/);
    expect(row?.title).toBe(row?.id === 'race-one' ? 'First' : 'Second');
  });

  it('does not attach an incoming copy when an imported URL is already present', async () => {
    const exportedAt = '2026-01-01T00:00:00.000Z';
    await env.DB.prepare('INSERT INTO articles(id,url,normalized_url,title,created_at,updated_at,read_at) VALUES(?,?,?,?,?,?,NULL)')
      .bind('url-winner', 'https://example.com/already-saved', 'https://example.com/already-saved', 'Existing title', exportedAt, exportedAt).run();
    const document = { version: 2, exportedAt, articles: [{ id: 'incoming-id', url: 'https://example.com/already-saved', title: 'Incoming', createdAt: exportedAt, updatedAt: exportedAt, readAt: null, copy: { markdown: '# Must not attach', capturedAt: exportedAt, source: 'paste', revision: 'incoming-revision' } }] };
    const result = await route(request('/api/import', 'POST', document));
    expect(await result.json()).toEqual({ imported: 0, skipped: 1 });
    expect(await env.DB.prepare('SELECT article_id FROM article_copies WHERE article_id IN (?,?)').bind('incoming-id', 'url-winner').first()).toBeNull();
    expect(await env.DB.prepare('SELECT title FROM articles WHERE id = ?').bind('url-winner').first()).toEqual({ title: 'Existing title' });
  });
});
