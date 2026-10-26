import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fetchPinnedSource, PinnedFetchFailure } from "./pinned-fetch.js";
import {
  FETCH_ERROR_CODES,
  FETCH_FAILURE_HEADER,
  FETCH_PROTOCOL_HEADER,
  MAX_MESSAGE_BYTES,
  MAX_SOURCE_BYTES,
  MAX_TARGET_BYTES,
  PROTOCOL_VERSION,
  type FetchErrorCode,
  type FetchRequestMessage,
} from "./protocol.js";

const PORT = Number(process.env.PORT ?? 8080);
const APP_ORIGIN = process.env.APP_ORIGIN;
const MAX_ACTIVE_REQUESTS = 1;
let activeRequests = 0;

function fail(response: ServerResponse, error: FetchErrorCode, status = 502): void {
  response.writeHead(status, {
    [FETCH_PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    [FETCH_FAILURE_HEADER]: error,
    "content-length": "0",
    "cache-control": "no-store",
    connection: "close",
  });
  response.end();
}

function sendFetched(response: ServerResponse, fetched: { status: number; headers: Record<string, string>; body: Uint8Array }): void {
  if (!Number.isInteger(fetched.status) || fetched.status < 200 || fetched.status > 599 || fetched.body.byteLength > MAX_SOURCE_BYTES) {
    fail(response, "source_too_large");
    return;
  }
  const bodyless = [204, 205, 304].includes(fetched.status);
  // The app follows redirects and handles HTTP errors itself; do not carry their upstream bodies.
  const omitBody = bodyless || fetched.status < 200 || fetched.status >= 300;
  const body = omitBody ? Buffer.alloc(0) : Buffer.from(fetched.body);
  const headers: Record<string, string> = {
    [FETCH_PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    "cache-control": "no-store",
    connection: "close",
  };
  if (fetched.status !== 204) headers["content-length"] = String(body.byteLength);
  for (const name of ["content-type", "location", "retry-after"]) {
    const value = fetched.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  response.writeHead(fetched.status, headers);
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
    const onAbort = () => {
      cleanup(false);
      const reason = signal.reason;
      reject(reason instanceof PinnedFetchFailure && reason.code === "timeout"
        ? reason
        : new PinnedFetchFailure("network_error"));
    };
    const onError = () => { cleanup(); reject(new PinnedFetchFailure("network_error")); };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAbort);
    request.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

type FetchSource = typeof fetchPinnedSource;

async function handle(request: IncomingMessage, response: ServerResponse, fetchSource: FetchSource, requestTimeoutMs: number): Promise<void> {
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
    fail(response, "invalid_url", 413);
    request.destroy();
    return;
  }
  if (activeRequests >= MAX_ACTIVE_REQUESTS) {
    fail(response, "network_error", 503);
    return;
  }
  activeRequests++;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new PinnedFetchFailure("timeout")), requestTimeoutMs);
  const abort = () => controller.abort();
  request.once("aborted", abort);
  response.once("close", () => { if (!response.writableEnded) controller.abort(); });
  try {
    const message = await readJson(request, controller.signal);
    if (message?.version !== PROTOCOL_VERSION || typeof message.url !== "string" || Buffer.byteLength(message.url, "utf8") > MAX_TARGET_BYTES) {
      throw new PinnedFetchFailure("invalid_url");
    }
    const fetched = await fetchSource(message.url, APP_ORIGIN, controller.signal);
    if (controller.signal.aborted) throw new PinnedFetchFailure("timeout");
    sendFetched(response, fetched);
  } catch (error) {
    if (!response.destroyed) fail(response, stableError(error));
  } finally {
    clearTimeout(deadline);
    request.removeListener("aborted", abort);
    activeRequests--;
  }
}

export function createFetchServer(fetchSource = fetchPinnedSource, options: { requestTimeoutMs?: number } = {}) {
  const requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 5_000) {
    throw new RangeError("requestTimeoutMs must be between 1 and 5000");
  }
  const server = createServer((request, response) => { void handle(request, response, fetchSource, requestTimeoutMs); });
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
