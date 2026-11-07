#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args[0] === 'build') {
  // Wrangler supplies the platform, tag, --load and Dockerfile on stdin. Keep
  // every argument and stdin intact; only select Buildx and add persistent cache.
  args.splice(0, 1, 'buildx', 'build', '--builder', process.env.CAPTURE_BUILDX_BUILDER,
    '--pull',
    '--cache-from', 'type=gha,version=2,scope=capture-amd64',
    '--cache-to', 'type=gha,version=2,scope=capture-amd64,mode=max,ignore-error=true,timeout=60s');
}
const result = spawnSync('docker', args, { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
