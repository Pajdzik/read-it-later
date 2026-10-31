import { env } from 'cloudflare:workers';
import { createMessageBatch, createExecutionContext, getQueueResult, createScheduledController } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, ExtractionMessage } from '../src/contracts';
import worker from '../src/worker';
import { processExtractionMessage, recoverExtractionJobs } from '../src/articles/processor';
import { claimExtractionJob, enqueueExtractionJob, getExtractionStatus, retryExtractionJob } from '../src/articles/jobs';
import { publishExtraction } from '../src/articles/extraction-queue';
import { saveArticleCopy } from '../src/articles/repository';
import { extractionQueueStub } from './extraction-queue-fixture';

const NOW = '2026-10-31T12:00:00.000Z';
const message = (articleId = 'job00001', generation = 1): ExtractionMessage => ({ version: 1, articleId, generation });
const success = () => Response.json({ version: 1, ok: true, article: { markdown: '# Saved article', metadata: { title: 'Extracted title', author: 'Jamie' } } });
function configured(overrides: Partial<Env> = {}) {
  const queue = extractionQueueStub();
  const fetcher = vi.fn(async () => success());
  const bindings: Env = {
    ...env, BACKGROUND_CAPTURE_ENABLED: 'true', EXTRACTION_QUEUE: queue.binding,
    ARTICLE_EXTRACTOR: { fetch: fetcher, connect() { throw new Error('unused'); } } as Fetcher,
    ...overrides,
  };
  return { bindings, queue, fetcher };
}
async function intent(id = 'job00001', materialize = true) {
  await env.DB.prepare(`INSERT INTO articles
    (id,url,normalized_url,title,created_at,updated_at,extraction_requested_at,title_origin)
    VALUES (?,?,?,?,?,?,?,'fallback')`)
    .bind(id, `https://source.example/${id}`, `https://source.example/${id}`, 'Fallback', NOW, NOW, NOW).run();
  if (materialize) await enqueueExtractionJob(env.DB, id, NOW);
}
async function deliver(bindings: Env, body: unknown, attempts = 1) {
  const batch = createMessageBatch('read-it-later-extraction', [{ id: 'notification', timestamp: new Date(NOW), body, attempts }]);
  const ctx = createExecutionContext();
  const retry = vi.spyOn(batch.messages[0], 'retry');
  await worker.queue(batch, bindings);
  return { ...await getQueueResult(batch, ctx), retryCalls: retry.mock.calls };
}

describe('queue driven extraction', () => {
  beforeEach(async () => {
    await env.DB.prepare('DROP TRIGGER IF EXISTS fail_queue_finish').run();
    await env.DB.prepare('DROP TRIGGER IF EXISTS fail_queue_record').run();
    await env.DB.prepare('DELETE FROM articles').run();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('processes the delivered article, enriches metadata, and acknowledges after commit without cron', async () => {
    await intent('job00001');
    await intent('job00002');
    const { bindings, fetcher } = configured();
    const result = await deliver(bindings, message('job00002'));
    expect(result.explicitAcks).toEqual(['notification']);
    expect(await getExtractionStatus(env.DB, 'job00002')).toMatchObject({ state: 'ready', attempts: 1 });
    expect(await getExtractionStatus(env.DB, 'job00001')).toMatchObject({ state: 'queued', attempts: 0 });
    expect(await env.DB.prepare('SELECT title,author,read_at FROM articles WHERE id=?').bind('job00002').first())
      .toMatchObject({ title: 'Extracted title', author: 'Jamie', read_at: null });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await deliver(bindings, message('job00002'))).explicitAcks).toEqual(['notification']);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('elects one claimant for simultaneous duplicate deliveries', async () => {
    await intent();
    const { bindings, fetcher } = configured();
    await Promise.all([processExtractionMessage(bindings, message()), processExtractionMessage(bindings, message())]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await getExtractionStatus(env.DB, 'job00001')).toMatchObject({ state: 'ready', attempts: 1 });
  });

  it('defers future retries and live leases without spending an extraction attempt', async () => {
    await intent();
    const { bindings, fetcher } = configured();
    await env.DB.prepare('UPDATE article_extraction_jobs SET next_attempt_at=?').bind('2026-10-31T12:01:00.000Z').run();
    expect(await processExtractionMessage(bindings, message())).toEqual({ action: 'retry', delaySeconds: 60 });
    expect(await getExtractionStatus(env.DB, 'job00001')).toMatchObject({ attempts: 0 });
    await env.DB.prepare('UPDATE article_extraction_jobs SET next_attempt_at=?').bind(NOW).run();
    await claimExtractionJob(env.DB, NOW, message());
    expect(await processExtractionMessage(bindings, message())).toEqual({ action: 'retry', delaySeconds: 120 });
    expect(await getExtractionStatus(env.DB, 'job00001')).toMatchObject({ attempts: 1 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('recovers only the delivered expired lease and defers its backoff', async () => {
    await intent(); await intent('job00002');
    await claimExtractionJob(env.DB, NOW, message());
    await claimExtractionJob(env.DB, NOW, message('job00002'));
    vi.setSystemTime(new Date('2026-10-31T12:02:00.000Z'));
    const { bindings, fetcher } = configured();
    expect(await processExtractionMessage(bindings, message())).toEqual({ action: 'retry', delaySeconds: 60 });
    expect(await getExtractionStatus(env.DB, 'job00001')).toMatchObject({ state: 'retry_wait', attempts: 1, errorCode: 'lease_expired' });
    expect(await getExtractionStatus(env.DB, 'job00002')).toMatchObject({ state: 'running', attempts: 1 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('persists 60/300 second backoff and stops after three extraction attempts', async () => {
    await intent();
    const { bindings, fetcher } = configured();
    fetcher.mockImplementation(async () => Response.json({ version: 1, ok: false, error: { code: 'upstream_http', retryable: true } }));
    for (const [at, expected] of [[NOW, 60], ['2026-10-31T12:01:00.000Z', 300]] as const) {
      vi.setSystemTime(new Date(at));
      const result = await deliver(bindings, message());
      expect(result.retryMessages).toEqual([{ msgId: 'notification' }]);
      expect(result.retryCalls).toEqual([[{ delaySeconds: expected }]]);
      expect(result.explicitAcks).toEqual([]);
    }
    vi.setSystemTime(new Date('2026-10-31T12:06:00.000Z'));
    expect((await deliver(bindings, message())).explicitAcks).toEqual(['notification']);
    expect(await getExtractionStatus(env.DB, 'job00001')).toMatchObject({ state: 'failed', attempts: 3 });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('honors bounded Retry-After and acknowledges permanent failures', async () => {
    await intent();
    const { bindings, fetcher } = configured();
    fetcher.mockImplementation(async () => Response.json({ version: 1, ok: false, error: { code: 'upstream_http', retryable: true, retryAfterSeconds: 3600 } }));
    expect(await processExtractionMessage(bindings, message())).toEqual({ action: 'retry', delaySeconds: 3600 });
    vi.setSystemTime(new Date('2026-10-31T13:00:00.000Z'));
    fetcher.mockImplementation(async () => Response.json({ version: 1, ok: false, error: { code: 'unsafe_destination', retryable: false } }));
    expect(await processExtractionMessage(bindings, message())).toEqual({ action: 'ack' });
    expect(await getExtractionStatus(env.DB, 'job00001')).toMatchObject({ state: 'failed', attempts: 2, errorCode: 'unsafe_destination' });
  });

  it('acknowledges deleted and superseded generations without fetching', async () => {
    await intent();
    const { bindings, fetcher } = configured();
    await env.DB.prepare("UPDATE article_extraction_jobs SET state='failed',updated_at=?").bind('2026-10-31T11:00:00.000Z').run();
    await retryExtractionJob(env.DB, 'job00001', NOW);
    expect(await processExtractionMessage(bindings, message())).toEqual({ action: 'ack' });
    expect(await getExtractionStatus(env.DB, 'job00001')).toMatchObject({ state: 'queued', attempts: 0 });
    await env.DB.prepare('DELETE FROM articles').run();
    expect(await processExtractionMessage(bindings, message('job00001', 2))).toEqual({ action: 'ack' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('preserves a manual copy saved while extraction is running', async () => {
    await intent();
    const { bindings, fetcher } = configured();
    fetcher.mockImplementation(async () => {
      await saveArticleCopy(env.DB, 'job00001', { markdown: 'Owner copy', capturedAt: NOW, source: 'paste', revision: 'owner-rev' }, null);
      return success();
    });
    expect(await processExtractionMessage(bindings, message())).toEqual({ action: 'ack' });
    expect(await env.DB.prepare('SELECT markdown,revision FROM article_copies').first()).toEqual({ markdown: 'Owner copy', revision: 'owner-rev' });
  });

  it('retries database failures without claiming or acknowledging, including the final transport delivery', async () => {
    await intent();
    const { bindings, fetcher, queue } = configured();
    const broken: Env = { ...bindings, DB: new Proxy(env.DB, { get(target, key) { if (key === 'prepare') return () => { throw new Error('private source details'); }; return Reflect.get(target, key); } }) };
    const result = await deliver(broken, message(), 11);
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toEqual([{ msgId: 'notification' }]);
    expect(result.retryCalls).toEqual([[{ delaySeconds: 60 }]]);
    expect(await getExtractionStatus(env.DB, 'job00001')).toMatchObject({ state: 'queued', attempts: 0 });
    await recoverExtractionJobs(bindings);
    expect(queue.messages.map(entry => entry.body)).toEqual([message()]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps a claimed lease recoverable when failure recording crashes', async () => {
    await intent();
    await env.DB.prepare(`CREATE TRIGGER fail_queue_record BEFORE UPDATE OF error_code ON article_extraction_jobs
      WHEN NEW.error_code IS NOT NULL BEGIN SELECT RAISE(ABORT, 'private storage details'); END`).run();
    const { bindings, fetcher } = configured();
    fetcher.mockImplementation(async () => Response.json({ version: 1, ok: false, error: { code: 'timeout', retryable: true } }));
    const delivery = await deliver(bindings, message());
    expect(delivery.retryMessages).toEqual([{ msgId: 'notification' }]);
    expect(delivery.retryCalls).toEqual([[{ delaySeconds: 60 }]]);
    expect(await getExtractionStatus(env.DB, 'job00001')).toMatchObject({ state: 'running', attempts: 1 });
  });

  it('turns a failed completion transaction into a persisted retry without a partial copy', async () => {
    await intent();
    await env.DB.prepare(`CREATE TRIGGER fail_queue_finish BEFORE UPDATE OF state ON article_extraction_jobs
      WHEN NEW.state='succeeded' BEGIN SELECT RAISE(ABORT, 'storage failure'); END`).run();
    const { bindings } = configured();
    expect(await processExtractionMessage(bindings, message())).toEqual({ action: 'retry', delaySeconds: 60 });
    expect(await getExtractionStatus(env.DB, 'job00001')).toMatchObject({ state: 'retry_wait', errorCode: 'storage_failed', attempts: 1 });
    expect(await env.DB.prepare('SELECT * FROM article_copies').first()).toBeNull();
  });

  it('validates malformed messages before accessing D1 and avoids logging payloads', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { bindings } = configured({ DB: new Proxy(env.DB, { get(target, key) { if (key === 'prepare') return () => { throw new Error('must not access D1'); }; return Reflect.get(target, key); } }) });
    for (const body of [null, {}, { ...message(), generation: 0 }, { ...message(), articleId: 'https://private.example' }, { ...message(), url: 'private' }]) {
      expect((await deliver(bindings, body)).explicitAcks).toEqual(['notification']);
    }
    expect(log.mock.calls.every(call => String(call[0]) === '{"event":"extraction_message_invalid"}')).toBe(true);
  });

  it('acknowledges while paused or missing bindings, leaving jobs durable for resume', async () => {
    await intent();
    const { bindings, fetcher, queue } = configured();
    for (const overrides of [{ BACKGROUND_CAPTURE_ENABLED: 'false' }, { ARTICLE_EXTRACTOR: undefined }, { EXTRACTION_QUEUE: undefined }]) {
      const paused = { ...bindings, ...overrides };
      expect((await deliver(paused, message())).explicitAcks).toEqual(['notification']);
      await recoverExtractionJobs(paused);
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(queue.messages).toEqual([]);
    expect(await getExtractionStatus(env.DB, 'job00001')).toMatchObject({ state: 'queued', attempts: 0 });
    await recoverExtractionJobs(bindings);
    expect(queue.messages.map(entry => entry.body)).toEqual([message()]);
  });

  it('recovers missing jobs and republishes more than fifty entries once each without extracting', async () => {
    for (let i = 0; i < 125; i++) await intent(`r${String(i).padStart(7, '0')}`, false);
    const { bindings, queue, fetcher } = configured();
    await worker.scheduled(createScheduledController({ cron: '0 * * * *' }), bindings);
    expect(queue.binding.sendBatch.mock.calls.map(([batch]) => Array.from(batch).length)).toEqual([50, 50, 25]);
    expect(new Set(queue.messages.map(entry => entry.body.articleId)).size).toBe(125);
    expect(await env.DB.prepare('SELECT sum(attempts) AS attempts FROM article_extraction_jobs').first()).toEqual({ attempts: 0 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('republishes recovered leases and future retries with their remaining delays', async () => {
    await intent(); await intent('job00002'); await intent('job00003');
    await claimExtractionJob(env.DB, NOW, message());
    await claimExtractionJob(env.DB, NOW, message('job00003'));
    await env.DB.prepare("UPDATE article_extraction_jobs SET attempts=3 WHERE article_id='job00003'").run();
    await env.DB.prepare("UPDATE article_extraction_jobs SET state='retry_wait',next_attempt_at=? WHERE article_id='job00002'")
      .bind('2026-10-31T13:02:00.000Z').run();
    vi.setSystemTime(new Date('2026-10-31T12:02:00.000Z'));
    const { bindings, queue, fetcher } = configured();
    await recoverExtractionJobs(bindings);
    expect(queue.messages.map(entry => [entry.body.articleId, entry.delaySeconds])).toEqual([
      ['job00001', 60], ['job00002', 3600],
    ]);
    expect(await getExtractionStatus(env.DB, 'job00003')).toMatchObject({ state: 'failed', attempts: 3, errorCode: 'lease_expired' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps failed publications recoverable and reports failed sweeps', async () => {
    await intent();
    const { bindings, queue } = configured();
    queue.binding.send.mockRejectedValue(new Error('private data'));
    await expect(publishExtraction(bindings, 'job00001')).resolves.toBeUndefined();
    queue.binding.sendBatch.mockRejectedValueOnce(new Error('queue outage'));
    await expect(recoverExtractionJobs(bindings)).rejects.toThrow('extraction_recovery_failed');
    expect(await getExtractionStatus(env.DB, 'job00001')).toMatchObject({ state: 'queued', attempts: 0 });
    await recoverExtractionJobs(bindings);
    expect(queue.messages.map(entry => entry.body)).toEqual([message()]);
  });
});
