/// <reference path="./bindings.d.ts" />
import { managedConversion } from "./managed";
import { Container, ContainerProxy } from "@cloudflare/containers";
import { authorizeAudio, hashAudioCapability, randomToken, serveScopedAudio, type AudioAssemblyRequest } from "./audio-capabilities";

export { ContainerProxy };
type CaptureEnv = CaptureBindings;

export class ArticleCaptureContainer extends Container<CaptureEnv> {
  defaultPort = 8080;
  sleepAfter = "30s";
  envVars = { APP_ORIGIN: this.env.APP_ORIGIN };

  override async fetch(request: Request): Promise<Response> {
    const keepAlive = request.url === "http://capture/assemble-audio" ? setInterval(() => this.renewActivityTimeout(), 15_000) : undefined;
    try { return await super.fetch(request); }
    finally { if (keepAlive) clearInterval(keepAlive); }
  }

  override onError(): void { throw new Error("capture_container_unavailable"); }
}

// Intercept ONLY this virtual host. Do not add catch-all handlers or HTTPS interception:
// source connections must keep using the native validated destination sockets.
ArticleCaptureContainer.outboundByHost = {
  "potem.convert": (request, env) => managedConversion(request, env),
  "potem.audio": (request, env) => serveScopedAudio(request, env),
};

export default {
  async fetch(request: Request, env: CaptureEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    const capturesArticle = path === "/capture" || path === "/preview";
    if (request.method !== "POST" || (!capturesArticle && path !== "/assemble-audio")) return new Response(null, { status: 404 });
    if (capturesArticle && env.MANAGED_CONVERSION_ENABLED !== "true") return Response.json({ version: 1, ok: false, error: { code: "capture_paused", retryable: false } });
    if (path === "/assemble-audio" && env.ARTICLE_AUDIO_ENABLED !== "true") return Response.json({ error: "audio_paused" }, { status: 503 });
    let tokenHash: string | undefined;
    try {
      if (capturesArticle) return await env.CAPTURE_CONTAINER.getByName("capture").fetch(request);
      const reader = request.body?.getReader();
      if (!reader) return Response.json({ error: "invalid_request" }, { status: 400 });
      const parts: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 64 * 1024) { await reader.cancel(); return Response.json({ error: "request_too_large" }, { status: 413 }); }
        parts.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
      let body: AudioAssemblyRequest;
      try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as AudioAssemblyRequest; }
      catch { return Response.json({ error: "invalid_request" }, { status: 400 }); }
      const keys = await authorizeAudio(body, env);
      if (!keys) return Response.json({ error: "audio_chunks_unavailable" }, { status: 404 });
      await env.DB.prepare("DELETE FROM audio_assembly_grants WHERE token_hash IN (SELECT token_hash FROM audio_assembly_grants WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now') LIMIT 64)").run();
      const active = await env.DB.prepare("SELECT COUNT(*) AS count FROM audio_assembly_grants WHERE expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')").first<{ count: number }>();
      if ((active?.count ?? 0) >= 16) return Response.json({ error: "audio_busy" }, { status: 503 });
      const token = randomToken();
      tokenHash = await hashAudioCapability(token);
      const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
      const grant = await env.DB.prepare(`INSERT INTO audio_assembly_grants(token_hash,episode_id,generation,expires_at) SELECT ?,id,generation,? FROM audio_episodes WHERE id = ? AND generation = ? AND state = 'generating' AND lease_token IS NOT NULL AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
        .bind(tokenHash, expiresAt, body.episodeId, keys.generation).run();
      if (!grant.meta.changes) return Response.json({ error: "audio_chunks_unavailable" }, { status: 404 });
      const headers = new Headers(request.headers);
      headers.set("X-Potem-Audio-Capability", token);
      headers.set("Content-Type", "application/json");
      const internal = new Request("http://capture/assemble-audio", { method: "POST", headers, body: bytes, signal: request.signal });
      const response = await env.CAPTURE_CONTAINER.getByName("capture").fetch(internal);
      if (!response.ok) await env.DB.prepare("DELETE FROM audio_assembly_grants WHERE token_hash = ?").bind(tokenHash).run();
      return response;
    }
    catch {
      if (tokenHash) await env.DB.prepare("DELETE FROM audio_assembly_grants WHERE token_hash = ?").bind(tokenHash).run().catch(() => undefined);
      return new Response(null, { status: 503 });
    }
  },
} satisfies ExportedHandler<CaptureEnv>;
