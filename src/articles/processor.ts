import type { Env, ExtractionMessage } from '../contracts';
import { captureArticle, isBackgroundCapturePaused } from './capture-client';
import {
  claimExtractionJob, completeExtractionJob, failExtractionJob, getExtractionDelivery,
  pendingExtractionPage, reconcileExtractionJobs, type ExtractionJob,
} from './jobs';
import { SourceFetchError } from './capture-protocol';
import { deliveryDelay, extractionLog, extractionNotification, isExtractionMessage } from './extraction-queue';

export type ExtractionOutcome = { action: 'ack' } | { action: 'retry'; delaySeconds: number };
const ACK: ExtractionOutcome = { action: 'ack' };

/** All result writes retain the existing lease and generation fences. */
async function runExtractionJob(env: Env, job: ExtractionJob): Promise<void> {
  try {
    const result = await captureArticle(job.url, env);
    let completed: boolean;
    try { completed = await completeExtractionJob(env.DB, job, result, new Date().toISOString()); }
    catch { throw new SourceFetchError('storage_failed', true); }
    extractionLog(completed ? 'extraction_job_completed' : 'extraction_job_completion_stale', {
      articleId: job.articleId, generation: job.generation, kind: job.kind, attempts: job.attempts,
      ...(completed ? { outputBytes: new TextEncoder().encode(result.markdown).byteLength } : {}),
    });
  } catch (error) {
    const failure = error instanceof SourceFetchError
      ? { code: error.code, retryable: error.retryable, retryAfterSeconds: error.retryAfterSeconds }
      : { code: 'processing_failed', retryable: false };
    await failExtractionJob(env.DB, job, failure, new Date().toISOString());
    extractionLog('extraction_job_failed', {
      articleId: job.articleId, generation: job.generation, attempts: job.attempts, code: failure.code,
    });
  }
}

type DeliveryInspection = ExtractionOutcome | { action: 'ready' };

async function inspectDelivery(env: Env, message: ExtractionMessage, now: string): Promise<DeliveryInspection> {
  let row = await getExtractionDelivery(env.DB, message.articleId);
  if (!row || row.generation !== message.generation) return ACK;
  if (row.state === 'running' && row.leaseExpiresAt! <= now) {
    await reconcileExtractionJobs(env.DB, now, message);
    row = await getExtractionDelivery(env.DB, message.articleId);
    if (!row || row.generation !== message.generation) return ACK;
  }
  if (!['queued', 'retry_wait', 'running'].includes(row.state)) return ACK;
  if (row.state !== 'running' && row.nextAttemptAt <= now) return { action: 'ready' };
  const at = row.state === 'running' ? row.leaseExpiresAt! : row.nextAttemptAt;
  return { action: 'retry', delaySeconds: deliveryDelay(at, Date.parse(now)) };
}

export async function processExtractionMessage(
  env: Env, message: ExtractionMessage, now = new Date().toISOString(),
): Promise<ExtractionOutcome> {
  if (isBackgroundCapturePaused(env)) return ACK;
  const before = await inspectDelivery(env, message, now);
  if (before.action !== 'ready') return before;
  const job = await claimExtractionJob(env.DB, now, message);
  if (job) await runExtractionJob(env, job);
  const after = await inspectDelivery(env, message, new Date().toISOString());
  return after.action === 'ready' ? { action: 'retry', delaySeconds: 1 } : after;
}

export async function consumeExtractionBatch(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    if (!isExtractionMessage(message.body)) {
      extractionLog('extraction_message_invalid');
      message.ack();
      continue;
    }
    try {
      const outcome = await processExtractionMessage(env, message.body);
      if (outcome.action === 'ack') message.ack();
      else {
        extractionLog('extraction_delivery_retry', {
          articleId: message.body.articleId, generation: message.body.generation,
          delaySeconds: outcome.delaySeconds, deliveryAttempt: message.attempts,
        });
        message.retry({ delaySeconds: outcome.delaySeconds });
      }
    } catch {
      extractionLog('extraction_delivery_failed', {
        articleId: message.body.articleId, generation: message.body.generation, deliveryAttempt: message.attempts,
      });
      message.retry({ delaySeconds: 60 });
    }
  }
}

/** Hourly repair and delivery only. Extraction always runs through the queue. */
export async function recoverExtractionJobs(env: Env, now = new Date().toISOString()): Promise<void> {
  if (isBackgroundCapturePaused(env) || !env.EXTRACTION_QUEUE) return;
  let recovered = 0, materialized = 0, published = 0;
  try {
    for (;;) {
      const result = await reconcileExtractionJobs(env.DB, now);
      recovered += result.recovered;
      materialized += result.materialized;
      if (result.recovered < 50 && result.materialized < 50) break;
    }
    let after = '';
    for (;;) {
      const page = await pendingExtractionPage(env.DB, after);
      if (!page.length) break;
      await env.EXTRACTION_QUEUE.sendBatch(page.map(extractionNotification));
      published += page.length;
      after = page[page.length - 1].articleId;
    }
    extractionLog('extraction_recovery_completed', { recovered, materialized, published });
  } catch {
    extractionLog('extraction_recovery_failed', { recovered, materialized, published });
    throw new Error('extraction_recovery_failed');
  }
}
