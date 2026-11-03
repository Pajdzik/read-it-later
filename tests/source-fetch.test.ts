import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSourceDocument, type SourceFetchOptions } from "../src/articles/source-fetch";
import { SourceFetchError } from "../src/articles/source-policy";
import { SOURCE_HOP_TIMEOUT_MS, SOURCE_TOTAL_TIMEOUT_MS } from "../src/articles/capture-limits";

type FetchCall = { input: RequestInfo | URL; init?: RequestInit };
function envWith(fetchHop: (input: string, init: RequestInit) => Promise<Response>, overrides: { APP_ORIGIN?: string } = {}): SourceFetchOptions {
  return { appOrigin: overrides.APP_ORIGIN, fetchHop };
}

async function fetchHtml(url: string, options: SourceFetchOptions): Promise<{ html: string; url: string }> {
  const source = await fetchSourceDocument(url, options);
  if (source.kind !== "html") throw new Error("Expected HTML fixture");
  return { html: source.html, url: source.url };
}

function html(body = "<article><h1>Fixture</h1><p>Readable body.</p></article>"): Response {
  return new Response(`<!doctype html><html><head><title>Fixture</title></head><body>${body}</body></html>`, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function expectFetchError(promise: Promise<unknown>, code: string): Promise<void> {
  return expect(promise).rejects.toMatchObject({ code, name: "SourceFetchError" });
}

describe("bounded source fetching", () => {
  afterEach(() => vi.useRealTimers());

  it("sends only fixed headers through the executor and follows validated redirects manually", async () => {
    const calls: FetchCall[] = [];
    const env = envWith(async (input, init) => {
      calls.push({ input, init });
      if (calls.length === 1) return new Response(null, { status: 302, headers: { Location: "/story" } });
      return html();
    });
    const result = await fetchHtml("https://news.example.com/start", env);
    expect(result.url).toBe("https://news.example.com/story");
    expect(result.html).toContain("<title>Fixture</title>");
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.init?.redirect).toBe("manual");
      expect(call.init?.method).toBe("GET");
      expect(call.init?.headers).toEqual({
        Accept: "text/html,application/pdf,application/xhtml+xml;q=0.9",
        "User-Agent": "PotemReader/1.0",
      });
      expect(call.init?.headers).not.toHaveProperty("Cookie");
      expect(call.init?.headers).not.toHaveProperty("Authorization");
    }
  });

  it("rejects credentials, private literals, restricted names, own origin, and unsafe ports before fetching", async () => {
    const fetcher = vi.fn(async () => html());
    const env = envWith(fetcher, { APP_ORIGIN: "https://app.potem.com" });
    for (const url of [
      "https://user:secret@news.example.com/post",
      "http://127.0.0.1/post",
      "http://10.1.2.3/post",
      "http://[::ffff:127.0.0.1]/post",
      "http://metadata.google.internal/latest",
      "https://app.potem.com/api/articles",
      "https://news.example.com:8443/post",
    ]) await expectFetchError(fetchHtml(url, env), "unsafe_destination");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("revalidates each redirect and rejects downgrade, loops, and excessive hops", async () => {
    const toPrivate = envWith(async () => new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/" } }));
    await expectFetchError(fetchHtml("https://news.example.com/start", toPrivate), "unsafe_destination");
    const downgrade = envWith(async () => new Response(null, { status: 301, headers: { Location: "http://news.example.com/plain" } }));
    await expectFetchError(fetchHtml("https://news.example.com/start", downgrade), "redirect_downgrade");
    const loop = envWith(async () => new Response(null, { status: 302, headers: { Location: "/start" } }));
    await expectFetchError(fetchHtml("https://news.example.com/start", loop), "redirect_loop");
    const endless = envWith(async (input) => new Response(null, { status: 302, headers: { Location: `https://news.example.com/${encodeURIComponent(String(input))}` } }));
    await expectFetchError(fetchHtml("https://news.example.com/start", endless), "too_many_redirects");
  });

  it("maps transient HTTP failures and caps Retry-After", async () => {
    const env = envWith(async () => new Response("", { status: 429, headers: { "Retry-After": "7200" } }));
    await expect(fetchHtml("https://news.example.com/post", env)).rejects.toMatchObject({
      code: "upstream_http", retryable: true, retryAfterSeconds: 3600,
    });
  });

  it("does not start a hop after the caller has aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchHop = vi.fn(async () => html());
    await expectFetchError(fetchSourceDocument("https://news.example.com/post", { fetchHop, signal: controller.signal }), "timeout");
    expect(fetchHop).not.toHaveBeenCalled();
  });

  it("rejects non-HTML, unsupported encoding, malformed, empty, invalid UTF-8, and oversized bodies", async () => {
    await expectFetchError(fetchHtml("https://news.example.com/post", envWith(async () => new Response("text", { headers: { "Content-Type": "text/plain" } }))), "unsupported_content");
    await expectFetchError(fetchHtml("https://news.example.com/post", envWith(async () => new Response("<html/>", { headers: { "Content-Type": "text/html; charset=utf-16" } }))), "unsupported_encoding");
    await expectFetchError(fetchHtml("https://news.example.com/post", envWith(async () => new Response("plain text", { headers: { "Content-Type": "text/html" } }))), "malformed_html");
    await expectFetchError(fetchHtml("https://news.example.com/post", envWith(async () => new Response("   ", { headers: { "Content-Type": "text/html" } }))), "empty_source");
    const invalidUtf8 = new Response(new Uint8Array([60, 104, 116, 109, 108, 62, 0xff]), { headers: { "Content-Type": "text/html" } });
    await expectFetchError(fetchHtml("https://news.example.com/post", envWith(async () => invalidUtf8)), "invalid_encoding");
    const bodyOfSize = (size: number) => {
      const prefix = new TextEncoder().encode("<!doctype html><html><body><article>Cursor article fixture</article></body></html>");
      const bytes = new Uint8Array(size).fill(0x20);
      bytes.set(prefix);
      return bytes;
    };
    const largeButAllowed = bodyOfSize(718_354);
    const largeResult = await fetchHtml("https://news.example.com/large", envWith(async () => new Response(largeButAllowed, { headers: { "Content-Type": "text/html" } })));
    expect(new TextEncoder().encode(largeResult.html).byteLength).toBe(718_354);
    const atLimit = new Response(bodyOfSize(2 * 1024 * 1024), { headers: { "Content-Type": "text/html" } });
    expect(new TextEncoder().encode((await fetchHtml("https://news.example.com/at-limit", envWith(async () => atLimit))).html).byteLength).toBe(2 * 1024 * 1024);
    const oversized = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bodyOfSize(2 * 1024 * 1024));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    }), { headers: { "Content-Type": "text/html" } });
    await expectFetchError(fetchHtml("https://news.example.com/post", envWith(async () => oversized)), "source_too_large");
    await expectFetchError(fetchHtml("https://news.example.com/declared-oversized", envWith(async () => new Response("<html/>", { headers: { "Content-Type": "text/html", "Content-Length": String(2 * 1024 * 1024 + 1) } }))), "source_too_large");
  });

  it("bounds a fetch hop even when its executor ignores abort", async () => {
    vi.useFakeTimers();
    const env = envWith(() => new Promise<Response>(() => undefined));
    const pending = fetchHtml("https://news.example.com/post", env);
    const assertion = expectFetchError(pending, "timeout");
    await vi.advanceTimersByTimeAsync(SOURCE_HOP_TIMEOUT_MS + 1);
    await assertion;
  });

  it("cancels a locked response stream and a response arriving after timeout", async () => {
    vi.useFakeTimers();
    let streamCancelled = false;
    const blockedBody = new Response(new ReadableStream<Uint8Array>({
      pull() { return new Promise<void>(() => undefined); },
      cancel() { streamCancelled = true; },
    }), { headers: { "Content-Type": "text/html" } });
    const blocked = fetchHtml("https://news.example.com/blocked", envWith(async () => blockedBody));
    const blockedAssertion = expectFetchError(blocked, "timeout");
    await vi.advanceTimersByTimeAsync(SOURCE_HOP_TIMEOUT_MS + 1);
    await blockedAssertion;
    expect(streamCancelled).toBe(true);

    let resolveFetch!: (response: Response) => void;
    const lateFetch = new Promise<Response>((resolve) => { resolveFetch = resolve; });
    let lateBodyCancelled = false;
    const late = fetchHtml("https://news.example.com/late", envWith(() => lateFetch));
    const lateAssertion = expectFetchError(late, "timeout");
    await vi.advanceTimersByTimeAsync(SOURCE_HOP_TIMEOUT_MS + 1);
    await lateAssertion;
    resolveFetch(new Response(new ReadableStream<Uint8Array>({ cancel() { lateBodyCancelled = true; } }), {
      headers: { "Content-Type": "text/html" },
    }));
    await Promise.resolve();
    await Promise.resolve();
    expect(lateBodyCancelled).toBe(true);
  });

  it("uses stable typed errors", () => {
    const error = new SourceFetchError("unsafe_destination", false);
    expect(error).toBeInstanceOf(Error);
    expect(error.retryable).toBe(false);
  });

  it("applies the same hop timeout before and after redirects", async () => {
    vi.useFakeTimers();
    const slowFirst = fetchHtml("https://news.example.com/story", envWith(() => new Promise<Response>((resolve) => {
      setTimeout(() => resolve(html()), SOURCE_HOP_TIMEOUT_MS - 100);
    })));
    await vi.advanceTimersByTimeAsync(SOURCE_HOP_TIMEOUT_MS - 1);
    expect((await slowFirst).html).toContain("<title>Fixture</title>");

    let requests = 0;
    const redirected = fetchHtml("https://news.example.com/start", envWith(async () => {
      requests++;
      if (requests === 1) return new Response(null, { status: 302, headers: { Location: "/story" } });
      return new Promise<Response>(() => undefined);
    }));
    const assertion = expectFetchError(redirected, "timeout");
    await vi.advanceTimersByTimeAsync(SOURCE_HOP_TIMEOUT_MS + 1);
    await assertion;
    expect(requests).toBe(2);
  });

  it("keeps the overall fetch deadline across several redirects", async () => {
    vi.useFakeTimers();
    let requests = 0;
    let lastSignal: AbortSignal | undefined;
    const pending = fetchHtml("https://news.example.com/start", envWith((_input, init) => {
      requests++;
      lastSignal = init?.signal ?? undefined;
      const current = requests;
      return new Promise<Response>((resolve) => setTimeout(() => resolve(current < 4
        ? new Response(null, { status: 302, headers: { Location: `/hop-${current}` } })
        : html()), current === 4 ? 9_000 : 4_000));
    }));
    const assertion = expectFetchError(pending, "timeout");
    await vi.advanceTimersByTimeAsync(SOURCE_TOTAL_TIMEOUT_MS + 1);
    await assertion;
    expect(requests).toBe(4);
    expect(lastSignal?.aborted).toBe(true);
  });
});
