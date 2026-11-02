import type { Article, ArticleCopy, Env, IntegrationStatus } from '../contracts';
import { digest } from '../auth/core';
import { getArticle, getArticleCopy } from './repository';
import { isArticleId } from './identity';
import { readDeliveryReceipt, writeDeliveryReceipt } from '../integrations/delivery-receipts';
import { IntegrationError } from '../integrations/types';

type Destination = { repository: string; branch: string; folder: string; token: string; destinationKey: string };
type Target = Destination & { path: string; url: string; apiUrl: string };
const MAX_RESPONSE_BYTES = 1024 * 1024;

export class GitHubBackupError extends IntegrationError {
  constructor(status: number, code: string, message: string) {
    super(status, code, message);
    this.name = 'GitHubBackupError';
  }
}

function destinationFor(env: Env): Destination {
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
  try {
    encodeURIComponent(folder); encodeURIComponent(branch);
  } catch {
    throw new GitHubBackupError(400, 'invalid_request', 'The article ID or GitHub destination contains invalid Unicode.');
  }
  const destinationKey = JSON.stringify([repository, branch, folder]);
  return { repository, branch, folder, token, destinationKey };
}

export function getGitHubBackupConfiguration(env: Env): { configured: boolean; message?: string; repository?: string; branch?: string; folder?: string; destinationKey?: string } {
  try {
    const destination = destinationFor(env);
    return { configured: true, repository: destination.repository, branch: destination.branch, folder: destination.folder, destinationKey: destination.destinationKey };
  } catch (error) {
    if (error instanceof GitHubBackupError) return { configured: false, message: error.message };
    throw error;
  }
}

function targetForArticle(env: Env, id: string): Target {
  if (!isArticleId(id)) throw new GitHubBackupError(400, 'invalid_request', 'The article ID is invalid.');
  const destination = destinationFor(env);
  const path = `${destination.folder ? `${destination.folder}/` : ''}${id}.md`;
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return { ...destination, path, url: `https://github.com/${destination.repository}/blob/${encodeURIComponent(destination.branch)}/${encodedPath}`, apiUrl: `https://api.github.com/repos/${destination.repository}/contents/${encodedPath}` };
}

export function articleMarkdown(article: Article, copy: ArticleCopy): string {
  const metadata = {
    id: article.id, title: article.title, url: article.url,
    author: article.author, description: article.description, tags: article.tags ?? [],
    descriptionOrigin: article.descriptionOrigin ?? (article.description ? 'manual' : null),
    tagsManuallyEdited: article.tagsManuallyEdited ?? false, savedAt: article.createdAt,
    capturedAt: copy.capturedAt, source: copy.source, revision: copy.revision,
  };
  return `---\npotem_backup_version: 2\n${Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n${copy.markdown}`;
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text); let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

async function responseJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing GitHub response');
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength; if (total > MAX_RESPONSE_BYTES) throw new Error('GitHub response exceeded limit');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid GitHub response');
  return parsed;
}

async function githubRequest(target: Target, signal: AbortSignal, method: 'GET' | 'PUT', body?: unknown): Promise<unknown | null> {
  try {
    const response = await fetch(method === 'GET' ? `${target.apiUrl}?ref=${encodeURIComponent(target.branch)}` : target.apiUrl, {
      method, signal, redirect: 'error',
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${target.token}`, 'User-Agent': 'potem-markdown-backup', 'X-GitHub-Api-Version': '2026-03-10', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
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

function objectResponse(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GitHubBackupError(503, 'github_unavailable', 'GitHub returned an invalid response. Retry when ready.');
  return value as Record<string, unknown>;
}

function remoteDocument(data: Record<string, unknown>, id: string): { sha: string; markdown: string } {
  try {
    if (data.type !== 'file' || data.encoding !== 'base64' || typeof data.content !== 'string' || typeof data.sha !== 'string' || !/^[a-f0-9]{40,64}$/.test(data.sha)) throw new Error();
    const binary = atob(data.content.replace(/\s/g, ''));
    const markdown = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
    const withoutBom = markdown.charCodeAt(0) === 0xfeff ? markdown.slice(1) : markdown;
    const lines = withoutBom.split(/\r?\n/);
    if (lines[0] !== '---' || lines[1] !== 'potem_backup_version: 2') throw new Error();
    const fields = new Map<string, unknown>(); let closed = false;
    for (const line of lines.slice(2)) {
      if (line === '---') { closed = true; break; }
      const colon = line.indexOf(': '); if (colon <= 0) throw new Error();
      const key = line.slice(0, colon); if (fields.has(key)) throw new Error();
      fields.set(key, JSON.parse(line.slice(colon + 2)));
    }
    if (!closed || fields.get('id') !== id || !isArticleId(fields.get('id'))) throw new Error();
    return { sha: data.sha, markdown };
  } catch {
    throw new GitHubBackupError(409, 'github_file_conflict', 'The destination already contains a file that is not this article’s Potem backup. It has not been replaced.');
  }
}

export async function getGitHubBackupStatus(env: Env, article: Article, copy: ArticleCopy | null): Promise<IntegrationStatus> {
  let target: Target;
  try { target = targetForArticle(env, article.id); }
  catch (error) {
    if (error instanceof GitHubBackupError) return { id: 'github', name: 'GitHub', configured: false, description: 'Save Markdown files to a repository.', destination: '', destinationKey: '', state: 'not_saved', message: error.message };
    throw error;
  }
  const last = await readDeliveryReceipt(env.DB, article.id, 'github', target.destinationKey);
  const currentHash = copy ? await digest(articleMarkdown(article, copy)) : null;
  return { id: 'github', name: 'GitHub', configured: true, description: 'Save Markdown files to a repository. Files inherit the repository’s visibility.', destination: `${target.repository} · ${target.branch} · ${target.folder || '(repository root)'}`, destinationKey: target.destinationKey,
    state: !last ? 'not_saved' : last.content_hash === currentHash ? 'saved' : 'outdated', ...(last ? { deliveredAt: last.delivered_at } : {}), url: target.url };
}

export async function saveGitHubBackup(env: Env, id: string, expectedRevision: string, expectedDestination?: { repository: string; branch: string; folder: string }): Promise<{ integration: IntegrationStatus; unchanged: boolean }> {
  const article = await getArticle(env.DB, id);
  if (!article) throw new GitHubBackupError(404, 'not_found', 'Article not found.');
  const copy = await getArticleCopy(env.DB, id);
  if (!copy) throw new GitHubBackupError(409, 'copy_required', 'Save a Markdown copy before saving to GitHub.');
  if (copy.revision !== expectedRevision) throw new GitHubBackupError(409, 'revision_conflict', 'This copy changed since you opened it. Reload it before saving to GitHub.');
  const target = targetForArticle(env, id);
  if (expectedDestination && (target.repository !== expectedDestination.repository || target.branch !== expectedDestination.branch || target.folder !== expectedDestination.folder)) throw new GitHubBackupError(409, 'destination_changed', 'The configured GitHub destination changed. Review setup before saving.');
  const markdown = articleMarkdown(article, copy); const contentHash = await digest(markdown); const signal = AbortSignal.timeout(10_000);
  // Always read remote state, even when a local receipt claims this exact revision was delivered.
  let existing: { sha: string; markdown: string } | null;
  const remote = await githubRequest(target, signal, 'GET');
  existing = remote ? remoteDocument(objectResponse(remote), id) : null;
  const current = async () => {
    const a = await getArticle(env.DB, id); const c = await getArticleCopy(env.DB, id);
    if (!a || !c || articleMarkdown(a, c) !== markdown) throw new GitHubBackupError(409, 'revision_conflict', 'The article or Markdown copy changed while saving to GitHub. Reload it and retry.');
  };
  await current();
  let unchanged = existing?.markdown === markdown;
  if (!unchanged) {
    try {
      await githubRequest(target, signal, 'PUT', { message: `Save Potem article ${id}`, content: base64(markdown), branch: target.branch, ...(existing ? { sha: existing.sha } : {}) });
    } catch (error) {
      // A timed out PUT may have committed. Re-read and accept only exact bytes.
      try {
        const check = await githubRequest(target, signal, 'GET');
        existing = check ? remoteDocument(objectResponse(check), id) : null;
      } catch (readError) {
        if (error instanceof GitHubBackupError && error.code === 'github_conflict') throw error;
        throw readError;
      }
      if (existing?.markdown !== markdown) throw error;
      unchanged = true;
    }
  }
  await writeDeliveryReceipt(env.DB, id, 'github', target.destinationKey, contentHash, new Date().toISOString());
  const latest = await getArticle(env.DB, id);
  if (!latest) throw new GitHubBackupError(409, 'revision_conflict', 'The article was deleted while saving to GitHub. The GitHub file is retained.');
  return { integration: await getGitHubBackupStatus(env, latest, await getArticleCopy(env.DB, id)), unchanged };
}
