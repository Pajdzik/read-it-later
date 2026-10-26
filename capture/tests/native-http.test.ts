import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { once } from "node:events";
import http, { type IncomingMessage, type RequestOptions } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { pinnedFetch } from "../pinned-fetch";

test("native HTTP failures reject safely and leave the executor able to fetch again", async t => {
  let status = 600;
  let encoding = "identity";
  const server = http.createServer((_request, response) => {
    response.writeHead(status, { "Content-Type": "text/html", "Content-Encoding": encoding });
    response.end("<html><body>Saved article.</body></html>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const nativeRequest = http.request;
  // Redirect sockets to a controlled local origin only in this isolated test process.
  t.mock.method(dns, "lookup", async () => [{ address: "1.1.1.1", family: 4 }]);
  t.mock.method(http, "request", (options: RequestOptions, callback: (response: IncomingMessage) => void) =>
    nativeRequest({ ...options, hostname: "127.0.0.1", port }, callback));
  syncBuiltinESMExports();
  const fetchSource = () => pinnedFetch("http://news.example.com/article", { signal: AbortSignal.timeout(2_000) });
  try {
    await assert.rejects(fetchSource(), { code: "upstream_http", retryable: true });
    status = 200;
    encoding = "gzip";
    await assert.rejects(fetchSource(), { code: "unsupported_encoding", retryable: false });
    encoding = "identity";
    const response = await fetchSource();
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "<html><body>Saved article.</body></html>");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
