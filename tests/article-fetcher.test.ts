import { describe, expect, it, vi } from "vitest";
import worker from "../services/article-fetcher/src/worker";

describe("private article fetcher adapter", () => {
  it("forwards only a validated URL and fixed gateway credentials", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("<html></html>", {
      status: 200,
      headers: { "content-type": "text/html", "set-cookie": "secret=1", "x-private": "hidden" },
    }));
    const response = await worker.fetch(new Request("https://original.example.com/path?q=1", {
      method: "GET", headers: { Cookie: "session=secret", Authorization: "Bearer user-token", Referer: "https://private.example/" },
    }), {
      ARTICLE_FETCHER_TOKEN: "gateway-secret",
      PROTECTED_GATEWAY: { fetch } as unknown as Fetcher,
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [endpoint, init] = fetch.mock.calls[0];
    expect(endpoint).toBe("http://article-fetch-gateway.internal:8080/fetch");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("x-article-fetcher-token")).toBe("gateway-secret");
    expect(JSON.parse(String(init?.body))).toEqual({ url: "https://original.example.com/path?q=1" });
    expect(new Headers(init?.headers).has("cookie")).toBe(false);
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-private")).toBeNull();
  });

  it("rejects non-GET methods and unsafe destinations without calling the gateway", async () => {
    const fetch = vi.fn();
    const env = { ARTICLE_FETCHER_TOKEN: "secret", PROTECTED_GATEWAY: { fetch } as unknown as Fetcher };
    const post = await worker.fetch(new Request("https://adapter.example/", { method: "POST", body: "x" }), env);
    const privateUrl = await worker.fetch(new Request("https://127.0.0.1/", { method: "GET" }), env);
    expect(post.status).toBe(405);
    expect(privateUrl.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("marks only gateway-generated, recognized failure codes", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: "unsafe_destination" }), {
      status: 502, headers: { "x-article-fetcher-error": "unsafe_destination", "set-cookie": "ignored" },
    }));
    const response = await worker.fetch(new Request("https://original.example.com/", { method: "GET" }), {
      ARTICLE_FETCHER_TOKEN: "secret",
      PROTECTED_GATEWAY: { fetch } as unknown as Fetcher,
    });
    expect(response.headers.get("x-article-fetcher-error")).toBe("unsafe_destination");
    const spoofed = vi.fn(async () => new Response("", {
      status: 502, headers: { "x-article-fetcher-error": "made-up", "content-type": "text/plain" },
    }));
    const untrusted = await worker.fetch(new Request("https://original.example.com/", { method: "GET" }), {
      ARTICLE_FETCHER_TOKEN: "secret", PROTECTED_GATEWAY: { fetch: spoofed } as unknown as Fetcher,
    });
    expect(untrusted.headers.get("x-article-fetcher-error")).toBeNull();
  });
});
