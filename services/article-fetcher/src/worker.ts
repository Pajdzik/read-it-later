/// <reference path="./bindings.d.ts" />
import { validateArticleUrl } from "../../../src/articles/url-policy.js";

const GATEWAY_ENDPOINT = "http://article-fetch-gateway.internal:8080/fetch";
const MAX_REQUEST_URL = 8_192;
const SAFE_ERRORS = new Set([
  "unsafe_destination", "dns_error", "network_error", "timeout", "source_too_large",
  "unsupported_content", "empty_source",
]);

function jsonError(code: string, status: number): Response {
  return Response.json({ error: code }, { status, headers: { "Cache-Control": "no-store" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "GET") return jsonError("method_not_allowed", 405);
    if (request.body) return jsonError("invalid_request", 400);
    const raw = request.url;
    if (raw.length > MAX_REQUEST_URL) return jsonError("invalid_url", 400);
    let target: URL;
    try { target = validateArticleUrl(raw); }
    catch (error) {
      return jsonError(error instanceof Error && error.message === "invalid_url" ? "invalid_url" : "unsafe_destination", 400);
    }
    try {
      const upstream = await env.PROTECTED_GATEWAY.fetch(GATEWAY_ENDPOINT, {
        method: "POST",
        // The gateway's redirect response must return to the app, where each
        // hop is revalidated and sent through the pinned egress transport.
        redirect: "manual",
        headers: {
          "Content-Type": "application/json",
          "Accept": "*/*",
          "X-Article-Fetcher-Token": env.ARTICLE_FETCHER_TOKEN,
        },
        body: JSON.stringify({ url: target.href }),
        signal: request.signal,
      });
      const code = upstream.headers.get("x-article-fetcher-error");
      const headers = new Headers({ "Cache-Control": "no-store" });
      for (const name of ["content-type", "location", "retry-after"]) {
        const value = upstream.headers.get(name);
        if (value) headers.set(name, value);
      }
      if (code && SAFE_ERRORS.has(code)) headers.set("x-article-fetcher-error", code);
      return new Response(upstream.body, { status: upstream.status, headers });
    } catch {
      return jsonError("network_error", 503);
    }
  },
};
