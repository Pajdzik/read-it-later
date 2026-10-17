import { lookup as systemLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { validateArticleUrl } from "../../../src/articles/url-policy.js";
import { isPublicAddress } from "./address-policy.js";

export const MAX_BODY_BYTES = 512 * 1024;
export const HOP_TIMEOUT_MS = 5_000;
const MAX_DNS_ANSWERS = 16;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export class GatewayFetchError extends Error {
  constructor(readonly code: string) { super(code); this.name = "GatewayFetchError"; }
}

export interface ResolvedAddress { address: string; family: number; }
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const resolveAll: Resolver = async (hostname) => {
  try { return await systemLookup(hostname, { all: true, verbatim: true }); }
  catch { throw new GatewayFetchError("dns_error"); }
};

export interface HopResponse {
  status: number;
  headers: Pick<IncomingHttpHeaders, "content-type" | "location" | "retry-after" | "content-length" | "content-encoding">;
  body: Buffer;
}

type Requester = typeof httpRequest;
type HttpsRequester = typeof httpsRequest;

function validateAddressSet(records: ResolvedAddress[]): ResolvedAddress[] {
  if (!Array.isArray(records) || records.length === 0 || records.length > MAX_DNS_ANSWERS) throw new GatewayFetchError("dns_error");
  const seen = new Set<string>();
  for (const record of records) {
    if (!record || isIP(record.address) !== record.family || !isPublicAddress(record.address)) throw new GatewayFetchError("unsafe_destination");
    seen.add(record.address);
  }
  if (!seen.size) throw new GatewayFetchError("dns_error");
  return records;
}

function doRequest(target: URL, address: ResolvedAddress, signal: AbortSignal, transport?: { http?: Requester; https?: HttpsRequester }): Promise<HopResponse> {
  return new Promise((resolve, reject) => {
    const requester = target.protocol === "https:" ? (transport?.https ?? httpsRequest) : (transport?.http ?? httpRequest);
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if (options && typeof options === "object" && "all" in options && options.all) {
        callback(null, [{ address: address.address, family: address.family }]);
      } else callback(null, address.address, address.family);
    };
    const options: RequestOptions = {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      method: "GET",
      path: `${target.pathname}${target.search}`,
      headers: { Host: target.host, "Accept-Encoding": "identity", Accept: "text/html,application/xhtml+xml;q=0.9", "User-Agent": "PotemReader/1.0" },
      agent: false,
      lookup,
      ...(target.protocol === "https:" && !/^\d+(?:\.\d+){3}$/.test(target.hostname) ? { servername: target.hostname } : {}),
      signal,
    };
    const req = requester(options, (res) => {
      const status = res.statusCode ?? 502;
      const headers = res.headers;
      if (REDIRECTS.has(status) || status < 200 || status >= 300) {
        // The app only needs status and the selected headers for redirects or
        // errors. Close the origin response immediately instead of draining an
        // untrusted, potentially unbounded body.
        res.once("error", () => undefined);
        res.destroy();
        resolve({ status, headers, body: Buffer.alloc(0) });
        return;
      }
      const encoding = String(headers["content-encoding"] ?? "identity").toLowerCase();
      if (encoding && encoding !== "identity") {
        res.destroy();
        reject(new GatewayFetchError("unsupported_content"));
        return;
      }
      const contentLength = headers["content-length"];
      if (contentLength && /^\d+$/.test(String(contentLength)) && Number(contentLength) > MAX_BODY_BYTES) {
        res.destroy();
        reject(new GatewayFetchError("source_too_large"));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer | Uint8Array) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += data.length;
        if (size > MAX_BODY_BYTES) {
          res.destroy(new GatewayFetchError("source_too_large"));
          return;
        }
        chunks.push(data);
      });
      res.once("end", () => resolve({ status, headers, body: Buffer.concat(chunks, size) }));
      res.once("error", (error) => reject(error instanceof GatewayFetchError ? error : new GatewayFetchError("network_error")));
    });
    req.once("error", () => reject(signal.aborted ? new GatewayFetchError("timeout") : new GatewayFetchError("network_error")));
    req.end();
  });
}

export async function fetchOneHop(
  rawUrl: string,
  options: { resolver?: Resolver; timeoutMs?: number; signal?: AbortSignal; transport?: { http?: Requester; https?: HttpsRequester }; blockedHosts?: string[]; appOrigin?: string } = {},
): Promise<HopResponse> {
  let target: URL;
  try { target = validateArticleUrl(rawUrl, options.appOrigin); }
  catch (error) { throw new GatewayFetchError(error instanceof Error && error.message === "invalid_url" ? "invalid_url" : "unsafe_destination"); }
  const host = target.hostname.toLowerCase().replace(/\.$/, "");
  const blocked = (options.blockedHosts ?? []).map((entry) => entry.toLowerCase().replace(/\.$/, ""));
  if (blocked.includes(host) || host === "article-fetch-gateway.internal") throw new GatewayFetchError("unsafe_destination");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(options.timeoutMs ?? HOP_TIMEOUT_MS, HOP_TIMEOUT_MS));
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  try {
    if (options.signal?.aborted) throw new GatewayFetchError("timeout");
    const dnsPromise = (options.resolver ?? resolveAll)(target.hostname);
    const records = validateAddressSet(await Promise.race([
      dnsPromise,
      new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new GatewayFetchError("timeout")), { once: true })),
    ]));
    if (controller.signal.aborted) throw new GatewayFetchError("timeout");
    // Use exactly one already-validated address; custom lookup pins the socket
    // to it and cannot perform a second resolver lookup.
    return await doRequest(target, records[0], controller.signal, options.transport);
  } catch (error) {
    if (error instanceof GatewayFetchError) throw error;
    if (controller.signal.aborted) throw new GatewayFetchError("timeout");
    throw new GatewayFetchError("network_error");
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}
