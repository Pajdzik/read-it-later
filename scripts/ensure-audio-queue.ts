import { parseArgs } from 'node:util';
import { ensureAudioQueue } from './extraction-queue-deployment';

try {
  const { values } = parseArgs({ options: {
    env: { type: 'string' }, config: { type: 'string', default: 'wrangler.jsonc' },
    execute: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
  }, strict: true, allowPositionals: false });
  if (values.execute && values['dry-run']) throw new Error('Choose --execute or --dry-run.');
  console.log(ensureAudioQueue(values.env ?? '', values.config, values.execute === true));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Audio queue provisioning failed.');
  process.exitCode = 1;
}
