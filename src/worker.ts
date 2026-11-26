import { recoverEnrichmentJobs } from './articles/enrichment';
import type { Env } from "./contracts";
import { handleAuth } from "./auth/handler";
import { handleArticles } from "./articles/handler";
import { errorResponse, logUnexpectedError } from "./http";
import { consumeExtractionBatch, recoverExtractionJobs } from "./articles/processor";
import { consumeAudioBatch, recoverAudioJobs } from './audio';
import { handleAudio } from './audio/handler';
import { handleFeeds, refreshFeeds } from './feeds/handler';

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

function isAuthPath(pathname: string): boolean {
  return pathname === '/api/session'
    || pathname === '/api/capture-tokens'
    || /^\/api\/capture-tokens\/[^/]+$/.test(pathname)
    || pathname === '/auth/github'
    || pathname === '/auth/github/callback'
    || pathname === '/auth/logout';
}

function isAudioPath(pathname: string): boolean {
  return /^\/api\/articles\/[^/]+\/audio$/.test(pathname)
    || /^\/api\/podcast\/episodes\/[^/]+\.mp3$/.test(pathname)
    || pathname === '/api/podcast/feed.xml'
    || pathname === '/api/podcast/settings'
    || pathname === '/api/podcast/token';
}

async function readShareHandoff(request: Request): Promise<Record<string, string>> {
  const maxBytes = 16 * 1024;
  const contentType = (request.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/x-www-form-urlencoded') {
    throw new Error('unsupported_share_encoding');
  }
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new Error('share_body_too_large');
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('share_body_too_large');
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let decoded: string;
  try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('invalid_share_body'); }
  const form = new URLSearchParams(decoded);
  const result: Record<string, string> = {};
  for (const name of ['title', 'text', 'url']) {
    const value = form.get(name);
    if (value !== null) result[name] = value;
  }
  if (Object.values(result).some(value => value.length > 8192) || (result.title?.length ?? 0) > 500) {
    throw new Error('share_field_too_large');
  }
  return result;
}

function withShareHandoff(response: Response, handoff: Record<string, string>): Response {
  const json = JSON.stringify(handoff).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
  return new HTMLRewriter().on('body', {
    element(element) {
      element.append(`<script id="share-handoff" type="application/json">${json}</script>`, { html: true });
    },
  }).transform(response);
}

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    if (batch.queue.startsWith('read-it-later-audio-')) await consumeAudioBatch(batch, env);
    else await consumeExtractionBatch(batch, env);
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    // Run independently so one maintenance task cannot prevent the others from starting.
    const results = await Promise.allSettled([recoverExtractionJobs(env), recoverEnrichmentJobs(env), recoverAudioJobs(env), refreshFeeds(env)]);
    try { if (results.some(result => result.status === 'rejected')) throw new Error('recovery_failed'); }
    catch {
      logUnexpectedError("worker.scheduled");
      throw new Error("Scheduled maintenance failed");
    }
  },
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/add' && request.method === 'POST') {
      let handoff: Record<string, string>;
      try {
        handoff = await readShareHandoff(request);
      } catch (error) {
        const code = error instanceof Error ? error.message : 'invalid_share_body';
        const status = code === 'share_body_too_large' || code === 'share_field_too_large' ? 413 : 400;
        return withSecurityHeaders(Response.json({ error: code }, { status, headers: { 'Cache-Control': 'private, no-store' } }));
      }
      const asset = await env.ASSETS.fetch(new Request(new URL('/add', url), { headers: { Accept: 'text/html' } }));
      if (!asset.ok || !(asset.headers.get('Content-Type') || '').includes('text/html')) return withSecurityHeaders(asset);
      const response = withShareHandoff(asset, handoff);
      response.headers.set('Cache-Control', 'private, no-store');
      response.headers.set('Referrer-Policy', 'no-referrer');
      return withSecurityHeaders(response);
    }
    if (url.pathname === "/healthz") {
      return withSecurityHeaders(Response.json({ ok: true }, { headers: { "Cache-Control": "public, max-age=30" } }));
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/") || url.pathname === "/auth" || url.pathname.startsWith("/auth/")) {
      try {
        let response: Response | null;
        if (isAuthPath(url.pathname)) response = await handleAuth(request, env);
        else if (isAudioPath(url.pathname)) response = await handleAudio(request, env);
        else if (url.pathname === '/api/feeds' || url.pathname.startsWith('/api/feeds/')) response = await handleFeeds(request, env);
        else if (url.pathname === '/api' || url.pathname.startsWith('/api/')) response = await handleArticles(request, env, ctx);
        else response = null;
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
