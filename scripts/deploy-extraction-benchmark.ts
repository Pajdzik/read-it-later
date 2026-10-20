import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { "cpu-ms": { type: "string" }, "dry-run": { type: "boolean", default: false } } });
const root = fileURLToPath(new URL("../", import.meta.url));
const config = JSON.parse(await readFile(path.join(root, "benchmarks/wrangler.jsonc"), "utf8"));
config.main = path.join(root, "benchmarks/worker.ts");
config.$schema = path.join(root, "node_modules/wrangler/config-schema.json");
config.vars.BENCHMARK_EXPIRES_AT = String(Date.now() + 20 * 60_000);
if (values["cpu-ms"] !== undefined) {
  const cpu = Number(values["cpu-ms"]);
  if (!Number.isInteger(cpu) || cpu < 1 || cpu > 30_000) throw new Error("CPU limit must be 1–30000 ms; custom CPU limits require Workers Paid.");
  config.limits = { cpu_ms: cpu };
}
const directory = await mkdtemp(path.join(tmpdir(), "potem-worker-benchmark-"));
try {
  const filename = path.join(directory, "wrangler.json");
  await writeFile(filename, JSON.stringify(config));
  const result = spawnSync("pnpm", ["exec", "wrangler", "deploy", "--config", filename,
    ...(values["dry-run"] ? ["--dry-run", "--outdir", path.join(root, "dist/extraction-benchmark")] : [])], {
    cwd: root, stdio: "inherit", env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { await rm(directory, { recursive: true, force: true }); }
