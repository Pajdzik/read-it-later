# Fetch-only article gateway

This service resolves and fetches one HTTP(S) hop for the app's existing `ARTICLE_FETCHER` service-binding interface. It does not extract article content: queue processing, redirects, metadata, Defuddle, and Markdown limits remain in the application Worker.

The gateway Worker is private (`workers_dev: false`, preview URLs disabled, no routes). An operator must deploy it and add a service binding to a selected app environment before the app can call it. `BACKGROUND_CAPTURE_ENABLED` remains `false` and there is no production binding in the checked-in app config.

The Node Container checks the source URL and every CNAME/A/AAAA result against the public address policy, then uses a fresh socket request to a numeric address. It keeps the original URL hostname for `Host`, TLS SNI, and certificate identity verification. TLS verification is enabled, redirects are returned to the app for validation, compressed bodies are rejected, and no upstream cookies/authentication are forwarded. It deliberately does not use a proxy, Cloudflare HTTPS interception, Node's global `fetch()`, or a DNS preflight followed by a hostname connection.

The fixed internal POST request uses JSON protocol v2. Responses carry bounded raw bytes and an explicit `x-safe-fetch-protocol: 2` marker, or a stable `x-safe-fetch-error`; mixed protocol versions fail closed. Source pages cannot supply these internal headers. This removes base64 encoding and JSON response decoding. The gateway grants Container readiness up to ten seconds, followed by a separate five-second fetch budget. The app allows the startup allowance only on the first hop and retains its twenty-second overall fetch deadline. Startup cancellation prevents a later readiness result from dispatching the article request.

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

Use the repository's manual `Deploy capture stack (paused)` workflow, selecting staging first and supplying that environment's exact app origin. It validates the configured owner/database, builds the image input and website, applies D1 migrations, deploys the gateway, then deploys the app with the correct service binding and capture paused. The workflow requires the selected GitHub environment's Cloudflare credentials and Worker, Container, and D1 permissions. It shares the production deployment concurrency group with the existing app workflow. Review costs and current Container instance limits before running it.

The workflow's generated binding must be committed to the selected environment's source config before returning to ordinary app-only deployments; those otherwise use the checked-in config. Activation is a later reviewed config change. Keep production disabled until staging verifies DNS policy, numeric connection pinning, TLS validation, redirect handling, cold starts, timeouts, and representative target coverage. Remote Container behavior is a release check; local fixtures do not prove Cloudflare's network path. See [the full boundary and probe findings](../docs/worker-safe-fetch.md).
