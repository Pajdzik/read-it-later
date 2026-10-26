import { lookup } from "node:dns/promises";
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { checkServerIdentity } from "node:tls";
import { Readable } from "node:stream";
import ipaddr from "ipaddr.js";
import { SourceFetchError } from "../src/articles/capture-protocol";
import { validateTarget } from "../src/articles/source-fetch";

export type Address = { address: string; family: number };
export type ResolveAddresses = (hostname: string) => Promise<Address[]>;

export function isPublicAddress(raw: string): boolean {
  if (raw.includes("%") || !ipaddr.isValid(raw)) return false;
  const address = ipaddr.parse(raw);
  if (address.range() !== "unicast") return false;
  // Restrict IPv6 to allocated global unicast, excluding transition/special ranges above.
  return address.kind() === "ipv4" || address.match(ipaddr.parseCIDR("2000::/3"));
}

export async function resolvePublicAddress(hostname: string, resolve: ResolveAddresses = host => lookup(host, { all: true, verbatim: true })): Promise<Address> {
  let addresses: Address[];
  try { addresses = await resolve(hostname); }
  catch { throw new SourceFetchError("network_error", true); }
  if (!addresses.length || addresses.some(({ address, family }) =>
    !isPublicAddress(address) || (family !== 4 && family !== 6) ||
    (ipaddr.parse(address).kind() === "ipv4" ? 4 : 6) !== family)) {
    throw new SourceFetchError("unsafe_destination", false);
  }
  // Prefer IPv4, but never resolve again at connect time or reuse an unrelated socket.
  return addresses.find(address => address.family === 4) ?? addresses[0];
}

export function pinnedRequestOptions(target: URL, address: Address, signal?: AbortSignal | null): RequestOptions & { servername: string; rejectUnauthorized: true; checkServerIdentity: typeof checkServerIdentity } {
  return {
    protocol: target.protocol, hostname: address.address, family: address.family,
    port: target.port || (target.protocol === "https:" ? 443 : 80),
    method: "GET", path: target.pathname + target.search, agent: false,
    // The TCP destination is numeric; Host, SNI and certificate identity remain the original hostname.
    servername: target.hostname, rejectUnauthorized: true,
    checkServerIdentity: (_hostname, certificate) => checkServerIdentity(target.hostname, certificate),
    headers: { Host: target.host, Accept: "text/html,application/xhtml+xml;q=0.9", "User-Agent": "PotemReader/1.0", "Accept-Encoding": "identity" },
    signal: signal ?? undefined, maxHeaderSize: 16 * 1024,
  };
}

/** Native Linux Node HTTP client. Never replace with Workers node:https or hostname fetch(). */
export async function pinnedFetch(input: string, init: RequestInit, appOrigin?: string, resolve?: ResolveAddresses): Promise<Response> {
  const target = validateTarget(input, { APP_ORIGIN: appOrigin });
  const address = await resolvePublicAddress(target.hostname, resolve);
  init.signal?.throwIfAborted();
  const options = pinnedRequestOptions(target, address, init.signal);
  return new Promise((resolveResponse, reject) => {
    const request = (target.protocol === "https:" ? httpsRequest : httpRequest)(options, upstream => {
      try {
        // No transparent decompression: bound the source exactly and reject unexpected encodings.
        if (upstream.headers["content-encoding"] && upstream.headers["content-encoding"] !== "identity") {
          throw new SourceFetchError("unsupported_encoding", false);
        }
        const headers = new Headers();
        for (const name of ["content-type", "content-length", "location", "retry-after"]) {
          const value = upstream.headers[name];
          if (typeof value === "string") headers.set(name, value);
        }
        const status = upstream.statusCode ?? 502;
        // Node accepts three-digit statuses that the Web Response constructor rejects.
        if (status < 200 || status > 599) throw new SourceFetchError("upstream_http", true);
        if ([204, 205, 304].includes(status)) {
          upstream.destroy();
          resolveResponse(new Response(null, { status, headers }));
        } else {
          // Cancelling the Web stream destroys the Node stream and its non-pooled socket.
          resolveResponse(new Response(Readable.toWeb(upstream) as ReadableStream<Uint8Array>, { status, headers }));
        }
      } catch (error) {
        upstream.destroy();
        reject(error instanceof SourceFetchError ? error : new SourceFetchError("network_error", true));
      }
    });
    request.on("error", () => reject(new SourceFetchError(init.signal?.aborted ? "timeout" : "network_error", true)));
    request.end();
  });
}
