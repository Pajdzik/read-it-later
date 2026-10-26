import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchSourcePage } from "../../src/articles/source-fetch";
import { extractInThread } from "../executor";

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
  assert.equal(article.metadata.title, "Recovered");
  assert.match(article.markdown, /A readable article after the timeout/);
});
