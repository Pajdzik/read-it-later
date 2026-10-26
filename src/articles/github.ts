import type { Article, ArticleCopy, Env, GitHubBackupConfiguration, GitHubBackupStatus } from '../contracts';
import { digest } from '../auth/core';
import { getArticle, getArticleCopy } from './repository';
import { backupBasename, isArticleId } from './identity';
import { normalizeArticleUrl } from './validation';

type Target = { repository: string; branch: string; folder: string; basename: string; path: string; url: string; apiUrl: string; token: string };
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_RECONCILE_FILES = 100;
const MAX_RECONCILE_TOTAL_BYTES = 4 * 1024 * 1024;

export class GitHubBackupError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'GitHubBackupError';
  }
}

export function getGitHubBackupConfiguration(env: Env): GitHubBackupConfiguration {
  try {
    const target = targetFor(env, 'capture-configuration');
    const slash = target.path.lastIndexOf('/');
    return {
      configured: true,
      repository: target.repository,
      branch: target.branch,
      folder: slash < 0 ? '' : target.path.slice(0, slash),
    };
  } catch (error) {
    if (error instanceof GitHubBackupError) return { configured: false, message: error.message };
    throw error;
  }
}

function targetFor(env: Env, id: string, title = ''): Target {
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
  const basename = `${backupBasename(title)}.md`;
  try {
    path = `${folder ? `${folder}/` : ''}${basename}`;
    encodeURIComponent(id);
    encodeURIComponent(folder);
    encodeURIComponent(branch);
  } catch {
    throw new GitHubBackupError(400, 'invalid_request', 'The article ID or GitHub destination contains invalid Unicode.');
  }
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return {
    repository, branch, folder, basename, path, token,
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
  try { target = targetFor(env, article.id, article.title); }
  catch (error) {
    if (error instanceof GitHubBackupError) return { configured: false, message: error.message };
    throw error;
  }
  const previous = await env.DB.prepare('SELECT repository,branch,path,content_hash,backed_up_at FROM article_github_backups WHERE article_id = ?')
    .bind(article.id).first<{ repository: string; branch: string; path: string; content_hash: string; backed_up_at: string }>();
  const reservation = await getReservation(env, article.id, target);
  const previousInFolder = previous && (target.folder
    ? previous.path.startsWith(`${target.folder}/`) && previous.path.slice(target.folder.length + 1).length > 0
    : !previous.path.includes('/'));
  const assignedPath = reservation?.path ?? (previousInFolder && previous?.repository === target.repository && previous.branch === target.branch ? previous.path : target.path);
  const assignedTarget = withPath(target, assignedPath);
  if (!previous || previous.repository !== target.repository || previous.branch !== target.branch || previous.path !== assignedPath) {
    return { ...destination(assignedTarget), state: 'not_saved' };
  }
  const currentHash = copy ? await digest(articleMarkdown(article, copy)) : null;
  return { ...destination(assignedTarget), state: currentHash === previous.content_hash ? 'saved' : 'outdated', backedUpAt: previous.backed_up_at };
}

function withPath(target: Target, path: string): Target {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return { ...target, path, url: `https://github.com/${target.repository}/blob/${encodeURIComponent(target.branch)}/${encodedPath}`, apiUrl: `https://api.github.com/repos/${target.repository}/contents/${encodedPath}` };
}

type Reservation = { path: string };
async function getReservation(env: Env, id: string, target: Target): Promise<Reservation | null> {
  return env.DB.prepare(`SELECT path FROM article_github_backup_paths
    WHERE article_id = ? AND repository = ? AND branch = ? AND folder = ?`)
    .bind(id, target.repository, target.branch, target.folder).first<Reservation>();
}

async function reserve(env: Env, id: string, target: Target, path: string): Promise<boolean> {
  const result = await env.DB.prepare(`INSERT OR IGNORE INTO article_github_backup_paths
    (article_id,repository,branch,folder,path) VALUES(?,?,?,?,?)`)
    .bind(id, target.repository, target.branch, target.folder, path).run();
  const row = await getReservation(env, id, target);
  return row?.path === path && Number(result.meta.changes ?? 0) === 1;
}

async function releaseReservation(env: Env, id: string, target: Target, path: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM article_github_backup_paths
    WHERE article_id = ? AND repository = ? AND branch = ? AND folder = ? AND path = ?`)
    .bind(id, target.repository, target.branch, target.folder, path).run();
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

async function responseJson(response: Response, maximumBytes = MAX_RESPONSE_BYTES): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing GitHub response');
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) throw new Error('GitHub response exceeded limit');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid GitHub response');
  return parsed;
}

async function githubRequest(target: Target, signal: AbortSignal, method: 'GET' | 'PUT', body?: unknown, requestUrl = target.apiUrl, maximumBytes = MAX_RESPONSE_BYTES): Promise<unknown | null> {
  try {
    const response = await fetch(method === 'GET' ? `${requestUrl}?ref=${encodeURIComponent(target.branch)}` : requestUrl, {
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
    return await responseJson(response, maximumBytes);
  } catch (error) {
    if (error instanceof GitHubBackupError) throw error;
    throw new GitHubBackupError(503, 'github_unavailable', 'GitHub saving could not complete. Your Markdown copy is still saved in Potem; retry when ready.');
  }
}

function objectResponse(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GitHubBackupError(503, 'github_unavailable', 'GitHub returned an invalid response. Retry when ready.');
  return value as Record<string, unknown>;
}

function backupHeader(markdown: string): { id: string | null; url: string | null } | null {
  try {
    const withoutBom = markdown.charCodeAt(0) === 0xfeff ? markdown.slice(1) : markdown;
    const lines = withoutBom.split(/\r?\n/);
    if (lines[0] !== '---' || lines[1] !== 'potem_backup_version: 1') return null;
    const fields = new Map<string, unknown>();
    let closed = false;
    for (const line of lines.slice(2)) {
      if (line === '---') { closed = true; break; }
      const colon = line.indexOf(': ');
      if (colon <= 0) return null;
      const key = line.slice(0, colon);
      if (fields.has(key)) return null;
      fields.set(key, JSON.parse(line.slice(colon + 2)));
    }
    if (!closed) return null;
    return { id: typeof fields.get('id') === 'string' ? fields.get('id') as string : null,
      url: typeof fields.get('url') === 'string' ? fields.get('url') as string : null };
  } catch { return null; }
}

function listedFile(data: unknown, folder: string): { path: string; size: number }[] {
  if (!Array.isArray(data)) throw new GitHubBackupError(503, 'github_unavailable', 'GitHub returned an invalid folder listing. Retry when ready.');
  const files = data.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
    .filter((entry) => entry.type === 'file' && typeof entry.path === 'string' && entry.path.endsWith('.md'));
  const prefix = folder ? `${folder}/` : '';
  if (files.some((entry) => typeof entry.path !== 'string' || !entry.path.startsWith(prefix) || entry.path.slice(prefix.length).includes('/'))) {
    throw new GitHubBackupError(503, 'github_unavailable', 'GitHub returned an unexpected folder path. Retry after reviewing the destination.');
  }
  if (files.length > MAX_RECONCILE_FILES || files.some((entry) => typeof entry.size !== 'number' || !Number.isFinite(entry.size) || entry.size < 0 || entry.size > MAX_RECONCILE_TOTAL_BYTES) ||
      files.reduce((sum, entry) => sum + Number(entry.size), 0) > MAX_RECONCILE_TOTAL_BYTES) {
    throw new GitHubBackupError(409, 'github_reconcile_limit', 'The GitHub folder is too large to reconcile safely. Review the folder or restore its path mapping before retrying.');
  }
  return files.map((entry) => ({ path: entry.path as string, size: entry.size as number }));
}

export async function reconcileGitHubBackupPaths(env: Env): Promise<{ scanned: number; mapped: number; conflicts: Array<{ id: string; path: string; code: string }> }> {
  const target = targetFor(env, 'reconcile');
  const signal = AbortSignal.timeout(10_000);
  const folderPath = target.folder ? target.folder.split('/').map(encodeURIComponent).join('/') : '';
  const listingUrl = `https://api.github.com/repos/${target.repository}/contents${folderPath ? `/${folderPath}` : ''}`;
  const files = listedFile((await githubRequest(target, signal, 'GET', undefined, listingUrl)) ?? [], target.folder);
  const matches = new Map<string, Array<{ path: string; url: string | null }>>();
  const conflicts: Array<{ id: string; path: string; code: string }> = [];
  // Four bounded requests at a time keep restore reconciliation within the
  // shared deadline while retaining a hard limit on scanned bytes and files.
  for (let offset = 0; offset < files.length; offset += 4) {
    const batch = await Promise.all(files.slice(offset, offset + 4).map(async (file) => {
      const maximumResponseBytes = Math.min(400 * 1024, Math.ceil(file.size * 4 / 3) + 8 * 1024);
      const remote = await githubRequest(target, signal, 'GET', undefined, withPath(target, file.path).apiUrl, maximumResponseBytes);
      if (!remote) return null;
      try {
        const parsed = remoteDocument(objectResponse(remote));
        if (!parsed.id || !isArticleId(parsed.id)) return null;
        return { id: parsed.id, path: file.path, url: parsed.url };
      } catch (error) {
        if (error instanceof GitHubBackupError && error.code === 'github_file_conflict') return null;
        throw error;
      }
    }));
    for (const record of batch) {
      if (!record) continue;
      const paths = matches.get(record.id) ?? [];
      paths.push({ path: record.path, url: record.url });
      matches.set(record.id, paths);
    }
  }
  let mapped = 0;
  for (const [id, paths] of matches) {
    if (paths.length > 1) {
      conflicts.push({ id, path: paths.map((record) => record.path).join(','), code: 'github_duplicate_backups' });
      continue;
    }
    const { path, url: sourceUrl } = paths[0];
    const article = await env.DB.prepare('SELECT normalized_url FROM articles WHERE id = ?').bind(id).first<{ normalized_url: string }>();
    if (!article) { conflicts.push({ id, path, code: 'unknown_article' }); continue; }
    let normalizedRemote: string | null = null;
    try { if (sourceUrl) normalizedRemote = normalizeArticleUrl(sourceUrl).normalizedUrl; } catch { /* report below */ }
    if (normalizedRemote !== article.normalized_url) { conflicts.push({ id, path, code: 'source_mismatch' }); continue; }
    const owner = await env.DB.prepare(`SELECT article_id FROM article_github_backup_paths
      WHERE repository = ? AND branch = ? AND path = ?`).bind(target.repository, target.branch, path).first<{ article_id: string }>();
    if (owner && owner.article_id !== id) { conflicts.push({ id, path, code: 'github_path_conflict' }); continue; }
    const current = await getReservation(env, id, target);
    if (current?.path === path) { mapped += 1; continue; }
    if (current) {
      await env.DB.prepare(`UPDATE OR IGNORE article_github_backup_paths SET path = ?
        WHERE article_id = ? AND repository = ? AND branch = ? AND folder = ?
        AND NOT EXISTS (SELECT 1 FROM article_github_backup_paths WHERE repository = ? AND branch = ? AND path = ? AND article_id != ?)`)
        .bind(path, id, target.repository, target.branch, target.folder, target.repository, target.branch, path, id).run();
    } else {
      await reserve(env, id, target, path);
    }
    const confirmed = await getReservation(env, id, target);
    if (confirmed?.path === path) mapped += 1;
    else conflicts.push({ id, path, code: 'github_path_conflict' });
  }
  return { scanned: files.length, mapped, conflicts };
}

function remoteDocument(data: Record<string, unknown>): { sha: string; markdown: string; id: string | null; url: string | null } {
  try {
    if (data.type !== 'file' || data.encoding !== 'base64' || typeof data.content !== 'string' ||
        typeof data.sha !== 'string' || !/^[a-f0-9]{40,64}$/.test(data.sha)) throw new Error();
    const binary = atob(data.content.replace(/\s/g, ''));
    const markdown = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
    const header = backupHeader(markdown);
    return { sha: data.sha, markdown, id: header?.id ?? null, url: header?.url ?? null };
  } catch {
    throw new GitHubBackupError(409, 'github_file_conflict', 'The destination already contains a file that is not this article’s Potem backup. It has not been replaced.');
  }
}

function remoteFile(data: Record<string, unknown>, id: string): { sha: string; markdown: string } {
  const remote = remoteDocument(data);
  if (remote.id !== id) throw new GitHubBackupError(409, 'github_file_conflict', 'The destination already contains a file that is not this article’s Potem backup. It has not been replaced.');
  return remote;
}

export async function saveGitHubBackup(
  env: Env,
  id: string,
  expectedRevision: string,
  expectedDestination?: { repository: string; branch: string; folder: string },
): Promise<{ backup: GitHubBackupStatus; unchanged: boolean }> {
  return saveGitHubBackupAttempt(env, id, expectedRevision, expectedDestination, AbortSignal.timeout(10_000), 2);
}

async function saveGitHubBackupAttempt(
  env: Env,
  id: string,
  expectedRevision: string,
  expectedDestination: { repository: string; branch: string; folder: string } | undefined,
  signal: AbortSignal,
  raceRetries: number,
): Promise<{ backup: GitHubBackupStatus; unchanged: boolean }> {
  const article = await getArticle(env.DB, id);
  if (!article) throw new GitHubBackupError(404, 'not_found', 'Article not found.');
  const copy = await getArticleCopy(env.DB, id);
  if (!copy) throw new GitHubBackupError(409, 'copy_required', 'Save a Markdown copy before saving to GitHub.');
  if (copy.revision !== expectedRevision) throw new GitHubBackupError(409, 'revision_conflict', 'This copy changed since you opened it. Reload it before saving to GitHub.');
  const target = targetFor(env, id, article.title);
  if (expectedDestination && (target.repository !== expectedDestination.repository || target.branch !== expectedDestination.branch || target.folder !== expectedDestination.folder)) {
    throw new GitHubBackupError(409, 'destination_changed', 'The configured GitHub destination changed. Review setup before saving.');
  }
  const markdown = articleMarkdown(article, copy);
  const contentHash = await digest(markdown);
  let reservation = await getReservation(env, id, target);
  let selectedPath = reservation?.path ?? null;
  let newlyReserved = false;
  if (!selectedPath) {
    const previous = await env.DB.prepare('SELECT repository,branch,path FROM article_github_backups WHERE article_id = ?')
      .bind(id).first<{ repository: string; branch: string; path: string }>();
    const inFolder = previous && (target.folder ? previous.path.startsWith(`${target.folder}/`) : !previous.path.includes('/'));
    if (previous?.repository === target.repository && previous.branch === target.branch && inFolder) {
      newlyReserved = await reserve(env, id, target, previous.path);
      reservation = await getReservation(env, id, target);
      if (!reservation) throw new GitHubBackupError(409, 'github_path_conflict', 'Another article already owns the confirmed GitHub path. Resolve the path mapping before saving.');
      selectedPath = reservation.path;
      // A path confirmed in the old status row is an assigned destination even
      // when its new reservation row had to be backfilled during this request.
      newlyReserved = false;
    }
  }
  let existing: { sha: string; markdown: string } | null = null;
  let destinationTarget: Target | null = null;
  for (let candidate = 1; !destinationTarget && candidate <= 100; candidate += 1) {
    if (!selectedPath) {
      const suffix = candidate === 1 ? '' : `-${candidate}`;
      const path = `${target.folder ? `${target.folder}/` : ''}${target.basename.replace(/\.md$/, '')}${suffix}.md`;
      newlyReserved = await reserve(env, id, target, path);
      reservation = await getReservation(env, id, target);
      if (reservation) {
        selectedPath = reservation.path;
        // Another request for this article won the reservation. Reuse its path.
      } else {
        continue; // Another article owns this candidate in D1.
      }
    }

    destinationTarget = withPath(target, selectedPath);
    const remote = await githubRequest(destinationTarget, signal, 'GET');
    try {
      existing = remote ? remoteFile(objectResponse(remote), id) : null;
    } catch (error) {
      if (newlyReserved && error instanceof GitHubBackupError && error.code === 'github_file_conflict') {
        await releaseReservation(env, id, target, selectedPath);
        selectedPath = null;
        destinationTarget = null;
        existing = null;
        continue;
      }
      throw error;
    }
  }
  if (!destinationTarget || !selectedPath) throw new GitHubBackupError(409, 'github_path_exhausted', 'No free readable filename was found after 100 candidates. Resolve a conflicting file and retry.');

  // Check after the network read. A newer D1 copy must never be overwritten by
  // an older request that was waiting for GitHub. The current blob SHA protects
  // replacements, and a concurrent creation is re-read before choosing a suffix.
  const assertCopyCurrent = async () => {
    const currentArticle = await getArticle(env.DB, id);
    const currentCopy = await getArticleCopy(env.DB, id);
    if (!currentArticle || !currentCopy || articleMarkdown(currentArticle, currentCopy) !== markdown) {
      throw new GitHubBackupError(409, 'revision_conflict', 'The article or Markdown copy changed while saving to GitHub. Reload it and retry.');
    }
  };
  await assertCopyCurrent();
  let unchanged = existing?.markdown === markdown;
  if (!unchanged) {
    try {
      await githubRequest(destinationTarget, signal, 'PUT', {
        message: `Save Potem article ${id}`, content: base64(markdown), branch: target.branch,
        ...(existing ? { sha: existing.sha } : {}),
      });
    } catch (error) {
      if (!(error instanceof GitHubBackupError) || error.code !== 'github_conflict') throw error;
      const concurrent = await githubRequest(destinationTarget, signal, 'GET');
      try {
        existing = concurrent ? remoteFile(objectResponse(concurrent), id) : null;
      } catch (recheckError) {
        if (!(recheckError instanceof GitHubBackupError) || recheckError.code !== 'github_file_conflict' || !newlyReserved) throw recheckError;
        await releaseReservation(env, id, target, selectedPath);
        if (raceRetries <= 0) throw error;
        return saveGitHubBackupAttempt(env, id, expectedRevision, expectedDestination, signal, raceRetries - 1);
      }
      if (!existing) throw error;
      unchanged = existing.markdown === markdown;
      if (!unchanged) throw error;
    }
  }
  const backedUpAt = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO article_github_backups (article_id,repository,branch,path,content_hash,backed_up_at)
    SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM articles WHERE id = ?)
    ON CONFLICT(article_id) DO UPDATE SET repository=excluded.repository,branch=excluded.branch,path=excluded.path,
      content_hash=excluded.content_hash,backed_up_at=excluded.backed_up_at`)
    .bind(id, target.repository, target.branch, selectedPath, contentHash, backedUpAt, id).run();
  const latestArticle = await getArticle(env.DB, id);
  if (!latestArticle) throw new GitHubBackupError(409, 'revision_conflict', 'The article was deleted while saving to GitHub. The GitHub file is retained.');
  return { backup: await getGitHubBackupStatus(env, latestArticle, await getArticleCopy(env.DB, id)), unchanged };
}
