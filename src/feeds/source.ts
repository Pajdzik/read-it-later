import type { Env } from "../contracts";
import { CAPTURE_TIMEOUT_MS, MAX_CAPTURE_RESPONSE_BYTES, SourceFetchError } from "../articles/capture-protocol";

export type FeedDocument = {
  title: string;
  items: { key: string; url: string; title: string; preview: string; publishedAt: string | null }[];
};

const SAFE_ERRORS = new Set([
  "capture_paused", "invalid_url", "unsafe_destination", "redirect_loop", "timeout", "network_error",
  "invalid_redirect", "too_many_redirects", "redirect_downgrade", "upstream_http", "unvalidated_redirect",
  "unsupported_content", "unsupported_encoding", "source_too_large", "empty_source", "invalid_encoding",
  "invalid_feed", "capture_busy", "capture_unavailable",
]);

function invalidResponse(): never { throw new SourceFetchError("invalid_capture_response", true); }

async function readBounded(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.ok || !/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get("content-type") ?? "") || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    invalidResponse();
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CAPTURE_RESPONSE_BYTES) invalidResponse();
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function validFeed(value: unknown): value is FeedDocument {
  if (!value || typeof value !== "object") return false;
  const feed = value as Partial<FeedDocument>;
  if (typeof feed.title !== "string" || feed.title.length > 600 || !Array.isArray(feed.items) || feed.items.length > 200) return false;
  return feed.items.every(item => item && typeof item.key === "string" && item.key.length > 0 && item.key.length <= 2048 &&
    typeof item.url === "string" && item.url.length <= 2048 && /^https?:\/\//i.test(item.url) &&
    typeof item.title === "string" && item.title.length <= 600 && typeof item.preview === "string" && item.preview.length <= 600 &&
    (item.publishedAt === null || (typeof item.publishedAt === "string" && Number.isFinite(Date.parse(item.publishedAt))))
  );
}

/** Calls only the private capture service; source URL resolution and parsing stay in its pinned executor. */
export async function fetchFeedDocument(env: Env, url: string): Promise<FeedDocument> {
  if (!env.ARTICLE_EXTRACTOR) throw new SourceFetchError("capture_unavailable", true);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SourceFetchError("timeout", true));
    }, CAPTURE_TIMEOUT_MS);
  });
  try {
    const pending = env.ARTICLE_EXTRACTOR.fetch("https://capture.internal/feed", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }), signal: controller.signal,
    });
    void pending.then(late => { if (controller.signal.aborted) void late.body?.cancel().catch(() => undefined); }).catch(() => undefined);
    const response = await Promise.race([pending, timeout]);
    const bytes = await Promise.race([readBounded(response, controller.signal), timeout]);
    let result: unknown;
    try { result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { invalidResponse(); }
    if (!result || typeof result !== "object" || (result as {version?: unknown}).version !== 1) invalidResponse();
    const envelope = result as { ok?: unknown; feed?: unknown; error?: { code?: unknown; retryable?: unknown; retryAfterSeconds?: unknown } };
    if (envelope.ok === false) {
      const error = envelope.error;
      if (!error || typeof error.code !== "string" || !SAFE_ERRORS.has(error.code) || typeof error.retryable !== "boolean" ||
        (error.retryAfterSeconds !== undefined && (typeof error.retryAfterSeconds !== "number" || !Number.isInteger(error.retryAfterSeconds) || error.retryAfterSeconds < 1 || error.retryAfterSeconds > 3600))) invalidResponse();
      throw new SourceFetchError(error.code, error.retryable, error.retryAfterSeconds as number | undefined);
    }
    if (envelope.ok !== true || !validFeed(envelope.feed)) invalidResponse();
    return envelope.feed;
  } catch (error) {
    if (error instanceof SourceFetchError) throw error;
    throw new SourceFetchError(controller.signal.aborted ? "timeout" : "capture_unavailable", true);
  } finally { clearTimeout(timer!); }
}
