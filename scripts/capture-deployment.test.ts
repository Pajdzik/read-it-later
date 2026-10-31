import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createCaptureDeploymentPlan } from "./capture-deployment.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const validOrigin = "https://read.pajdzik.pl";

function temporaryRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "capture-deploy-"));
  mkdirSync(path.join(dir, "fetcher"));
  writeFileSync(path.join(dir, "wrangler.jsonc"), readFileSync(path.join(root, "wrangler.jsonc")));
  writeFileSync(path.join(dir, "fetcher/wrangler.jsonc"), readFileSync(path.join(root, "fetcher/wrangler.jsonc")));
  return dir;
}

test("plans the selected environment with a private gateway binding and capture paused", () => {
  const plan = createCaptureDeploymentPlan({ root, environment: "production", origin: validOrigin });
  const productionVars = plan.generatedConfig.env.production.vars as Record<string, unknown>;
  assert.equal(plan.environment, "production");
  assert.equal(plan.gatewayWorker, "read-it-later-safe-fetch-production");
  assert.equal(productionVars.BACKGROUND_CAPTURE_ENABLED, "false");
  assert.deepEqual(plan.generatedConfig.env.production.services, [
    { binding: "ARTICLE_EXTRACTOR", service: "read-it-later-capture-production" },
    { binding: "ARTICLE_FETCHER", service: "read-it-later-safe-fetch-production" },
  ]);
  assert.equal(productionVars.MANAGED_CONVERSION_ENABLED, "false");
  assert.deepEqual(plan.generatedConfig.env.staging.services, [{ binding: "ARTICLE_EXTRACTOR", service: "read-it-later-capture-staging" }]);
});

test("plans a configured staging stack while preserving its resources and isolating production", () => {
  const dir = temporaryRepo();
  try {
    const appPath = path.join(dir, "wrangler.jsonc");
    const app = JSON.parse(readFileSync(appPath, "utf8"));
    app.env.staging.vars.OWNER_GITHUB_ID = "1497744";
    app.env.staging.d1_databases[0].database_id = "00000000-0000-4000-8000-000000000001";
    writeFileSync(appPath, JSON.stringify(app));

    const stagingOrigin = "https://read-it-later-staging.example.workers.dev";
    const plan = createCaptureDeploymentPlan({ root: dir, environment: "staging", origin: stagingOrigin });
    const stagingVars = plan.generatedConfig.env.staging.vars as Record<string, unknown>;
    assert.equal(plan.appWorker, "read-it-later-staging");
    assert.equal(plan.gatewayWorker, "read-it-later-safe-fetch-staging");
    assert.equal(stagingVars.APP_ORIGIN, stagingOrigin);
    assert.equal(stagingVars.BACKGROUND_CAPTURE_ENABLED, "false");
    assert.deepEqual(plan.generatedConfig.env.staging.services, [
      ...app.env.staging.services,
      { binding: "ARTICLE_FETCHER", service: "read-it-later-safe-fetch-staging" },
    ]);
    assert.equal(stagingVars.MANAGED_CONVERSION_ENABLED, "false");
    assert.deepEqual(plan.generatedConfig.env.staging.r2_buckets, app.env.staging.r2_buckets);
    assert.deepEqual(plan.generatedConfig.env.staging.d1_databases, app.env.staging.d1_databases);
    assert.deepEqual(plan.generatedConfig.env.staging.triggers, app.env.staging.triggers);
    assert.deepEqual(plan.generatedConfig.env.production, app.env.production);
    assert.deepEqual(plan.generatedConfig.vars, app.vars);
    assert.equal(plan.generatedConfig.services, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("orders D1 migration, gateway deploy, then app deploy after both builds", () => {
  const plan = createCaptureDeploymentPlan({ root, environment: "production", origin: validOrigin });
  assert.deepEqual(plan.commands.map((command) => command.slice(0, 2)), [
    ["pnpm", "build:web"], ["pnpm", "build:fetcher"], ["pnpm", "exec"], ["pnpm", "exec"], ["pnpm", "queue:ensure"], ["pnpm", "exec"],
  ]);
  assert.ok(plan.commands[2].includes("migrations"));
  assert.ok(plan.commands[2].includes("--remote"));
  assert.ok(plan.commands[3].includes("deploy"));
  assert.ok(plan.commands[3].includes("--env"));
  assert.ok(plan.commands[3].includes("production"));
  assert.ok(plan.commands[4].includes("queue:ensure"));
  assert.ok(plan.commands[4].includes("production"));
  assert.ok(plan.commands[5].includes("deploy"));
  assert.ok(plan.commands[5].includes(plan.generatedConfigPath));
});

test("rejects invalid target, origin, owner, database ID, and gateway name", () => {
  assert.throws(() => createCaptureDeploymentPlan({ root, environment: "preview", origin: validOrigin }), /staging or production/);
  for (const origin of ["http://read.pajdzik.pl", "https://read.pajdzik.pl/path", "https://<host>.workers.dev"]) {
    assert.throws(() => createCaptureDeploymentPlan({ root, environment: "production", origin }), /app_origin/);
  }

  const dir = temporaryRepo();
  try {
    const appPath = path.join(dir, "wrangler.jsonc");
    const fetcherPath = path.join(dir, "fetcher/wrangler.jsonc");
    const app = JSON.parse(readFileSync(appPath, "utf8"));
    app.env.production.vars.OWNER_GITHUB_ID = "replace-with-numeric-github-user-id";
    writeFileSync(appPath, JSON.stringify(app));
    assert.throws(() => createCaptureDeploymentPlan({ root: dir, environment: "production", origin: validOrigin }), /OWNER_GITHUB_ID/);

    app.env.production.vars.OWNER_GITHUB_ID = "1497744";
    app.env.production.d1_databases[0].database_id = "replace-with-d1-database-id";
    writeFileSync(appPath, JSON.stringify(app));
    assert.throws(() => createCaptureDeploymentPlan({ root: dir, environment: "production", origin: validOrigin }), /database_id/);

    app.env.production.d1_databases[0].database_id = "e4a7e714-8e4e-413d-8f13-51c0c02fab5f";
    writeFileSync(appPath, JSON.stringify(app));
    const gateway = JSON.parse(readFileSync(fetcherPath, "utf8"));
    gateway.env.production.name = "read-it-later-safe-fetch-staging";
    writeFileSync(fetcherPath, JSON.stringify(gateway));
    assert.throws(() => createCaptureDeploymentPlan({ root: dir, environment: "production", origin: validOrigin }), /gateway Worker name/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects DEV_AUTH_BYPASS and a staging database shared with production", () => {
  const dir = temporaryRepo();
  try {
    const appPath = path.join(dir, "wrangler.jsonc");
    const valid = JSON.parse(readFileSync(appPath, "utf8"));
    valid.env.staging.vars.OWNER_GITHUB_ID = "1497744";
    valid.env.staging.d1_databases[0].database_id = "00000000-0000-4000-8000-000000000001";

    valid.vars.DEV_AUTH_BYPASS = "true";
    writeFileSync(appPath, JSON.stringify(valid));
    assert.throws(() => createCaptureDeploymentPlan({ root: dir, environment: "staging", origin: "https://read-it-later-staging.example.workers.dev" }), /DEV_AUTH_BYPASS/);
    delete valid.vars.DEV_AUTH_BYPASS;

    valid.env.staging.vars.DEV_AUTH_BYPASS = "false";
    writeFileSync(appPath, JSON.stringify(valid));
    assert.throws(() => createCaptureDeploymentPlan({ root: dir, environment: "staging", origin: "https://read-it-later-staging.example.workers.dev" }), /DEV_AUTH_BYPASS/);
    delete valid.env.staging.vars.DEV_AUTH_BYPASS;

    valid.env.staging.d1_databases[0].database_id = valid.env.production.d1_databases[0].database_id;
    writeFileSync(appPath, JSON.stringify(valid));
    assert.throws(() => createCaptureDeploymentPlan({ root: dir, environment: "staging", origin: "https://read-it-later-staging.example.workers.dev" }), /different D1 database IDs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dry-run prints the plan without invoking Wrangler or writing generated config", () => {
  const generated = path.join(root, ".wrangler.capture-deploy.production.jsonc");
  const generatedWasPresent = existsSync(generated);
  const previousGeneratedContents = generatedWasPresent ? readFileSync(generated, "utf8") : undefined;
  const toolsDir = mkdtempSync(path.join(os.tmpdir(), "capture-deploy-bin-"));
  const marker = path.join(toolsDir, "remote-command-was-run");
  const fakePnpm = path.join(toolsDir, "pnpm");
  writeFileSync(fakePnpm, `#!/bin/sh\n: > '${marker}'\n`);
  chmodSync(fakePnpm, 0o755);
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/deploy-capture-stack.ts", "--dry-run"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: toolsDir, CAPTURE_ENVIRONMENT: "production", CAPTURE_APP_ORIGIN: validOrigin },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Preview only/);
    assert.match(result.stdout, /wrangler/);
    assert.equal(existsSync(generated), generatedWasPresent);
    if (generatedWasPresent) assert.equal(readFileSync(generated, "utf8"), previousGeneratedContents);
    assert.equal(existsSync(marker), false);

    for (const args of [["--execute", "--dry-run"], ["--dry-run", "--unexpected"], []]) {
      const invalid = spawnSync(process.execPath, ["--import", "tsx", "scripts/deploy-capture-stack.ts", ...args], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, PATH: toolsDir, CAPTURE_ENVIRONMENT: "production", CAPTURE_APP_ORIGIN: validOrigin },
      });
      assert.equal(invalid.status, 1);
      assert.equal(existsSync(marker), false);
      assert.equal(existsSync(generated), generatedWasPresent);
      if (generatedWasPresent) assert.equal(readFileSync(generated, "utf8"), previousGeneratedContents);
    }
  } finally {
    rmSync(toolsDir, { recursive: true, force: true });
  }
});
