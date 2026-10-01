import type { Env } from "./contracts";
import { errorResponse } from "./contracts";

const securityHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'",
};

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return withSecurityHeaders(Response.json({ ok: true }, { headers: { "Cache-Control": "public, max-age=30" } }));
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/") || url.pathname === "/auth" || url.pathname.startsWith("/auth/")) {
      return withSecurityHeaders(errorResponse(404, "not_found", "Route not found"));
    }
    const asset = await env.ASSETS.fetch(request);
    return withSecurityHeaders(asset);
  },
} satisfies ExportedHandler<Env>;
