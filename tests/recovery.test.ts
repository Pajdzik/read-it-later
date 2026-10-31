import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/contracts';
import { handleArticles } from '../src/articles/handler';
import { claimExtractionJob, completeExtractionJob, enqueueExtractionJob, failExtractionJob, getExtractionStatus, reconcileExtractionJobs, retryExtractionJob } from '../src/articles/jobs';
import { requestRecapture, undoRecapture } from '../src/articles/recovery';
import { deleteArticle, getArticle, getArticleCopy, saveArticle, saveArticleCopy, updateArticle } from '../src/articles/repository';
import { deliverPendingExtractions, extractionQueueStub } from './extraction-queue-fixture';
import { articleMarkdown, getGitHubBackupStatus } from '../src/articles/github';
import { digest } from '../src/auth/core';
import { captureFixture } from './capture-fixture';

const time = (seconds = 0) => new Date(Date.parse('2026-11-01T10:00:00.000Z') + seconds * 1000).toISOString();
const result = { markdown: '# Recovered 📰', metadata: { title: 'Source title', author: 'Source author', description: 'Source description' } };
const oldCopy = { markdown: '# Original', capturedAt: time(-1000), source: 'upload' as const, revision: 'original-revision' };

async function seed(copy = true) {
  const { article } = await saveArticle(env.DB, { url: 'https://example.com/recovery', normalizedUrl: 'https://example.com/recovery', title: 'Owner title', author: 'Owner author', description: 'Owner description' });
  await updateArticle(env.DB, article.id, { title: 'Owner title', read: true }, time(-100));
  if (copy) await saveArticleCopy(env.DB, article.id, oldCopy, null);
  return article.id;
}
async function start(id: string, revision: string | null = oldCopy.revision, refresh = false, at = 0) {
  expect(await requestRecapture(env.DB, id, revision, refresh, time(at))).toBe('queued');
  const job = await claimExtractionJob(env.DB, time(at));
  expect(job).toMatchObject({ articleId: id, kind: 'recapture' });
  return job!;
}
const snapshot = (id: string) => env.DB.prepare('SELECT * FROM article_capture_recovery WHERE article_id=?').bind(id).first();
beforeEach(async () => { await env.DB.prepare('DELETE FROM articles').run(); });
afterEach(async () => { await env.DB.prepare('DROP TRIGGER IF EXISTS fail_recovery').run(); vi.restoreAllMocks(); });

describe('per-article capture recovery', () => {
  it('keeps a readable copy while queued and running, then replaces only Markdown by default', async () => {
    const id = await seed();
    const before = await getArticle(env.DB, id);
    expect(await requestRecapture(env.DB, id, oldCopy.revision, false, time())).toBe('queued');
    expect(await getExtractionStatus(env.DB, id)).toMatchObject({ state: 'ready', recovery: { state: 'queued', generation: 1 }, undoAvailable: false });
    const job = await claimExtractionJob(env.DB, time());
    expect(await getArticleCopy(env.DB, id)).toEqual(oldCopy);
    expect(await claimExtractionJob(env.DB, time())).toBeNull();
    expect(await completeExtractionJob(env.DB, job!, result, time(10))).toBe(true);
    expect(await getArticleCopy(env.DB, id)).toMatchObject({ markdown: result.markdown, capturedAt: time(10), revision: expect.not.stringMatching(oldCopy.revision) });
    expect(await getArticle(env.DB, id)).toEqual(before);
    expect(await getExtractionStatus(env.DB, id)).toMatchObject({ state: 'ready', recovery: { state: 'succeeded' }, undoAvailable: true });
  });

  it('refreshes supplied metadata only by explicit opt-in and restores it with one-step undo', async () => {
    const id = await seed();
    const before = await getArticle(env.DB, id);
    const job = await start(id, oldCopy.revision, true);
    // Reading changes do not invalidate metadata guards.
    await updateArticle(env.DB, id, { read: false }, time(5));
    expect(await completeExtractionJob(env.DB, job, result, time(10))).toBe(true);
    const copy = (await getArticleCopy(env.DB, id))!;
    expect(await getArticle(env.DB, id)).toMatchObject({ title: 'Source title', author: 'Source author', description: 'Source description', readAt: null, createdAt: before!.createdAt });
    expect(await undoRecapture(env.DB, id, copy.revision, time(20))).toBe('saved');
    expect(await getArticleCopy(env.DB, id)).toMatchObject({ markdown: oldCopy.markdown, capturedAt: oldCopy.capturedAt, source: 'upload', revision: expect.not.stringMatching(copy.revision) });
    expect(await getArticle(env.DB, id)).toMatchObject({ title: 'Owner title', author: 'Owner author', description: 'Owner description', readAt: null });
    expect(await env.DB.prepare('SELECT title_origin FROM articles WHERE id=?').bind(id).first()).toEqual({ title_origin: 'protected' });
    expect(await snapshot(id)).toBeNull();
    expect(await undoRecapture(env.DB, id, copy.revision, time(21))).toBe('conflict');
  });

  it('retains metadata omitted or blank in the new extraction', async () => {
    const id = await seed();
    const job = await start(id, oldCopy.revision, true);
    await completeExtractionJob(env.DB, job, { markdown: 'new', metadata: { title: '  ', author: 'New author' } }, time(10));
    expect(await getArticle(env.DB, id)).toMatchObject({ title: 'Owner title', author: 'New author', description: 'Owner description' });
  });

  it('captures link-only/imported articles without requiring an earlier extraction intent', async () => {
    const id = await seed(false);
    const job = await start(id, null);
    expect(await completeExtractionJob(env.DB, job, result, time(10))).toBe(true);
    expect(await getArticleCopy(env.DB, id)).toMatchObject({ markdown: result.markdown });
    expect(await getExtractionStatus(env.DB, id)).toMatchObject({ undoAvailable: false });
    expect(await snapshot(id)).toBeNull();
  });

  it('does not supersede an active initial capture', async () => {
    const id = await seed(false);
    await env.DB.prepare('UPDATE articles SET extraction_requested_at=? WHERE id=?').bind(time(), id).run();
    await enqueueExtractionJob(env.DB, id, time());
    expect(await requestRecapture(env.DB, id, null, false, time())).toBe('capture_active');
    expect(await claimExtractionJob(env.DB, time())).toMatchObject({ kind: 'initial', generation: 1 });
  });

  it('atomically deduplicates requests, rejects stale versions/options and enforces cooldown', async () => {
    const id = await seed();
    const responses = await Promise.all([requestRecapture(env.DB, id, oldCopy.revision, false, time()), requestRecapture(env.DB, id, oldCopy.revision, false, time())]);
    expect(responses.sort()).toEqual(['active', 'queued']);
    expect(await requestRecapture(env.DB, id, oldCopy.revision, true, time())).toBe('capture_active');
    expect(await requestRecapture(env.DB, id, 'stale', false, time())).toBe('revision_conflict');
    const job = (await claimExtractionJob(env.DB, time()))!;
    await failExtractionJob(env.DB, job, { code: 'upstream_http', retryable: false }, time(10));
    expect(await requestRecapture(env.DB, id, oldCopy.revision, false, time(69))).toBe('cooldown');
    expect(await requestRecapture(env.DB, id, oldCopy.revision, false, time(70))).toBe('queued');
    expect(await getExtractionStatus(env.DB, id)).toMatchObject({ recovery: { generation: 2, attempts: 0 } });
    expect(await completeExtractionJob(env.DB, job, result, time(71))).toBe(false);
  });

  it('never replaces an edited copy or metadata and keeps manual saves authoritative', async () => {
    const id = await seed();
    const job = await start(id);
    await saveArticleCopy(env.DB, id, { ...oldCopy, markdown: 'Manual correction', revision: 'manual-revision' }, oldCopy.revision);
    expect(await completeExtractionJob(env.DB, job, result, time(10))).toBe(false);
    expect(await getArticleCopy(env.DB, id)).toMatchObject({ markdown: 'Manual correction' });
    expect(await getExtractionStatus(env.DB, id)).toMatchObject({ recovery: { state: 'failed', errorCode: 'copy_changed' } });
    const next = await start(id, 'manual-revision', true, 120);
    await updateArticle(env.DB, id, { author: 'New owner edit' }, time(125));
    expect(await completeExtractionJob(env.DB, next, result, time(130))).toBe(false);
    expect(await getArticleCopy(env.DB, id)).toMatchObject({ markdown: 'Manual correction' });
    expect(await getArticle(env.DB, id)).toMatchObject({ author: 'New owner edit' });
    expect(await getExtractionStatus(env.DB, id)).toMatchObject({ recovery: { state: 'failed', errorCode: 'metadata_changed' } });
    expect(await snapshot(id)).toBeNull();
  });

  it('detects a disappeared copy even when no manual-save job update occurred', async () => {
    const id = await seed();
    const job = await start(id);
    await env.DB.prepare('DELETE FROM article_copies WHERE article_id=?').bind(id).run();
    expect(await completeExtractionJob(env.DB, job, result, time(10))).toBe(false);
    expect(await getExtractionStatus(env.DB, id)).toMatchObject({ recovery: { state: 'failed', errorCode: 'copy_changed' } });
  });

  it('retries transient errors with a readable old copy and exhausts abandoned leases', async () => {
    const id = await seed();
    const job = await start(id);
    await failExtractionJob(env.DB, job, { code: 'timeout', retryable: true }, time(10));
    expect(await getExtractionStatus(env.DB, id)).toMatchObject({ state: 'ready', recovery: { state: 'retry_wait', nextAttemptAt: time(70) } });
    expect(await claimExtractionJob(env.DB, time(69))).toBeNull();
    const second = (await claimExtractionJob(env.DB, time(70)))!;
    await reconcileExtractionJobs(env.DB, time(190));
    expect(await completeExtractionJob(env.DB, second, result, time(191))).toBe(false);
    await claimExtractionJob(env.DB, time(490));
    await reconcileExtractionJobs(env.DB, time(610));
    expect(await getExtractionStatus(env.DB, id)).toMatchObject({ state: 'ready', recovery: { state: 'failed', attempts: 3, errorCode: 'lease_expired' } });
    expect(await getArticleCopy(env.DB, id)).toEqual(oldCopy);
  });

  it('retains the prior undo on failure and replaces it only on the next success', async () => {
    const id = await seed();
    await completeExtractionJob(env.DB, await start(id), result, time(10));
    const first = (await getArticleCopy(env.DB, id))!;
    const originalSnapshot = await snapshot(id);
    const failure = await start(id, first.revision, false, 120);
    await failExtractionJob(env.DB, failure, { code: 'upstream_http', retryable: false }, time(130));
    expect(await snapshot(id)).toEqual(originalSnapshot);
    const third = await start(id, first.revision, false, 240);
    await completeExtractionJob(env.DB, third, { markdown: 'Third copy', metadata: {} }, time(250));
    const latest = (await getArticleCopy(env.DB, id))!;
    expect(await undoRecapture(env.DB, id, latest.revision, time(260))).toBe('saved');
    expect(await getArticleCopy(env.DB, id)).toMatchObject({ markdown: first.markdown });
  });

  it('guards undo against later copy or affected metadata edits but permits read changes', async () => {
    const id = await seed();
    await completeExtractionJob(env.DB, await start(id, oldCopy.revision, true), result, time(10));
    const latest = (await getArticleCopy(env.DB, id))!;
    expect(await undoRecapture(env.DB, id, 'stale', time(20))).toBe('conflict');
    await updateArticle(env.DB, id, { title: 'Later edit' }, time(20));
    expect(await getExtractionStatus(env.DB, id)).toMatchObject({ undoAvailable: false });
    expect(await undoRecapture(env.DB, id, latest.revision, time(30))).toBe('conflict');
    await saveArticleCopy(env.DB, id, { ...latest, revision: 'later-edit', markdown: 'Later content' }, latest.revision);
    expect(await undoRecapture(env.DB, id, 'later-edit', time(40))).toBe('conflict');
    expect(await getArticleCopy(env.DB, id)).toMatchObject({ markdown: 'Later content' });
  });

  it('undoes Markdown-only recovery without reverting later metadata and supersedes pending recapture', async () => {
    const id = await seed();
    await completeExtractionJob(env.DB, await start(id), result, time(10));
    const latest = (await getArticleCopy(env.DB, id))!;
    const next = await start(id, latest.revision, false, 120);
    await updateArticle(env.DB, id, { title: 'Later title', read: false }, time(125));
    expect(await undoRecapture(env.DB, id, latest.revision, time(130))).toBe('saved');
    expect(await completeExtractionJob(env.DB, next, result, time(131))).toBe(false);
    expect(await getArticle(env.DB, id)).toMatchObject({ title: 'Later title', readAt: null });
    expect(await getArticleCopy(env.DB, id)).toMatchObject({ markdown: oldCopy.markdown });
  });

  it.each([
    ['snapshot', 'BEFORE INSERT ON article_capture_recovery'],
    ['copy', 'BEFORE UPDATE ON article_copies'],
    ['metadata', 'BEFORE UPDATE ON articles'],
    ['completion', "BEFORE UPDATE OF state ON article_extraction_jobs WHEN NEW.state='succeeded'"],
  ])('rolls back the entire replacement if %s storage fails', async (_label, clause) => {
    const id = await seed();
    await completeExtractionJob(env.DB, await start(id), result, time(10));
    const latest = (await getArticleCopy(env.DB, id))!;
    const before = await getArticle(env.DB, id);
    const previous = await snapshot(id);
    const job = await start(id, latest.revision, true, 120);
    await env.DB.prepare(`CREATE TRIGGER fail_recovery ${clause} BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`).run();
    await expect(completeExtractionJob(env.DB, job, { markdown: 'Must roll back', metadata: result.metadata }, time(130))).rejects.toThrow();
    expect(await getArticleCopy(env.DB, id)).toEqual(latest);
    expect(await getArticle(env.DB, id)).toEqual(before);
    expect(await snapshot(id)).toEqual(previous);
    expect(await getExtractionStatus(env.DB, id)).toMatchObject({ recovery: { state: 'running' } });
  });

  it('rolls back undo if consuming the snapshot fails', async () => {
    const id = await seed();
    await completeExtractionJob(env.DB, await start(id, oldCopy.revision, true), result, time(10));
    const latest = (await getArticleCopy(env.DB, id))!;
    const before = await getArticle(env.DB, id);
    await env.DB.prepare("CREATE TRIGGER fail_recovery BEFORE DELETE ON article_capture_recovery BEGIN SELECT RAISE(ABORT, 'fixture failure'); END").run();
    await expect(undoRecapture(env.DB, id, latest.revision, time(20))).rejects.toThrow();
    expect(await getArticleCopy(env.DB, id)).toEqual(latest);
    expect(await getArticle(env.DB, id)).toEqual(before);
    expect(await getExtractionStatus(env.DB, id)).toMatchObject({ undoAvailable: true });
  });

  it('cascades deletion and prevents a deleted article from being recreated by a late worker', async () => {
    const id = await seed();
    await completeExtractionJob(env.DB, await start(id), result, time(10));
    const latest = (await getArticleCopy(env.DB, id))!;
    const next = await start(id, latest.revision, false, 120);
    await deleteArticle(env.DB, id);
    expect(await completeExtractionJob(env.DB, next, result, time(130))).toBe(false);
    expect(await snapshot(id)).toBeNull();
    expect(await getArticleCopy(env.DB, id)).toBeNull();
    expect(await requestRecapture(env.DB, id, null, false, time(140))).toBe('missing');
  });

  it('can retry a completed job whose copy disappeared', async () => {
    const id = await seed(false);
    await env.DB.prepare('UPDATE articles SET extraction_requested_at=? WHERE id=?').bind(time(), id).run();
    await enqueueExtractionJob(env.DB, id, time());
    const job = (await claimExtractionJob(env.DB, time()))!;
    await completeExtractionJob(env.DB, job, result, time(10));
    await env.DB.prepare('DELETE FROM article_copies WHERE article_id=?').bind(id).run();
    expect(await retryExtractionJob(env.DB, id, time(70))).toBe('queued');
    expect(await claimExtractionJob(env.DB, time(70))).toMatchObject({ generation: 2, kind: 'initial' });
  });

  it('uses the existing processor and leaves paused requests durable', async () => {
    const id = await seed();
    // The processor uses real time to finish, so give this job a current lease.
    const now = new Date().toISOString();
    await requestRecapture(env.DB, id, oldCopy.revision, false, now);
    const fetcher = vi.fn(async () => await captureFixture('<article><h1>Recovered</h1><p>Preserved article content from a fixture extractor.</p></article>'));
    const processorEnv: Env = { ...env, BACKGROUND_CAPTURE_ENABLED: 'false', ARTICLE_EXTRACTOR: { fetch: fetcher, connect() { throw new Error('unused'); } } as Fetcher };
    await deliverPendingExtractions(processorEnv, now);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await getExtractionStatus(env.DB, id, true)).toMatchObject({ paused: true, state: 'ready', recovery: { state: 'queued' } });
    await deliverPendingExtractions({ ...processorEnv, BACKGROUND_CAPTURE_ENABLED: 'true' }, now);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await getArticleCopy(env.DB, id)).toMatchObject({ markdown: expect.stringContaining('fixture extractor') });
  });

  it('marks GitHub backup status outdated after recapture and undo without publishing', async () => {
    const id = await seed();
    const article = (await getArticle(env.DB, id))!;
    const githubEnv: Env = { ...env, GITHUB_BACKUP_REPOSITORY: 'owner/repository', GITHUB_BACKUP_BRANCH: 'main', GITHUB_BACKUP_PATH: 'Articles', GITHUB_BACKUP_TOKEN: 'fixture-token' };
    await env.DB.prepare(`INSERT INTO article_github_backups(article_id,repository,branch,path,content_hash,backed_up_at)
      VALUES(?,'owner/repository','main','Articles/original.md',?,?)`)
      .bind(id, await digest(articleMarkdown(article, oldCopy)), time(-50)).run();
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Recovery must not publish'); });
    expect(await getGitHubBackupStatus(githubEnv, article, oldCopy)).toMatchObject({ state: 'saved' });
    await completeExtractionJob(env.DB, await start(id), result, time(10));
    const copy = (await getArticleCopy(env.DB, id))!;
    expect(await getGitHubBackupStatus(githubEnv, article, copy)).toMatchObject({ state: 'outdated' });
    await undoRecapture(env.DB, id, copy.revision, time(20));
    expect(await getGitHubBackupStatus(githubEnv, article, await getArticleCopy(env.DB, id))).toMatchObject({ state: 'outdated' });
    expect(network).not.toHaveBeenCalled();
  });
});

describe('recovery HTTP boundaries', () => {
  const origin = 'http://localhost:8787';
  const localEnv: Env = { ...env, APP_ORIGIN: origin, DEV_AUTH_BYPASS: 'true' };
  const route = async (id: string, action: string, body: unknown, headers = {}) => (await handleArticles(new Request(`${origin}/api/articles/${id}/extraction/${action}`, {
    method: 'POST', headers: { Origin: origin, 'X-CSRF-Token': 'dev-bypass', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  }), localEnv))!;

  it('validates requests, returns 202 once and reports readable recovery status without leaking exports', async () => {
    const id = await seed();
    expect((await route(id, 'recapture', {})).status).toBe(400);
    expect((await route(id, 'recapture', { expectedRevision: oldCopy.revision, refreshMetadata: 'yes' })).status).toBe(400);
    expect((await route(id, 'recapture', { expectedRevision: oldCopy.revision, url: 'https://other.example' })).status).toBe(400);
    expect((await route(id, 'undo', { expectedRevision: null })).status).toBe(400);
    expect((await route(id, 'recapture', { expectedRevision: 'wrong' })).status).toBe(409);
    const accepted = await route(id, 'recapture', { expectedRevision: oldCopy.revision });
    expect(accepted.status).toBe(202);
    expect(accepted.headers.get('Cache-Control')).toContain('no-store');
    expect(await accepted.json()).toMatchObject({ extraction: { state: 'ready', recovery: { state: 'queued' } } });
    expect((await route(id, 'recapture', { expectedRevision: oldCopy.revision })).status).toBe(200);
    expect((await route(id, 'recapture', { expectedRevision: oldCopy.revision, refreshMetadata: true })).status).toBe(409);
    const job = (await claimExtractionJob(env.DB, time()))!;
    await completeExtractionJob(env.DB, job, result, time(10));
    // Bring the job back to real time to check the HTTP cooldown.
    await env.DB.prepare('UPDATE article_extraction_jobs SET updated_at=? WHERE article_id=?').bind(new Date().toISOString(), id).run();
    const copy = (await getArticleCopy(env.DB, id))!;
    const cooldown = await route(id, 'recapture', { expectedRevision: copy.revision });
    expect(cooldown.status).toBe(429);
    expect(cooldown.headers.get('Retry-After')).toBe('60');
    const exported = (await handleArticles(new Request(`${origin}/api/export`), localEnv))!;
    const backup = await exported.json() as { version: number; articles: unknown[] };
    expect(backup.version).toBe(2);
    expect(JSON.stringify(backup)).not.toContain('resulting_revision');
    expect((await route(id, 'undo', { expectedRevision: copy.revision })).status).toBe(200);
    expect((await route(id, 'undo', { expectedRevision: copy.revision })).status).toBe(409);
  });

  it('requires owner authentication, exact origin and CSRF; capture tokens cannot recover', async () => {
    const id = await seed();
    for (const action of ['recapture', 'undo']) {
      const body = { expectedRevision: oldCopy.revision };
      expect((await route(id, action, body, { Origin: 'https://attacker.example' })).status).toBe(403);
      expect((await route(id, action, body, { 'X-CSRF-Token': '' })).status).toBe(403);
      const authenticationHeaders: Record<string, string>[] = [{}, { Authorization: 'Bearer save-only-token' }];
      for (const headers of authenticationHeaders) {
        const response = (await handleArticles(new Request(`https://service.example/api/articles/${id}/extraction/${action}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
        }), { ...env, APP_ORIGIN: 'https://service.example', GITHUB_CLIENT_ID: 'fixture-client', GITHUB_CLIENT_SECRET: 'fixture-secret', OWNER_GITHUB_ID: '123456' }))!;
        expect(response.status).toBe(401);
      }
    }
  });
});
