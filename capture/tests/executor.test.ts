import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { fetchSourcePage } from "../../src/articles/source-fetch";
import { executeCapture, extractInThread } from "../executor";
import { EXECUTOR_TIMEOUT_MS } from '../../src/articles/capture-limits';
import { CAPTURE_TIMEOUT_MS } from '../../src/articles/capture-protocol';

const threadUrl = new URL("../../dist/capture/extract-thread.mjs", import.meta.url);

test("slow metadata stays inside the bounded thread and subsequent extraction still works", { timeout: 15_000 }, async () => {
  const url = "https://news.example.com/article";
  // This valid, bounded page previously blocked the server thread for over 20 seconds.
  const html = `<html><head><title>Article</title><meta name="description" content="${"<".repeat(250_000)}"></head><body><article><p>Saved article.</p></article></body></html>`;
  const source = await fetchSourcePage(url, {
    BACKGROUND_CAPTURE_ENABLED: "true",
    ARTICLE_FETCHER: { fetch: async () => new Response(html, { headers: { "Content-Type": "text/html" } }) },
  });
  assert.deepEqual(source, { html, url });

  let heartbeats = 0;
  const interval = setInterval(() => { heartbeats++; }, 20);
  const started = Date.now();
  try {
    await assert.rejects(extractInThread(source.html, source.url, threadUrl), { code: "conversion_failed" });
    assert.ok(Date.now() - started >= 4_500, "the thread deadline terminates metadata parsing");
    assert.ok(heartbeats > 0, "the server event loop remains responsive during parsing");
  } finally { clearInterval(interval); }

  const article = await extractInThread("<html><head><title>Recovered</title></head><body><article><p>A readable article after the timeout.</p></article></body></html>", url, threadUrl);
  assert.equal(article.title, "Recovered");
  assert.equal(article.description, "A readable article after the timeout.");
});

test('executor bounds an unresponsive conversion gateway even when it ignores abort', async () => {
  let cancelled=false;
  const replacement=mock.method(globalThis,'fetch',async (_input: RequestInfo | URL, init?: RequestInit)=>{
    init?.signal?.addEventListener('abort',()=>{cancelled=true;},{once:true});
    return new Promise<Response>(()=>undefined);
  });
  try {
    await assert.rejects(executeCapture('https://news.example.com/paper','https://read.example.com',crypto.randomUUID(),undefined,25),{code:'timeout',retryable:true});
    assert.equal(cancelled,true);
    assert.ok(EXECUTOR_TIMEOUT_MS<CAPTURE_TIMEOUT_MS);
  } finally { replacement.mock.restore(); }
});

test('executor cancels a stalled conversion response and remains usable', async () => {
  let cancelled=false;
  const replacement=mock.method(globalThis,'fetch',async()=>new Response(new ReadableStream({
    pull(){return new Promise(()=>undefined);},cancel(){cancelled=true;},
  })));
  try {
    await assert.rejects(executeCapture('https://news.example.com/paper','https://read.example.com',crypto.randomUUID(),undefined,25),{code:'timeout',retryable:true});
    assert.equal(cancelled,true);
    replacement.mock.mockImplementation(async()=>Response.json({version:1,ok:true,article:{markdown:'# Recovered',metadata:{}}}));
    assert.equal((await executeCapture('https://news.example.com/paper','https://read.example.com',crypto.randomUUID(),undefined,100)).markdown,'# Recovered');
  } finally { replacement.mock.restore(); }
});
