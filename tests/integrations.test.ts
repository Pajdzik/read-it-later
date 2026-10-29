import { env as testEnv } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Article, ArticleCopy, Env, IntegrationConfiguration } from '../src/contracts';
import { handleArticles } from '../src/articles/handler';
import { getArticle, getArticleCopy, saveArticleCopy } from '../src/articles/repository';
import { integrationConfigurations } from '../src/integrations/registry';

const origin = 'http://localhost:8787';
const article: Article = { id: 'k7m2q9x4', url: 'https://example.com/article', title: 'A saved article', author: 'Ada', description: null,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', readAt: null };
const copy: ArticleCopy = { markdown: '# 日本語 📰\n\nAn exact saved body.\n', source: 'paste', capturedAt: '2026-10-01T00:00:00.000Z', revision: 'copy-one' };
const hooks = [{ id: 'kindle', name: 'Kindle', destination: 'My reading device', description: 'Send the saved article to my Kindle delivery service.' },
  { id: 'archive', name: 'Private archive', destination: 'My vault', description: 'Keep a copy in my private archive.' }];
let requests: Request[];
let env: Env;
let kindle: IntegrationConfiguration;
const api = (path: string, method = 'GET', body?: unknown, headers: HeadersInit = {}) => new Request(`${origin}${path}`, {
  method, headers: { Origin: origin, 'X-CSRF-Token': 'dev-bypass', 'Content-Type': 'application/json', ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
async function route(path: string, method = 'GET', body?: unknown, settings = env) {
  return (await handleArticles(api(path, method, body), settings))!;
}
const articlePath = `/api/articles/${article.id}`;
const deliver = (id = 'kindle', revision = copy.revision, destinationKey = kindle.destinationKey) => route(`${articlePath}/integrations/${id}`, 'POST', { expectedRevision: revision, expectedDestinationKey: destinationKey });

beforeEach(async () => {
  requests = [];
  env = { ...testEnv, APP_ORIGIN: origin, DEV_AUTH_BYPASS: 'true',
    GITHUB_BACKUP_TOKEN: undefined, GITHUB_BACKUP_REPOSITORY: undefined,
    ARTICLE_HOOKS_CONFIG: JSON.stringify(hooks),
    ARTICLE_HOOKS: { fetch: vi.fn(async (request: Request) => { requests.push(request); return new Response(null, { status: 204 }); }) , connect() { throw new Error("unused"); } } as Fetcher,
  };
  kindle = integrationConfigurations(env)[0];
  await env.DB.prepare('DELETE FROM articles').run();
  await env.DB.prepare('INSERT INTO articles(id,url,normalized_url,title,author,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .bind(article.id, article.url, article.url, article.title, article.author, article.createdAt, article.updatedAt).run();
  await saveArticleCopy(env.DB, article.id, copy, null);
});

describe('optional article integrations', () => {
  it('discovers hooks without GitHub and returns an empty list with no integrations', async () => {
    const response = await route('/api/integrations');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ integrations: [{ id: 'kindle', configured: true }, { id: 'archive', configured: true }] });
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await (await route('/api/integrations', 'GET', undefined, { ...env, ARTICLE_HOOKS_CONFIG: undefined })).json()).toEqual({ integrations: [] });
    expect(requests).toHaveLength(0);
  });

  it('adapts the existing GitHub writer and backup history through the generic API', async () => {
    env.GITHUB_BACKUP_TOKEN = 'server-only-token';
    env.GITHUB_BACKUP_REPOSITORY = 'Fixture/Archive';
    env.GITHUB_BACKUP_BRANCH = 'main';
    env.GITHUB_BACKUP_PATH = 'Articles';
    const github = integrationConfigurations(env).find(item => item.id === 'github')!;
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) =>
      init?.method === 'GET' ? new Response(null, { status: 404 }) : Response.json({ ok: true }));
    try {
      const response = await route(`${articlePath}/integrations/github`, 'POST', {
        expectedRevision: copy.revision, expectedDestinationKey: github.destinationKey,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ integration: { id: 'github', state: 'saved', url: expect.stringContaining('github.com/Fixture/Archive') } });
      expect(await (await route(`${articlePath}/github`)).json()).toMatchObject({ backup: { state: 'saved' } });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(requests).toHaveLength(0);
      expect(JSON.stringify(await (await route('/api/integrations')).json())).not.toContain('server-only-token');
    } finally { fetcher.mockRestore(); }
  });

  it('delivers the persisted snapshot and deduplicates an unchanged delivery', async () => {
    const response = await deliver();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ integration: { id: 'kindle', state: 'saved', deliveredAt: expect.any(String) }, unchanged: false });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://article-hooks/hooks/kindle');
    const payload = await requests[0].json<{ version: number; deliveryId: string; article: object; copy: ArticleCopy }>();
    expect(payload).toMatchObject({ version: 1, event: 'article.delivery.requested', copy, article: { id: article.id, title: article.title, savedAt: article.createdAt } });
    expect(payload.article).not.toHaveProperty('readAt');
    expect(payload.article).not.toHaveProperty('updatedAt');
    expect(requests[0].headers.get('Idempotency-Key')).toBe(payload.deliveryId);
    expect(await (await deliver()).json()).toMatchObject({ unchanged: true });
    expect(requests).toHaveLength(1);
    expect(await getArticleCopy(env.DB, article.id)).toEqual(copy);
    expect(await getArticle(env.DB, article.id)).toEqual(article);
  });

  it('keeps provider delivery status separate and marks metadata or content changes outdated', async () => {
    await deliver();
    let statuses = await (await route(`${articlePath}/integrations`)).json<{ integrations: Array<{ id: string; state: string }> }>();
    expect(statuses.integrations.map(item => item.state)).toEqual(['saved', 'not_saved']);
    await route(articlePath, 'PATCH', { read: true });
    expect(await (await deliver()).json()).toMatchObject({ unchanged: true });
    await route(articlePath, 'PATCH', { title: 'Updated title' });
    statuses = await (await route(`${articlePath}/integrations`)).json();
    expect(statuses.integrations[0].state).toBe('outdated');
    await deliver();
    expect(requests).toHaveLength(2);
    expect(requests[0].headers.get('Idempotency-Key')).not.toBe(requests[1].headers.get('Idempotency-Key'));
    await saveArticleCopy(env.DB, article.id, { ...copy, markdown: 'New content', revision: 'copy-two' }, copy.revision);
    expect(await (await route(`${articlePath}/integrations`)).json()).toMatchObject({ integrations: [{ state: 'outdated' }, { state: 'not_saved' }] });
  });

  it('requires a current revision, a reviewed destination and no unsaved draft fields', async () => {
    expect((await deliver('kindle', 'stale')).status).toBe(409);
    expect((await deliver('kindle', copy.revision, 'another-device')).status).toBe(409);
    expect((await deliver('missing')).status).toBe(404);
    expect((await route(`${articlePath}/integrations/kindle`, 'POST', { expectedRevision: copy.revision })).status).toBe(400);
    expect((await route(`${articlePath}/integrations/kindle`, 'POST', { expectedRevision: copy.revision, expectedDestinationKey: kindle.destinationKey, markdown: 'unsaved' })).status).toBe(400);
    await env.DB.prepare('DELETE FROM article_copies WHERE article_id = ?').bind(article.id).run();
    expect((await deliver()).status).toBe(409);
    expect(requests).toHaveLength(0);
  });

  it('keeps local saves independent and retries ambiguous failures with the same key', async () => {
    const seen: string[] = [];
    let failure = true;
    env.ARTICLE_HOOKS = { fetch: vi.fn(async (request: Request) => {
      seen.push(request.headers.get('Idempotency-Key')!);
      if (failure) throw new Error('secret provider diagnostics');
      return new Response(null, { status: 204 });
    }) , connect() { throw new Error("unused"); } } as Fetcher;
    const failed = await deliver();
    expect(failed.status).toBe(502);
    expect(JSON.stringify(await failed.json())).not.toContain('secret provider diagnostics');
    expect(await (await route(`${articlePath}/integrations`)).json()).toMatchObject({ integrations: [{ state: 'not_saved' }, { state: 'not_saved' }] });
    expect(await getArticleCopy(env.DB, article.id)).toEqual(copy);
    failure = false;
    expect((await deliver()).status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    await route(`${articlePath}/copy`, 'PUT', { markdown: 'A new local copy', source: 'paste', expectedRevision: copy.revision });
    expect(seen).toHaveLength(2);
  });

  it('reports an in-flight change as outdated and does not follow hook redirects or accept unconfirmed work', async () => {
    env.ARTICLE_HOOKS = { fetch: vi.fn(async () => {
      await saveArticleCopy(env.DB, article.id, { ...copy, revision: 'copy-two', markdown: 'A concurrent edit' }, copy.revision);
      return new Response(null, { status: 204 });
    }) , connect() { throw new Error("unused"); } } as Fetcher;
    expect(await (await deliver()).json()).toMatchObject({ integration: { state: 'outdated' } });
    for (const status of [202, 302, 500]) {
      env.ARTICLE_HOOKS = { fetch: vi.fn(async () => new Response(null, { status })) , connect() { throw new Error("unused"); } } as Fetcher;
      expect((await deliver('kindle', 'copy-two')).status).toBe(502);
    }
  });

  it('invalidates destination consent and prior receipts when configuration changes', async () => {
    await deliver();
    env.ARTICLE_HOOKS_CONFIG = JSON.stringify([{ ...hooks[0], destination: 'A different device' }, hooks[1]]);
    expect((await deliver()).status).toBe(409);
    expect(await (await route(`${articlePath}/integrations`)).json()).toMatchObject({ integrations: [{ state: 'not_saved' }, { state: 'not_saved' }] });
    expect(requests).toHaveLength(1);
  });

  it('rejects invalid hook configuration and disables unbound hooks', async () => {
    for (const invalid of ['broken', '{}', JSON.stringify([hooks[0], hooks[0]]), JSON.stringify([{ ...hooks[0], id: 'github' }]), JSON.stringify([{ ...hooks[0], id: '../private' }])]) {
      expect((await route('/api/integrations', 'GET', undefined, { ...env, ARTICLE_HOOKS_CONFIG: invalid })).status).toBe(503);
    }
    env.ARTICLE_HOOKS = undefined;
    expect(await (await route('/api/integrations')).json()).toMatchObject({ integrations: [{ id: 'kindle', configured: false }, { id: 'archive', configured: false }] });
    expect((await deliver()).status).toBe(503);
  });

  it('enforces owner authentication and CSRF and cleans receipts on deletion', async () => {
    const privateEnv: Env = { ...env, DEV_AUTH_BYPASS: undefined, APP_ORIGIN: 'https://service.example', GITHUB_CLIENT_ID: 'client', GITHUB_CLIENT_SECRET: 'secret', OWNER_GITHUB_ID: '123456' };
    for (const path of ['/api/integrations', `${articlePath}/integrations`, `${articlePath}/integrations/kindle`]) {
      expect((await handleArticles(new Request(`https://service.example${path}`, { headers: { Authorization: 'Bearer save-only-token' } }), privateEnv))?.status).toBe(401);
    }
    expect((await handleArticles(api(`${articlePath}/integrations/kindle`, 'POST', { expectedRevision: copy.revision, expectedDestinationKey: kindle.destinationKey }, { 'X-CSRF-Token': 'wrong' }), env))?.status).toBe(403);
    await deliver();
    await route(articlePath, 'DELETE');
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM article_integration_deliveries').first<{ count: number }>())?.count).toBe(0);
  });
});
