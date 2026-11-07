import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const environment = process.env.INPUT_ENVIRONMENT;
const dryRun = process.env['INPUT_DRY-RUN'];
if (!['staging', 'production'].includes(environment) || !['true', 'false'].includes(dryRun)) {
  throw new Error('Expected a staging/production environment and a true/false dry-run input.');
}
if (!process.env.ACTIONS_RUNTIME_TOKEN || !process.env.ACTIONS_RESULTS_URL) {
  throw new Error('The capture build action requires the GitHub Actions cache runtime.');
}

const env = {
  ...process.env,
  WRANGLER_DOCKER_BIN: fileURLToPath(new URL('./docker.mjs', import.meta.url)),
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
  CAPTURE_BUILDX_BUILDER: `capture-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
};
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('docker', ['buildx', 'create', '--name', env.CAPTURE_BUILDX_BUILDER, '--driver', 'docker-container']);
const args = ['exec', 'wrangler', 'deploy', '--config', 'capture/wrangler.jsonc', '--env', environment];
if (dryRun === 'true') args.push('--dry-run', '--outdir', 'dist/capture-worker');
run('pnpm', args);
