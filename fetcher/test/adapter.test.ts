import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchViaContainer } from "../adapter.js";
import { MAX_SOURCE_BYTES, PROTOCOL_VERSION } from "../protocol.js";

function payload(body: Uint8Array, status = 200, headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" }) {
  return JSON.stringify({ version: PROTOCOL_VERSION, ok: true, status, headers, body: Buffer.from(body).toString("base64") });
}

const liveSignal = () => new AbortController().signal;

test("adapter POST is fixed, preserves original URL, and only forwards allowlisted headers", async () => {
  let internalRequest!: Request;
  const result = await fetchViaContainer("https://news.example.com/path?q=1", liveSignal(), async (request) => {
    internalRequest = request;
    return new Response(JSON.stringify({
      version: 1, ok: true, status: 200,
      headers: { "content-type": "text/html" },
      body: Buffer.from("<html></html>").toString("base64"),
    }), { headers: { "content-type": "application/json", "set-cookie": "container=secret" } });
  });
  assert.equal(internalRequest.url, "http://container.internal/v1/fetch");
  assert.equal(internalRequest.method, "POST");
  assert.deepEqual(await internalRequest.json(), { version: 1, url: "https://news.example.com/path?q=1" });
  assert.equal(result.status, 200);
  assert.equal(result.url, "");
  assert.equal(result.headers.get("set-cookie"), null);
  assert.equal(result.headers.get("x-upstream"), null);
  assert.equal(await result.text(), "<html></html>");
});

test("adapter preserves stable typed errors and rejects malformed protocol", async () => {
  const unsafe = await fetchViaContainer("https://news.example.com/", liveSignal(), async () =>
    new Response(JSON.stringify({ version: 1, ok: false, error: "unsafe_destination" })));
  assert.equal(unsafe.headers.get("x-safe-fetch-error"), "unsafe_destination");
  const malformed = await fetchViaContainer("https://news.example.com/", liveSignal(), async () => new Response("{}"));
  assert.equal(malformed.headers.get("x-safe-fetch-error"), "network_error");
  const badHeader = await fetchViaContainer("https://news.example.com/", liveSignal(), async () =>
    new Response(JSON.stringify({ version: 1, ok: true, status: 200, headers: { "set-cookie": "x" }, body: "" })));
  assert.equal(badHeader.headers.get("x-safe-fetch-error"), "network_error");
});

test("adapter round-trips the full 512 KiB limit and handles bodyless statuses", async () => {
  const sourceBytes = new Uint8Array(MAX_SOURCE_BYTES).fill(0x5a);
  const response = await fetchViaContainer("https://news.example.com/", liveSignal(), async () => new Response(payload(sourceBytes)));
  assert.equal((await response.arrayBuffer()).byteLength, MAX_SOURCE_BYTES);
  const noContent = await fetchViaContainer("https://news.example.com/", liveSignal(), async () => new Response(payload(new Uint8Array(), 204)));
  assert.equal(noContent.status, 204);
  assert.equal(await noContent.text(), "");
});

test("adapter cancels oversized gateway responses and deadlines hanging bindings", async () => {
  let canceled = false;
  const oversized = await fetchViaContainer("https://news.example.com/", liveSignal(), async () => new Response(new ReadableStream({
    cancel() { canceled = true; },
  }), { headers: { "content-length": "800000" } }));
  assert.equal(oversized.headers.get("x-safe-fetch-error"), "network_error");
  assert.equal(canceled, true);

  const started = Date.now();
  const timeout = await fetchViaContainer("https://news.example.com/", liveSignal(), async () => new Promise<Response>(() => undefined));
  assert.equal(timeout.headers.get("x-safe-fetch-error"), "timeout");
  assert.ok(Date.now() - started < 5_500);
});

test("adapter cancellation reaches internal request and cancels a late response body", async () => {
  const controller = new AbortController();
  let internalSignal!: AbortSignal;
  let canceled = false;
  const pending = fetchViaContainer("https://news.example.com/", controller.signal, async (request) => {
    internalSignal = request.signal;
    return new Promise<Response>((resolve) => {
      setTimeout(() => resolve(new Response(new ReadableStream({ cancel() { canceled = true; } }))), 30);
    });
  });
  controller.abort();
  const response = await pending;
  assert.equal(response.headers.get("x-safe-fetch-error"), "timeout");
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
  assert.equal(response.headers.get("x-safe-fetch-error"), "timeout");
});
