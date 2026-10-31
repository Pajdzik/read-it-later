import { spawnSync } from 'node:child_process';

export type QueueEnvironment = 'staging' | 'production';
export type QueueCommandRunner = (args: string[]) => { status: number | null; output: string };

export function extractionQueueName(environment: string): string {
  if (environment !== 'staging' && environment !== 'production') throw new Error('Queue environment must be staging or production.');
  return `read-it-later-extraction-${environment}`;
}

const runWrangler: QueueCommandRunner = args => {
  const result = spawnSync('pnpm', ['exec', 'wrangler', ...args], {
    encoding: 'utf8', env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false' },
  });
  if (result.error) throw new Error('Could not start Wrangler for queue provisioning.');
  return { status: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
};

/** Only an explicit not-found result authorizes creation; auth/network errors stop deployment. */
export function ensureExtractionQueue(
  environment: string, config: string, execute: boolean, run: QueueCommandRunner = runWrangler,
): string {
  const name = extractionQueueName(environment);
  if (!execute) return `Ensure ${name}: inspect queue, create only if missing (config=${config}, env=${environment}).`;
  const options = ['--config', config, '--env', environment];
  const inspect = () => run(['queues', 'info', name, ...options]);
  const existing = inspect();
  if (existing.status === 0) return `Queue ${name} already exists.`;
  if (!existing.output.includes(`Queue "${name}" does not exist.`)) {
    throw new Error(`Cannot inspect ${name}; check Cloudflare authentication, Queues permissions, and connectivity.`);
  }
  const created = run(['queues', 'create', name, ...options]);
  // A concurrent release may have provisioned the same queue after our inspection.
  if (created.status !== 0 && inspect().status !== 0) throw new Error(`Could not provision ${name}.`);
  return `Queue ${name} is ready.`;
}
