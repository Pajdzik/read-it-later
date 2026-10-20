import { connect } from "cloudflare:sockets";
import { classifyConnectionError, classifyTlsError, isProbeEnabled, isProbeRequest, type ProbeOutcome } from "./guard";

// Fixed destinations only. This probe accepts no URL, host, or IP from a
// request, query string, header, or environment binding.
const GITHUB_IP = "20.29.134.23";
const GITHUB_HOST = "github.com";
const MISMATCH_HOST = "invalid.example";
const MAX_HEADER_BYTES = 8_192;
const TLS_TIMEOUT_MS = 8_000;
type ProbeResult = {
  outcome: ProbeOutcome | `http_status_${string}` | "tls_http_response" | "identity_mismatch_accepted" | "malformed_or_empty_response" | "header_too_large";
};

async function withTimeout<T>(promise: Promise<T>, ms = 8_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("probe_timeout")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function monitorSocket(socket: ReturnType<typeof connect>): void {
  // Some socket failures reject `closed` independently of an outstanding read.
  // Attach a rejection handler as soon as each socket is created or upgraded.
  void socket.closed.catch(() => undefined);
}

async function readStatusLine(socket: ReturnType<typeof connect>, deadline: number): Promise<string | undefined> {
  const timed = <T>(promise: Promise<T>) => withTimeout(promise, Math.max(0, deadline - Date.now()));
  const writer = socket.writable.getWriter();
  try {
    await timed(writer.write(new TextEncoder().encode(
      "GET / HTTP/1.1\r\nHost: github.com\r\nConnection: close\r\n\r\n",
    )));
  } finally {
    writer.releaseLock();
  }

  const reader = socket.readable.getReader();
  const decoder = new TextDecoder();
  let header = "";
  let headerBytes = 0;
  let reachedEof = false;
  try {
    while (!header.includes("\r\n\r\n") && headerBytes < MAX_HEADER_BYTES) {
      const { done, value } = await timed(reader.read());
      if (done) {
        reachedEof = true;
        break;
      }
      const remaining = MAX_HEADER_BYTES - headerBytes;
      const boundedChunk = value.subarray(0, remaining);
      headerBytes += boundedChunk.byteLength;
      header += decoder.decode(boundedChunk, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (!header.includes("\r\n\r\n")) {
    if (!reachedEof && headerBytes >= MAX_HEADER_BYTES) throw new Error("header_too_large");
    throw new Error("malformed_or_empty_response");
  }
  return /^HTTP\/\d(?:\.\d)? (\d{3})\b/.exec(header)?.[1];
}

async function tlsProbe(expectedServerHostname?: string): Promise<ProbeResult> {
  let socket: ReturnType<typeof connect> | undefined;
  const deadline = Date.now() + TLS_TIMEOUT_MS;
  const timed = <T>(promise: Promise<T>) => withTimeout(promise, Math.max(0, deadline - Date.now()));
  try {
    socket = connect({ hostname: GITHUB_IP, port: 443 }, { secureTransport: "starttls", allowHalfOpen: false });
    monitorSocket(socket);
    socket = socket.startTls(expectedServerHostname ? { expectedServerHostname } : {});
    monitorSocket(socket);
    await timed(socket.opened);
    const status = await readStatusLine(socket, deadline);
    if (!status) return { outcome: "malformed_or_empty_response" };
    if (expectedServerHostname === MISMATCH_HOST) return { outcome: "identity_mismatch_accepted" };
    return { outcome: `http_status_${status}` };
  } catch (error) {
    if (error instanceof Error && error.message === "malformed_or_empty_response") {
      return { outcome: "malformed_or_empty_response" };
    }
    if (error instanceof Error && error.message === "header_too_large") return { outcome: "header_too_large" };
    const message = error instanceof Error ? error.message : "unknown_error";
    return { outcome: classifyTlsError(message) };
  } finally {
    await socket?.close().catch(() => undefined);
  }
}

async function hostnameTlsControl(): Promise<ProbeResult> {
  let socket: ReturnType<typeof connect> | undefined;
  try {
    socket = connect({ hostname: GITHUB_HOST, port: 443 }, { secureTransport: "on", allowHalfOpen: false });
    monitorSocket(socket);
    const deadline = Date.now() + TLS_TIMEOUT_MS;
    const timed = <T>(promise: Promise<T>) => withTimeout(promise, Math.max(0, deadline - Date.now()));
    await timed(socket.opened);
    const status = await readStatusLine(socket, deadline);
    return { outcome: status ? "tls_http_response" : "malformed_or_empty_response" };
  } catch (error) {
    if (error instanceof Error && error.message === "malformed_or_empty_response") {
      return { outcome: "malformed_or_empty_response" };
    }
    if (error instanceof Error && error.message === "header_too_large") return { outcome: "header_too_large" };
    const message = error instanceof Error ? error.message : "unknown_error";
    return { outcome: classifyTlsError(message) };
  } finally {
    await socket?.close().catch(() => undefined);
  }
}

async function http80Control(): Promise<ProbeResult> {
  let socket: ReturnType<typeof connect> | undefined;
  try {
    const deadline = Date.now() + 8_000;
    const timed = <T>(promise: Promise<T>) => withTimeout(promise, Math.max(0, deadline - Date.now()));
    socket = connect({ hostname: GITHUB_IP, port: 80 }, { allowHalfOpen: false });
    monitorSocket(socket);
    await timed(socket.opened);
    const status = await readStatusLine(socket, deadline);
    return { outcome: status ? `http_status_${status}` : "malformed_or_empty_response" };
  } catch (error) {
    if (error instanceof Error && error.message === "malformed_or_empty_response") {
      return { outcome: "malformed_or_empty_response" };
    }
    if (error instanceof Error && error.message === "header_too_large") return { outcome: "header_too_large" };
    const message = error instanceof Error ? error.message : "unknown_error";
    return { outcome: classifyConnectionError(message) };
  } finally {
    await socket?.close().catch(() => undefined);
  }
}

export default {
  async fetch(request: Request, env: { BENCHMARK_EXPIRES_AT?: string }): Promise<Response> {
    if (!isProbeRequest(request)) {
      return new Response("not found", { status: 404 });
    }
    if (!isProbeEnabled(env.BENCHMARK_EXPIRES_AT)) {
      return new Response("probe expired or disabled", { status: 410, headers: { "Cache-Control": "no-store" } });
    }

    const outcomes = {
      tls_ip_expected_github: await tlsProbe(GITHUB_HOST),
      tls_ip_expected_mismatch: await tlsProbe(MISMATCH_HOST),
      tls_hostname_control: await hostnameTlsControl(),
      http_ip_port80_control: await http80Control(),
    };
    return Response.json(outcomes, {
      headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
    });
  },
};
