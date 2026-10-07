import type { Env } from "../contracts";
import { parseArticleMetadata, type ArticleMetadata } from "./metadata";

const MAX_HTML_BYTES = 512 * 1024;
const HOP_TIMEOUT_MS = 5_000;
const TOTAL_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;

export class SourceFetchError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = "SourceFetchError";
  }
}

export function isBackgroundCapturePaused(env: Env): boolean {
  return env.BACKGROUND_CAPTURE_ENABLED !== "true" || !env.ARTICLE_FETCHER;
}

function fail(code: string, retryable = false, retryAfterSeconds?: number): never {
  throw new SourceFetchError(code, retryable, retryAfterSeconds);
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  const [a, b, c, d] = parts.map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && c === 0) || (b === 0 && c === 2) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    (a === 255 && b === 255 && c === 255 && d === 255);
}

const RESTRICTED_SUFFIXES = [
  ".localhost", ".local", ".internal", ".lan", ".home", ".home.arpa",
  ".test", ".invalid", ".example", ".onion", ".arpa", ".svc", ".cluster.local",
];

function validateTarget(raw: string, env: Env): URL {
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return fail("invalid_url");
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") fail("unsafe_destination");
  if (target.username || target.password) fail("unsafe_destination");
  if (target.port && target.port !== "80" && target.port !== "443") fail("unsafe_destination");

  const host = target.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || !host.includes(".") || RESTRICTED_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))) {
    fail("unsafe_destination");
  }
  // URL canonicalizes unusual IPv4 spellings (integer, octal, and hex) before
  // exposing hostname. Reject private/reserved literals; IPv6 literals are
  // conservatively rejected so mapped and scoped forms cannot bypass checks.
  if (host.startsWith("[") || host.includes(":")) fail("unsafe_destination");
  if (/^\d+(?:\.\d+){3}$/.test(host) && isPrivateIpv4(host)) fail("unsafe_destination");
  if (/^(?:0x[\da-f]+|\d+)$/i.test(host)) fail("unsafe_destination");

  const configuredOrigin = env.APP_ORIGIN;
  if (configuredOrigin) {
    try {
      if (new URL(configuredOrigin).hostname.toLowerCase().replace(/\.$/, "") === host) fail("unsafe_destination");
    } catch (error) {
      if (error instanceof SourceFetchError) throw error;
    }
  }
  return target;
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
export async function fetchSourcePage(url: string, env: Env): Promise<{ html: string; url: string; metadata: ArticleMetadata }> {
  if (isBackgroundCapturePaused(env)) fail("capture_paused");
  const fetcher = env.ARTICLE_FETCHER;
  if (!fetcher) fail("capture_paused");

  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  const visited = new Set<string>();
  let target = validateTarget(url, env);
  for (let redirects = 0; ; redirects++) {
    target = validateTarget(target.href, env);
    if (visited.has(target.href)) fail("redirect_loop");
    visited.add(target.href);
    const remaining = deadline - Date.now();
    if (remaining <= 0) fail("timeout", true);

    const controller = new AbortController();
    const hopMs = Math.min(HOP_TIMEOUT_MS, remaining);
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
      next = validateTarget(next.href, env);
      if (target.protocol === "https:" && next.protocol === "http:") fail("redirect_downgrade");
      target = next;
      continue;
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
    let metadata: ArticleMetadata;
    try { metadata = parseArticleMetadata(html); } catch { fail("invalid_html"); }
    return { html, url: target.href, metadata };
  }
}
