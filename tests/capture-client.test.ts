import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/contracts";
import { captureArticle, isBackgroundCapturePaused } from "../src/articles/capture-client";
import { CAPTURE_TIMEOUT_MS, MAX_CAPTURE_RESPONSE_BYTES } from "../src/articles/capture-protocol";

import { extractionQueueStub } from './extraction-queue-fixture';

function configured(fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>, overrides: Partial<Env> = {}): Env {
  return { EXTRACTION_QUEUE: extractionQueueStub().binding, DB: {} as D1Database, ASSETS: {} as Fetcher, BACKGROUND_CAPTURE_ENABLED: "true",
    ARTICLE_EXTRACTOR: { fetch, connect() { throw new Error("unused"); } } as Fetcher, ...overrides };
}
const success = () => Response.json({ version: 1, ok: true, article: { markdown: "# Saved", metadata: { title: "Saved" } } });

describe("private capture service", () => {
  afterEach(() => vi.useRealTimers());

  it("requires explicit enablement and binding, without a source-fetch fallback", async () => {
    const fetcher = vi.fn(async () => success());
    for (const env of [configured(fetcher, { BACKGROUND_CAPTURE_ENABLED: "false" }), configured(fetcher, { ARTICLE_EXTRACTOR: undefined }), configured(fetcher, { EXTRACTION_QUEUE: undefined })]) {
      expect(isBackgroundCapturePaused(env)).toBe(true);
      await expect(captureArticle("https://news.example.com/post", env)).rejects.toMatchObject({ code: "capture_paused" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends only the URL to a fixed private endpoint and accepts bounded results", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => success());
    await expect(captureArticle("https://news.example.com/private?x=1", configured(fetcher))).resolves.toEqual({ markdown: "# Saved", metadata: { title: "Saved" } });
    const [input, init] = fetcher.mock.calls[0];
    expect(input).toBe("https://capture.internal/capture");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({ url: "https://news.example.com/private?x=1" });
  });

  it("preserves safe error categories and retry delays, but rejects raw service messages", async () => {
    const env = configured(async () => Response.json({ version: 1, ok: false, error: { code: "upstream_http", retryable: true, retryAfterSeconds: 3600 } }));
    await expect(captureArticle("https://news.example.com/post", env)).rejects.toMatchObject({ code: "upstream_http", retryable: true, retryAfterSeconds: 3600 });
    await expect(captureArticle("https://news.example.com/post", configured(async () => Response.json({ version: 1, ok: false, error: { code: "private page text", retryable: true } })))).rejects.toMatchObject({ code: "invalid_capture_response" });
  });

  it("rejects malformed, empty, oversized and invalid metadata results", async () => {
    for (const article of [{ markdown: "", metadata: {} }, { markdown: "x".repeat(256 * 1024 + 1), metadata: {} }, { markdown: "valid", metadata: { title: "x".repeat(501) } }, { markdown: "valid", metadata: [] }]) {
      await expect(captureArticle("https://news.example.com/post", configured(async () => Response.json({ version: 1, ok: true, article })))).rejects.toMatchObject({ code: "invalid_capture_response" });
    }
    await expect(captureArticle("https://news.example.com/post", configured(async () => new Response("x".repeat(MAX_CAPTURE_RESPONSE_BYTES + 1), { headers: { "Content-Type": "application/json" } })))).rejects.toMatchObject({ code: "invalid_capture_response" });
  });

  it("times out and cancels a stalled result stream before the job lease expires", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const response = new Response(new ReadableStream({ pull() { return new Promise(() => undefined); }, cancel() { cancelled = true; } }), { headers: { "Content-Type": "application/json" } });
    const pending = captureArticle("https://news.example.com/post", configured(async () => response));
    const assertion = expect(pending).rejects.toMatchObject({ code: "timeout", retryable: true });
    await vi.advanceTimersByTimeAsync(CAPTURE_TIMEOUT_MS + 1);
    await assertion;
    expect(cancelled).toBe(true);
    expect(CAPTURE_TIMEOUT_MS).toBeLessThan(120_000);
  });

  it("cancels a late service response even when the fetcher ignores abort", async () => {
    vi.useFakeTimers();
    let resolveResponse!: (response: Response) => void;
    let cancelled = false;
    const pendingResponse = new Promise<Response>(resolve => { resolveResponse = resolve; });
    const pending = captureArticle("https://news.example.com/post", configured(() => pendingResponse));
    const assertion = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(CAPTURE_TIMEOUT_MS + 1);
    await assertion;
    resolveResponse(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
    await Promise.resolve(); await Promise.resolve();
    expect(cancelled).toBe(true);
  });
});
