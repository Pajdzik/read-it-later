export const PROBE_OUTCOMES = [
  "tls_connected",
  "tls_rejected",
  "option_rejected",
  "timeout",
  "connection_error",
] as const;

export type ProbeOutcome = (typeof PROBE_OUTCOMES)[number];

export function isProbeEnabled(expiresAtValue: string | undefined, now = Date.now()): boolean {
  if (!expiresAtValue?.trim()) return false;
  const expiresAt = Number(expiresAtValue);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

export function isProbeRequest(request: Request): boolean {
  const url = new URL(request.url);
  return request.method === "GET" && url.pathname === "/probe" && !url.search;
}

export function classifyTlsError(message: string): ProbeOutcome {
  if (message.includes("expectedServerHostname") && message.includes("not currently supported")) {
    return "option_rejected";
  }
  if (message.includes("certificate") || message.includes("Certificate") || message.includes("TLS")) {
    return "tls_rejected";
  }
  if (message.includes("probe_timeout")) return "timeout";
  return "connection_error";
}

export function classifyConnectionError(message: string): ProbeOutcome {
  return message.includes("probe_timeout") ? "timeout" : "connection_error";
}
