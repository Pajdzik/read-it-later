import type { Env, ExtractionMessage } from '../contracts';
import { getExtractionDelivery, type ExtractionDelivery } from './jobs';
import { isBackgroundCapturePaused } from './capture-client';
import { isArticleId } from './identity';

export function extractionLog(event: string, fields: Record<string, string | number> = {}): void {
  const entry = JSON.stringify({ event, ...fields });
  if (event.endsWith('_failed') || event.endsWith('_invalid')) console.error(entry);
  else console.info(entry);
}

export function isExtractionMessage(value: unknown): value is ExtractionMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return message.version === 1 && typeof message.articleId === 'string' && isArticleId(message.articleId)
    && Number.isSafeInteger(message.generation) && Number(message.generation) > 0
    && Object.keys(message).every(key => ['version', 'articleId', 'generation'].includes(key));
}

export function deliveryDelay(at: string, now = Date.now()): number {
  return Math.min(86400, Math.max(1, Math.ceil((Date.parse(at) - now) / 1000)));
}

export function extractionNotification(job: ExtractionDelivery): MessageSendRequest<ExtractionMessage> {
  return {
    body: { version: 1, articleId: job.articleId, generation: job.generation },
    contentType: 'json',
    delaySeconds: Date.parse(job.nextAttemptAt) <= Date.now() ? 0 : deliveryDelay(job.nextAttemptAt),
  };
}

/** A failed notification never invalidates the durable D1 save. */
export async function publishExtraction(env: Env, articleId: string): Promise<void> {
  if (isBackgroundCapturePaused(env) || !env.EXTRACTION_QUEUE) return;
  try {
    const job = await getExtractionDelivery(env.DB, articleId);
    if (!job || !['queued', 'retry_wait'].includes(job.state)) return;
    const { body, ...options } = extractionNotification(job);
    await env.EXTRACTION_QUEUE.send(body, options);
  } catch {
    extractionLog('extraction_dispatch_failed', { articleId });
  }
}

export async function scheduleExtraction(env: Env, articleId: string, ctx?: ExecutionContext): Promise<void> {
  const pending = publishExtraction(env, articleId);
  if (ctx) ctx.waitUntil(pending);
  else await pending;
}
