import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { after, before, test } from "node:test";
import type { IncomingMessage, RequestOptions, Server } from "node:http";
import type { LookupFunction } from "node:net";
import { isPublicAddress } from "../src/address-policy.js";
import { fetchOneHop, MAX_BODY_BYTES, type ResolvedAddress } from "../src/fetch-one-hop.js";
import { createGatewayServer } from "../src/server.js";

const publicV4: ResolvedAddress = { address: "93.184.216.34", family: 4 };

test("public address policy rejects local, reserved, mapped, and transition ranges", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "192.0.2.2", "224.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "2001:db8::1", "2002::1", "2001:0::1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ["93.184.216.34", "2606:4700:4700::1111"]) assert.equal(isPublicAddress(address), true, address);
});

function mockTransport(onOptions: (options: RequestOptions) => void, status = 200, headers: Record<string, string> = { "content-type": "text/html" }, body = "<html>ok</html>") {
  const requester = ((options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    onOptions(options);
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => {
      const res = new PassThrough() as PassThrough & IncomingMessage;
      Object.assign(res, { statusCode: status, headers });
      callback(res);
      queueMicrotask(() => res.end(body));
    };
    return req;
  }) as unknown as typeof import("node:http").request;
  return { http: requester, https: requester as unknown as typeof import("node:https").request };
}

test("validates every DNS answer and refuses mixed public/private answers before dialing", async () => {
  let dials = 0;
  await assert.rejects(fetchOneHop("https://news.example.com/", {
    resolver: async () => [publicV4, { address: "169.254.169.254", family: 4 }],
    transport: mockTransport(() => dials++),
  }), { code: "unsafe_destination" });
  assert.equal(dials, 0);
});

test("fails closed on empty or malformed DNS answers and the deadline covers DNS", async () => {
  for (const records of [[], [{ address: "93.184.216.34", family: 6 }]]) {
    await assert.rejects(fetchOneHop("https://news.example.com/", {
      resolver: async () => records as ResolvedAddress[], transport: mockTransport(() => assert.fail("must not dial")),
    }));
  }
  await assert.rejects(fetchOneHop("https://news.example.com/", {
    timeoutMs: 10, resolver: async () => new Promise<ResolvedAddress[]>(() => undefined),
  }), { code: "timeout" });
});

test("pins lookup to the validated address, preserves HTTPS hostname, and makes one redirect hop", async () => {
  let lookupAddress = "";
  let lookupCalls = 0;
  let requestCount = 0;
  let servername: string | undefined;
  let rejectUnauthorized: boolean | undefined;
  const transport = mockTransport((options) => {
    const tlsOptions = options as RequestOptions & { servername?: string; rejectUnauthorized?: boolean };
    requestCount++;
    servername = tlsOptions.servername;
    rejectUnauthorized = tlsOptions.rejectUnauthorized;
    const lookup = options.lookup as LookupFunction;
    lookupCalls++;
    lookup(options.hostname!, {}, ((error: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>) => {
      assert.ifError(error);
      lookupAddress = typeof address === "string" ? address : address[0].address;
    }) as never);
  }, 302, { location: "https://other.example.org/next", "set-cookie": "private=1" }, "ignored");
  const result = await fetchOneHop("https://news.example.com/start", {
    resolver: async () => [publicV4], transport,
  });
  assert.equal(result.status, 302);
  assert.equal(result.headers.location, "https://other.example.org/next");
  assert.equal(lookupAddress, publicV4.address);
  assert.equal(lookupCalls, 1);
  assert.equal(servername, "news.example.com");
  assert.notEqual(rejectUnauthorized, false);
  assert.equal(requestCount, 1);
});

test("rejects an oversized response even when the server omits Content-Length", async () => {
  await assert.rejects(fetchOneHop("https://news.example.com/", {
    resolver: async () => [publicV4],
    transport: mockTransport(() => undefined, 200, { "content-type": "text/html" }, "x".repeat(MAX_BODY_BYTES + 1)),
  }), { code: "source_too_large" });
});

test("cancellation stops before resolving or dialing", async () => {
  const controller = new AbortController();
  controller.abort();
  let resolved = false;
  await assert.rejects(fetchOneHop("https://news.example.com/", {
    signal: controller.signal,
    resolver: async () => { resolved = true; return [publicV4]; },
  }), { code: "timeout" });
  assert.equal(resolved, false);
});

test("redirect and error responses close unbounded origin bodies immediately", async () => {
  for (const status of [302, 503]) {
    let originResponse: (PassThrough & IncomingMessage) | undefined;
    const requester = ((options: RequestOptions, callback: (response: IncomingMessage) => void) => {
      const req = new EventEmitter() as EventEmitter & { end: () => void };
      req.end = () => {
        originResponse = new PassThrough() as PassThrough & IncomingMessage;
        Object.assign(originResponse, { statusCode: status, headers: { location: "https://other.example.org/" } });
        callback(originResponse);
      };
      return req;
    }) as unknown as typeof import("node:http").request;
    const transport = { http: requester, https: requester as unknown as typeof import("node:https").request };

    const response = await fetchOneHop("http://news.example.com/", {
      resolver: async () => [publicV4],
      transport,
      timeoutMs: 100,
    });

    assert.equal(response.status, status);
    assert.equal(response.body.byteLength, 0);
    assert.equal(originResponse?.destroyed, true);
  }
});

test("blocks the configured application origin and requires it in the startup blocklist", async () => {
  await assert.rejects(fetchOneHop("https://read-it-later.example/", {
    appOrigin: "https://read-it-later.example", resolver: async () => [publicV4],
  }), { code: "unsafe_destination" });
  assert.throws(() => createGatewayServer({
    token: TOKEN, appOrigin: "https://read-it-later.example", blockedHosts: ["article-fetch-gateway.internal"],
  }), /BLOCKED_HOSTS must include/);
});

const TOKEN = "test-token-that-is-long-enough-for-authentication";
let server: Server;
let baseUrl: string;
before(async () => {
  server = createGatewayServer({
    token: TOKEN,
    appOrigin: "https://read-it-later.example",
    blockedHosts: ["read-it-later.example", "read-it-later-staging.example", "article-fetch-gateway.internal"],
    fetch: async () => ({ status: 302, headers: { location: "/next", "set-cookie": "secret=1" }, body: Buffer.alloc(0) }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
after(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });

test("requires authentication and strips upstream cookies and internal headers", async () => {
  const denied = await fetch(`${baseUrl}/fetch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://news.example.com/" }) });
  assert.equal(denied.status, 401);
  const response = await fetch(`${baseUrl}/fetch`, {
    redirect: "manual",
    method: "POST",
    headers: { "content-type": "application/json", "x-article-fetcher-token": TOKEN },
    body: JSON.stringify({ url: "https://news.example.com/" }),
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/next");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("x-article-fetcher-error"), null);
});
