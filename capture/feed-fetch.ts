import { SourceFetchError } from "../src/articles/capture-protocol";
import { validateSourceTarget } from "../src/articles/source-policy";
import { SOURCE_HOP_TIMEOUT_MS, SOURCE_TOTAL_TIMEOUT_MS } from "../src/articles/capture-limits";
import { pinnedFetch } from "./pinned-fetch";

const MAX_FEED_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;

/** Fetch one feed through the same DNS-pinned native transport as article capture. */
export async function fetchFeedXml(url: string, appOrigin: string, signal?: AbortSignal): Promise<{ xml: string; url: string }> {
  const deadline = Date.now() + SOURCE_TOTAL_TIMEOUT_MS;
  const visited = new Set<string>();
  let target = validateSourceTarget(url, { APP_ORIGIN: appOrigin });
  for (let redirects = 0; ; redirects++) {
    target = validateSourceTarget(target.href, { APP_ORIGIN: appOrigin });
    if (visited.has(target.href)) throw new SourceFetchError("redirect_loop", false);
    visited.add(target.href);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new SourceFetchError("timeout", true);
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let response: Response | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        void response?.body?.cancel().catch(() => undefined);
        reject(new SourceFetchError("timeout", true));
      }, Math.min(SOURCE_HOP_TIMEOUT_MS, remaining));
    });
    try {
      const pending = pinnedFetch(target.href, {
        method: "GET", redirect: "manual", signal: controller.signal,
        headers: { Accept: "application/atom+xml,application/rss+xml,application/xml,text/xml;q=0.9" },
      }, appOrigin);
      void pending.then(late => { if (controller.signal.aborted) void late.body?.cancel().catch(() => undefined); }).catch(() => undefined);
      response = await Promise.race([pending, timeout]);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get("location");
        if (!location) throw new SourceFetchError("invalid_redirect", false);
        if (redirects >= MAX_REDIRECTS) throw new SourceFetchError("too_many_redirects", false);
        let next: URL;
        try { next = new URL(location, target); } catch { throw new SourceFetchError("invalid_redirect", false); }
        next = validateSourceTarget(next.href, { APP_ORIGIN: appOrigin });
        if (target.protocol === "https:" && next.protocol === "http:") throw new SourceFetchError("redirect_downgrade", false);
        target = next;
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel().catch(() => undefined);
        throw new SourceFetchError("upstream_http", response.status === 408 || response.status === 429 || response.status >= 500);
      }
      if (response.url && response.url !== target.href) throw new SourceFetchError("unvalidated_redirect", false);
      const type = response.headers.get("content-type") ?? "";
      if (!/^\s*(?:application\/(?:atom\+xml|rss\+xml|xml)|text\/(?:xml|plain))(?:\s*;|\s*$)/i.test(type)) {
        await response.body?.cancel().catch(() => undefined);
        throw new SourceFetchError("unsupported_content", false);
      }
      const length = response.headers.get("content-length");
      if (length && /^\d+$/.test(length) && Number(length) > MAX_FEED_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        throw new SourceFetchError("source_too_large", false);
      }
      if (!response.body) throw new SourceFetchError("empty_source", false);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await Promise.race([reader.read(), timeout]);
          if (done) break;
          size += value.byteLength;
          if (size > MAX_FEED_BYTES) throw new SourceFetchError("source_too_large", false);
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      if (!size) throw new SourceFetchError("empty_source", false);
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let xml: string;
      try { xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { throw new SourceFetchError("invalid_encoding", false); }
      return { xml, url: target.href };
    } catch (error) {
      if (error instanceof SourceFetchError) throw error;
      throw new SourceFetchError(controller.signal.aborted ? "timeout" : "network_error", true);
    } finally { clearTimeout(timer!); signal?.removeEventListener("abort", abort); }
  }
}
