import {
  FETCH_FAILURE_HEADER,
  MAX_MESSAGE_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_SOURCE_BYTES,
  MAX_TARGET_BYTES,
  PROTOCOL_VERSION,
  isFetchErrorCode,
  type FetchRequestMessage,
  type FetchResponseMessage,
} from "./protocol.js";

const errorResponse = (code = "network_error") => new Response(null, { status: 502, headers: { [FETCH_FAILURE_HEADER]: code } });

function validateFetchResponse(value: unknown): value is FetchResponseMessage {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.version !== PROTOCOL_VERSION || typeof record.ok !== "boolean") return false;
  if (!record.ok) return isFetchErrorCode(record.error);
  if (!Number.isInteger(record.status) || (record.status as number) < 200 || (record.status as number) > 599) return false;
  if (!record.headers || typeof record.headers !== "object" || Array.isArray(record.headers)) return false;
  const headers = record.headers as Record<string, unknown>;
  if (Object.keys(headers).some((key) => !["content-type", "content-length", "location", "retry-after", "content-encoding"].includes(key) || typeof headers[key] !== "string")) return false;
  if (typeof record.body !== "string" || record.body.length > Math.ceil(MAX_SOURCE_BYTES / 3) * 4 || record.body.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(record.body)) return false;
  try { atob(record.body); return true; } catch { return false; }
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("aborted");
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

async function readLimited(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("oversized_gateway_response");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new Error("oversized_gateway_response");
      }
      parts.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally { signal.removeEventListener("abort", onAbort); reader.releaseLock(); }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
  return out;
}

/** Adapt the original GET Fetcher seam to a fixed internal container POST. */
export async function fetchViaContainer(
  target: string,
  requestSignal: AbortSignal,
  fetchContainer: (request: Request) => Promise<Response>,
): Promise<Response> {
  if (new TextEncoder().encode(target).byteLength > MAX_TARGET_BYTES) return errorResponse("invalid_url");
  if (requestSignal.aborted) return errorResponse("timeout");
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 5_000);
  const onAbort = () => controller.abort();
  requestSignal.addEventListener("abort", onAbort, { once: true });
  let containerPromise: Promise<Response> | undefined;
  try {
    const message: FetchRequestMessage = { version: PROTOCOL_VERSION, url: target };
    const json = JSON.stringify(message);
    const encoded = new TextEncoder().encode(json);
    if (encoded.byteLength > MAX_MESSAGE_BYTES) return errorResponse("invalid_url");
    containerPromise = fetchContainer(new Request("http://container.internal/v1/fetch", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(encoded.byteLength) },
      body: json,
      signal: controller.signal,
    }));
    void containerPromise.then((lateResponse) => {
      if (controller.signal.aborted) void lateResponse.body?.cancel().catch(() => undefined);
    }).catch(() => undefined);
    const response = await abortable(containerPromise, controller.signal);
    if (!response.ok || response.status !== 200) {
      void response.body?.cancel().catch(() => undefined);
      return errorResponse();
    }
    const bytes = await readLimited(response, controller.signal);
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { return errorResponse(); }
    if (!validateFetchResponse(parsed)) return errorResponse();
    if (!parsed.ok) return errorResponse(parsed.error);
    let rawBody: string;
    try { rawBody = atob(parsed.body); } catch { return errorResponse(); }
    const body = Uint8Array.from(rawBody, (character) => character.charCodeAt(0));
    if (body.byteLength > MAX_SOURCE_BYTES) return errorResponse("source_too_large");
    const headers = new Headers();
    for (const name of ["content-type", "content-length", "location", "retry-after", "content-encoding"]) {
      const value = parsed.headers[name];
      if (typeof value === "string") headers.set(name, value);
    }
    const responseBody = [204, 205, 304].includes(parsed.status) ? null : body.byteLength ? body : null;
    // The private container URL does not become Response.url.
    return new Response(responseBody, { status: parsed.status, headers });
  } catch {
    return errorResponse(controller.signal.aborted ? "timeout" : "network_error");
  } finally {
    clearTimeout(deadline);
    requestSignal.removeEventListener("abort", onAbort);
  }
}
