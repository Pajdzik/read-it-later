import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { fetchOneHop, GatewayFetchError, MAX_BODY_BYTES, type HopResponse } from "./fetch-one-hop.js";

const MAX_REQUEST_BYTES = 8 * 1024;
const MAX_CONCURRENT_FETCHES = 8;
const SAFE_ERRORS = new Set(["unsafe_destination", "dns_error", "network_error", "timeout", "source_too_large", "unsupported_content"]);
function authorized(req: IncomingMessage, token: string): boolean {
  const supplied = req.headers["x-article-fetcher-token"];
  if (typeof supplied !== "string") return false;
  const expectedDigest = createHash("sha256").update(token).digest();
  const suppliedDigest = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
}

function json(res: ServerResponse, status: number, body: unknown, marker?: string): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    ...(marker ? { "x-article-fetcher-error": marker } : {}),
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<{ url?: unknown }> {
  const type = req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/json") throw new GatewayFetchError("invalid_request");
  const length = req.headers["content-length"];
  if (length && /^\d+$/.test(length) && Number(length) > MAX_REQUEST_BYTES) throw new GatewayFetchError("invalid_request");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.byteLength;
    if (size > MAX_REQUEST_BYTES) throw new GatewayFetchError("invalid_request");
    chunks.push(data);
  }
  try { return JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as { url?: unknown }; }
  catch { throw new GatewayFetchError("invalid_request"); }
}

export function createGatewayServer(config: {
  token: string;
  appOrigin: string;
  blockedHosts: string[];
  fetch?: (url: string, options: { signal: AbortSignal; appOrigin: string; blockedHosts: string[] }) => Promise<HopResponse>;
}): Server {
  if (config.token.length < 32) throw new Error("ARTICLE_FETCHER_TOKEN must contain at least 32 characters");
  if (!config.appOrigin || config.blockedHosts.length === 0) throw new Error("APP_ORIGIN and BLOCKED_HOSTS must be configured");
  let appHost: string;
  try { appHost = new URL(config.appOrigin).hostname.toLowerCase().replace(/\.$/, ""); }
  catch { throw new Error("APP_ORIGIN must be a valid absolute URL"); }
  const blockedHosts = config.blockedHosts.map((host) => host.toLowerCase().replace(/\.$/, ""));
  if (!blockedHosts.includes(appHost)) throw new Error("BLOCKED_HOSTS must include the APP_ORIGIN hostname");
  let inFlight = 0;
  return createServer(async (req, res) => {
  const controller = new AbortController();
  req.once("aborted", () => controller.abort());
  res.once("close", () => { if (!res.writableEnded) controller.abort(); });

  if (!authorized(req, config.token)) { json(res, 401, { error: "unauthorized" }); return; }
  if (req.method === "GET" && req.url === "/healthz") { json(res, 200, { ok: true }); return; }
  if (req.method !== "POST" || req.url !== "/fetch") { json(res, 404, { error: "not_found" }); return; }
  if (inFlight >= MAX_CONCURRENT_FETCHES) { json(res, 503, { error: "busy" }); return; }

  inFlight++;
  try {
    const body = await readJson(req);
    if (typeof body.url !== "string" || body.url.length > MAX_REQUEST_BYTES) throw new GatewayFetchError("invalid_request");
    const result = await (config.fetch ?? ((url, options) => fetchOneHop(url, options)))(body.url, {
      signal: controller.signal, blockedHosts, appOrigin: config.appOrigin,
    });
    const headers: Record<string, string> = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    for (const name of ["content-type", "location", "retry-after"] as const) {
      const value = result.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    if (result.body.length > MAX_BODY_BYTES) throw new GatewayFetchError("source_too_large");
    res.writeHead(result.status, headers);
    res.end(result.body);
  } catch (error) {
    if (res.destroyed || res.writableEnded) return;
    if (error instanceof GatewayFetchError && SAFE_ERRORS.has(error.code)) {
      json(res, 502, { error: error.code }, error.code);
    } else if (error instanceof GatewayFetchError && error.code === "invalid_request") {
      json(res, 400, { error: "invalid_request" });
    } else {
      json(res, 502, { error: "network_error" }, "network_error");
    }
  } finally {
    inFlight--;
  }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const token = process.env.ARTICLE_FETCHER_TOKEN ?? "";
  const appOrigin = process.env.APP_ORIGIN ?? "";
  const blockedHosts = (process.env.BLOCKED_HOSTS ?? "").split(",").map((host) => host.trim()).filter(Boolean);
  const port = Number(process.env.PORT ?? "8080");
  const server = createGatewayServer({ token, appOrigin, blockedHosts });
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  server.listen(port, "0.0.0.0", () => {
    // No request URLs, bodies, or credentials are emitted to logs.
    process.stdout.write(`article-fetch-gateway listening on ${port}\n`);
  });
}
