import { createServer } from "node:http";
import { SourceFetchError, type CaptureResult } from "../src/articles/capture-protocol";
import { executeCapture } from "./executor";
import { assembleAudio, AudioAssemblyError, type AudioAssemblyResult } from "./audio-assembler";
import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

type AudioInput = { version: 1; episodeId: string; chunkKeys: string[] };
type AudioExecutor = (input: AudioInput, capability: string, signal: AbortSignal) => Promise<AudioAssemblyResult>;

export function createCaptureServer(appOrigin: string, execute = executeCapture, assemble: AudioExecutor = async (input, capability, signal) => assembleAudio({ ...input, capability, signal })) {
  let busy = false;
  const server = createServer(async (request, response) => {
    const send = (result: CaptureResult) => {
      if(response.destroyed || response.writableEnded)return;
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify(result));
    };
    if (request.method === "POST" && request.url === "/assemble-audio") {
      if (busy) { response.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify({ error: "capture_busy" })); return; }
      busy = true;
      const controller = new AbortController();
      const disconnect = () => { if (!response.writableEnded) controller.abort(); };
      response.once("close", disconnect);
      let result: AudioAssemblyResult | undefined;
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 64 * 1024) throw new AudioAssemblyError("request_too_large");
          chunks.push(chunk);
        }
        let body: unknown;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new AudioAssemblyError("invalid_request"); }
        const input = body as Partial<AudioInput>;
        const capability = request.headers["x-potem-audio-capability"];
        if (input?.version !== 1 || typeof input.episodeId !== "string" || !Array.isArray(input.chunkKeys) || input.chunkKeys.length < 1 || input.chunkKeys.length > 100 || input.chunkKeys.some(key => typeof key !== "string") || typeof capability !== "string" || !/^[a-f0-9]{48,128}$/i.test(capability)) throw new AudioAssemblyError("invalid_request");
        result = await assemble(input as AudioInput, capability, controller.signal);
        if (controller.signal.aborted) throw new AudioAssemblyError("assembly_timeout");
        response.writeHead(200, {
          "Content-Type": "audio/mpeg", "Cache-Control": "no-store", "Content-Length": String(result.bytes),
          "X-Audio-Duration-Seconds": String(result.durationSeconds), "X-Audio-Bytes": String(result.bytes),
        });
        await pipeline(createReadStream(result.path), response, { signal: controller.signal });
      } catch (error) {
        if (!response.headersSent && !response.destroyed) {
          const code = error instanceof AudioAssemblyError ? error.code : "assembly_failed";
          response.writeHead(code === "capture_busy" ? 503 : 422, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify({ error: code }));
        }
      } finally {
        response.removeListener("close", disconnect);
        if (result) await rm(result.directory, { recursive: true, force: true });
        busy = false;
      }
      return;
    }
    if (request.method !== "POST" || request.url !== "/capture") {
      response.writeHead(404).end(); return;
    }
    if (busy) { send({ version: 1, ok: false, error: { code: "capture_busy", retryable: true } }); return; }
    busy = true;
    const controller=new AbortController();
    const disconnect=()=>{if(!response.writableEnded)controller.abort();};
    response.once('close',disconnect);
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
      if (body.originalPdfId !== undefined && (typeof body.originalPdfId !== "string" || !/^[a-f0-9-]{36}$/.test(body.originalPdfId))) throw new SourceFetchError("invalid_pdf", false);
      const article = await execute(body.url, appOrigin, body.originalPdfId, controller.signal);
      send({ version: 1, ok: true, article });
    } catch (error) {
      const failure = error instanceof SourceFetchError ? error : new SourceFetchError("capture_unavailable", true);
      send({ version: 1, ok: false, error: { code: failure.code, retryable: failure.retryable, retryAfterSeconds: failure.retryAfterSeconds } });
    } finally { response.removeListener('close',disconnect); busy = false; }
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  return server;
}
