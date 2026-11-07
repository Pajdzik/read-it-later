import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createCaptureServer } from "../server";

const episodeId = "1c651e4e-812f-4804-8c2c-424fefb1052c";
const body = { version: 1, episodeId, chunkKeys: [`audio/chunks/${episodeId}/0-1-a2e07c1a-1c78-48c7-a66e-f11364f89f40.wav`] };
const token = "b".repeat(64);

async function withServer(run: (origin: string) => Promise<void>, assemble?: Parameters<typeof createCaptureServer>[2]) {
  const server = createCaptureServer("https://read.example", undefined, assemble);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

test("audio assembly validates the internal job capability and streams exact response metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "audio-server-test-"));
  const audioPath = join(directory, "result.mp3");
  const payload = Buffer.from("fake-mp3-data");
  await writeFile(audioPath, payload);
  let received: unknown;
  try {
    await withServer(async origin => {
      const reject = await fetch(origin + "/assemble-audio", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
      assert.equal(reject.status, 422);
      const response = await fetch(origin + "/assemble-audio", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", "X-Potem-Audio-Capability": token } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "audio/mpeg");
      assert.equal(response.headers.get("content-length"), String(payload.length));
      assert.equal(response.headers.get("x-audio-duration-seconds"), "1.25");
      assert.equal(Buffer.from(await response.arrayBuffer()).toString(), payload.toString());
    }, async (input, capability) => {
      received = input;
      assert.equal(capability, token);
      return { path: audioPath, directory, bytes: payload.length, durationSeconds: 1.25 };
    });
    assert.deepEqual(received, body);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("audio request size is bounded before assembly", async () => {
  let called = false;
  await withServer(async origin => {
    const response = await fetch(origin + "/assemble-audio", { method: "POST", headers: { "X-Potem-Audio-Capability": token }, body: JSON.stringify({ ...body, padding: "x".repeat(65 * 1024) }) });
    assert.equal(response.status, 422);
    assert.equal(called, false);
  }, async () => { called = true; throw new Error("unexpected"); });
});
