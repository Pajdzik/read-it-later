import { createServer } from "node:http";
import { SourceFetchError, type CaptureResult } from "../src/articles/capture-protocol";
import { executeCapture } from "./executor";

export function createCaptureServer(appOrigin: string, execute = executeCapture) {
  let busy = false;
  const server = createServer(async (request, response) => {
    const send = (result: CaptureResult) => {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify(result));
    };
    if (request.method !== "POST" || request.url !== "/capture") {
      response.writeHead(404).end(); return;
    }
    if (busy) { send({ version: 1, ok: false, error: { code: "capture_busy", retryable: true } }); return; }
    busy = true;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 64 * 1024) throw new SourceFetchError("invalid_url", false);
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new SourceFetchError("invalid_url", false); }
      if (!body || typeof body.url !== "string" || new TextEncoder().encode(body.url).byteLength > 8 * 1024) throw new SourceFetchError("invalid_url", false);
      const article = await execute(body.url, appOrigin);
      send({ version: 1, ok: true, article });
    } catch (error) {
      const failure = error instanceof SourceFetchError ? error : new SourceFetchError("capture_unavailable", true);
      send({ version: 1, ok: false, error: { code: failure.code, retryable: failure.retryable, retryAfterSeconds: failure.retryAfterSeconds } });
    } finally { busy = false; }
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  return server;
}
