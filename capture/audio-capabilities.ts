export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashAudioCapability(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

type AudioReadEnv = Pick<CaptureBindings, "DB" | "AUDIO_BUCKET">;
type AudioAuthorizeEnv = Pick<CaptureBindings, "DB">;
export type AudioAssemblyRequest = { version: 1; episodeId: string; chunkKeys: string[] };

export async function authorizeAudio(body: AudioAssemblyRequest, env: AudioAuthorizeEnv): Promise<{ keys: string[]; generation: number } | null> {
  if (!body || typeof body !== "object" || body.version !== 1 || !/^[0-9a-f-]{36}$/i.test(body.episodeId) || !Array.isArray(body.chunkKeys) || body.chunkKeys.length < 1 || body.chunkKeys.length > 100 || body.chunkKeys.some(key => typeof key !== "string") || new Set(body.chunkKeys).size !== body.chunkKeys.length) return null;
  const rows = await env.DB.prepare(`SELECT c.chunk_index AS chunkIndex, c.object_key AS objectKey, c.state AS state, e.generation AS generation FROM audio_chunks c JOIN audio_episodes e ON e.id = c.episode_id WHERE e.id = ? AND e.state = 'generating' AND e.lease_token IS NOT NULL AND e.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') ORDER BY c.chunk_index`)
    .bind(body.episodeId).all<{ chunkIndex: number; objectKey: string | null; state: string; generation: number }>();
  if (rows.results.length !== body.chunkKeys.length || rows.results.length > 100) return null;
  if (rows.results.some((row, index) => row.chunkIndex !== index || row.state !== "succeeded" || row.objectKey !== body.chunkKeys[index] || !row.objectKey)) return null;
  const generation = rows.results[0]?.generation;
  if (!generation || rows.results.some(row => row.generation !== generation)) return null;
  return { keys: [...body.chunkKeys], generation };
}

export async function serveScopedAudio(request: Request, env: AudioReadEnv): Promise<Response> {
  const url = new URL(request.url);
  const [, token, item] = url.pathname.split("/");
  if (!token || !/^[a-f0-9]{64}$/.test(token) || !item || url.search || request.headers.has("range")) return new Response(null, { status: 404 });
  const tokenHash = await hashAudioCapability(token);
  if (item === "revoke" && request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM audio_assembly_grants WHERE token_hash = ?").bind(tokenHash).run();
    return new Response(null, { status: 204 });
  }
  if (request.method !== "GET" || !/^\d{1,3}$/.test(item)) return new Response(null, { status: 404 });
  const row = await env.DB.prepare(`SELECT c.object_key AS objectKey FROM audio_assembly_grants g JOIN audio_episodes e ON e.id = g.episode_id AND e.generation = g.generation JOIN audio_chunks c ON c.episode_id = e.id AND c.chunk_index = ? WHERE g.token_hash = ? AND g.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') AND e.state = 'generating' AND e.lease_token IS NOT NULL AND e.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') AND c.state = 'succeeded' AND c.object_key IS NOT NULL`)
    .bind(Number(item), tokenHash).first<{ objectKey: string }>();
  if (!row?.objectKey) return new Response(null, { status: 404 });
  const object = await env.AUDIO_BUCKET.get(row.objectKey);
  if (!object) return new Response(null, { status: 404 });
  return new Response(object.body, { headers: { "Content-Type": "audio/wav", "Content-Length": String(object.size), "Cache-Control": "no-store" } });
}
