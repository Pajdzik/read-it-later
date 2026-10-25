import {
  FETCH_FAILURE_HEADER,
  FETCH_PROTOCOL_HEADER,
  MAX_MESSAGE_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_SOURCE_BYTES,
  MAX_TARGET_BYTES,
  PROTOCOL_VERSION,
  isFetchErrorCode,
  type FetchRequestMessage,
} from "./protocol.js";
import { SOURCE_HOP_TIMEOUT_MS } from "../src/articles/capture-limits.js";

const errorResponse = (code = "network_error") => new Response(null, { status: 502, headers: { [FETCH_FAILURE_HEADER]: code } });
const ALLOWED_RESPONSE_HEADERS = ["content-type", "location", "retry-after"] as const;

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

async function readLimited(response: Response, signal: AbortSignal, bodyless: boolean): Promise<Uint8Array<ArrayBuffer>> {
  const declared = response.headers.get("content-length");
  if (declared === null && bodyless && response.body === null) return new Uint8Array();
  if (declared === null || !/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES || (bodyless && Number(declared) !== 0)) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("invalid_or_oversized_gateway_length");
  }
  if (!response.body) {
    if (Number(declared) !== 0) throw new Error("gateway_length_mismatch");
    return new Uint8Array();
  }
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
    if (length !== Number(declared)) throw new Error("gateway_length_mismatch");
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
  const deadline = setTimeout(() => controller.abort(), SOURCE_HOP_TIMEOUT_MS);
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

    // The internal version header is mandatory so mixed old/new deployments fail closed.
    if (response.headers.get(FETCH_PROTOCOL_HEADER) !== String(PROTOCOL_VERSION)) {
      void response.body?.cancel().catch(() => undefined);
      return errorResponse();
    }
    const failure = response.headers.get(FETCH_FAILURE_HEADER);
    if (failure !== null) {
      void response.body?.cancel().catch(() => undefined);
      return errorResponse(isFetchErrorCode(failure) ? failure : "network_error");
    }
    if (response.status < 200 || response.status > 599) {
      void response.body?.cancel().catch(() => undefined);
      return errorResponse();
    }

    const bodyless = [204, 205, 304].includes(response.status);
    const redirectOrFailure = response.status < 200 || response.status >= 300;
    const bytes = await readLimited(response, controller.signal, bodyless);
    if (bytes.byteLength > MAX_SOURCE_BYTES) return errorResponse("source_too_large");
    if ((bodyless || redirectOrFailure) && bytes.byteLength !== 0) return errorResponse();
    const headers = new Headers();
    for (const name of ALLOWED_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    // Always publish the bytes actually received, never trust a supplied upstream length.
    if (response.status !== 204) headers.set("content-length", String(bytes.byteLength));
    const responseBody = !bodyless && bytes.byteLength > 0 ? bytes.buffer : null;
    // The private container URL does not become Response.url.
    return new Response(responseBody, { status: response.status, headers });
  } catch {
    return errorResponse(controller.signal.aborted ? "timeout" : "network_error");
  } finally {
    clearTimeout(deadline);
    requestSignal.removeEventListener("abort", onAbort);
  }
}
