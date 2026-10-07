import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/contracts";
import { fetchSourcePage, isBackgroundCapturePaused, SourceFetchError } from "../src/articles/source-fetch";

type FetchCall = { input: RequestInfo | URL; init?: RequestInit };
function envWith(fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>, overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    ASSETS: {} as Fetcher,
    BACKGROUND_CAPTURE_ENABLED: "true",
    ARTICLE_FETCHER: { fetch, connect() { throw new Error("unused"); } } as Fetcher,
    ...overrides,
  };
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

  it("stays paused without explicit enablement and never falls back to global fetch", async () => {
    const globalFetch = vi.spyOn(globalThis, "fetch");
    const fetcher = vi.fn(async () => html());
    const disabled = envWith(fetcher, { BACKGROUND_CAPTURE_ENABLED: undefined });
    expect(isBackgroundCapturePaused(disabled)).toBe(true);
    await expectFetchError(fetchSourcePage("https://news.example.com/post", disabled), "capture_paused");
    expect(isBackgroundCapturePaused(envWith(fetcher, { ARTICLE_FETCHER: undefined }))).toBe(true);
    expect(globalFetch).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    globalFetch.mockRestore();
  });

  it("sends only fixed headers through the gateway and follows validated redirects manually", async () => {
    const calls: FetchCall[] = [];
    const env = envWith(async (input, init) => {
      calls.push({ input, init });
      if (calls.length === 1) return new Response(null, { status: 302, headers: { Location: "/story" } });
      return html();
    });
    const result = await fetchSourcePage("https://news.example.com/start", env);
    expect(result.url).toBe("https://news.example.com/story");
    expect(result.metadata.title).toBe("Fixture");
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.init?.redirect).toBe("manual");
      expect(call.init?.method).toBe("GET");
      expect(call.init?.headers).toEqual({
        Accept: "text/html,application/xhtml+xml;q=0.9",
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
    ]) await expectFetchError(fetchSourcePage(url, env), "unsafe_destination");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("revalidates each redirect and rejects downgrade, loops, and excessive hops", async () => {
    const toPrivate = envWith(async () => new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/" } }));
    await expectFetchError(fetchSourcePage("https://news.example.com/start", toPrivate), "unsafe_destination");
    const downgrade = envWith(async () => new Response(null, { status: 301, headers: { Location: "http://news.example.com/plain" } }));
    await expectFetchError(fetchSourcePage("https://news.example.com/start", downgrade), "redirect_downgrade");
    const loop = envWith(async () => new Response(null, { status: 302, headers: { Location: "/start" } }));
    await expectFetchError(fetchSourcePage("https://news.example.com/start", loop), "redirect_loop");
    const endless = envWith(async (input) => new Response(null, { status: 302, headers: { Location: `https://news.example.com/${encodeURIComponent(String(input))}` } }));
    await expectFetchError(fetchSourcePage("https://news.example.com/start", endless), "too_many_redirects");
  });

  it("maps transient HTTP failures and caps Retry-After", async () => {
    const env = envWith(async () => new Response("", { status: 429, headers: { "Retry-After": "7200" } }));
    await expect(fetchSourcePage("https://news.example.com/post", env)).rejects.toMatchObject({
      code: "upstream_http", retryable: true, retryAfterSeconds: 3600,
    });
  });

  it("rejects non-HTML, unsupported encoding, malformed, empty, invalid UTF-8, and oversized bodies", async () => {
    await expectFetchError(fetchSourcePage("https://news.example.com/post", envWith(async () => new Response("text", { headers: { "Content-Type": "text/plain" } }))), "unsupported_content");
    await expectFetchError(fetchSourcePage("https://news.example.com/post", envWith(async () => new Response("<html/>", { headers: { "Content-Type": "text/html; charset=utf-16" } }))), "unsupported_encoding");
    await expectFetchError(fetchSourcePage("https://news.example.com/post", envWith(async () => new Response("plain text", { headers: { "Content-Type": "text/html" } }))), "malformed_html");
    await expectFetchError(fetchSourcePage("https://news.example.com/post", envWith(async () => new Response("   ", { headers: { "Content-Type": "text/html" } }))), "empty_source");
    const invalidUtf8 = new Response(new Uint8Array([60, 104, 116, 109, 108, 62, 0xff]), { headers: { "Content-Type": "text/html" } });
    await expectFetchError(fetchSourcePage("https://news.example.com/post", envWith(async () => invalidUtf8)), "invalid_encoding");
    const oversized = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(512 * 1024));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    }), { headers: { "Content-Type": "text/html" } });
    await expectFetchError(fetchSourcePage("https://news.example.com/post", envWith(async () => oversized)), "source_too_large");
  });

  it("enforces the per-hop timeout even when a fetcher ignores abort", async () => {
    vi.useFakeTimers();
    const env = envWith(() => new Promise<Response>(() => undefined));
    const pending = fetchSourcePage("https://news.example.com/post", env);
    const assertion = expectFetchError(pending, "timeout");
    await vi.advanceTimersByTimeAsync(5_001);
    await assertion;
  });

  it("cancels a locked response stream and a response arriving after timeout", async () => {
    vi.useFakeTimers();
    let streamCancelled = false;
    const blockedBody = new Response(new ReadableStream<Uint8Array>({
      pull() { return new Promise<void>(() => undefined); },
      cancel() { streamCancelled = true; },
    }), { headers: { "Content-Type": "text/html" } });
    const blocked = fetchSourcePage("https://news.example.com/blocked", envWith(async () => blockedBody));
    const blockedAssertion = expectFetchError(blocked, "timeout");
    await vi.advanceTimersByTimeAsync(5_001);
    await blockedAssertion;
    expect(streamCancelled).toBe(true);

    let resolveFetch!: (response: Response) => void;
    const lateFetch = new Promise<Response>((resolve) => { resolveFetch = resolve; });
    let lateBodyCancelled = false;
    const late = fetchSourcePage("https://news.example.com/late", envWith(() => lateFetch));
    const lateAssertion = expectFetchError(late, "timeout");
    await vi.advanceTimersByTimeAsync(5_001);
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
});
