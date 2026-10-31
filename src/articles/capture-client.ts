import type { Env } from "../contracts";
import { CAPTURE_TIMEOUT_MS, MAX_CAPTURE_RESPONSE_BYTES, MAX_MARKDOWN_BYTES, SourceFetchError, captureErrorCodes, type CapturedArticle } from "./capture-protocol";

export function isBackgroundCapturePaused(env: Env): boolean {
  return env.BACKGROUND_CAPTURE_ENABLED !== "true" || !env.ARTICLE_EXTRACTOR || !env.EXTRACTION_QUEUE;
}

function invalidResponse(): never { throw new SourceFetchError("invalid_capture_response", true); }

async function readResult(response: Response, signal: AbortSignal): Promise<CapturedArticle> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new SourceFetchError("capture_unavailable", true);
  }
  if (!response.body || !/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get("content-type") ?? "")) {
    await response.body?.cancel().catch(() => undefined);
    invalidResponse();
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
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
  let result;
  try { result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { invalidResponse(); }
  if (!result || result.version !== 1) invalidResponse();
  if (result.ok === false) {
    const error = result.error;
    if (!error || !captureErrorCodes.includes(error.code) || typeof error.retryable !== "boolean" ||
      (error.retryAfterSeconds !== undefined && (!Number.isInteger(error.retryAfterSeconds) || error.retryAfterSeconds < 1 || error.retryAfterSeconds > 3600))) invalidResponse();
    throw new SourceFetchError(error.code, error.retryable, error.retryAfterSeconds);
  }
  const article = result.article;
  if (result.ok !== true || !article || typeof article.markdown !== "string" || !article.markdown.trim() ||
    new TextEncoder().encode(article.markdown).byteLength > MAX_MARKDOWN_BYTES ||
    !article.metadata || typeof article.metadata !== "object" || Array.isArray(article.metadata)) invalidResponse();
  const metadata: CapturedArticle["metadata"] = {};
  for (const [key, limit] of [["title", 500], ["author", 200], ["description", 500]] as const) {
    const value = article.metadata[key];
    if (value !== undefined) {
      if (typeof value !== "string" || value.length > limit) invalidResponse();
      metadata[key] = value;
    }
  }
  return { markdown: article.markdown, metadata };
}

/** Private service call. The application Worker never fetches source URLs or parses source HTML. */
export async function captureArticle(url: string, env: Env): Promise<CapturedArticle> {
  if (isBackgroundCapturePaused(env) || !env.ARTICLE_EXTRACTOR) throw new SourceFetchError("capture_paused", false);
  const controller = new AbortController();
  let response: Response | undefined;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      void response?.body?.cancel().catch(() => undefined);
      reject(new SourceFetchError("timeout", true));
    }, CAPTURE_TIMEOUT_MS);
  });
  try {
    const pending = env.ARTICLE_EXTRACTOR.fetch("https://capture.internal/capture", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }), signal: controller.signal,
    });
    void pending.then(late => { if (controller.signal.aborted) void late.body?.cancel().catch(() => undefined); }).catch(() => undefined);
    response = await Promise.race([pending, timeout]);
    return await Promise.race([readResult(response, controller.signal), timeout]);
  } catch (error) {
    if (error instanceof SourceFetchError) throw error;
    throw new SourceFetchError("capture_unavailable", true);
  } finally { clearTimeout(timer!); }
}
