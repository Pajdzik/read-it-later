import { recoverEnrichmentJobs } from './articles/enrichment';
import type { Env } from "./contracts";
import { handleAuth } from "./auth/handler";
import { handleArticles } from "./articles/handler";
import { errorResponse, logUnexpectedError } from "./http";
import { consumeExtractionBatch, recoverExtractionJobs } from "./articles/processor";
import { consumeAudioBatch, recoverAudioJobs } from './audio';
import { handleAudio } from './audio/handler';

const securityHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; connect-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'",
};

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders)) {
    if (name === "Content-Security-Policy" && response.headers.get("Content-Type") === "application/pdf" && headers.get(name)?.startsWith("sandbox;")) continue;
    headers.set(name, value);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    if (batch.queue.startsWith('read-it-later-audio-')) await consumeAudioBatch(batch, env);
    else await consumeExtractionBatch(batch, env);
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    // Run independently: a paused or failed capture recovery must not block enrichment.
    const results = await Promise.allSettled([recoverExtractionJobs(env), recoverEnrichmentJobs(env), recoverAudioJobs(env)]);
    try { if (results.some(result => result.status === 'rejected')) throw new Error('recovery_failed'); }
    catch {
      logUnexpectedError("worker.scheduled");
      throw new Error("Background extraction processing failed");
    }
  },
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return withSecurityHeaders(Response.json({ ok: true }, { headers: { "Cache-Control": "public, max-age=30" } }));
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/") || url.pathname === "/auth" || url.pathname.startsWith("/auth/")) {
      try {
        const response = await handleAuth(request, env) ?? await handleAudio(request, env) ?? await handleArticles(request, env, ctx);
        return withSecurityHeaders(response ?? errorResponse(404, "not_found", "Route not found"));
      } catch {
        logUnexpectedError("worker.request");
        return withSecurityHeaders(errorResponse(503, "service_unavailable", "The service is temporarily unavailable. Please retry."));
      }
    }
    const asset = await env.ASSETS.fetch(request);
    return withSecurityHeaders(asset);
  },
} satisfies ExportedHandler<Env>;
