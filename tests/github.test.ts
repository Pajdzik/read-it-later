import { env as testEnv } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Article, ArticleCopy, Env, GitHubBackupStatus } from '../src/contracts';
import { handleArticles } from '../src/articles/handler';
import { articleMarkdown } from '../src/articles/github';
import { getArticle, getArticleCopy, saveArticleCopy } from '../src/articles/repository';

const origin = 'http://localhost:8787';
const env: Env = {
  ...testEnv, APP_ORIGIN: origin, DEV_AUTH_BYPASS: 'true',
  GITHUB_BACKUP_REPOSITORY: 'Pajdzik/Kamilpedia', GITHUB_BACKUP_BRANCH: 'main',
  GITHUB_BACKUP_PATH: 'Articles', GITHUB_BACKUP_TOKEN: 'server-only-backup-token',
};
const copy: ArticleCopy = { markdown: '# 日本語 📰\n\nQuoted “text” & café.\n\n---\nExisting body frontmatter\n', capturedAt: '2026-10-01T01:00:00.000Z', source: 'upload', revision: 'first-revision' };
const article: Article = {
  id: 'k7m2q9x4', url: 'https://example.com/source?q=one%20two', title: 'Why we read',
  author: 'Author', description: 'Description\nwith newline', createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z', readAt: '2026-01-03T00:00:00.000Z',
};
function request(method = 'GET', body?: unknown, id = article.id, headers: HeadersInit = {}): Request {
  const h = new Headers({ Origin: origin, 'X-CSRF-Token': 'dev-bypass', 'Content-Type': 'application/json' });
  new Headers(headers).forEach((value, key) => h.set(key, value));
  return new Request(`${origin}/api/articles/${encodeURIComponent(id)}/github`, { method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function reconcileRequest(body = '{}', headers: HeadersInit = {}): Request {
  const h = new Headers({ Origin: origin, 'X-CSRF-Token': 'dev-bypass', 'Content-Type': 'application/json' });
  new Headers(headers).forEach((value, key) => h.set(key, value));
  return new Request(`${origin}/api/github/reconcile`, { method: 'POST', headers: h, body });
}
async function route(req = request(), settings = env): Promise<Response> {
  return (await handleArticles(req, settings))!;
}
const saveRequest = () => request('POST', { expectedRevision: copy.revision });
function encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
function decode(text: string): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(text), (char) => char.charCodeAt(0)));
}
function mockGitHub(initial: string | null = null) {
  let content = initial;
  let sha = 'a'.repeat(40);
  let conflictWrites = 0;
  const writes: Array<Record<string, unknown>> = [];
  const files = new Map<string, { content: string; sha: string }>();
  let listing: Array<{ path: string; type: 'file'; size: number }> = [];
  let dropAfterPut = false;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (init?.method === 'GET' && !url.pathname.endsWith('.md')) return Response.json(listing);
    const path = decodeURIComponent(url.pathname.split('/contents/')[1] ?? '');
    const file = files.get(path) ?? (path === 'Articles/why-we-read.md' && content !== null ? { content, sha } : null);
    if (init?.method === 'GET') return file === null ? new Response(null, { status: 404 })
      : Response.json({ type: 'file', encoding: 'base64', sha: file.sha, content: encode(file.content) });
    const body = JSON.parse(String(init?.body));
    if (conflictWrites > 0) { conflictWrites -= 1; return new Response(null, { status: 409 }); }
    if (file !== null && body.sha !== file.sha) return new Response(null, { status: 409 });
    writes.push(body);
    content = decode(body.content);
    sha = 'b'.repeat(40);
    files.set(path, { content, sha });
    if (dropAfterPut) { dropAfterPut = false; throw new Error('connection closed after commit'); }
    return Response.json({ content: { sha }, commit: { sha: 'c'.repeat(40) } }, { status: 201 });
  });
  vi.stubGlobal('fetch', fetcher);
  return { fetcher, writes, content: (path = 'Articles/why-we-read.md') => files.get(path)?.content ?? (path === 'Articles/why-we-read.md' ? content : null),
    setFile: (path: string, value: string) => files.set(path, { content: value, sha }),
    setListing: (paths: string[]) => { listing = paths.map((path) => ({ path, type: 'file', size: new TextEncoder().encode(files.get(path)?.content ?? '').byteLength })); },
    dropAfterNextWrite: () => { dropAfterPut = true; },
    conflictNextWrite: () => { conflictWrites += 1; } };
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM articles').run();
  await env.DB.prepare('INSERT INTO articles(id,url,normalized_url,title,author,description,created_at,updated_at,read_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .bind(article.id, article.url, article.url, article.title, article.author, article.description, article.createdAt, article.updatedAt, article.readAt).run();
  await saveArticleCopy(env.DB, article.id, copy, null);
});
afterEach(() => vi.unstubAllGlobals());

describe('GitHub Markdown saving', () => {
  it('returns only authenticated GitHub destination configuration before an article exists', async () => {
    const configRequest = () => new Request(`${origin}/api/github`, { headers: { Origin: origin } });
    const configured = await route(configRequest());
    expect(configured.status).toBe(200);
    const configuration = await configured.json();
    expect(configuration).toEqual({ github: {
      configured: true, repository: 'Pajdzik/Kamilpedia', branch: 'main', folder: 'Articles',
    } });
    expect(JSON.stringify(configuration)).not.toContain(env.GITHUB_BACKUP_TOKEN);
    for (const settings of [
      { ...env, GITHUB_BACKUP_TOKEN: undefined },
      { ...env, GITHUB_BACKUP_REPOSITORY: '../unsafe' },
    ]) {
      expect(await (await route(configRequest(), settings)).json()).toMatchObject({ github: { configured: false, message: expect.any(String) } });
    }
    const privateEnv: Env = { ...env, DEV_AUTH_BYPASS: undefined, APP_ORIGIN: 'https://service.example', GITHUB_CLIENT_ID: 'client', GITHUB_CLIENT_SECRET: 'secret', OWNER_GITHUB_ID: '123456' };
    const unauthorized = await handleArticles(new Request('https://service.example/api/github', { headers: { Authorization: 'Bearer capture-token' } }), privateEnv);
    expect(unauthorized?.status).toBe(401);
  });

  it('writes Unicode Markdown with safe frontmatter to the configured path, without changing D1 state', async () => {
    const remote = mockGitHub();
    const response = await route(saveRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await response.json()).toMatchObject({ unchanged: false, backup: {
      configured: true, repository: 'Pajdzik/Kamilpedia', branch: 'main', path: 'Articles/why-we-read.md', state: 'saved', backedUpAt: expect.any(String),
    } });
    expect(remote.fetcher.mock.calls.some(([url]) => url === 'https://api.github.com/repos/Pajdzik/Kamilpedia/contents/Articles/why-we-read.md?ref=main')).toBe(true);
    expect(remote.fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal), headers: { Authorization: `Bearer ${env.GITHUB_BACKUP_TOKEN}` } });
    expect(remote.writes[0]).toMatchObject({ branch: 'main' });
    expect(remote.writes[0]).not.toHaveProperty('sha');
    const content = remote.content()!;
    expect(content).toBe(articleMarkdown(article, copy));
    const separator = content.indexOf('\n---\n', 4);
    const metadata = Object.fromEntries(content.slice(4, separator).split('\n').map((line) => {
      const colon = line.indexOf(': ');
      return [line.slice(0, colon), JSON.parse(line.slice(colon + 2))];
    }));
    expect(metadata).toMatchObject({ id: article.id, title: article.title, url: article.url, capturedAt: copy.capturedAt, source: copy.source, revision: copy.revision });
    expect(content.slice(separator + 5)).toBe(copy.markdown);
    expect(content).not.toContain(env.GITHUB_BACKUP_TOKEN);
    expect(metadata).not.toHaveProperty('readAt');
    expect(await getArticle(env.DB, article.id)).toEqual(article);
    expect(await getArticleCopy(env.DB, article.id)).toEqual(copy);
    expect(JSON.stringify(await (await route()).json())).not.toContain(env.GITHUB_BACKUP_TOKEN);

    // Recover the frontmatter/body through the existing version-2 D1 importer.
    await env.DB.prepare('DELETE FROM articles').run();
    const restore = new Request(`${origin}/api/import`, { method: 'POST', headers: {
      Origin: origin, 'X-CSRF-Token': 'dev-bypass', 'Content-Type': 'application/json',
    }, body: JSON.stringify({ version: 2, exportedAt: copy.capturedAt, articles: [{
      id: metadata.id, url: metadata.url, title: metadata.title, author: metadata.author, description: metadata.description,
      createdAt: metadata.savedAt, updatedAt: metadata.savedAt, readAt: null,
      copy: { markdown: content.slice(separator + 5), capturedAt: metadata.capturedAt, source: metadata.source, revision: metadata.revision },
    }] }) });
    expect(await (await handleArticles(restore, env))?.json()).toEqual({ imported: 1, skipped: 0 });
    expect(await getArticleCopy(env.DB, article.id)).toEqual(copy);
    expect(await env.DB.prepare('SELECT article_id FROM article_github_backups').first()).toBeNull();
  });

  it('makes retries idempotent and updates existing backups using the current blob SHA', async () => {
    const remote = mockGitHub();
    expect((await route(saveRequest())).status).toBe(200);
    expect(await (await route(saveRequest())).json()).toMatchObject({ unchanged: true });
    expect(remote.writes).toHaveLength(1);
    const next = { ...copy, markdown: '# New saved copy', revision: 'next-revision' };
    await saveArticleCopy(env.DB, article.id, next, copy.revision);
    expect(await (await route()).json()).toMatchObject({ backup: { state: 'outdated' } });
    expect((await route(request('POST', { expectedRevision: next.revision }))).status).toBe(200);
    expect(remote.writes[1]).toMatchObject({ sha: 'b'.repeat(40) });
    expect(remote.content()).toBe(articleMarkdown(article, next));
    expect(await (await route()).json()).toMatchObject({ backup: { state: 'saved' } });
    await env.DB.prepare('UPDATE articles SET read_at = NULL, updated_at = ? WHERE id = ?').bind('2026-10-02T00:00:00.000Z', article.id).run();
    expect(await (await route()).json()).toMatchObject({ backup: { state: 'saved' } });
    await env.DB.prepare('UPDATE articles SET title = ? WHERE id = ?').bind('Edited title', article.id).run();
    expect(await (await route()).json()).toMatchObject({ backup: { state: 'outdated' } });
    expect(await (await route()).json()).toMatchObject({ backup: { path: 'Articles/why-we-read.md' } });
    expect(await (await route(request(), { ...env, GITHUB_BACKUP_PATH: 'Other' })).json()).toMatchObject({ backup: { state: 'not_saved', path: 'Other/edited-title.md' } });
  });

  it('handles the maximum UTF-8 copy size without losing bytes or duplicating commits', async () => {
    const largeCopy = { ...copy, markdown: 'é'.repeat(262144 / 2), revision: 'large-copy' };
    await saveArticleCopy(env.DB, article.id, largeCopy, copy.revision);
    const remote = mockGitHub();
    expect((await route(request('POST', { expectedRevision: largeCopy.revision }))).status).toBe(200);
    expect(remote.content()).toBe(articleMarkdown(article, largeCopy));
    expect(await (await route(request('POST', { expectedRevision: largeCopy.revision }))).json()).toMatchObject({ unchanged: true });
    expect(remote.writes).toHaveLength(1);
  });

  it('encodes a Unicode configured folder and branch independently', async () => {
    const remote = mockGitHub();
    const settings = { ...env, GITHUB_BACKUP_PATH: 'Articles/日本語 folder/', GITHUB_BACKUP_BRANCH: 'archive/markdown' };
    expect((await route(request('POST', { expectedRevision: copy.revision }), settings)).status).toBe(200);
    const expectedPath = 'Articles/日本語 folder/why-we-read.md';
    expect(remote.fetcher.mock.calls.some(([url]) => url === `https://api.github.com/repos/Pajdzik/Kamilpedia/contents/${expectedPath.split('/').map(encodeURIComponent).join('/')}?ref=archive%2Fmarkdown`)).toBe(true);
    expect(remote.writes[0]).toMatchObject({ branch: 'archive/markdown' });
  });

  it('refuses stale copies and copies that change during a GitHub read', async () => {
    const remote = mockGitHub();
    expect((await route(request('POST', { expectedRevision: 'stale' }))).status).toBe(409);
    expect(remote.fetcher).not.toHaveBeenCalled();
    remote.fetcher.mockImplementationOnce(async () => {
      await saveArticleCopy(env.DB, article.id, { ...copy, markdown: 'newer', revision: 'newer' }, copy.revision);
      return new Response(null, { status: 404 });
    });
    expect((await route(saveRequest())).status).toBe(409);
    expect(remote.writes).toHaveLength(0);
    expect((await getArticleCopy(env.DB, article.id))?.markdown).toBe('newer');
  });

  it('rejects a consented destination mismatch before contacting GitHub', async () => {
    const remote = mockGitHub();
    const response = await route(request('POST', { expectedRevision: copy.revision, expectedDestination: { repository: 'Pajdzik/Kamilpedia', branch: 'main', folder: '' } }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'destination_changed' } });
    expect(remote.fetcher).not.toHaveBeenCalled();
    const rootFolderSettings = { ...env, GITHUB_BACKUP_PATH: '' };
    const rootRemote = mockGitHub();
    expect((await route(request('POST', { expectedRevision: copy.revision, expectedDestination: { repository: 'Pajdzik/Kamilpedia', branch: 'main', folder: '' } }), rootFolderSettings)).status).toBe(200);
    expect(rootRemote.fetcher).toHaveBeenCalled();
  });

  it('skips an occupied initial name and keeps SHA conflict protection on assigned files', async () => {
    const unrelated = mockGitHub();
    unrelated.setFile('Articles/why-we-read.md', '# A manually maintained file');
    expect(await (await route(saveRequest())).json()).toMatchObject({ backup: { path: 'Articles/why-we-read-2.md', state: 'saved' } });
    expect(unrelated.writes).toHaveLength(1);
    expect(unrelated.content('Articles/why-we-read.md')).toBe('# A manually maintained file');
    const remote = mockGitHub(articleMarkdown(article, { ...copy, revision: 'old-revision' }));
    remote.conflictNextWrite();
    const conflict = await route(saveRequest());
    expect(conflict.status).toBe(409);
    expect(remote.fetcher).toHaveBeenCalledTimes(3);
    expect(await getArticleCopy(env.DB, article.id)).toEqual(copy);
  });

  it('allocates suffixes when another article already reserved the readable name', async () => {
    const remote = mockGitHub();
    expect((await route(saveRequest())).status).toBe(200);
    const secondId = 'abcdefgh';
    await env.DB.prepare('INSERT INTO articles(id,url,normalized_url,title,created_at,updated_at,read_at) VALUES(?,?,?,?,?,?,NULL)')
      .bind(secondId, 'https://example.com/second', 'https://example.com/second', article.title, article.createdAt, article.createdAt).run();
    await saveArticleCopy(env.DB, secondId, copy, null);
    expect((await route(request('POST', { expectedRevision: copy.revision }, secondId))).status).toBe(200);
    expect(await env.DB.prepare('SELECT path FROM article_github_backup_paths WHERE article_id = ?').bind(secondId).first()).toEqual({ path: 'Articles/why-we-read-2.md' });
  });

  it('reconciles a renamed backup by frontmatter ID and rejects duplicate claims', async () => {
    const remote = mockGitHub();
    const renamed = articleMarkdown(article, copy);
    remote.setFile('Articles/renamed-by-hand.md', renamed);
    remote.setListing(['Articles/renamed-by-hand.md']);
    const reconciled = await route(reconcileRequest());
    expect(reconciled.status).toBe(200);
    expect(reconciled.headers.get('Cache-Control')).toContain('no-store');
    expect(await reconciled.json()).toEqual({ scanned: 1, mapped: 1, conflicts: [] });
    expect((await route(saveRequest())).status).toBe(200);
    expect(await (await route()).json()).toMatchObject({ backup: { path: 'Articles/renamed-by-hand.md', state: 'saved' } });
    expect(remote.writes).toHaveLength(0);

    await env.DB.prepare('DELETE FROM article_github_backup_paths WHERE article_id = ?').bind(article.id).run();
    await env.DB.prepare('DELETE FROM article_github_backups WHERE article_id = ?').bind(article.id).run();
    const wrongSource = articleMarkdown({ ...article, url: 'https://different.example/article' }, copy);
    remote.setFile('Articles/renamed-by-hand.md', wrongSource);
    expect(await (await route(reconcileRequest())).json()).toMatchObject({ scanned: 1, mapped: 0, conflicts: [{ id: article.id, code: 'source_mismatch' }] });
    expect(await env.DB.prepare('SELECT path FROM article_github_backup_paths WHERE article_id = ?').bind(article.id).first()).toBeNull();
    remote.setFile('Articles/renamed-by-hand.md', `\uFEFF${renamed.replace(/\n/g, '\r\n')}`);
    expect(await (await route(reconcileRequest())).json()).toEqual({ scanned: 1, mapped: 1, conflicts: [] });
    expect((await route(saveRequest())).status).toBe(200);
    await env.DB.prepare('DELETE FROM article_github_backup_paths WHERE article_id = ?').bind(article.id).run();
    await env.DB.prepare('DELETE FROM article_github_backups WHERE article_id = ?').bind(article.id).run();
    remote.setFile('Articles/also-a-duplicate.md', renamed);
    remote.setListing(['Articles/renamed-by-hand.md', 'Articles/also-a-duplicate.md']);
    expect(await (await route(reconcileRequest())).json()).toMatchObject({ scanned: 2, mapped: 0, conflicts: [{ id: article.id, code: 'github_duplicate_backups' }] });
  });

  it('protects path reconciliation with owner authentication and CSRF checks', async () => {
    mockGitHub();
    const privateEnv: Env = { ...env, DEV_AUTH_BYPASS: undefined, APP_ORIGIN: 'https://service.example', GITHUB_CLIENT_ID: 'client', GITHUB_CLIENT_SECRET: 'secret', OWNER_GITHUB_ID: '123456' };
    expect((await route(reconcileRequest('{}', { Origin: 'https://attacker.example' }))).status).toBe(403);
    expect((await route(reconcileRequest('{}', { 'X-CSRF-Token': '' }))).status).toBe(403);
    expect((await route(reconcileRequest('[]'))).status).toBe(400);
    expect((await route(new Request('https://service.example/api/github/reconcile', { method: 'POST', headers: { Authorization: 'Bearer capture-token', 'Content-Type': 'application/json' }, body: '{}' }), privateEnv)).status).toBe(401);
  });

  it('reuses a reserved path when GitHub committed before the request timed out', async () => {
    const remote = mockGitHub();
    remote.dropAfterNextWrite();
    expect((await route(saveRequest())).status).toBe(503);
    expect(await env.DB.prepare('SELECT path FROM article_github_backup_paths WHERE article_id = ?').bind(article.id).first()).toEqual({ path: 'Articles/why-we-read.md' });
    expect((await route(saveRequest())).status).toBe(200);
    expect(remote.writes).toHaveLength(1);
  });

  it('makes concurrent initial saves share one path and one GitHub commit', async () => {
    const remote = mockGitHub();
    const responses = await Promise.all([route(saveRequest()), route(saveRequest())]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(remote.writes).toHaveLength(1);
    expect(await env.DB.prepare('SELECT path FROM article_github_backup_paths WHERE article_id = ?').bind(article.id).first()).toEqual({ path: 'Articles/why-we-read.md' });
  });

  it('keeps a confirmed path assigned when its reservation row must be restored', async () => {
    const remote = mockGitHub();
    expect((await route(saveRequest())).status).toBe(200);
    const confirmed = (await (await route()).json() as { backup: GitHubBackupStatus }).backup;
    await env.DB.prepare('DELETE FROM article_github_backup_paths WHERE article_id = ?').bind(article.id).run();
    remote.setFile('Articles/why-we-read.md', '# unrelated replacement');

    const response = await route(saveRequest());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'github_file_conflict' } });
    expect(remote.writes).toHaveLength(1);
    expect(await env.DB.prepare('SELECT path FROM article_github_backup_paths WHERE article_id = ?').bind(article.id).first()).toEqual({ path: 'Articles/why-we-read.md' });
    expect(await env.DB.prepare('SELECT path FROM article_github_backups WHERE article_id = ?').bind(article.id).first()).toEqual({ path: 'Articles/why-we-read.md' });
    expect((await (await route()).json() as { backup: GitHubBackupStatus }).backup.backedUpAt).toBe(confirmed.backedUpAt);
  });

  it('retains D1 copies and previous backup status when GitHub fails', async () => {
    mockGitHub();
    expect((await route(saveRequest())).status).toBe(200);
    const previous = (await (await route()).json() as { backup: GitHubBackupStatus }).backup.backedUpAt;
    for (const status of [401, 403, 429, 500]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status })));
      const result = await route(saveRequest());
      expect(result.status).toBe(503);
      expect(JSON.stringify(await result.json())).not.toContain(env.GITHUB_BACKUP_TOKEN);
      expect(await getArticleCopy(env.DB, article.id)).toEqual(copy);
      expect((await (await route()).json() as { backup: GitHubBackupStatus }).backup.backedUpAt).toBe(previous);
    }
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network failure with private detail'); }));
    expect((await route(saveRequest())).status).toBe(503);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ content: 'x'.repeat(1024 * 1024 + 1) })));
    expect((await route(saveRequest())).status).toBe(503);
  });

  it('requires configuration, a saved copy, owner authentication, CSRF, and a valid envelope', async () => {
    const remote = mockGitHub();
    expect(await (await route(request(), { ...env, GITHUB_BACKUP_TOKEN: undefined })).json()).toMatchObject({ backup: { configured: false } });
    expect((await route(saveRequest(), { ...env, GITHUB_BACKUP_TOKEN: undefined })).status).toBe(503);
    for (const path of ['../Articles', '/Articles', 'Articles/../Other', 'Articles\\Other', 'Articles//Other']) {
      expect((await route(saveRequest(), { ...env, GITHUB_BACKUP_PATH: path })).status).toBe(503);
    }
    expect((await route(saveRequest(), { ...env, GITHUB_BACKUP_BRANCH: '../main' })).status).toBe(503);
    expect((await route(request('POST', { expectedRevision: copy.revision, markdown: 'Client content' }))).status).toBe(400);
    expect((await route(request('POST', { expectedRevision: null }))).status).toBe(400);
    expect((await route(request('POST', { expectedRevision: copy.revision }, article.id, { Origin: 'https://attacker.example' }))).status).toBe(403);
    expect((await route(request('POST', { expectedRevision: copy.revision }, article.id, { 'X-CSRF-Token': '' }))).status).toBe(403);
    const privateEnv: Env = { ...env, DEV_AUTH_BYPASS: undefined, APP_ORIGIN: 'https://service.example', GITHUB_CLIENT_ID: 'client', GITHUB_CLIENT_SECRET: 'secret', OWNER_GITHUB_ID: '123456' };
    expect((await route(new Request('https://service.example/api/articles/k7m2q9x4/github', { headers: { Authorization: 'Bearer capture-token' } }), privateEnv)).status).toBe(401);
    expect((await route(new Request('https://service.example/api/articles/k7m2q9x4/github', { method: 'POST', body: '{}' }), privateEnv)).status).toBe(401);
    expect((await route(request('GET', undefined, 'abcdefgh'))).status).toBe(404);
    expect((await route(request('POST', { expectedRevision: copy.revision }, 'abcdefgh'))).status).toBe(404);
    await env.DB.prepare('DELETE FROM article_copies WHERE article_id = ?').bind(article.id).run();
    expect(await (await route(saveRequest())).json()).toMatchObject({ error: { code: 'copy_required' } });
    expect(remote.fetcher).not.toHaveBeenCalled();
  });
});
