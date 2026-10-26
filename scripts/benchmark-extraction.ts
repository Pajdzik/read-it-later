import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { extractionFixture, fixtureNames } from "../benchmarks/fixtures";

const { values } = parseArgs({ options: {
  url: { type: "string" }, tail: { type: "string" }, out: { type: "string" }, samples: { type: "string", default: "10" },
} });
if (!values.url || !values.tail || !values.out) throw new Error("Usage: benchmark-extraction --url <benchmark Worker> --tail <Wrangler JSON tail file> --out <report.json> [--samples 10]");
const base = new URL(values.url);
if (!base.hostname.endsWith(".workers.dev") || base.protocol !== "https:") throw new Error("Use the deployed fixture-only workers.dev benchmark URL.");
const samples = Number(values.samples);
if (!Number.isInteger(samples) || samples < 2 || samples > 30) throw new Error("Samples must be between 2 and 30.");
const runId = randomUUID();
const startedAt = new Date().toISOString();
interface Result { fixture: string; sample: number; status: number; inputBytes?: number; outputBytes?: number; outcome?: string }
interface Trace { cpuTime?: number; wallTime?: number; outcome?: string; scriptVersion?: { id?: string }; event?: { request?: { url: string; headers?: Record<string, string> } } }
const results: Result[] = [];

for (const fixture of ["baseline", ...fixtureNames]) {
  for (let sample = 0; sample < samples; sample++) {
    const response = await fetch(new URL(`/run/${fixture}/${sample}`, base), {
      headers: { "X-Benchmark-Run": runId }, signal: AbortSignal.timeout(30_000),
    });
    let result: Partial<Result> = {};
    try { result = await response.json() as Partial<Result>; } catch { /* Keep safe status only for platform errors. */ }
    const inputBytes = fixture === "baseline" ? 0 : new TextEncoder().encode(extractionFixture(fixture as typeof fixtureNames[number])).byteLength;
    results.push({ ...result, fixture, sample, status: response.status, inputBytes });
    // Keep real-time log streaming below its sampling threshold.
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  console.info(`Completed ${fixture}: ${samples} requests`);
}

function eventsFrom(text: string): Trace[] {
  const events: Trace[] = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; continue; }
    if (start >= 0 && char === '"') { quoted = true; continue; }
    if (char === "{") { if (depth++ === 0) start = i; }
    if (char === "}" && depth > 0 && --depth === 0) {
      try { events.push(JSON.parse(text.slice(start, i + 1))); } catch { /* Ignore banners and incomplete tail output. */ }
      start = -1;
    }
  }
  return events;
}

let events: Trace[] = [];
for (let attempt = 0; attempt < 50; attempt++) {
  events = eventsFrom(await readFile(values.tail, "utf8")).filter(event => event.event?.request?.headers?.["x-benchmark-run"] === runId);
  if (events.length >= results.length) break;
  await new Promise(resolve => setTimeout(resolve, 100));
}
const records = results.map(result => {
  const event = events.find(event => event.event?.request && new URL(event.event.request.url).pathname === `/run/${result.fixture}/${result.sample}`);
  // Persist only measurements; raw tail data also contains client network metadata.
  return { ...result, cpuMs: typeof event?.cpuTime === "number" ? event.cpuTime : null,
    wallMs: typeof event?.wallTime === "number" ? event.wallTime : null,
    invocationOutcome: event?.outcome ?? null, version: event?.scriptVersion?.id ?? null };
});
const percentile = (values: number[], fraction: number) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(fraction * values.length) - 1] : null;
const summary = ["baseline", ...fixtureNames].map(fixture => {
  const rows = records.filter(row => row.fixture === fixture);
  const cpu = rows.flatMap(row => typeof row.cpuMs === "number" ? [row.cpuMs] : []);
  return { fixture, samples: rows.length, inputBytes: rows[0]?.inputBytes ?? 0, outputBytes: rows[0]?.outputBytes ?? 0,
    firstCpuMs: rows[0]?.cpuMs ?? null,
    p50CpuMs: cpu.length === rows.length ? percentile(cpu, .5) : null,
    p95CpuMs: cpu.length === rows.length ? percentile(cpu, .95) : null,
    maxObservedCpuMs: cpu.length ? Math.max(...cpu) : null,
    measurements: cpu.length, httpSuccesses: rows.filter(row => row.status === 200).length,
    observedCpuLimitFailures: rows.filter(row => row.invocationOutcome === "exceededCpu").length };
});
await writeFile(values.out, JSON.stringify({ runtime: "deployed Cloudflare Worker", startedAt, runId, samplesPerFixture: samples,
  notes: "CPU/wall time are Cloudflare invocation measurements, not client elapsed time. Synthetic fixtures include generation, metadata, Defuddle and JSON response costs. First sample does not guarantee a cold isolate. No production database or source fetching.", summary, records }, null, 2) + "\n");
console.table(summary);
if (records.some(row => row.cpuMs === null)) throw new Error("Missing CPU measurements; ensure Wrangler tail was connected before the run.");
if (records.some(row => row.status !== 200 || row.invocationOutcome !== "ok")) throw new Error("One or more benchmark requests failed; inspect the saved report.");
