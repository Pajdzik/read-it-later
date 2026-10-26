import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createTlsServer, request as requireHttpsRequest } from "node:https";
import { createSecureContext } from "node:tls";
import { request as createPinnedHttpRequest } from "node:http";
import type { IncomingMessage, RequestOptions } from "node:http";
import { Resolver } from "node:dns/promises";
import { after, before, test } from "node:test";
import {
  isPublicAddress,
  pinnedRequest,
  PinnedFetchFailure,
  resolvePublicAddress,
} from "../pinned-fetch.js";

const temp = mkdtempSync(join(tmpdir(), "safe-fetch-test-"));
const caKey = join(temp, "ca.key");
const caCert = join(temp, "ca.crt");
const leafKey = join(temp, "leaf.key");
const leafCsr = join(temp, "leaf.csr");
const leafCert = join(temp, "leaf.crt");
const extensions = join(temp, "leaf.ext");
let tlsServer: ReturnType<typeof createTlsServer>;
let httpServer: HttpServer;
let tlsPort = 0;
let httpPort = 0;
const observedSni: string[] = [];
const observedHosts: string[] = [];
const liveSignal = () => new AbortController().signal;

before(async () => {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKey, "-out", caCert, "-days", "1", "-subj", "/CN=Safe Fetch Test CA"], { stdio: "ignore" });
  execFileSync("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", leafKey, "-out", leafCsr, "-subj", "/CN=news.example.com"], { stdio: "ignore" });
  writeFileSync(extensions, "subjectAltName=DNS:news.example.com\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n");
  execFileSync("openssl", ["x509", "-req", "-in", leafCsr, "-CA", caCert, "-CAkey", caKey, "-CAcreateserial", "-out", leafCert, "-days", "1", "-extfile", extensions], { stdio: "ignore" });
  const tlsOptions = {
    key: readFileSync(leafKey),
    cert: readFileSync(leafCert),
    SNICallback(servername: string, callback: (error: Error | null, context?: ReturnType<typeof createSecureContext>) => void) {
      observedSni.push(servername);
      callback(null, createSecureContext({ key: readFileSync(leafKey), cert: readFileSync(leafCert) }));
    },
  };
  tlsServer = createTlsServer(tlsOptions, (request, response) => {
    observedHosts.push(String(request.headers.host));
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<html><body>fixture</body></html>");
  });
  httpServer = createHttpServer((request, response) => {
    if (request.url === "/large") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(Buffer.alloc(32, 65));
    } else if (request.url === "/truncated") {
      response.writeHead(200, { "content-type": "text/html", "content-length": "40" });
      response.end("short");
    } else if (request.url === "/hang") {
      request.socket.once("close", () => { httpServer.emit("fixture-client-closed"); });
    } else if (request.url === "/redirect") {
      response.writeHead(302, { location: "https://other.example.com/" });
      response.end();
    } else if (request.url === "/large-headers") {
      response.writeHead(200, { "x-large": "x".repeat(17 * 1024) });
      response.end();
    } else if (request.url === "/compressed") {
      response.writeHead(200, { "content-encoding": "gzip" });
      response.end("not actually decompressed");
    } else {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html><body>plain</body></html>");
    }
  });
  await Promise.all([
    new Promise<void>((resolve) => tlsServer.listen(0, "127.0.0.1", resolve)),
    new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve)),
  ]);
});

after(async () => {
  await Promise.all([
    new Promise<void>((resolve) => tlsServer.close(() => resolve())),
    new Promise<void>((resolve) => httpServer.close(() => resolve())),
  ]);
  rmSync(temp, { recursive: true, force: true });
});

test("public address policy excludes reserved and special-purpose ranges", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "100.64.0.1", "169.254.169.254", "192.168.1.1", "198.18.0.1", "203.0.113.1", "::1", "fc00::1", "fe80::1", "2001:db8::1", "3fff::1", "64:ff9b::808:808", "64:ff9b:1::1", "2002:0808:0808::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "::ffff:8.8.8.8", "fe80::1%en0"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"]) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test("resolver rejects mixed public/private aliases and DNS rebinding answers", async () => {
  const controller = new AbortController();
  const mixed = {
    cancel() {},
    async resolveCname(name: string) { return name === "news.example.com" ? ["origin.example.net"] : []; },
    async resolve4(name: string) { return name === "origin.example.net" ? ["1.1.1.1", "127.0.0.1"] : ["1.1.1.1"]; },
    async resolve6() { const error = Object.assign(new Error("no data"), { code: "ENODATA" }); throw error; },
  } as unknown as Resolver;
  await assert.rejects(resolvePublicAddress("news.example.com", controller.signal, { resolver: mixed }),
    (error: unknown) => error instanceof PinnedFetchFailure && error.code === "unsafe_destination");

  const rebinding = {
    cancel() {},
    async resolveCname() { return []; },
    async resolve4() { return ["1.1.1.1", "169.254.169.254"]; },
    async resolve6() { const error = Object.assign(new Error("no data"), { code: "ENODATA" }); throw error; },
  } as unknown as Resolver;
  await assert.rejects(resolvePublicAddress("news.example.com", controller.signal, { resolver: rebinding }),
    (error: unknown) => error instanceof PinnedFetchFailure && error.code === "unsafe_destination");
});

test("resolver detects CNAME loops and fails closed on DNS errors", async () => {
  const controller = new AbortController();
  const loop = {
    cancel() {},
    async resolveCname(name: string) { return [name === "a.example.com" ? "b.example.com" : "a.example.com"]; },
    async resolve4() { return []; }, async resolve6() { return []; },
  } as unknown as Resolver;
  await assert.rejects(resolvePublicAddress("a.example.com", controller.signal, { resolver: loop }),
    (error: unknown) => error instanceof PinnedFetchFailure && error.code === "dns_error");
  const failed = {
    cancel() {}, async resolveCname() { throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" }); },
    async resolve4() { return ["1.1.1.1"]; }, async resolve6() { return []; },
  } as unknown as Resolver;
  await assert.rejects(resolvePublicAddress("a.example.com", controller.signal, { resolver: failed }),
    (error: unknown) => error instanceof PinnedFetchFailure && error.code === "dns_error");
});

test("resolver rejects restricted or own-origin CNAME aliases before resolving their addresses", async () => {
  const controller = new AbortController();
  let addressLookups = 0;
  const aliasResolver = (alias: string) => ({
    cancel() {}, async resolveCname(name: string) { return name === "news.example.com" ? [alias] : []; },
    async resolve4() { addressLookups++; return ["1.1.1.1"]; },
    async resolve6() { const error = Object.assign(new Error("no data"), { code: "ENODATA" }); throw error; },
  }) as unknown as Resolver;
  await assert.rejects(resolvePublicAddress("news.example.com", controller.signal, {
    resolver: aliasResolver("app.example.com"), appOrigin: "https://app.example.com",
  }), (error: unknown) => error instanceof PinnedFetchFailure && error.code === "unsafe_destination");
  await assert.rejects(resolvePublicAddress("news.example.com", controller.signal, {
    resolver: aliasResolver("metadata.internal"), appOrigin: "https://app.example.com",
  }), (error: unknown) => error instanceof PinnedFetchFailure && error.code === "unsafe_destination");
  assert.equal(addressLookups, 0);
});

test("an address change on a later DNS query cannot alter the pinned connection", async () => {
  httpPort = (httpServer.address() as { port: number }).port;
  let answers = 0;
  const resolver = {
    cancel() {}, async resolveCname() { return []; },
    async resolve4() { answers++; return answers === 1 ? ["1.1.1.1"] : ["127.0.0.1"]; },
    async resolve6() { const error = Object.assign(new Error("no data"), { code: "ENODATA" }); throw error; },
  } as unknown as Resolver;
  const address = await resolvePublicAddress("news.example.com", liveSignal(), { resolver });
  assert.equal(address, "1.1.1.1");
  const response = await pinnedRequest(new URL(`http://news.example.com:${httpPort}/`), address, {
    signal: new AbortController().signal,
    requestFactory(options, callback) {
      assert.equal(options.hostname, "1.1.1.1");
      assert.deepEqual(options.headers, {
        Host: `news.example.com:${httpPort}`,
        Accept: "text/html,application/xhtml+xml;q=0.9",
        "User-Agent": "PotemReader/1.0",
        "Accept-Encoding": "identity",
        Connection: "close",
      });
      return createPinnedHttpRequest({ ...options, hostname: "127.0.0.1" }, callback);
    },
  });
  assert.equal(response.status, 200);
  assert.equal(answers, 1);
});

test("HTTPS pins a numeric address while preserving SNI and certificate hostname checks", async () => {
  tlsPort = (tlsServer.address() as { port: number }).port;
  const response = await pinnedRequest(new URL(`https://news.example.com:${tlsPort}/story?q=1`), "1.1.1.1", {
    signal: new AbortController().signal,
    requestFactory(options, callback) {
      assert.equal(options.hostname, "1.1.1.1");
      assert.equal((options as import("node:https").RequestOptions).servername, "news.example.com");
      return requireHttpsRequest({ ...options, hostname: "127.0.0.1", ca: readFileSync(caCert) }, callback);
    },
  });
  assert.equal(response.status, 200);
  assert.match(Buffer.from(response.body).toString(), /fixture/);
  assert.ok(observedSni.includes("news.example.com"));
  assert.ok(observedHosts.includes(`news.example.com:${tlsPort}`));
});

test("HTTPS rejects a mismatched certificate even when test transport redirects the numeric socket", async () => {
  tlsPort = (tlsServer.address() as { port: number }).port;
  let tlsErrorCode = "";
  await assert.rejects(pinnedRequest(new URL(`https://wrong.example.com:${tlsPort}/`), "1.1.1.1", {
    signal: new AbortController().signal,
    requestFactory(options, callback) {
      assert.equal(options.hostname, "1.1.1.1");
      assert.equal((options as import("node:https").RequestOptions).servername, "wrong.example.com");
      const request = requireHttpsRequest({ ...options, hostname: "127.0.0.1", ca: readFileSync(caCert) }, callback);
      request.once("error", (error) => { tlsErrorCode = (error as NodeJS.ErrnoException).code ?? ""; });
      return request;
    },
  }), (error: unknown) => error instanceof PinnedFetchFailure && error.code === "network_error");
  assert.equal(tlsErrorCode, "ERR_TLS_CERT_ALTNAME_INVALID");
  assert.ok(observedSni.includes("wrong.example.com"));
});

test("HTTPS rejects an untrusted certificate", async () => {
  tlsPort = (tlsServer.address() as { port: number }).port;
  let tlsErrorCode = "";
  await assert.rejects(pinnedRequest(new URL(`https://news.example.com:${tlsPort}/`), "1.1.1.1", {
    signal: new AbortController().signal,
    requestFactory(options, callback) {
      const request = requireHttpsRequest({ ...options, hostname: "127.0.0.1" }, callback);
      request.once("error", (error) => { tlsErrorCode = (error as NodeJS.ErrnoException).code ?? ""; });
      return request;
    },
  }), (error: unknown) => error instanceof PinnedFetchFailure && error.code === "network_error");
  assert.ok(["SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT"].includes(tlsErrorCode), tlsErrorCode);
});

test("HTTP connects to the pinned numeric address and caps the response body", async () => {
  httpPort = (httpServer.address() as { port: number }).port;
  const response = await pinnedRequest(new URL(`http://news.example.com:${httpPort}/`), "1.1.1.1", {
    signal: new AbortController().signal,
    requestFactory(options, callback) {
      assert.equal(options.hostname, "1.1.1.1");
      return createPinnedHttpRequest({ ...options, hostname: "127.0.0.1" }, callback);
    },
  });
  assert.equal(response.status, 200);
  assert.match(Buffer.from(response.body).toString(), /plain/);
});

test("HTTP body limit and truncated responses fail closed, while redirects remain a single hop", async () => {
  httpPort = (httpServer.address() as { port: number }).port;
  const factory = (options: RequestOptions, callback: (response: IncomingMessage) => void) =>
    createPinnedHttpRequest({ ...options, hostname: "127.0.0.1" }, callback);
  await assert.rejects(pinnedRequest(new URL(`http://news.example.com:${httpPort}/large`), "1.1.1.1", {
    signal: new AbortController().signal, maxBytes: 16, requestFactory: factory,
  }), (error: unknown) => error instanceof PinnedFetchFailure && error.code === "source_too_large");
  await assert.rejects(pinnedRequest(new URL(`http://news.example.com:${httpPort}/truncated`), "1.1.1.1", {
    signal: new AbortController().signal, requestFactory: factory,
  }), (error: unknown) => error instanceof PinnedFetchFailure && error.code === "network_error");
  const redirect = await pinnedRequest(new URL(`http://news.example.com:${httpPort}/redirect`), "1.1.1.1", {
    signal: new AbortController().signal, requestFactory: factory,
  });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.location, "https://other.example.com/");
  await assert.rejects(pinnedRequest(new URL(`http://news.example.com:${httpPort}/large-headers`), "1.1.1.1", {
    signal: new AbortController().signal, requestFactory: factory,
  }), (error: unknown) => error instanceof PinnedFetchFailure && error.code === "network_error");
  await assert.rejects(pinnedRequest(new URL(`http://news.example.com:${httpPort}/compressed`), "1.1.1.1", {
    signal: new AbortController().signal, requestFactory: factory,
  }), (error: unknown) => error instanceof PinnedFetchFailure && error.code === "unsupported_encoding");
});

test("aborting an active request destroys its socket", async () => {
  httpPort = (httpServer.address() as { port: number }).port;
  const controller = new AbortController();
  let closed!: () => void;
  const socketClosed = new Promise<void>((resolve) => { closed = resolve; });
  httpServer.once("fixture-client-closed", closed);
  const request = pinnedRequest(new URL(`http://news.example.com:${httpPort}/hang`), "1.1.1.1", {
    signal: controller.signal,
    requestFactory(options, callback) { return createPinnedHttpRequest({ ...options, hostname: "127.0.0.1" }, callback); },
  });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(request, (error: unknown) => error instanceof PinnedFetchFailure && error.code === "timeout");
  await Promise.race([socketClosed, new Promise((_, reject) => setTimeout(() => reject(new Error("socket not closed")), 500))]);
});
