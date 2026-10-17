/** URL syntax policy shared by the app and the protected fetch adapter. */
export const RESTRICTED_HOST_SUFFIXES = [
  ".localhost", ".local", ".internal", ".lan", ".home", ".home.arpa",
  ".test", ".invalid", ".example", ".onion", ".arpa", ".svc", ".cluster.local",
] as const;

function isRestrictedIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  const [a, b, c, d] = parts.map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && c === 0) || (b === 0 && c === 2) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) || (a === 255 && b === 255 && c === 255 && d === 255);
}

export function validateArticleUrl(raw: string, appOrigin?: string): URL {
  let target: URL;
  try { target = new URL(raw); }
  catch { throw new Error("invalid_url"); }
  if (target.protocol !== "https:" && target.protocol !== "http:") throw new Error("unsafe_destination");
  if (target.username || target.password) throw new Error("unsafe_destination");
  if (target.port && target.port !== "80" && target.port !== "443") throw new Error("unsafe_destination");
  const host = target.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || !host.includes(".") || RESTRICTED_HOST_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))) {
    throw new Error("unsafe_destination");
  }
  // Any literal IP is left to the gateway's complete address classifier. The
  // app must never try to classify an address differently from the dialer.
  if (host.startsWith("[") || host.includes(":")) throw new Error("unsafe_destination");
  if (/^(?:0x[\da-f]+|\d+)$/i.test(host)) throw new Error("unsafe_destination");
  if (/^\d+(?:\.\d+){3}$/.test(host) && isRestrictedIpv4(host)) throw new Error("unsafe_destination");
  if (appOrigin) {
    try {
      if (new URL(appOrigin).hostname.toLowerCase().replace(/\.$/, "") === host) throw new Error("unsafe_destination");
    } catch (error) {
      if (error instanceof Error && error.message === "unsafe_destination") throw error;
    }
  }
  return target;
}
