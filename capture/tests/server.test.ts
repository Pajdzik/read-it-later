import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createCaptureServer } from "../server";
import type { executeCapture } from "../executor";

async function withServer(run: (origin: string) => Promise<void>, execute?: typeof executeCapture) {
  const server = createCaptureServer("https://read.example.com", execute);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

const post = (origin: string, body: unknown) => fetch(origin + "/capture", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

test("actual HTTP executor rejects private/self URLs with safe protocol failures", async () => {
  await withServer(async origin => {
    assert.equal((await fetch(origin + "/capture")).status, 404);
    for (const url of ["http://127.0.0.1/", "http://169.254.169.254/metadata", "https://read.example.com/api"]) {
      const response = await post(origin, { url });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { version: 1, ok: false, error: { code: "unsafe_destination", retryable: false } });
    }
    assert.deepEqual(await (await post(origin, { url: "x".repeat(8193) })).json(), { version: 1, ok: false, error: { code: "invalid_url", retryable: false } });
  });
});

test("actual HTTP executor limits overlap and serializes only the safe result", async () => {
  let unblock!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  await withServer(async origin => {
    const first = post(origin, { url: "https://news.example.com/article" });
    await started;
    assert.deepEqual(await (await post(origin, { url: "https://news.example.com/next" })).json(), {
      version: 1, ok: false, error: { code: "capture_busy", retryable: true },
    });
    unblock();
    assert.deepEqual(await (await first).json(), { version: 1, ok: true, article: { markdown: "# Saved", metadata: { title: "Saved" } } });
  }, async (url, appOrigin) => {
    assert.equal(url, "https://news.example.com/article");
    assert.equal(appOrigin, "https://read.example.com");
    entered(); await blocked;
    return { markdown: "# Saved", metadata: { title: "Saved" } };
  });
});
