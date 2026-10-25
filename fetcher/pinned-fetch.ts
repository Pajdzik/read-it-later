import { Resolver } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ClientRequest } from "node:http";
import { checkServerIdentity } from "node:tls";
import ipaddr from "ipaddr.js";
import { validateSourceTarget } from "../src/articles/source-policy.js";
import { MAX_SOURCE_BYTES, type FetchErrorCode } from "./protocol.js";

export const MAX_HOP_MS = 5_000;
export const MAX_HEADER_BYTES = 16 * 1024;
const MAX_CNAME_DEPTH = 8;
const ACCEPT = "text/html,application/xhtml+xml;q=0.9";
const USER_AGENT = "PotemReader/1.0";

export class PinnedFetchFailure extends Error {
  constructor(readonly code: FetchErrorCode) {
    super(code);
    this.name = "PinnedFetchFailure";
  }
}

export interface ResolveOptions {
  resolver?: Pick<Resolver, "cancel" | "resolve4" | "resolve6" | "resolveCname">;
  appOrigin?: string;
}

function failure(code: FetchErrorCode): never { throw new PinnedFetchFailure(code); }

export function isPublicAddress(value: string): boolean {
  try {
    const address = ipaddr.parse(value);
    if (address.kind() === "ipv6") {
      const ipv6 = address as ipaddr.IPv6;
      if (ipv6.zoneId || ipv6.isIPv4MappedAddress() || ipv6.range() !== "unicast") return false;
      if (!ipv6.match(ipaddr.parse("2000::"), 3)) return false;
      // Reject protocol translation/tunnelling ranges even when they embed public IPv4.
      if (ipv6.match(ipaddr.parse("64:ff9b::"), 96) || ipv6.match(ipaddr.parse("64:ff9b:1::"), 48) ||
          ipv6.match(ipaddr.parse("2002::"), 16) || ipv6.match(ipaddr.parse("2001:0::"), 32) ||
          ipv6.match(ipaddr.parse("3fff::"), 20)) return false;
    }
    return address.range() === "unicast";
  } catch { return false; }
}

function dnsNoRecord(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENODATA";
}

/** Resolve all aliases and both address families; every answer is policy checked. */
export async function resolvePublicAddress(hostname: string, signal: AbortSignal, options: ResolveOptions = {}): Promise<string> {
  const resolver = options.resolver ?? new Resolver();
  const owned = !options.resolver;
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  const seen = new Set<string>();
  const pending = [hostname.replace(/\.$/, "")];
  const addresses: string[] = [];
  try {
    while (pending.length) {
      if (signal.aborted) failure("timeout");
      const name = pending.shift()!.toLowerCase();
      if (seen.has(name)) failure("dns_error");
      seen.add(name);
      if (seen.size > MAX_CNAME_DEPTH + 1 || name.length > 253) failure("dns_error");
      try { validateSourceTarget(`https://${name}`, { APP_ORIGIN: options.appOrigin }); }
      catch (error) {
        if (error instanceof Error && "code" in error) failure(String((error as { code: string }).code) === "unsafe_destination" ? "unsafe_destination" : "dns_error");
        failure("unsafe_destination");
      }

      // Public IPv4 literals are already canonicalized and validated by the source policy.
      try {
        const literal = ipaddr.parse(name);
        if (literal.kind() === "ipv4") {
          if (!isPublicAddress(name)) failure("unsafe_destination");
          addresses.push(name);
          continue;
        }
      } catch { /* hostname; resolve below */ }

      let aliases: string[] = [];
      try { aliases = await resolver.resolveCname(name); }
      catch (error) { if (!dnsNoRecord(error)) failure("dns_error"); }
      if (aliases.length) {
        if (aliases.length !== 1) failure("dns_error");
        pending.push(aliases[0]);
        continue;
      }

      const familyResults = await Promise.all([
        resolver.resolve4(name).then((items) => items, (error: unknown) => dnsNoRecord(error) ? [] : failure("dns_error")),
        resolver.resolve6(name).then((items) => items, (error: unknown) => dnsNoRecord(error) ? [] : failure("dns_error")),
      ]);
      const current = familyResults.flat();
      if (!current.length) failure("dns_error");
      for (const address of current) {
        if (!isPublicAddress(address)) failure("unsafe_destination");
        addresses.push(address);
      }
    }
    if (!addresses.length || signal.aborted) failure(signal.aborted ? "timeout" : "dns_error");
    // Deterministic address choice; never pass the hostname to socket-level lookup.
    return addresses.find((address) => ipaddr.parse(address).kind() === "ipv4") ?? addresses[0];
  } catch (error) {
    if (signal.aborted) failure("timeout");
    if (error instanceof PinnedFetchFailure) throw error;
    return failure("dns_error");
  } finally {
    signal.removeEventListener("abort", cancel);
    if (owned) resolver.cancel();
  }
}

export interface PinnedRequestOptions {
  signal: AbortSignal;
  maxBytes?: number;
  /** Test seam only: production entrypoints do not accept caller-controlled transport options. */
  requestFactory?: (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
}

function readBody(response: IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = (removeError = true) => {
      response.removeListener("data", onData);
      response.removeListener("end", onEnd);
      response.removeListener("aborted", onAbort);
      if (removeError) response.removeListener("error", onError);
      signal.removeEventListener("abort", onSignalAbort);
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > maxBytes) {
        cleanup(false);
        response.destroy();
        reject(new PinnedFetchFailure("source_too_large"));
      } else chunks.push(bytes);
    };
    const onEnd = () => {
      cleanup();
      if (!response.complete) reject(new PinnedFetchFailure("network_error"));
      else resolve(Buffer.concat(chunks, size));
    };
    const onAbort = () => { cleanup(false); reject(new PinnedFetchFailure("network_error")); };
    const onError = () => { cleanup(); reject(new PinnedFetchFailure("network_error")); };
    const onSignalAbort = () => { cleanup(false); response.destroy(); reject(new PinnedFetchFailure("timeout")); };
    response.on("data", onData);
    response.once("end", onEnd);
    response.once("aborted", onAbort);
    response.once("error", onError);
    response.once("close", () => response.removeListener("error", onError));
    signal.addEventListener("abort", onSignalAbort, { once: true });
    if (signal.aborted) onSignalAbort();
  });
}

export async function pinnedRequest(target: URL, address: string, options: PinnedRequestOptions): Promise<{
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}> {
  if (!isPublicAddress(address)) failure("unsafe_destination");
  const port = target.port ? Number(target.port) : target.protocol === "https:" ? 443 : 80;
  const path = `${target.pathname || "/"}${target.search}`;
  const headers = {
    Host: target.host,
    Accept: ACCEPT,
    "User-Agent": USER_AGENT,
    "Accept-Encoding": "identity",
    Connection: "close",
  };
  const requestOptions: RequestOptions = {
    protocol: target.protocol,
    hostname: address,
    family: ipaddr.parse(address).kind() === "ipv4" ? 4 : 6,
    port,
    path,
    method: "GET",
    headers,
    agent: false,
    signal: options.signal,
    maxHeaderSize: MAX_HEADER_BYTES,
    ...(target.protocol === "https:" ? {
      servername: target.hostname,
      rejectUnauthorized: true,
      checkServerIdentity: (_hostname: string, cert: Parameters<typeof checkServerIdentity>[1]) => checkServerIdentity(target.hostname, cert),
    } : {}),
  };
  const makeRequest = options.requestFactory ?? (target.protocol === "https:" ? httpsRequest : httpRequest);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      if (error instanceof PinnedFetchFailure) reject(error);
      else if (options.signal.aborted) reject(new PinnedFetchFailure("timeout"));
      else reject(new PinnedFetchFailure("network_error"));
    };
    const req = makeRequest(requestOptions, (response) => {
      const safeHeaders: Record<string, string> = {};
      for (const key of ["content-type", "content-length", "location", "retry-after", "content-encoding"]) {
        const value = response.headers[key];
        if (typeof value === "string") safeHeaders[key] = value;
      }
      const encoding = (safeHeaders["content-encoding"] || "identity").trim().toLowerCase();
      if (encoding && encoding !== "identity") {
        response.destroy();
        finishReject(new PinnedFetchFailure("unsupported_encoding"));
        return;
      }
      const declaredLength = safeHeaders["content-length"];
      if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > (options.maxBytes ?? MAX_SOURCE_BYTES))) {
        response.destroy();
        finishReject(new PinnedFetchFailure("source_too_large"));
        return;
      }
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) || (response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
        response.destroy();
        settled = true;
        resolve({ status: response.statusCode ?? 502, headers: safeHeaders, body: new Uint8Array() });
        return;
      }
      void readBody(response, options.maxBytes ?? MAX_SOURCE_BYTES, options.signal).then((body) => {
        if (settled) return;
        settled = true;
        resolve({ status: response.statusCode ?? 502, headers: safeHeaders, body });
      }, finishReject);
    });
    req.once("error", finishReject);
    if (options.signal.aborted) {
      req.destroy();
      finishReject(new PinnedFetchFailure("timeout"));
    }
    req.end();
  });
}

export async function fetchPinnedSource(rawUrl: string, appOrigin?: string, signal?: AbortSignal): Promise<{
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}> {
  if (Buffer.byteLength(rawUrl, "utf8") > 8 * 1024) failure("invalid_url");
  let target: URL;
  try { target = validateSourceTarget(rawUrl, { APP_ORIGIN: appOrigin }); }
  catch (error) {
    if (error instanceof Error && "code" in error) failure((error as { code: FetchErrorCode }).code);
    failure("invalid_url");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MAX_HOP_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  try {
    const address = await resolvePublicAddress(target.hostname, controller.signal, { appOrigin });
    if (controller.signal.aborted) failure("timeout");
    return await pinnedRequest(target, address, { signal: controller.signal });
  } catch (error) {
    if (error instanceof PinnedFetchFailure) throw error;
    return failure(controller.signal.aborted ? "timeout" : "network_error");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}
