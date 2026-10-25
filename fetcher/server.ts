import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fetchPinnedSource, PinnedFetchFailure } from "./pinned-fetch.js";
import {
  FETCH_ERROR_CODES,
  MAX_MESSAGE_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_SOURCE_BYTES,
  MAX_TARGET_BYTES,
  PROTOCOL_VERSION,
  type FetchErrorCode,
  type FetchRequestMessage,
  type FetchResponseMessage,
} from "./protocol.js";

const PORT = Number(process.env.PORT ?? 8080);
const APP_ORIGIN = process.env.APP_ORIGIN;
const MAX_ACTIVE_REQUESTS = 1;
let activeRequests = 0;

function json(response: ServerResponse, status: number, value: FetchResponseMessage): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.byteLength),
    "cache-control": "no-store",
    connection: "close",
  });
  response.end(body);
}

function stableError(error: unknown): FetchErrorCode {
  if (error instanceof PinnedFetchFailure && (FETCH_ERROR_CODES as readonly string[]).includes(error.code)) return error.code;
  return "network_error";
}

function readJson(request: IncomingMessage, signal: AbortSignal): Promise<FetchRequestMessage> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = (removeError = true) => {
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("aborted", onAbort);
      if (removeError) request.removeListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > MAX_MESSAGE_BYTES) {
        cleanup(false);
        reject(new PinnedFetchFailure("invalid_url"));
        request.destroy();
      } else chunks.push(bytes);
    };
    const onEnd = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as FetchRequestMessage); }
      catch { reject(new PinnedFetchFailure("invalid_url")); }
    };
    const onAbort = () => { cleanup(false); reject(new PinnedFetchFailure("network_error")); };
    const onError = () => { cleanup(); reject(new PinnedFetchFailure("network_error")); };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAbort);
    request.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === "GET" && request.url === "/healthz") {
    response.writeHead(200, { "content-type": "text/plain", "content-length": "2", connection: "close" }).end("ok");
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/fetch" || request.headers["content-type"] !== "application/json") {
    response.writeHead(404, { connection: "close" }).end();
    return;
  }
  const declaredLength = request.headers["content-length"];
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_MESSAGE_BYTES)) {
    json(response, 200, { version: PROTOCOL_VERSION, ok: false, error: "invalid_url" });
    request.destroy();
    return;
  }
  if (activeRequests >= MAX_ACTIVE_REQUESTS) {
    json(response, 503, { version: PROTOCOL_VERSION, ok: false, error: "network_error" });
    return;
  }
  activeRequests++;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 5_000);
  const abort = () => controller.abort();
  request.once("aborted", abort);
  response.once("close", () => { if (!response.writableEnded) controller.abort(); });
  try {
    const message = await readJson(request, controller.signal);
    if (message?.version !== PROTOCOL_VERSION || typeof message.url !== "string" || Buffer.byteLength(message.url, "utf8") > MAX_TARGET_BYTES) {
      throw new PinnedFetchFailure("invalid_url");
    }
    const fetched = await fetchPinnedSource(message.url, APP_ORIGIN, controller.signal);
    if (controller.signal.aborted) throw new PinnedFetchFailure("timeout");
    const body = Buffer.from(fetched.body).toString("base64");
    const payload: FetchResponseMessage = {
      version: PROTOCOL_VERSION,
      ok: true,
      status: fetched.status,
      headers: fetched.headers,
      body,
    };
    const encoded = Buffer.from(JSON.stringify(payload));
    if (encoded.byteLength > MAX_RESPONSE_BYTES || fetched.body.byteLength > MAX_SOURCE_BYTES) {
      throw new PinnedFetchFailure("source_too_large");
    }
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(encoded.byteLength),
      "cache-control": "no-store",
      connection: "close",
    });
    response.end(encoded);
  } catch (error) {
    if (!response.destroyed) json(response, 200, { version: PROTOCOL_VERSION, ok: false, error: stableError(error) });
  } finally {
    clearTimeout(deadline);
    request.removeListener("aborted", abort);
    activeRequests--;
  }
}

export function createFetchServer() {
  const server = createServer((request, response) => { void handle(request, response); });
  server.maxHeadersCount = 32;
  server.headersTimeout = 2_000;
  server.requestTimeout = 6_000;
  server.keepAliveTimeout = 1;
  server.maxConnections = 4;
  server.on("clientError", (_error, socket) => socket.destroy());
  return server;
}

if (process.env.NODE_ENV !== "test") {
  let appOrigin: URL;
  try { appOrigin = new URL(APP_ORIGIN ?? ""); }
  catch { throw new Error("A valid APP_ORIGIN is required for the safe fetch service"); }
  if (!["https:", "http:"].includes(appOrigin.protocol) || appOrigin.origin !== APP_ORIGIN) {
    throw new Error("APP_ORIGIN must contain only the configured HTTP(S) app origin");
  }
  createFetchServer().listen(PORT, "0.0.0.0");
}
