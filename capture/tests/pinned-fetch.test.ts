import assert from "node:assert/strict";
import { test } from "node:test";
import type { PeerCertificate } from "node:tls";
import { isPublicAddress, pinnedFetch, pinnedRequestOptions, resolvePublicAddress } from "../pinned-fetch";
import { extractInThread } from "../executor";

test("public-address policy rejects private, metadata, reserved, mapped and transition addresses", () => {
  for (const address of ["0.0.0.0", "10.0.0.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "172.31.255.255", "192.168.1.1", "192.0.2.1", "198.18.0.1", "203.0.113.1", "224.0.0.1", "240.0.0.1", "::", "::1", "fc00::1", "fe80::1", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1", "2001:db8::1", "3fff::1", "fe80::1%eth0", "nonsense"]) assert.equal(isPublicAddress(address), false, address);
  for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "2001:4860:4860::8888"]) assert.equal(isPublicAddress(address), true, address);
});

test("mixed public/private DNS answers fail closed, regardless of address ordering", async () => {
  for (const addresses of [
    [{ address: "1.1.1.1", family: 4 }, { address: "127.0.0.1", family: 4 }],
    [{ address: "fd00::1", family: 6 }, { address: "1.1.1.1", family: 4 }], [],
    [{ address: "1.1.1.1", family: 6 }],
  ]) await assert.rejects(resolvePublicAddress("news.example.com", async () => addresses), { code: "unsafe_destination" });
});

test("connection uses the already validated numeric address, preserving Host and TLS identity", async () => {
  let lookups = 0;
  const address = await resolvePublicAddress("news.example.com", async () => {
    lookups++;
    return lookups === 1 ? [{ address: "1.1.1.1", family: 4 }] : [{ address: "127.0.0.1", family: 4 }];
  });
  const options = pinnedRequestOptions(new URL("https://news.example.com/article?q=1"), address);
  assert.equal(lookups, 1);
  assert.equal(options.hostname, "1.1.1.1");
  assert.equal(options.servername, "news.example.com");
  assert.equal((options.headers as Record<string, string>).Host, "news.example.com");
  assert.equal(options.path, "/article?q=1");
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.agent, false);
  assert.ok(options.checkServerIdentity("1.1.1.1", { subjectaltname: "DNS:other.example.com" } as PeerCertificate));
  assert.equal(options.checkServerIdentity("1.1.1.1", { subjectaltname: "DNS:news.example.com" } as PeerCertificate), undefined);
});

test("private targets and aborted resolution never open a source connection", async () => {
  await assert.rejects(pinnedFetch("http://127.0.0.1/", {}, "https://read.example.com"), { code: "unsafe_destination" });
  await assert.rejects(pinnedFetch("https://read.example.com/api", {}, "https://read.example.com"), { code: "unsafe_destination" });
  const controller = new AbortController();
  await assert.rejects(pinnedFetch("https://news.example.com/", { signal: controller.signal }, undefined, async () => {
    controller.abort(); return [{ address: "1.1.1.1", family: 4 }];
  }), { name: "AbortError" });
});

test("built extractor runs in an isolated Node thread, preserves formatting and resolves links", async () => {
  const { markdown, metadata } = await extractInThread('<html><head><title>Saved article</title><meta name="author" content="Jamie"></head><body><article><h1>Saved article</h1><p>Keep <strong>formatting</strong> and <a href="/next">links</a>.</p><script>throw new Error("must not execute")</script></article></body></html>', "https://source.example.com/article", new URL("../../dist/capture/extract-thread.mjs", import.meta.url));
  assert.equal(metadata.title, "Saved article");
  assert.equal(metadata.author, "Jamie");
  assert.match(markdown, /Keep/);
  assert.match(markdown, /\*\*formatting\*\*/);
  assert.match(markdown, /https:\/\/source.example.com\/next/);
  assert.doesNotMatch(markdown, /must not execute/);
});

test("a stalled synchronous extraction thread is terminated by its deadline", async () => {
  const started = Date.now();
  await assert.rejects(extractInThread("<html/>", "https://source.example.com/", new URL("./stalled-thread.mjs", import.meta.url)), { code: "conversion_failed" });
  assert.ok(Date.now() - started >= 4_500);
});
