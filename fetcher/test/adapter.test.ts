import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchViaContainer } from "../adapter.js";
import {
  FETCH_FAILURE_HEADER,
  FETCH_PROTOCOL_HEADER,
  MAX_SOURCE_BYTES,
  PROTOCOL_VERSION,
} from "../protocol.js";

const liveSignal = () => new AbortController().signal;
function rawResponse(body: Uint8Array, status = 200, headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" }) {
  const copy = new Uint8Array(body.byteLength);
  copy.set(body);
  const responseHeaders = {
    [FETCH_PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    ...(status === 204 ? {} : { "content-length": String(body.byteLength) }),
    ...headers,
  };
  return new Response(bodyless(status) ? null : copy.buffer, {
    status,
    headers: responseHeaders,
  });
}
function bodyless(status: number): boolean { return [204, 205, 304].includes(status); }

test("adapter POST is fixed, preserves original URL, and only forwards allowlisted raw response headers", async () => {
  let internalRequest!: Request;
  const bytes = new TextEncoder().encode("<html>ok</html>");
  const result = await fetchViaContainer("https://news.example.com/path?q=1", liveSignal(), async (request) => {
    internalRequest = request;
    return rawResponse(bytes, 200, {
      "content-type": "text/html",
      "set-cookie": "container=secret",
      "x-upstream": "must-not-forward",
    });
  });
  assert.equal(internalRequest.url, "http://container.internal/v1/fetch");
  assert.equal(internalRequest.method, "POST");
  assert.deepEqual(await internalRequest.json(), { version: 2, url: "https://news.example.com/path?q=1" });
  assert.equal(internalRequest.headers.get("content-type"), "application/json");
  assert.equal(result.status, 200);
  assert.equal(result.url, "");
  assert.equal(result.headers.get("content-length"), String(bytes.byteLength));
  assert.equal(result.headers.get("set-cookie"), null);
  assert.equal(result.headers.get("x-upstream"), null);
  assert.equal(new TextDecoder().decode(await result.arrayBuffer()), "<html>ok</html>");
});

test("adapter requires protocol v2 and preserves only valid trusted typed errors", async () => {
  const mismatch = await fetchViaContainer("https://news.example.com/", liveSignal(), async () =>
    new Response("stale envelope", { headers: { [FETCH_PROTOCOL_HEADER]: "1" } }));
  assert.equal(mismatch.headers.get(FETCH_FAILURE_HEADER), "network_error");

  const unsafe = await fetchViaContainer("https://news.example.com/", liveSignal(), async () =>
    new Response(null, { status: 502, headers: { [FETCH_PROTOCOL_HEADER]: "2", [FETCH_FAILURE_HEADER]: "unsafe_destination" } }));
  assert.equal(unsafe.headers.get(FETCH_FAILURE_HEADER), "unsafe_destination");

  const malformedError = await fetchViaContainer("https://news.example.com/", liveSignal(), async () =>
    new Response(null, { status: 502, headers: { [FETCH_PROTOCOL_HEADER]: "2", [FETCH_FAILURE_HEADER]: "spoofed" } }));
  assert.equal(malformedError.headers.get(FETCH_FAILURE_HEADER), "network_error");

  const malformedLength = await fetchViaContainer("https://news.example.com/", liveSignal(), async () =>
    new Response("{}", { headers: { [FETCH_PROTOCOL_HEADER]: "2", "content-length": "2x" } }));
  assert.equal(malformedLength.headers.get(FETCH_FAILURE_HEADER), "network_error");
});

test("adapter round-trips the exact 2 MiB raw limit and handles bodyless and redirect statuses", async () => {
  const sourceBytes = new Uint8Array(MAX_SOURCE_BYTES).fill(0x5a);
  const response = await fetchViaContainer("https://news.example.com/", liveSignal(), async () => rawResponse(sourceBytes));
  assert.equal((await response.arrayBuffer()).byteLength, MAX_SOURCE_BYTES);

  for (const status of [204, 205, 304]) {
    const result = await fetchViaContainer("https://news.example.com/", liveSignal(), async () => rawResponse(new Uint8Array(), status));
    assert.equal(result.status, status);
    assert.equal(await result.text(), "");
    if (status === 204) assert.equal(result.headers.get("content-length"), null);
    else assert.equal(result.headers.get("content-length"), "0");
  }
  const redirect = await fetchViaContainer("https://news.example.com/", liveSignal(), async () => rawResponse(new Uint8Array(), 302, { location: "https://other.example.com/" }));
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), "https://other.example.com/");
  assert.equal(await redirect.text(), "");
  const notFound = await fetchViaContainer("https://news.example.com/", liveSignal(), async () => rawResponse(new Uint8Array(), 404));
  assert.equal(notFound.status, 404);
  assert.equal(await notFound.text(), "");
});

test("adapter accepts missing length only for an empty bodyless response", async () => {
  const bodyless = await fetchViaContainer("https://news.example.com/", liveSignal(), async () =>
    new Response(null, { status: 204, headers: { [FETCH_PROTOCOL_HEADER]: "2" } }));
  assert.equal(bodyless.status, 204);
  assert.equal(bodyless.headers.get("content-length"), null);

  const invalidLength = await fetchViaContainer("https://news.example.com/", liveSignal(), async () =>
    new Response(null, { status: 204, headers: { [FETCH_PROTOCOL_HEADER]: "2", "content-length": "1" } }));
  assert.equal(invalidLength.headers.get(FETCH_FAILURE_HEADER), "network_error");

  const missingBodyLength = await fetchViaContainer("https://news.example.com/", liveSignal(), async () =>
    new Response("body", { headers: { [FETCH_PROTOCOL_HEADER]: "2" } }));
  assert.equal(missingBodyLength.headers.get(FETCH_FAILURE_HEADER), "network_error");
});

test("adapter cancels oversized gateway responses and deadlines hanging bindings", async () => {
  let canceled = false;
  const oversized = await fetchViaContainer("https://news.example.com/", liveSignal(), async () => new Response(new ReadableStream({
    cancel() { canceled = true; },
  }), { headers: { [FETCH_PROTOCOL_HEADER]: "2", "content-length": String(MAX_SOURCE_BYTES + 1) } }));
  assert.equal(oversized.headers.get(FETCH_FAILURE_HEADER), "network_error");
  assert.equal(canceled, true);

  const started = Date.now();
  const timeout = await fetchViaContainer("https://news.example.com/", liveSignal(), async () => new Promise<Response>(() => undefined));
  assert.equal(timeout.headers.get(FETCH_FAILURE_HEADER), "timeout");
  assert.ok(Date.now() - started < 5_500);
});

test("adapter cancellation reaches internal request and cancels a late response body", async () => {
  const controller = new AbortController();
  let internalSignal!: AbortSignal;
  let canceled = false;
  const pending = fetchViaContainer("https://news.example.com/", controller.signal, async (request) => {
    internalSignal = request.signal;
    return new Promise<Response>((resolve) => {
      setTimeout(() => resolve(new Response(new ReadableStream({ cancel() { canceled = true; } }), {
        headers: { [FETCH_PROTOCOL_HEADER]: "2", "content-length": "0" },
      })), 30);
    });
  });
  controller.abort();
  const response = await pending;
  assert.equal(response.headers.get(FETCH_FAILURE_HEADER), "timeout");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(internalSignal.aborted, true);
  assert.equal(canceled, true);
});

test("already-aborted callers never invoke the container binding", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const response = await fetchViaContainer("https://news.example.com/", controller.signal, async () => {
    called = true;
    throw new Error("must not dispatch");
  });
  assert.equal(called, false);
  assert.equal(response.headers.get(FETCH_FAILURE_HEADER), "timeout");
});
