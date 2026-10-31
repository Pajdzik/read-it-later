import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export type CaptureEnvironment = "staging" | "production";

type JsonRecord = Record<string, unknown>;
type GeneratedWranglerConfig = JsonRecord & { env: Record<string, JsonRecord> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseJsonc(file: string): JsonRecord {
  const source = readFileSync(file, "utf8");
  const parsed = ts.parseConfigFileTextToJson(file, source);
  if (parsed.error) {
    throw new Error(`Cannot parse ${file}: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, " ")}`);
  }
  if (!parsed.config || typeof parsed.config !== "object") throw new Error(`${file} must contain a JSON object.`);
  return parsed.config as JsonRecord;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function requiredEnv(config: JsonRecord, env: CaptureEnvironment, label: string): JsonRecord {
  const selected = asRecord(asRecord(config.env)?.[env]);
  if (!selected) throw new Error(`${label} has no ${env} environment.`);
  return selected;
}

function validateOrigin(origin: string): void {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error("app_origin must be an exact HTTPS origin.");
  }
  if (parsed.protocol !== "https:" || parsed.origin !== origin || parsed.username || parsed.password || !parsed.hostname.includes(".") || /[<>]/.test(origin)) {
    throw new Error("app_origin must be an exact HTTPS origin with no path, credentials, placeholder, query, or trailing slash.");
  }
}

export interface CaptureDeploymentPlan {
  environment: CaptureEnvironment;
  origin: string;
  appWorker: string;
  gatewayWorker: string;
  databaseName: string;
  databaseId: string;
  generatedConfigPath: string;
  generatedConfig: GeneratedWranglerConfig;
  commands: string[][];
}

export function createCaptureDeploymentPlan(options: {
  root: string;
  environment: string;
  origin: string;
}): CaptureDeploymentPlan {
  const { root, origin } = options;
  if (options.environment !== "staging" && options.environment !== "production") {
    throw new Error("environment must be staging or production.");
  }
  const environment = options.environment as CaptureEnvironment;
  validateOrigin(origin);

  const appConfigPath = path.join(root, "wrangler.jsonc");
  const gatewayConfigPath = path.join(root, "fetcher/wrangler.jsonc");
  const app = parseJsonc(appConfigPath);
  const gateway = parseJsonc(gatewayConfigPath);
  const appEnv = requiredEnv(app, environment, "Application config");
  const gatewayEnv = requiredEnv(gateway, environment, "Gateway config");

  const appWorker = appEnv.name;
  const gatewayWorker = gatewayEnv.name;
  if (typeof appWorker !== "string" || appWorker !== `read-it-later-${environment}`) {
    throw new Error(`Selected application Worker name must be read-it-later-${environment}.`);
  }
  const expectedGateway = `read-it-later-safe-fetch-${environment}`;
  if (typeof gatewayWorker !== "string" || gatewayWorker !== expectedGateway) {
    throw new Error(`Selected gateway Worker name must be exactly ${expectedGateway}.`);
  }

  for (const [label, config, selected] of [
    ["application", app, appEnv],
    ["gateway", gateway, gatewayEnv],
  ] as const) {
    if (Object.hasOwn(asRecord(config.vars) ?? {}, "DEV_AUTH_BYPASS") || Object.hasOwn(asRecord(selected.vars) ?? {}, "DEV_AUTH_BYPASS")) {
      throw new Error(`DEV_AUTH_BYPASS must not be configured in base or selected ${label} vars.`);
    }
  }

  const selectedVars = asRecord(appEnv.vars) ?? {};
  const configuredOrigin = selectedVars.APP_ORIGIN;
  if (typeof configuredOrigin === "string" && !/[<>]/.test(configuredOrigin) && configuredOrigin !== origin) {
    throw new Error("app_origin must match the selected app environment's configured APP_ORIGIN.");
  }
  const ownerId = selectedVars.OWNER_GITHUB_ID;
  if (typeof ownerId !== "string" || !/^\d+$/.test(ownerId) || ownerId === "0") {
    throw new Error("Selected app environment OWNER_GITHUB_ID must be a configured numeric GitHub user ID.");
  }

  const databases = appEnv.d1_databases;
  if (!Array.isArray(databases) || databases.length !== 1) throw new Error("Selected app environment must configure exactly one D1 database.");
  const db = asRecord(databases[0]);
  if (!db) throw new Error("Selected app environment DB entry must be an object.");
  if (db.binding !== "DB" || typeof db.database_name !== "string" || !db.database_name.trim()) {
    throw new Error("Selected app environment must configure the DB binding with a database name.");
  }
  if (typeof db.database_id !== "string" || !UUID.test(db.database_id) || /[<>]|replace-with|11111111/i.test(db.database_id)) {
    throw new Error("Selected app environment DB must have an explicitly configured, non-placeholder UUID database_id.");
  }

  if (environment === "staging") {
    const production = asRecord(asRecord(app.env)?.production);
    const productionDatabases = production?.d1_databases;
    const productionDb = Array.isArray(productionDatabases) ? asRecord(productionDatabases[0]) : undefined;
    if (typeof productionDb?.database_id === "string" && UUID.test(productionDb.database_id) && productionDb.database_id.toLowerCase() === db.database_id.toLowerCase()) {
      throw new Error("Staging and production must use different D1 database IDs.");
    }
  }

  const generatedConfig = structuredClone(app) as GeneratedWranglerConfig;
  const generatedEnv = asRecord(asRecord(generatedConfig.env)?.[environment]);
  if (!generatedEnv) throw new Error(`Generated app config has no ${environment} environment.`);
  generatedEnv.vars = { ...(asRecord(generatedEnv.vars) ?? {}), APP_ORIGIN: origin, BACKGROUND_CAPTURE_ENABLED: "false" };
  const services = Array.isArray(generatedEnv.services) ? generatedEnv.services : [];
  const serviceRecords = services.map(asRecord);
  const existingFetcherBinding = serviceRecords.find((service) => service?.binding === "ARTICLE_FETCHER");
  if (existingFetcherBinding && existingFetcherBinding.service !== gatewayWorker) {
    throw new Error(`Selected app environment already binds ARTICLE_FETCHER to an unexpected Worker.`);
  }
  generatedEnv.services = [...serviceRecords.filter((service): service is JsonRecord => service !== undefined).filter((service) => service.binding !== "ARTICLE_FETCHER"), {
    binding: "ARTICLE_FETCHER",
    service: gatewayWorker,
  }];

  // Keep the generated config beside the source config so every relative path retains its meaning.
  const generatedConfigPath = path.join(root, `.wrangler.capture-deploy.${environment}.jsonc`);
  const commands = [
    ["pnpm", "build:web"],
    ["pnpm", "build:fetcher"],
    ["pnpm", "exec", "wrangler", "d1", "migrations", "apply", db.database_name, "--remote", "--env", environment, "--config", generatedConfigPath],
    ["pnpm", "exec", "wrangler", "deploy", "--config", gatewayConfigPath, "--env", environment, "--var", `APP_ORIGIN:${origin}`],
    ["pnpm", "queue:ensure", "--env", environment, "--config", generatedConfigPath, "--execute"],
    ["pnpm", "exec", "wrangler", "deploy", "--config", generatedConfigPath, "--env", environment],
  ];
  return { environment, origin, appWorker, gatewayWorker, databaseName: db.database_name, databaseId: db.database_id, generatedConfigPath, generatedConfig, commands };
}
