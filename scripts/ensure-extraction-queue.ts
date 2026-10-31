import { parseArgs } from 'node:util';
import { ensureExtractionQueue } from './extraction-queue-deployment';

try {
  const { values } = parseArgs({ options: {
    env: { type: 'string' }, config: { type: 'string', default: 'wrangler.jsonc' },
    execute: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
  }, strict: true, allowPositionals: false });
  if (values.execute && values['dry-run']) throw new Error('Choose --execute or --dry-run.');
  console.log(ensureExtractionQueue(values.env ?? '', values.config, values.execute === true));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Queue provisioning failed.');
  process.exitCode = 1;
}
