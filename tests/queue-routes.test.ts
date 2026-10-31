import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/contracts';
import worker from '../src/worker';
import { digest } from '../src/auth/core';
import { recoverExtractionJobs } from '../src/articles/processor';
import { saveArticleCopy } from '../src/articles/repository';
import { extractionQueueStub } from './extraction-queue-fixture';

const origin = 'http://localhost:8787';
function setup() {
  const queue = extractionQueueStub();
  const bindings: Env = {
    ...env, APP_ORIGIN: origin, DEV_AUTH_BYPASS: 'true', BACKGROUND_CAPTURE_ENABLED: 'true',
    EXTRACTION_QUEUE: queue.binding, GITHUB_CLIENT_ID: 'local-client', GITHUB_CLIENT_SECRET: 'local-secret', OWNER_GITHUB_ID: '123456',
    ARTICLE_EXTRACTOR: { fetch: vi.fn(async () => { throw new Error('Save must not extract'); }), connect() { throw new Error('unused'); } } as Fetcher,
  };
  return { queue, bindings };
}
function request(path: string, body: unknown) {
  return new Request(origin + path, { method: 'POST', headers: {
    Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': 'dev-bypass',
  }, body: JSON.stringify(body) });
}
async function post(bindings: Env, path: string, body: unknown) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request(path, body), bindings, ctx);
  await waitOnExecutionContext(ctx);
  return { response, data: await response.json() as { article: { id: string }; extraction: { state: string } } };
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM articles').run();
  await env.DB.prepare('DELETE FROM capture_tokens').run();
  await env.DB.prepare('DELETE FROM capture_rate_buckets').run();
});

describe('HTTP extraction publication', () => {
  it('publishes only pending captures, including duplicates, while keeping a stable job generation', async () => {
    const { bindings, queue } = setup();
    const { response, data } = await post(bindings, '/api/articles', { url: 'https://example.com/save', captureMarkdown: true });
    expect(response.status).toBe(201);
    const expected = { version: 1, articleId: data.article.id, generation: 1 };
    expect(queue.messages.map(entry => entry.body)).toEqual([expected]);
    await post(bindings, '/api/articles', { url: 'https://example.com/save#again', captureMarkdown: true });
    expect(queue.messages.map(entry => entry.body)).toEqual([expected, expected]);
    expect(await env.DB.prepare('SELECT generation,attempts FROM article_extraction_jobs').first()).toEqual({ generation: 1, attempts: 0 });
    await post(bindings, '/api/articles', { url: 'https://example.com/link', captureMarkdown: false });
    expect(queue.messages).toHaveLength(2);
    await env.DB.prepare("UPDATE article_extraction_jobs SET state='failed'").run();
    await post(bindings, '/api/articles', { url: 'https://example.com/save', captureMarkdown: true });
    expect(queue.messages).toHaveLength(2);
  });

  it('completes a saved article through the published notification without cron', async () => {
    const { bindings, queue } = setup();
    bindings.ARTICLE_EXTRACTOR = {
      fetch: vi.fn(async () => Response.json({ version: 1, ok: true, article: { markdown: '# Queue result', metadata: {} } })),
      connect() { throw new Error('unused'); },
    } as Fetcher;
    const { data } = await post(bindings, '/api/articles', { url: 'https://example.com/end-to-end', captureMarkdown: true });
    const batch = createMessageBatch('read-it-later-extraction', [{ id: 'saved', timestamp: new Date(), attempts: 1, body: queue.messages[0].body }]);
    const ctx = createExecutionContext();
    await worker.queue(batch, bindings);
    expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(['saved']);
    const response = await worker.fetch(new Request(origin + `/api/articles/${data.article.id}`), bindings);
    expect(await response.json()).toMatchObject({ article: { hasCopy: true, extraction: { state: 'ready', attempts: 1 } } });
  });

  it('returns the durable save before publication finishes and recovers failed background sends', async () => {
    const { bindings, queue } = setup();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    queue.binding.send.mockImplementationOnce(async () => {
      await blocked;
      throw new Error('queue unavailable');
    });
    const ctx = createExecutionContext();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    let id: string;
    try {
      const response = await worker.fetch(request('/api/articles', { url: 'https://example.com/failed-send', captureMarkdown: true }), bindings, ctx);
      expect(response.status).toBe(201);
      id = ((await response.json()) as { article: { id: string } }).article.id;
    } finally { release(); }
    await waitOnExecutionContext(ctx);
    expect(log.mock.calls.map(call => JSON.parse(String(call[0])))).toContainEqual({ event: 'extraction_dispatch_failed', articleId: id! });
    log.mockRestore();
    await recoverExtractionJobs(bindings);
    expect(queue.messages.map(entry => entry.body)).toEqual([{ version: 1, articleId: id!, generation: 1 }]);
  });

  it('publishes accepted owner retry and recapture generations, but not active requests or undo', async () => {
    const { bindings, queue } = setup();
    const { data } = await post(bindings, '/api/articles', { url: 'https://example.com/retry', captureMarkdown: true });
    const id = data.article.id;
    const old = '2020-01-01T00:00:00.000Z';
    await env.DB.prepare("UPDATE article_extraction_jobs SET state='failed',updated_at=?").bind(old).run();
    expect((await post(bindings, `/api/articles/${id}/extraction/retry`, {})).response.status).toBe(200);
    expect(queue.messages.at(-1)?.body).toEqual({ version: 1, articleId: id, generation: 2 });
    await post(bindings, `/api/articles/${id}/extraction/retry`, {});
    expect(queue.messages).toHaveLength(2);
    await saveArticleCopy(env.DB, id, { markdown: 'Reviewed copy', capturedAt: old, source: 'paste', revision: 'owner-copy' }, null);
    await env.DB.prepare('UPDATE article_extraction_jobs SET updated_at=?').bind(old).run();
    expect((await post(bindings, `/api/articles/${id}/extraction/recapture`, { expectedRevision: 'owner-copy' })).response.status).toBe(202);
    expect(queue.messages.at(-1)?.body).toEqual({ version: 1, articleId: id, generation: 3 });
    await post(bindings, `/api/articles/${id}/extraction/recapture`, { expectedRevision: 'owner-copy' });
    await post(bindings, `/api/articles/${id}/extraction/undo`, { expectedRevision: 'owner-copy' });
    expect(queue.messages).toHaveLength(3);
  });

  it('publishes capture-token saves without exposing article identity or adding token permissions', async () => {
    const { bindings, queue } = setup();
    await env.DB.prepare('INSERT INTO capture_tokens(id,token_hash,label,created_at) VALUES(?,?,?,?)')
      .bind('phone', await digest('t'.repeat(43)), 'Phone', new Date().toISOString()).run();
    const capture = async (captureMarkdown?: boolean) => {
      const ctx = createExecutionContext();
      const response = await worker.fetch(new Request(origin + '/api/capture', {
        method: 'POST', headers: { Authorization: `Bearer ${'t'.repeat(43)}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/phone', captureMarkdown }),
      }), bindings, ctx);
      await waitOnExecutionContext(ctx);
      return response;
    };
    const response = await capture();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, extractionRequested: true });
    expect(queue.messages).toHaveLength(1);
    expect(queue.messages[0].body).toMatchObject({ version: 1, articleId: expect.stringMatching(/^[a-z0-9]{8}$/), generation: 1 });
    await capture(false);
    expect(queue.messages).toHaveLength(1);
    const forbidden = await worker.fetch(new Request(origin + `/api/articles/${queue.messages[0].body.articleId}/extraction/retry`, {
      method: 'POST', headers: { Authorization: `Bearer ${'t'.repeat(43)}`, 'Content-Type': 'application/json' }, body: '{}',
    }), { ...bindings, APP_ORIGIN: 'https://service.example', DEV_AUTH_BYPASS: undefined });
    expect(forbidden.status).toBe(401);
  });
});
