import ipaddr from "ipaddr.js";

export class SourceFetchError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = "SourceFetchError";
  }
}

export function failSourceFetch(code: string, retryable = false, retryAfterSeconds?: number): never {
  throw new SourceFetchError(code, retryable, retryAfterSeconds);
}

function isPublicIpv4Literal(host: string): boolean {
  try {
    const address = ipaddr.parse(host);
    return address.kind() === "ipv4" && address.range() === "unicast";
  } catch { return false; }
}

const RESTRICTED_SUFFIXES = [
  ".localhost", ".local", ".internal", ".lan", ".home", ".home.arpa",
  ".test", ".invalid", ".example", ".onion", ".arpa", ".svc", ".cluster.local",
];

export function validateSourceTarget(raw: string, env: { APP_ORIGIN?: string } = {}): URL {
  let target: URL;
  try { target = new URL(raw); } catch { return failSourceFetch("invalid_url"); }
  if (target.protocol !== "https:" && target.protocol !== "http:") failSourceFetch("unsafe_destination");
  if (target.username || target.password) failSourceFetch("unsafe_destination");
  if (target.port && target.port !== "80" && target.port !== "443") failSourceFetch("unsafe_destination");

  const host = target.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || !host.includes(".") || RESTRICTED_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))) {
    failSourceFetch("unsafe_destination");
  }
  // URL canonicalizes unusual IPv4 spellings before exposing hostname. IPv6 URL literals
  // remain deliberately rejected; resolved IPv6 destinations are checked by the gateway.
  if (host.startsWith("[") || host.includes(":")) failSourceFetch("unsafe_destination");
  if (/^\d+(?:\.\d+){3}$/.test(host) && !isPublicIpv4Literal(host)) failSourceFetch("unsafe_destination");
  if (/^(?:0x[\da-f]+|\d+)$/i.test(host)) failSourceFetch("unsafe_destination");

  if (env.APP_ORIGIN) {
    try {
      if (new URL(env.APP_ORIGIN).hostname.toLowerCase().replace(/\.$/, "") === host) failSourceFetch("unsafe_destination");
    } catch (error) {
      if (error instanceof SourceFetchError) throw error;
    }
  }
  return target;
}
