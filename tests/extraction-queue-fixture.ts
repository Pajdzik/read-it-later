import { vi } from 'vitest';
import type { Env, ExtractionMessage } from '../src/contracts';
import { processExtractionMessage, recoverExtractionJobs } from '../src/articles/processor';

export function extractionQueueStub() {
  const messages: MessageSendRequest<ExtractionMessage>[] = [];
  const metrics = () => ({ backlogCount: messages.length, backlogBytes: 0 });
  const binding = {
    send: vi.fn(async (body: ExtractionMessage, options?: QueueSendOptions) => {
      messages.push({ body, ...options });
      return { metadata: { metrics: metrics() } };
    }),
    sendBatch: vi.fn(async (batch: Iterable<MessageSendRequest<ExtractionMessage>>) => {
      messages.push(...batch);
      return { metadata: { metrics: metrics() } };
    }),
    metrics: vi.fn(async () => metrics()),
  } satisfies Queue<ExtractionMessage>;
  return { binding, messages };
}

/** Existing integration scenarios explicitly deliver recovered notifications. */
export async function deliverPendingExtractions(env: Env, now = new Date().toISOString()): Promise<void> {
  const queue = extractionQueueStub();
  const configured = { ...env, EXTRACTION_QUEUE: queue.binding };
  await recoverExtractionJobs(configured, now);
  for (const { body } of queue.messages) await processExtractionMessage(configured, body, now);
}
