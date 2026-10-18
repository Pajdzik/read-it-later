import assert from "node:assert/strict";
import { test } from "node:test";
import adapter from "../../article-fetcher/src/worker.js";

test("adapter returns origin redirects without following them outside the pinned gateway", async () => {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const binding = {
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      calls.push({ input, init });
      return new Response(null, {
        status: 302,
        headers: {
          location: "http://127.0.0.1/latest-metadata",
          "set-cookie": "origin=secret",
          "x-article-fetcher-error": "network_error",
        },
      });
    },
  };

  const response = await adapter.fetch(
    new Request("https://news.example.com/story", { headers: { authorization: "Bearer caller", cookie: "session=secret" } }),
    { PROTECTED_GATEWAY: binding, ARTICLE_FETCHER_TOKEN: "adapter-secret" },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, "http://article-fetch-gateway.internal:8080/fetch");
  assert.equal(calls[0].init?.redirect, "manual");
  const sentHeaders = new Headers(calls[0].init?.headers);
  assert.equal(sentHeaders.get("authorization"), null);
  assert.equal(sentHeaders.get("cookie"), null);
  assert.equal(sentHeaders.get("x-article-fetcher-token"), "adapter-secret");
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "http://127.0.0.1/latest-metadata");
  assert.equal(response.headers.get("set-cookie"), null);
  // The internal error marker is accepted only from the authenticated gateway,
  // which strips upstream copies before returning its response.
  assert.equal(response.headers.get("x-article-fetcher-error"), "network_error");
});
