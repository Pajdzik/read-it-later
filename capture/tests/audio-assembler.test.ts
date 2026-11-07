import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { AudioAssemblyError, assembleAudio } from "../audio-assembler";

const episodeId = "1c651e4e-812f-4804-8c2c-424fefb1052c";
const capability = "a".repeat(64);
const chunkKey = `audio/chunks/${episodeId}/0-1-a2e07c1a-1c78-48c7-a66e-f11364f89f40.wav`;

function wav(sampleRate = 24_000, channels = 1, bits = 16): Buffer {
  const sampleCount = sampleRate / 2;
  const bytes = sampleCount * channels * (bits / 8);
  const result = Buffer.alloc(44 + bytes);
  result.write("RIFF", 0); result.writeUInt32LE(36 + bytes, 4); result.write("WAVE", 8);
  result.write("fmt ", 12); result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20);
  result.writeUInt16LE(channels, 22); result.writeUInt32LE(sampleRate, 24);
  result.writeUInt32LE(sampleRate * channels * (bits / 8), 28);
  result.writeUInt16LE(channels * (bits / 8), 32); result.writeUInt16LE(bits, 34);
  result.write("data", 36); result.writeUInt32LE(bytes, 40);
  return result;
}

function mockFetcher(data: Buffer, calls: string[]) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/revoke")) return new Response(null, { status: 204 });
    const index = Number(url.split("/").at(-1));
    if (!Number.isInteger(index)) return new Response(null, { status: 404 });
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(data); controller.close(); } }), { status: 200 });
  }) as typeof fetch;
}

test("invalid WAV is rejected, its scratch files are removed, and scoped capability is revoked", async () => {
  const root = await mkdtemp(join(tmpdir(), "audio-test-"));
  const calls: string[] = [];
  try {
    await assert.rejects(assembleAudio({ episodeId, chunkKeys: [chunkKey], capability, signal: new AbortController().signal,
      fetcher: mockFetcher(Buffer.from("not wave"), calls), scratchRoot: root }), (error: unknown) => error instanceof AudioAssemblyError && error.code === "invalid_wav");
    assert.deepEqual(await readdir(root), []);
    assert.ok(calls.includes(`DELETE http://potem.audio/${capability}/revoke`));
    assert.ok(calls.includes(`GET http://potem.audio/${capability}/0`));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects WAVs with a sample format other than 24 kHz mono PCM16 before invoking ffmpeg", async () => {
  const root = await mkdtemp(join(tmpdir(), "audio-test-"));
  try {
    await assert.rejects(assembleAudio({ episodeId, chunkKeys: [chunkKey], capability, signal: new AbortController().signal,
      fetcher: mockFetcher(wav(44_100), []), scratchRoot: root }), (error: unknown) => error instanceof AudioAssemblyError && error.code === "invalid_wav_format");
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("produces a seekable MP3 with measured duration and byte count", { skip: spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "audio-test-"));
  const calls: string[] = [];
  let result: Awaited<ReturnType<typeof assembleAudio>> | undefined;
  try {
    result = await assembleAudio({ episodeId, chunkKeys: [chunkKey, chunkKey.replace("/0-1-", "/1-1-")], capability, signal: new AbortController().signal,
      fetcher: mockFetcher(wav(), calls), scratchRoot: root });
    assert.equal(result.durationSeconds, 1);
    assert.ok(result.bytes > 0);
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", result.path], { encoding: "utf8" });
    assert.equal(probe.status, 0);
    assert.ok(Number(probe.stdout.trim()) > 0.9);
    const seek = spawnSync("ffmpeg", ["-v", "error", "-ss", "0.25", "-i", result.path, "-frames:a", "1", "-f", "null", "-"], { stdio: "ignore" });
    assert.equal(seek.status, 0);
    assert.ok(calls.includes(`DELETE http://potem.audio/${capability}/revoke`));
  } finally {
    if (result) await rm(result.directory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("chunk key values cannot become filesystem paths or external URLs", async () => {
  const calls: string[] = [];
  await assert.rejects(assembleAudio({ episodeId, chunkKeys: ["../../etc/passwd"], capability, signal: new AbortController().signal,
    fetcher: mockFetcher(Buffer.from("not wave"), calls) }), (error: unknown) => error instanceof AudioAssemblyError && error.code === "invalid_wav");
  assert.deepEqual(calls, [`GET http://potem.audio/${capability}/0`, `DELETE http://potem.audio/${capability}/revoke`]);
});

test("assembly timeout aborts a stalled chunk stream and cleans scratch", async () => {
  const root = await mkdtemp(join(tmpdir(), "audio-test-"));
  const calls: string[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/revoke")) return new Response(null, { status: 204 });
    return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
  }) as typeof fetch;
  try {
    await assert.rejects(assembleAudio({ episodeId, chunkKeys: [chunkKey], capability, signal: new AbortController().signal,
      fetcher, scratchRoot: root, timeoutMs: 10 }), (error: unknown) => error instanceof AudioAssemblyError && error.code === "assembly_timeout");
    assert.deepEqual(await readdir(root), []);
    assert.ok(calls.includes(`DELETE http://potem.audio/${capability}/revoke`));
  } finally { await rm(root, { recursive: true, force: true }); }
});
