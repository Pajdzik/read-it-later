import { env as testEnv } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Article, ArticleCopy, Env } from '../src/contracts';
import { handleArticles } from '../src/articles/handler';
import { articleMarkdown } from '../src/articles/github';
import { getArticle, getArticleCopy, saveArticleCopy } from '../src/articles/repository';

const origin = 'http://localhost:8787';
const baseEnv: Env = { ...testEnv, APP_ORIGIN: origin, DEV_AUTH_BYPASS: 'true', GITHUB_BACKUP_REPOSITORY: 'Pajdzik/Kamilpedia', GITHUB_BACKUP_BRANCH: 'main', GITHUB_BACKUP_PATH: 'Articles', GITHUB_BACKUP_TOKEN: 'server-only-backup-token' };
const copy: ArticleCopy = { markdown: '# 日本語 📰\n\nQuoted “text” & café.\n', capturedAt: '2026-10-01T01:00:00.000Z', source: 'upload', revision: 'first-revision' };
const article: Article = { id: 'k7m2q9x4', url: 'https://example.com/source?q=one%20two', title: 'Why we read', author: 'Author', description: 'Description', tags: ['research'], descriptionOrigin: 'manual', tagsManuallyEdited: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', readAt: null };
let env: Env;
const api = (path: string, method = 'GET', body?: unknown) => new Request(`${origin}${path}`, { method, headers: { Origin: origin, 'X-CSRF-Token': 'dev-bypass', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const route = async (path: string, method = 'GET', body?: unknown, settings = env) => (await handleArticles(api(path, method, body), settings))!;
const articleUrl = `/api/articles/${article.id}`;
const delivery = (destinationKey: string, revision = copy.revision) => route(`${articleUrl}/integrations/github`, 'POST', { expectedRevision: revision, expectedDestinationKey: destinationKey });
function encode(text: string) { const bytes = new TextEncoder().encode(text); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); }
function decode(text: string) { return new TextDecoder().decode(Uint8Array.from(atob(text), c => c.charCodeAt(0))); }
function remoteMock(initial: string | null = null) {
  let remote = initial === null ? null : { markdown: initial, sha: 'a'.repeat(40) };
  let dropAfterPut = false;
  const paths: string[] = []; const writes: Array<Record<string, unknown>> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)); paths.push(url.pathname);
    if (init?.method === 'GET') return remote ? Response.json({ type: 'file', encoding: 'base64', sha: remote.sha, content: encode(remote.markdown) }) : new Response(null, { status: 404 });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (remote && body.sha !== remote.sha) return new Response(null, { status: 409 });
    if (!remote && body.sha) return new Response(null, { status: 409 });
    writes.push(body); remote = { markdown: decode(String(body.content)), sha: 'b'.repeat(40) };
    if (dropAfterPut) { dropAfterPut = false; throw new Error('connection closed after commit'); }
    return Response.json({ content: { sha: remote.sha } }, { status: 201 });
  });
  vi.stubGlobal('fetch', fetcher);
  return { fetcher, paths, writes, get remote() { return remote?.markdown ?? null; }, set remote(value: string | null) { remote = value === null ? null : { markdown: value, sha: 'c'.repeat(40) }; }, dropAfterNextPut() { dropAfterPut = true; } };
}

beforeEach(async () => {
  env = { ...baseEnv };
  await env.DB.prepare('DELETE FROM articles').run();
  await env.DB.prepare('INSERT INTO articles(id,url,normalized_url,title,author,description,description_origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(article.id, article.url, article.url, article.title, article.author, article.description, article.descriptionOrigin, article.createdAt, article.updatedAt).run();
  await env.DB.prepare('INSERT INTO article_tags(article_id,tag) VALUES(?,?)').bind(article.id, 'research').run();
  await saveArticleCopy(env.DB, article.id, copy, null);
});
afterEach(() => vi.unstubAllGlobals());

describe('GitHub integration', () => {
  it('writes exact Markdown to a path derived from folder and stable article ID', async () => {
    const remote = remoteMock();
    const integration = (await (await route('/api/integrations')).json<{ integrations: Array<{ id: string; destinationKey: string }> }>()).integrations.find(item => item.id === 'github')!;
    const response = await delivery(integration.destinationKey);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ unchanged: false, integration: { id: 'github', state: 'saved', url: 'https://github.com/Pajdzik/Kamilpedia/blob/main/Articles/k7m2q9x4.md' } });
    expect(remote.paths).toEqual(['/repos/Pajdzik/Kamilpedia/contents/Articles/k7m2q9x4.md', '/repos/Pajdzik/Kamilpedia/contents/Articles/k7m2q9x4.md']);
    expect(remote.remote).toBe(articleMarkdown(article, copy));
    expect(remote.remote).toContain('tags: [\"research\"]\ndescriptionOrigin: \"manual\"\ntagsManuallyEdited: false');
    expect(await getArticle(env.DB, article.id)).toEqual(article);
    expect(await getArticleCopy(env.DB, article.id)).toEqual(copy);
  });

  it('always reads GitHub, detects deletion, and recreates the same ID path after title edits', async () => {
    const remote = remoteMock();
    const key = JSON.parse(JSON.stringify(['Pajdzik/Kamilpedia', 'main', 'Articles']));
    const config = JSON.stringify({ expectedRevision: copy.revision, expectedDestinationKey: JSON.stringify(key) });
    const post = () => route(`${articleUrl}/integrations/github`, 'POST', JSON.parse(config));
    await post();
    remote.remote = null;
    expect(await (await post()).json()).toMatchObject({ unchanged: false, integration: { state: 'saved' } });
    expect(remote.paths.filter(path => path.endsWith('.md'))).toHaveLength(4);
    await route(articleUrl, 'PATCH', { title: 'Renamed article' });
    const updatedArticle = (await getArticle(env.DB, article.id))!;
    await post();
    expect(remote.paths.every(path => path.endsWith('/Articles/k7m2q9x4.md'))).toBe(true);
    expect(remote.remote).toBe(articleMarkdown(updatedArticle, copy));
  });

  it('refuses to replace an occupied file that is not owned by this article ID', async () => {
    const remote = remoteMock('---\npotem_backup_version: 2\nid: \"zzzzzzzz\"\n---\nOther article\n');
    const integration = (await (await route('/api/integrations')).json<{ integrations: Array<{ id: string; destinationKey: string }> }>()).integrations.find(item => item.id === 'github')!;
    const response = await delivery(integration.destinationKey);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'github_file_conflict' } });
    expect(remote.writes).toHaveLength(0);
  });

  it('confirms an ambiguous write by exact remote bytes and retries safely', async () => {
    const remote = remoteMock(); remote.dropAfterNextPut();
    const integration = (await (await route('/api/integrations')).json<{ integrations: Array<{ id: string; destinationKey: string }> }>()).integrations.find(item => item.id === 'github')!;
    const response = await delivery(integration.destinationKey);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ unchanged: true, integration: { state: 'saved' } });
    expect(remote.fetcher).toHaveBeenCalledTimes(3); // GET, PUT (commit then timeout), GET confirmation
    expect(remote.writes).toHaveLength(1);
  });

  it('keeps receipt history scoped to each consented repository destination', async () => {
    const remote = remoteMock();
    const key = (repository: string) => JSON.stringify([repository, 'main', 'Articles']);
    const send = (repository: string) => delivery(key(repository));
    await send('Pajdzik/Kamilpedia');
    const editedCopy = { ...copy, markdown: '# changed body\n', revision: 'second-revision' };
    await saveArticleCopy(env.DB, article.id, editedCopy, copy.revision);
    const changed = { ...env, GITHUB_BACKUP_REPOSITORY: 'Other/Archive' };
    const config = await (await route('/api/integrations', 'GET', undefined, changed)).json<{ integrations: Array<{ destinationKey: string }> }>();
    expect(config.integrations.find(x => x.destinationKey === key('Other/Archive'))).toBeTruthy();
    const otherSend = await handleArticles(api(`${articleUrl}/integrations/github`, 'POST', { expectedRevision: editedCopy.revision, expectedDestinationKey: key('Other/Archive') }), changed);
    expect(otherSend?.status).toBe(200);
    expect((await (await route(`${articleUrl}/integrations`, 'GET', undefined, env)).json<{ integrations: Array<{ id: string; state: string }> }>()).integrations.find(x => x.id === 'github')?.state).toBe('outdated');
    expect((await (await route(`${articleUrl}/integrations`, 'GET', undefined, changed)).json<{ integrations: Array<{ id: string; state: string }> }>()).integrations.find(x => x.id === 'github')?.state).toBe('saved');
    const returnToA = await handleArticles(api(`${articleUrl}/integrations/github`, 'POST', { expectedRevision: editedCopy.revision, expectedDestinationKey: key('Pajdzik/Kamilpedia') }), env);
    expect(returnToA?.status).toBe(200);
    expect((await (await route(`${articleUrl}/integrations`, 'GET', undefined, env)).json<{ integrations: Array<{ id: string; state: string }> }>()).integrations.find(x => x.id === 'github')?.state).toBe('saved');
  });
});
