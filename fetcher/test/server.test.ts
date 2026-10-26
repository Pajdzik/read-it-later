import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { request as httpRequest, type Server } from "node:http";
import { createFetchServer } from "../server.js";
import { FETCH_FAILURE_HEADER, FETCH_PROTOCOL_HEADER, MAX_SOURCE_BYTES } from "../protocol.js";

let server: Server;
let baseUrl: string;

before(async () => {
  server = createFetchServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("container server exposes health only and rejects private targets before network access", async () => {
  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), "ok");

  const rejected = await fetch(`${baseUrl}/v1/fetch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: 2, url: "https://127.0.0.1/latest/meta-data" }),
  });
  assert.equal(rejected.status, 502);
  assert.equal(rejected.headers.get(FETCH_PROTOCOL_HEADER), "2");
  assert.equal(rejected.headers.get(FETCH_FAILURE_HEADER), "unsafe_destination");
  assert.equal(await rejected.text(), "");

  const wrongRoute = await fetch(`${baseUrl}/anything`);
  assert.equal(wrongRoute.status, 404);
});

test("container server returns raw bodies, normalizes content length, and strips internal or upstream headers", async () => {
  const source = new Uint8Array(MAX_SOURCE_BYTES).fill(0x41);
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  server = createFetchServer(async () => ({
    status: 200,
    headers: {
      "content-type": "text/html",
      "content-length": "999999999",
      [FETCH_PROTOCOL_HEADER]: "spoofed",
      [FETCH_FAILURE_HEADER]: "unsafe_destination",
      "set-cookie": "secret=1",
    },
    body: source,
  }));
  await new Promise<void>((resolve) => server.listen(Number(new URL(baseUrl).port), "127.0.0.1", resolve));
  const response = await fetch(`${baseUrl}/v1/fetch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: 2, url: "https://news.example.com/" }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get(FETCH_PROTOCOL_HEADER), "2");
  assert.equal(response.headers.get(FETCH_FAILURE_HEADER), null);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("content-length"), String(MAX_SOURCE_BYTES));
  assert.equal((await response.arrayBuffer()).byteLength, MAX_SOURCE_BYTES);
});

test("server discards redirect and HTTP failure bodies while retaining status and safe headers", async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  server = createFetchServer(async (url) => ({
    status: url.includes("redirect") ? 302 : 404,
    headers: { location: "https://other.example.com/", "content-type": "text/plain" },
    body: new TextEncoder().encode("discard this upstream body"),
  }));
  await new Promise<void>((resolve) => server.listen(Number(new URL(baseUrl).port), "127.0.0.1", resolve));
  for (const [path, expectedStatus] of [["redirect", 302], ["missing", 404]] as const) {
    const response = await fetch(`${baseUrl}/v1/fetch`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 2, url: `https://news.example.com/${path}` }),
    });
    assert.equal(response.status, expectedStatus);
    assert.equal(response.headers.get(FETCH_PROTOCOL_HEADER), "2");
    assert.equal(response.headers.get("content-length"), "0");
    assert.equal(await response.text(), "");
    if (expectedStatus === 302) assert.equal(response.headers.get("location"), "https://other.example.com/");
  }
});

test("server handles bodyless statuses and fails closed on malformed requests", async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  server = createFetchServer(async (url) => ({
    status: url.includes("no-content") ? 204 : url.includes("reset-content") ? 205 : 304,
    headers: {},
    body: new Uint8Array(),
  }));
  await new Promise<void>((resolve) => server.listen(Number(new URL(baseUrl).port), "127.0.0.1", resolve));
  for (const [path, expectedStatus] of [["no-content", 204], ["reset-content", 205], ["not-modified", 304]] as const) {
    const response = await fetch(`${baseUrl}/v1/fetch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 2, url: `https://news.example.com/${path}` }),
    });
    assert.equal(response.status, expectedStatus);
    assert.equal(response.headers.get(FETCH_PROTOCOL_HEADER), "2");
    assert.equal(response.headers.get("content-length"), expectedStatus === 204 ? null : "0");
    assert.equal(await response.text(), "");
  }
  const malformed = await fetch(`${baseUrl}/v1/fetch`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{bad",
  });
  assert.equal(malformed.headers.get(FETCH_PROTOCOL_HEADER), "2");
  assert.equal(malformed.headers.get(FETCH_FAILURE_HEADER), "invalid_url");
  const oldVersion = await fetch(`${baseUrl}/v1/fetch`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: 1, url: "https://news.example.com/" }),
  });
  assert.equal(oldVersion.headers.get(FETCH_FAILURE_HEADER), "invalid_url");
});

test("server classifies a partial request body deadline as timeout", async () => {
  const shortServer = createFetchServer(undefined, { requestTimeoutMs: 40 });
  await new Promise<void>((resolve) => shortServer.listen(0, "127.0.0.1", resolve));
  const address = shortServer.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  try {
    const received = await new Promise<{ status: number; protocol: string | undefined; failure: string | undefined; body: string }>((resolve, reject) => {
      const request = httpRequest({
        host: "127.0.0.1",
        port: address.port,
        path: "/v1/fetch",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "100" },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => resolve({
          status: response.statusCode ?? 0,
          protocol: response.headers[FETCH_PROTOCOL_HEADER] as string | undefined,
          failure: response.headers[FETCH_FAILURE_HEADER] as string | undefined,
          body: Buffer.concat(chunks).toString(),
        }));
      });
      request.once("error", reject);
      request.write('{"version":2,');
    });
    assert.deepEqual(received, { status: 502, protocol: "2", failure: "timeout", body: "" });
  } finally {
    shortServer.closeAllConnections?.();
    await new Promise<void>((resolve) => shortServer.close(() => resolve()));
  }
});
