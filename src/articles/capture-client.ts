import { assetId, MAX_PDF_BYTES } from "./pdf";
import type { Env, OriginalPdf } from "../contracts";
import { CAPTURE_TIMEOUT_MS, MAX_CAPTURE_RESPONSE_BYTES, MAX_MARKDOWN_BYTES, SourceFetchError, captureErrorCodes, type CapturedArticle } from "./capture-protocol";
import { normalizeArticleUrl } from "./validation";

export function isBackgroundCapturePaused(env: Env): boolean {
  return !captureService(env) || !env.EXTRACTION_QUEUE;
}

function captureService(env: Env): Env["ARTICLE_EXTRACTOR"] {
  return env.BACKGROUND_CAPTURE_ENABLED === "true" && env.MANAGED_CONVERSION_ENABLED !== "false"
    ? env.ARTICLE_EXTRACTOR : undefined;
}

function invalidResponse(): never { throw new SourceFetchError("invalid_capture_response", true); }

async function readResult(response: Response, signal: AbortSignal, preview: boolean): Promise<CapturedArticle> {
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
  const originalPdf = article?.originalPdf;
  const conversionError = article?.conversionError;
  if (preview && (originalPdf || conversionError)) invalidResponse();
  if (originalPdf && (!assetId(originalPdf.id) || !/^[a-f0-9]{64}$/.test(originalPdf.checksum) ||
    !Number.isInteger(originalPdf.bytes) || originalPdf.bytes < 1 || originalPdf.bytes > MAX_PDF_BYTES ||
    typeof originalPdf.capturedAt !== "string" || !Number.isFinite(Date.parse(originalPdf.capturedAt)) ||
    typeof originalPdf.sourceUrl !== "string" || originalPdf.sourceUrl.length > 8192 || !/^https?:\/\//.test(originalPdf.sourceUrl))) invalidResponse();
  if (conversionError && (!originalPdf || !captureErrorCodes.includes(conversionError.code) || typeof conversionError.retryable !== "boolean" || article.markdown !== "")) invalidResponse();
  if (result.ok !== true || !article || typeof article.markdown !== "string" || (!article.markdown.trim() && !conversionError) ||
    new TextEncoder().encode(article.markdown).byteLength > MAX_MARKDOWN_BYTES ||
    !article.metadata || typeof article.metadata !== "object" || Array.isArray(article.metadata)) invalidResponse();
  let sourceUrl: string | undefined;
  if (preview && article.sourceUrl !== undefined) {
    try { sourceUrl = normalizeArticleUrl(article.sourceUrl).url; }
    catch { invalidResponse(); }
  }
  const metadata: CapturedArticle["metadata"] = {};
  for (const [key, limit] of [["title", 500], ["author", 200], ["description", 500]] as const) {
    const value = article.metadata[key];
    if (value !== undefined) {
      if (typeof value !== "string" || value.length > limit) invalidResponse();
      metadata[key] = value;
    }
  }
  return { markdown: article.markdown, metadata, ...(sourceUrl ? { sourceUrl } : {}), ...(originalPdf ? { originalPdf: originalPdf as OriginalPdf } : {}), ...(conversionError ? { conversionError } : {}) };
}

/** Private service call. The application Worker never fetches source URLs or parses source HTML. */
export async function captureArticle(url: string, env: Env, originalPdfId?: string): Promise<CapturedArticle> {
  const service = captureService(env);
  if (!service || !env.EXTRACTION_QUEUE) throw new SourceFetchError("capture_paused", false);
  return requestCapture(service, "capture", { url, ...(originalPdfId ? { originalPdfId } : {}) });
}

export async function captureArticlePreview(url: string, env: Env, signal?: AbortSignal): Promise<CapturedArticle> {
  const service = captureService(env);
  if (!service) throw new SourceFetchError("capture_paused", false);
  return requestCapture(service, "preview", { url }, signal);
}

async function requestCapture(
  service: NonNullable<Env["ARTICLE_EXTRACTOR"]>, path: "capture" | "preview",
  body: { url: string; originalPdfId?: string }, signal?: AbortSignal,
): Promise<CapturedArticle> {
  const controller = new AbortController();
  let response: Response | undefined;
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => {
      controller.abort();
      void response?.body?.cancel().catch(() => undefined);
      reject(new SourceFetchError("timeout", true));
    };
  });
  const timer = setTimeout(abort, CAPTURE_TIMEOUT_MS);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) {
      abort();
      return await cancelled;
    }
    const pending = service.fetch(`https://capture.internal/${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: controller.signal,
    });
    void pending.then(late => { if (controller.signal.aborted) void late.body?.cancel().catch(() => undefined); }).catch(() => undefined);
    response = await Promise.race([pending, cancelled]);
    return await Promise.race([readResult(response, controller.signal, path === "preview"), cancelled]);
  } catch (error) {
    if (error instanceof SourceFetchError) throw error;
    throw new SourceFetchError("capture_unavailable", true);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
