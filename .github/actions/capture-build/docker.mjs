#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

let args = process.argv.slice(2);
// Wrangler cleans up its random local tag after a dry run. The cache-only
// exporter never creates that tag, so there is no local image to remove.
if (process.env.CAPTURE_DOCKER_DRY_RUN === 'true' && args[0] === 'image' && args[1] === 'rm') process.exit(0);
if (args[0] === 'build') {
  // A dry run needs the complete build, but never pushes or runs the image.
  // Avoid downloading/exporting cached layers just to load an unused image.
  // Production retains --load so Wrangler can inspect, tag, and push normally.
  if (process.env.CAPTURE_DOCKER_DRY_RUN === 'true') {
    args = args.filter(arg => arg !== '--load');
    args.push('--output', 'type=cacheonly');
  }
  // Keep Wrangler's platform, tag, and streamed Dockerfile intact.
  args.splice(0, 1, 'buildx', 'build', '--builder', process.env.CAPTURE_BUILDX_BUILDER,
    '--pull',
    '--cache-from', 'type=gha,version=2,scope=capture-amd64',
    '--cache-to', 'type=gha,version=2,scope=capture-amd64,mode=max,ignore-error=true,timeout=60s');
}
const result = spawnSync('docker', args, { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
