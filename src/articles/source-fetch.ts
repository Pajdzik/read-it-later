import { failSourceFetch as fail, SourceFetchError, validateSourceTarget } from "./source-policy";
import { MAX_SOURCE_HTML_BYTES, MAX_SOURCE_PDF_BYTES, SOURCE_HOP_TIMEOUT_MS, SOURCE_TOTAL_TIMEOUT_MS } from "./capture-limits";

export type SourceFetchOptions = {
  appOrigin?: string;
  signal?: AbortSignal;
  fetchHop: (url: string, init: RequestInit) => Promise<Response>;
};

const MAX_REDIRECTS = 3;

function retryAfter(response: Response, now: number): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  let seconds: number;
  if (/^\d+$/.test(value.trim())) seconds = Number(value.trim());
  else {
    const date = Date.parse(value);
    if (!Number.isFinite(date)) return undefined;
    seconds = Math.ceil((date - now) / 1_000);
  }
  if (seconds <= 0) return undefined;
  return Math.min(3_600, seconds);
}

function contentCharset(contentType: string): string {
  const match = /(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i.exec(contentType);
  const charset = (match?.[1] || match?.[2] || match?.[3] || "utf-8").toLowerCase();
  if (!["utf-8", "utf8"].includes(charset)) fail("unsupported_encoding");
  return "utf-8";
}

export type SourceDocument = { kind: "html"; html: string; url: string } | { kind: "pdf"; bytes: Uint8Array; url: string };

async function readDocument(response: Response, signal: AbortSignal): Promise<Omit<Extract<SourceDocument, {kind: "html"}>, "url"> | Omit<Extract<SourceDocument, {kind: "pdf"}>, "url">> {
  const contentType = response.headers.get("content-type") || "";
  const pdf = /^\s*application\/(?:pdf|octet-stream)(?:\s*;|\s*$)/i.test(contentType);
  const limit = pdf ? MAX_SOURCE_PDF_BYTES : MAX_SOURCE_HTML_BYTES;
  if (!pdf && !/^\s*(?:text\/html|application\/xhtml\+xml)(?:\s*;|\s*$)/i.test(contentType)) {
    await response.body?.cancel().catch(() => undefined);
    fail("unsupported_content");
  }
  let charset: string;
  try { charset = pdf ? "utf-8" : contentCharset(contentType); }
  catch (error) {
    await response.body?.cancel().catch(() => undefined);
    throw error;
  }
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > limit) {
    await response.body?.cancel().catch(() => undefined);
    fail("source_too_large");
  }
  if (!response.body) fail("empty_source");

  const reader = response.body.getReader();
  const cancelReader = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancelReader, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) fail("source_too_large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof SourceFetchError) throw error;
    fail("network_error", true);
  } finally {
    signal.removeEventListener("abort", cancelReader);
    if (!signal.aborted) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (!size) fail("empty_source");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (pdf) {
    if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") fail("invalid_pdf");
    return { kind: "pdf", bytes };
  }
  let html: string;
  try {
    html = new TextDecoder(charset, { fatal: true }).decode(bytes);
  } catch {
    fail("invalid_encoding");
  }
  if (!html.trim()) fail("empty_source");
  if (!/<(?:!doctype\s+html|html\b|head\b|body\b|article\b|main\b)/i.test(html)) fail("malformed_html");
  return { kind: "html", html };
}

/**
 * Fetches each manually validated hop through the executor's native pinned
 * transport. Its resolver checks the complete DNS answer set before connecting
 * to a numeric public address with the original hostname for TLS verification.
 */
export async function fetchSourceDocument(url: string, options: SourceFetchOptions): Promise<SourceDocument> {
  const deadline = Date.now() + SOURCE_TOTAL_TIMEOUT_MS;
  const visited = new Set<string>();
  let target = validateSourceTarget(url, { APP_ORIGIN: options.appOrigin });
  for (let redirects = 0; ; redirects++) {
    target = validateSourceTarget(target.href, { APP_ORIGIN: options.appOrigin });
    if (visited.has(target.href)) fail("redirect_loop");
    visited.add(target.href);
    const remaining = deadline - Date.now();
    if (remaining <= 0) fail("timeout", true);

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (options.signal?.aborted) abortFromCaller();
    const hopMs = Math.min(SOURCE_HOP_TIMEOUT_MS, remaining);
    let activeResponse: Response | undefined;
    let timeoutId: ReturnType<typeof setTimeout>;
    const hopTimeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort("source timeout");
        void activeResponse?.body?.cancel().catch(() => undefined);
        reject(new SourceFetchError("timeout", true));
      }, hopMs);
    });
    let response: Response;
    try {
      controller.signal.throwIfAborted();
      const fetchPromise = options.fetchHop(target.href, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "text/html,application/pdf,application/xhtml+xml;q=0.9",
          "User-Agent": "PotemReader/1.0",
        },
      });
      void fetchPromise.then((lateResponse) => {
        if (controller.signal.aborted) void lateResponse.body?.cancel().catch(() => undefined);
      }).catch(() => undefined);
      response = await Promise.race([fetchPromise, hopTimeout]);
      activeResponse = response;
    } catch (error) {
      clearTimeout(timeoutId!);
      options.signal?.removeEventListener("abort", abortFromCaller);
      if (error instanceof SourceFetchError) throw error;
      fail(Date.now() >= deadline || controller.signal.aborted ? "timeout" : "network_error", true);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      clearTimeout(timeoutId!);
      options.signal?.removeEventListener("abort", abortFromCaller);
      const location = response.headers.get("location");
      if (!location) fail("invalid_redirect");
      if (redirects >= MAX_REDIRECTS) fail("too_many_redirects");
      let next: URL;
      try { next = new URL(location, target); } catch { fail("invalid_redirect"); }
      next = validateSourceTarget(next.href, { APP_ORIGIN: options.appOrigin });
      if (target.protocol === "https:" && next.protocol === "http:") fail("redirect_downgrade");
      target = next;
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => undefined);
      clearTimeout(timeoutId!);
      options.signal?.removeEventListener("abort", abortFromCaller);
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        fail("upstream_http", true, retryAfter(response, Date.now()));
      }
      fail("upstream_http");
    }
    if (response.url && response.url !== target.href) {
      await response.body?.cancel().catch(() => undefined);
      clearTimeout(timeoutId!);
      options.signal?.removeEventListener("abort", abortFromCaller);
      fail("unvalidated_redirect");
    }
    let document: Awaited<ReturnType<typeof readDocument>>;
    try { document = await Promise.race([readDocument(response, controller.signal), hopTimeout]); }
    catch (error) {
      if (error instanceof SourceFetchError) throw error;
      fail(Date.now() >= deadline || controller.signal.aborted ? "timeout" : "network_error", true);
    }
    finally { clearTimeout(timeoutId!); options.signal?.removeEventListener("abort", abortFromCaller); }
    // Parsing belongs to the executor's bounded thread, after the network deadline.
    return { ...document, url: target.href };
  }
}
