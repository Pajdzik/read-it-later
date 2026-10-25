import { writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { createCaptureDeploymentPlan } from "./capture-deployment.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const environment = process.env.CAPTURE_ENVIRONMENT ?? "";
const origin = process.env.CAPTURE_APP_ORIGIN ?? "";

try {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { "dry-run": { type: "boolean" }, execute: { type: "boolean" } },
    allowPositionals: false,
    strict: true,
  });
  if (values["dry-run"] === values.execute) {
    throw new Error("Choose exactly one of --dry-run or --execute.");
  }
  const execute = values.execute === true;
  const plan = createCaptureDeploymentPlan({ root, environment, origin });
  console.log(`Capture deployment plan for ${plan.environment}: app=${plan.appWorker}, gateway=${plan.gatewayWorker}, D1=${plan.databaseName} (${plan.databaseId})`);
  if (!execute) {
    console.log("Preview only; no files or remote resources were changed.");
    for (const command of plan.commands) console.log(`$ ${command.map((part) => JSON.stringify(part)).join(" ")}`);
    process.exit(0);
  }

  if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
    throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set in the selected GitHub environment.");
  }
  writeFileSync(plan.generatedConfigPath, `${JSON.stringify(plan.generatedConfig, null, 2)}\n`, { flag: "wx" });
  try {
    for (const [command, ...args] of plan.commands) {
      const result = spawnSync(command, args, {
        cwd: root, stdio: "inherit",
        env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" },
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Command failed with exit code ${result.status ?? "unknown"}: ${command} ${args.join(" ")}`);
    }
  } finally {
    unlinkSync(plan.generatedConfigPath);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Capture deployment failed.");
  process.exitCode = 1;
}
