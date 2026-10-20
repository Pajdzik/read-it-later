import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { createFetchServer } from "../server.js";

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
    body: JSON.stringify({ version: 1, url: "https://127.0.0.1/latest/meta-data" }),
  });
  assert.equal(rejected.status, 200);
  assert.deepEqual(await rejected.json(), { version: 1, ok: false, error: "unsafe_destination" });

  const wrongRoute = await fetch(`${baseUrl}/anything`);
  assert.equal(wrongRoute.status, 404);
});
