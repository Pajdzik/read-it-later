import type { Article, ArticleCopy, Env, GitHubBackupStatus } from '../contracts';
import { digest } from '../auth/core';
import { getArticle, getArticleCopy } from './repository';

type Target = { repository: string; branch: string; path: string; url: string; apiUrl: string; token: string };
const MAX_RESPONSE_BYTES = 1024 * 1024;

export class GitHubBackupError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'GitHubBackupError';
  }
}

function targetFor(env: Env, id: string): Target {
  const repository = env.GITHUB_BACKUP_REPOSITORY?.trim();
  const token = env.GITHUB_BACKUP_TOKEN?.trim();
  if (!repository || !token) throw new GitHubBackupError(503, 'github_not_configured', 'GitHub saving is not configured. Set the backup repository and server-side token.');
  const parts = repository.split('/');
  if (parts.length !== 2 || !/^[A-Za-z0-9-]{1,39}$/.test(parts[0]) ||
      !/^[A-Za-z0-9_.-]{1,100}$/.test(parts[1]) || ['.', '..'].includes(parts[1])) {
    throw new GitHubBackupError(503, 'github_not_configured', 'The configured GitHub repository must be owner/repository.');
  }
  const branch = env.GITHUB_BACKUP_BRANCH ?? 'main';
  if (!branch || branch.length > 255 || /[\x00-\x20\x7f~^:?*\[\\]/.test(branch) || branch.includes('..') ||
      branch.includes('@{') || branch === '@' || branch.startsWith('-') ||
      branch.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) {
    throw new GitHubBackupError(503, 'github_not_configured', 'The configured GitHub branch is invalid.');
  }
  const folder = (env.GITHUB_BACKUP_PATH ?? 'articles').replace(/\/+$/, '');
  if ((env.GITHUB_BACKUP_PATH ?? '').startsWith('/') || folder.length > 512 || /[\\\x00-\x1f\x7f]/.test(folder) ||
      (folder && folder.split('/').some((part) => !part || ['.', '..', '.git'].includes(part)))) {
    throw new GitHubBackupError(503, 'github_not_configured', 'The configured GitHub folder must be a relative repository path without dot segments.');
  }
  let path: string;
  try {
    // Quote opaque imported IDs as a single filename, then quote the GitHub URL
    // separately. A slash in an ID can never escape the configured folder.
    path = `${folder ? `${folder}/` : ''}${encodeURIComponent(id)}.md`;
    encodeURIComponent(folder);
    encodeURIComponent(branch);
  } catch {
    throw new GitHubBackupError(400, 'invalid_request', 'The article ID or GitHub destination contains invalid Unicode.');
  }
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return {
    repository, branch, path, token,
    url: `https://github.com/${repository}/blob/${encodeURIComponent(branch)}/${encodedPath}`,
    apiUrl: `https://api.github.com/repos/${repository}/contents/${encodedPath}`,
  };
}

function destination(target: Target) {
  return { configured: true, repository: target.repository, branch: target.branch, path: target.path, url: target.url };
}

export function articleMarkdown(article: Article, copy: ArticleCopy): string {
  // JSON-quoted strings are valid YAML scalars, including embedded newlines,
  // quotes and Unicode. Keep the body byte-for-byte, even existing frontmatter.
  const metadata = {
    id: article.id, title: article.title, url: article.url,
    author: article.author, description: article.description, savedAt: article.createdAt,
    capturedAt: copy.capturedAt, source: copy.source, revision: copy.revision,
  };
  return `---\npotem_backup_version: 1\n${Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n${copy.markdown}`;
}

export async function getGitHubBackupStatus(env: Env, article: Article, copy: ArticleCopy | null): Promise<GitHubBackupStatus> {
  let target: Target;
  try { target = targetFor(env, article.id); }
  catch (error) {
    if (error instanceof GitHubBackupError) return { configured: false, message: error.message };
    throw error;
  }
  const previous = await env.DB.prepare('SELECT repository,branch,path,content_hash,backed_up_at FROM article_github_backups WHERE article_id = ?')
    .bind(article.id).first<{ repository: string; branch: string; path: string; content_hash: string; backed_up_at: string }>();
  if (!previous || previous.repository !== target.repository || previous.branch !== target.branch || previous.path !== target.path) {
    return { ...destination(target), state: 'not_saved' };
  }
  const currentHash = copy ? await digest(articleMarkdown(article, copy)) : null;
  return { ...destination(target), state: currentHash === previous.content_hash ? 'saved' : 'outdated', backedUpAt: previous.backed_up_at };
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing GitHub response');
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error('GitHub response exceeded limit');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid GitHub response');
  return parsed as Record<string, unknown>;
}

async function githubRequest(target: Target, signal: AbortSignal, method: 'GET' | 'PUT', body?: unknown): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(method === 'GET' ? `${target.apiUrl}?ref=${encodeURIComponent(target.branch)}` : target.apiUrl, {
      method, signal, redirect: 'error',
      headers: {
        Accept: 'application/vnd.github+json', Authorization: `Bearer ${target.token}`,
        'User-Agent': 'potem-markdown-backup', 'X-GitHub-Api-Version': '2026-03-10',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (method === 'GET' && response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 409 || response.status === 422) throw new GitHubBackupError(409, 'github_conflict', 'GitHub could not commit this file. It may have changed or the branch may reject writes. Retry after checking the destination.');
      throw new GitHubBackupError(503, 'github_unavailable', 'GitHub saving failed. Check the repository, branch, token permissions, and GitHub availability, then retry.');
    }
    return await responseJson(response);
  } catch (error) {
    if (error instanceof GitHubBackupError) throw error;
    throw new GitHubBackupError(503, 'github_unavailable', 'GitHub saving could not complete. Your Markdown copy is still saved in Potem; retry when ready.');
  }
}

function remoteFile(data: Record<string, unknown>, id: string): { sha: string; markdown: string } {
  try {
    if (data.type !== 'file' || data.encoding !== 'base64' || typeof data.content !== 'string' ||
        typeof data.sha !== 'string' || !/^[a-f0-9]{40,64}$/.test(data.sha)) throw new Error();
    const binary = atob(data.content.replace(/\s/g, ''));
    const markdown = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
    const lines = markdown.split('\n', 4);
    if (lines[0] !== '---' || lines[1] !== 'potem_backup_version: 1' ||
        !lines[2].startsWith('id: ') || JSON.parse(lines[2].slice(4)) !== id) throw new Error();
    return { sha: data.sha, markdown };
  } catch {
    throw new GitHubBackupError(409, 'github_file_conflict', 'The destination already contains a file that is not this article’s Potem backup. It has not been replaced.');
  }
}

export async function saveGitHubBackup(env: Env, id: string, expectedRevision: string): Promise<{ backup: GitHubBackupStatus; unchanged: boolean }> {
  const target = targetFor(env, id);
  const article = await getArticle(env.DB, id);
  if (!article) throw new GitHubBackupError(404, 'not_found', 'Article not found.');
  const copy = await getArticleCopy(env.DB, id);
  if (!copy) throw new GitHubBackupError(409, 'copy_required', 'Save a Markdown copy before saving to GitHub.');
  if (copy.revision !== expectedRevision) throw new GitHubBackupError(409, 'revision_conflict', 'This copy changed since you opened it. Reload it before saving to GitHub.');
  const markdown = articleMarkdown(article, copy);
  const contentHash = await digest(markdown);
  const signal = AbortSignal.timeout(10_000);
  const data = await githubRequest(target, signal, 'GET');
  const existing = data ? remoteFile(data, id) : null;
  // Check after the network read. A newer D1 copy must never be overwritten by
  // an older request that was waiting for GitHub. The blob SHA protects races
  // between concurrent GitHub writes; conflicts are not blindly retried.
  const currentArticle = await getArticle(env.DB, id);
  const currentCopy = await getArticleCopy(env.DB, id);
  if (!currentArticle || !currentCopy || articleMarkdown(currentArticle, currentCopy) !== markdown) {
    throw new GitHubBackupError(409, 'revision_conflict', 'The article or Markdown copy changed while saving to GitHub. Reload it and retry.');
  }
  const unchanged = existing?.markdown === markdown;
  if (!unchanged) await githubRequest(target, signal, 'PUT', {
    message: `Save Potem article ${id}`, content: base64(markdown), branch: target.branch,
    ...(existing ? { sha: existing.sha } : {}),
  });
  const backedUpAt = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO article_github_backups (article_id,repository,branch,path,content_hash,backed_up_at)
    SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM articles WHERE id = ?)
    ON CONFLICT(article_id) DO UPDATE SET repository=excluded.repository,branch=excluded.branch,path=excluded.path,
      content_hash=excluded.content_hash,backed_up_at=excluded.backed_up_at`)
    .bind(id, target.repository, target.branch, target.path, contentHash, backedUpAt, id).run();
  const latestArticle = await getArticle(env.DB, id);
  if (!latestArticle) throw new GitHubBackupError(409, 'revision_conflict', 'The article was deleted while saving to GitHub. The GitHub file is retained.');
  return { backup: await getGitHubBackupStatus(env, latestArticle, await getArticleCopy(env.DB, id)), unchanged };
}
