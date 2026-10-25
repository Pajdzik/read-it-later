# Fetch-only article gateway

This service resolves and fetches one HTTP(S) hop for the app's existing `ARTICLE_FETCHER` service-binding interface. It does not extract article content: queue processing, redirects, metadata, Defuddle, and Markdown limits remain in the application Worker.

The gateway Worker is private (`workers_dev: false`, preview URLs disabled, no routes). An operator must deploy it and add a service binding to a selected app environment before the app can call it. `BACKGROUND_CAPTURE_ENABLED` remains `false` and there is no production binding in the checked-in app config.

The Node Container checks the source URL and every CNAME/A/AAAA result against the public address policy, then uses a fresh socket request to a numeric address. It keeps the original URL hostname for `Host`, TLS SNI, and certificate identity verification. TLS verification is enabled, redirects are returned to the app for validation, compressed bodies are rejected, and no upstream cookies/authentication are forwarded. It deliberately does not use a proxy, Cloudflare HTTPS interception, Node's global `fetch()`, or a DNS preflight followed by a hostname connection.

## Local checks

```sh
pnpm typecheck:fetcher
pnpm test:fetcher
pnpm build:fetcher-dry-run
pnpm test:fetcher:container
```

After changing the gateway's Wrangler bindings, regenerate its declarations with `pnpm types:fetcher`.

The Node tests use local HTTP/TLS fixtures and ephemeral test certificates. The Container smoke test needs a Docker daemon; CI builds and runs it on its Docker-enabled runner. The Wrangler dry run uses `--containers-rollout=none`, so it checks Worker packaging without deploying or building the image.

## Manual deployment

Use the repository's manual `Deploy article fetcher` workflow, selecting staging first and supplying that environment's exact app origin. It deploys only the private gateway Worker and Container; it does not change the app's flag or service bindings. The workflow requires the selected GitHub environment's Cloudflare credentials and the existing account's Container/Worker permissions. Review costs and current Container instance limits before running it.

After deployment, add `ARTICLE_FETCHER` to the staging app's `services` binding with the exact staged gateway Worker name. Keep production unbound until staging verifies DNS policy, numeric connection pinning, TLS validation, redirect handling, timeouts, and representative target coverage. Remote Container behavior is a release check; local fixtures do not prove Cloudflare's network path. See [the full boundary and probe findings](../docs/worker-safe-fetch.md).
