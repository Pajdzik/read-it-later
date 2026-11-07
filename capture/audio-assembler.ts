import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, statfs, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Writable } from "node:stream";
import { Buffer } from "node:buffer";

const MAX_SCRATCH_BYTES = 2 * 1024 ** 3;
const MIN_FREE_BYTES = 512 * 1024 ** 2;
const MAX_OUTPUT_BYTES = 350 * 1024 ** 2;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_INPUT_BYTES = MAX_SCRATCH_BYTES - MAX_OUTPUT_BYTES - MAX_MANIFEST_BYTES;
const MAX_CHUNKS = 100;
const ASSEMBLY_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_AUDIO_SECONDS = 12 * 60 * 60;

export class AudioAssemblyError extends Error {
  constructor(readonly code: string) { super(code); }
}

export interface AudioAssemblyResult {
  path: string;
  directory: string;
  bytes: number;
  durationSeconds: number;
}

export interface AssembleAudioOptions {
  episodeId: string;
  chunkKeys: string[];
  capability: string;
  signal: AbortSignal;
  fetcher?: typeof fetch;
  scratchRoot?: string;
  timeoutMs?: number;
}

function checkWavFormat(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const fdStream = createReadStream(path, { start: 0, end: 1024 * 1024 - 1 });
    const parts: Buffer[] = [];
    fdStream.on("data", chunk => parts.push(Buffer.from(chunk)));
    fdStream.on("error", reject);
    fdStream.on("end", () => {
      const b = Buffer.concat(parts);
      if (b.length < 44 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") return reject(new AudioAssemblyError("invalid_wav"));
      const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
      let offset = 12;
      let fmt: Buffer | undefined;
      while (offset + 8 <= b.length) {
        const size = view.getUint32(offset + 4, true);
        const end = offset + 8 + size;
        if (end > b.length) break;
        if (b.toString("ascii", offset, offset + 4) === "fmt ") { fmt = b.subarray(offset + 8, end); break; }
        offset = end + (size & 1);
      }
      if (!fmt || fmt.length < 16) return reject(new AudioAssemblyError("invalid_wav_format"));
      const fmtView = new DataView(fmt.buffer, fmt.byteOffset, fmt.byteLength);
      if (fmtView.getUint16(0, true) !== 1 || fmtView.getUint16(2, true) !== 1 || fmtView.getUint32(4, true) !== 24000 || fmtView.getUint16(14, true) !== 16 || fmtView.getUint16(12, true) !== 2) return reject(new AudioAssemblyError("invalid_wav_format"));
      resolve();
    });
  });
}

function run(program: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn(program, args, { shell: false, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", part => { if (output.length < 4096) output += part; });
    const abort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", () => reject(new AudioAssemblyError("encoder_unavailable")));
    child.once("close", code => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(new AudioAssemblyError("assembly_timeout"));
      else if (code !== 0) reject(new AudioAssemblyError("audio_encode_failed"));
      else resolve(output.trim());
    });
  });
}

export async function assembleAudio(options: AssembleAudioOptions): Promise<AudioAssemblyResult> {
  const { chunkKeys, capability, signal } = options;
  if (!Array.isArray(chunkKeys) || chunkKeys.length < 1 || chunkKeys.length > MAX_CHUNKS || chunkKeys.some(key => typeof key !== "string" || key.length > 1024)) throw new AudioAssemblyError("invalid_chunks");
  if (!/^[0-9a-f-]{36}$/i.test(options.episodeId) || !/^[a-f0-9]{48,128}$/i.test(capability)) throw new AudioAssemblyError("invalid_request");
  const root = options.scratchRoot ?? tmpdir();
  const fs = await statfs(root);
  if (fs.bavail * fs.bsize < MIN_FREE_BYTES) throw new AudioAssemblyError("insufficient_disk");
  const directory = await mkdtemp(join(root, "potem-audio-"));
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  const timer = setTimeout(abort, options.timeoutMs ?? ASSEMBLY_TIMEOUT_MS);
  let used = 0;
  try {
    const fetcher = options.fetcher ?? fetch;
    const files: string[] = [];
    for (let i = 0; i < chunkKeys.length; i++) {
      controller.signal.throwIfAborted();
      const response = await fetcher(`http://potem.audio/${capability}/${i}`, { signal: controller.signal });
      if (!response.ok || !response.body) throw new AudioAssemblyError("chunk_unavailable");
      const path = join(directory, `chunk-${String(i).padStart(3, "0")}.wav`);
      const limited = new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, ctl) {
        used += chunk.byteLength;
        if (used > MAX_SCRATCH_BYTES) throw new AudioAssemblyError("scratch_limit");
        ctl.enqueue(chunk);
      } });
    await response.body.pipeThrough(limited).pipeTo(Writable.toWeb(createWriteStream(path)) as WritableStream<Uint8Array>, { signal: controller.signal });
      await checkWavFormat(path);
      files.push(path);
    }
    if (used > MAX_INPUT_BYTES) throw new AudioAssemblyError("scratch_limit");
    let inputDuration = 0;
    for (const path of files) {
      const duration = Number(await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path], controller.signal));
      if (!Number.isFinite(duration) || duration <= 0) throw new AudioAssemblyError("invalid_wav");
      inputDuration += duration;
      if (inputDuration > MAX_AUDIO_SECONDS) throw new AudioAssemblyError("audio_too_long");
    }
    const concatPath = join(directory, "inputs.txt");
    await writeFile(concatPath, files.map(path => `file '${path}'`).join("\n"), { mode: 0o600 });
    const manifestStat = await stat(concatPath);
    if (manifestStat.size > MAX_MANIFEST_BYTES) throw new AudioAssemblyError("scratch_limit");
    const outputPath = join(directory, "episode.mp3");
    await run("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", concatPath, "-vn", "-ac", "1", "-ar", "24000", "-c:a", "libmp3lame", "-b:a", "64k", "-write_xing", "1", "-y", outputPath], controller.signal);
    const metadata = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", outputPath], controller.signal);
    const durationSeconds = Number(metadata);
    const outputStat = await stat(outputPath);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > MAX_AUDIO_SECONDS || !outputStat.size || outputStat.size > MAX_OUTPUT_BYTES || used + outputStat.size + manifestStat.size > MAX_SCRATCH_BYTES) throw new AudioAssemblyError("invalid_audio_output");
    return { path: outputPath, directory, bytes: outputStat.size, durationSeconds };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    if (controller.signal.aborted) throw new AudioAssemblyError("assembly_timeout");
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    // The capability is a one-job grant; revocation is deliberately attempted on every exit.
    try { await (options.fetcher ?? fetch)(`http://potem.audio/${capability}/revoke`, { method: "DELETE", signal: AbortSignal.timeout(1_000) }); } catch { /* capability expires in the Worker as a fallback */ }
  }
}

