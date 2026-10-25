import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { fetchViaContainer } from "../adapter.js";
import { FETCH_PROTOCOL_HEADER, PROTOCOL_VERSION } from "../protocol.js";
import { ContainerStartupError, waitForContainerReady } from "../startup.js";
import { SOURCE_HOP_TIMEOUT_MS } from "../../src/articles/capture-limits.js";

test("a cold start longer than the network deadline still receives a fresh network budget", { timeout: 9_000 }, async () => {
  const caller = new AbortController();
  let ready = false;
  await waitForContainerReady(async () => {
    await delay(SOURCE_HOP_TIMEOUT_MS + 100);
    ready = true;
  }, caller.signal);
  const response = await fetchViaContainer("https://news.example.com/article", caller.signal, async (request) => {
    assert.equal(ready, true);
    assert.equal(request.signal.aborted, false);
    return new Response("ok", { headers: { [FETCH_PROTOCOL_HEADER]: String(PROTOCOL_VERSION), "content-length": "2" } });
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
});

test("startup remains bounded when readiness ignores cancellation", async () => {
  let startupSignal: AbortSignal | undefined;
  await assert.rejects(waitForContainerReady((signal) => {
    startupSignal = signal;
    return new Promise<void>(() => undefined);
  }, new AbortController().signal, 20), (error: unknown) => error instanceof ContainerStartupError && error.code === "timeout");
  assert.equal(startupSignal?.aborted, true);
});

test("cancelling startup prevents a late readiness result from fetching an article", async () => {
  const caller = new AbortController();
  let resolveReady!: () => void;
  let fetched = false;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
  const pending = (async () => {
    await waitForContainerReady(() => ready, caller.signal);
    fetched = true;
  })();
  const rejected = assert.rejects(pending, (error: unknown) => error instanceof ContainerStartupError && error.code === "timeout");
  caller.abort();
  await rejected;
  resolveReady();
  await Promise.resolve();
  assert.equal(fetched, false);
});

test("pre-aborted callers do not start a Container and startup errors expose only stable codes", async () => {
  const caller = new AbortController();
  caller.abort();
  let started = false;
  await assert.rejects(waitForContainerReady(async () => { started = true; }, caller.signal), { code: "timeout" });
  assert.equal(started, false);
  await assert.rejects(waitForContainerReady(async () => { throw new Error("private platform details"); }, new AbortController().signal),
    (error: unknown) => error instanceof ContainerStartupError && error.code === "network_error" && error.message === "network_error");
});
