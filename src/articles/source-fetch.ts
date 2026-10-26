import type { Env } from "../contracts";
import { parseArticleMetadata, type ArticleDocument, type ArticleMetadata } from "./metadata";
import { parseArticleDocument } from "./extraction";
import { failSourceFetch as fail, SourceFetchError, validateSourceTarget } from "./source-policy";
import { FETCH_FAILURE_HEADER, isFetchErrorCode } from "../../fetcher/protocol";
import { CONTAINER_STARTUP_TIMEOUT_MS, SOURCE_HOP_TIMEOUT_MS, SOURCE_TOTAL_TIMEOUT_MS } from "./capture-limits";

export { SourceFetchError } from "./source-policy";
export { validateSourceTarget as validateTarget } from "./source-policy";

export type SourceFetchEnv = Pick<Env, "APP_ORIGIN" | "BACKGROUND_CAPTURE_ENABLED" | "ARTICLE_FETCHER">;

const MAX_HTML_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;

export function isBackgroundCapturePaused(env: SourceFetchEnv): boolean {
  return env.BACKGROUND_CAPTURE_ENABLED !== "true" || !env.ARTICLE_FETCHER;
}

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

async function readHtml(response: Response, signal: AbortSignal): Promise<string> {
  const contentType = response.headers.get("content-type") || "";
  if (!/^\s*(?:text\/html|application\/xhtml\+xml)(?:\s*;|\s*$)/i.test(contentType)) {
    await response.body?.cancel().catch(() => undefined);
    fail("unsupported_content");
  }
  let charset: string;
  try { charset = contentCharset(contentType); }
  catch (error) {
    await response.body?.cancel().catch(() => undefined);
    throw error;
  }
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > MAX_HTML_BYTES) {
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
      if (size > MAX_HTML_BYTES) fail("source_too_large");
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
  let html: string;
  try {
    html = new TextDecoder(charset, { fatal: true }).decode(bytes);
  } catch {
    fail("invalid_encoding");
  }
  if (!html.trim()) fail("empty_source");
  if (!/<(?:!doctype\s+html|html\b|head\b|body\b|article\b|main\b)/i.test(html)) fail("malformed_html");
  return html;
}

/**
 * Fetches only through the configured connection-time public-egress gateway.
 * That service must resolve and validate every A/AAAA/CNAME candidate and
 * connect to a validated public address while preserving TLS hostname checks.
 * A Worker-side DNS preflight cannot prove which address an ordinary fetch uses.
 */
export async function fetchSourcePage(url: string, env: SourceFetchEnv): Promise<{ html: string; document: ArticleDocument; url: string; metadata: ArticleMetadata }> {
  if (isBackgroundCapturePaused(env)) fail("capture_paused");
  const fetcher = env.ARTICLE_FETCHER;
  if (!fetcher) fail("capture_paused");

  const deadline = Date.now() + SOURCE_TOTAL_TIMEOUT_MS;
  const visited = new Set<string>();
  let target = validateSourceTarget(url, env);
  for (let redirects = 0; ; redirects++) {
    target = validateSourceTarget(target.href, env);
    if (visited.has(target.href)) fail("redirect_loop");
    visited.add(target.href);
    const remaining = deadline - Date.now();
    if (remaining <= 0) fail("timeout", true);

    const controller = new AbortController();
    // The gateway enforces its network deadline after readiness; only the first
    // hop can spend an additional bounded allowance waking the Container.
    const hopMs = Math.min(SOURCE_HOP_TIMEOUT_MS + (redirects === 0 ? CONTAINER_STARTUP_TIMEOUT_MS : 0), remaining);
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
      const fetchPromise = fetcher.fetch(target.href, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "text/html,application/xhtml+xml;q=0.9",
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
      if (error instanceof SourceFetchError) throw error;
      fail(Date.now() >= deadline || controller.signal.aborted ? "timeout" : "network_error", true);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      clearTimeout(timeoutId!);
      const location = response.headers.get("location");
      if (!location) fail("invalid_redirect");
      if (redirects >= MAX_REDIRECTS) fail("too_many_redirects");
      let next: URL;
      try { next = new URL(location, target); } catch { fail("invalid_redirect"); }
      next = validateSourceTarget(next.href, env);
      if (target.protocol === "https:" && next.protocol === "http:") fail("redirect_downgrade");
      target = next;
      continue;
    }
    const gatewayError = response.headers.get(FETCH_FAILURE_HEADER);
    if (gatewayError && isFetchErrorCode(gatewayError)) {
      await response.body?.cancel().catch(() => undefined);
      clearTimeout(timeoutId!);
      fail(gatewayError, ["dns_error", "timeout", "network_error"].includes(gatewayError));
    }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => undefined);
      clearTimeout(timeoutId!);
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        fail("upstream_http", true, retryAfter(response, Date.now()));
      }
      fail("upstream_http");
    }
    if (response.url && response.url !== target.href) {
      await response.body?.cancel().catch(() => undefined);
      clearTimeout(timeoutId!);
      fail("unvalidated_redirect");
    }
    let html: string;
    try { html = await Promise.race([readHtml(response, controller.signal), hopTimeout]); }
    catch (error) {
      if (error instanceof SourceFetchError) throw error;
      fail(Date.now() >= deadline || controller.signal.aborted ? "timeout" : "network_error", true);
    }
    finally { clearTimeout(timeoutId!); }
    let document: ArticleDocument;
    let metadata: ArticleMetadata;
    try {
      document = parseArticleDocument(html);
      metadata = parseArticleMetadata(document);
    } catch { fail("invalid_html"); }
    return { html, document, url: target.href, metadata };
  }
}
