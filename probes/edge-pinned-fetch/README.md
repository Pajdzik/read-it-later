# Fixed-target edge fetch probe

This isolated Worker compares raw socket TLS to one fixed public GitHub IP, TLS by the GitHub hostname, and HTTP to the same IP on port 80. It accepts no URL or destination from requests, query strings, headers, or bindings. `GET /probe` returns only coarse outcomes and never returns upstream bodies or runtime error text.

The checked-in `BENCHMARK_EXPIRES_AT` value is `0`, so the endpoint is disabled. A manual trial must override it with a Unix timestamp in milliseconds no more than 20 minutes ahead. The handler returns 410 once that timestamp passes; delete the Worker within that same window as well. The config has no app bindings, routes, credentials, or production resources. It disables preview URLs and keeps ordinary observability logs and traces enabled.

To run a reviewed trial, first install the lockfile dependencies, then deploy this dedicated config. The command below gives the Worker a 20-minute handler lifetime:

```sh
EXPIRES_AT_MS="$(node -e 'process.stdout.write(String(Date.now() + 20 * 60 * 1000))')"
CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false pnpm exec wrangler deploy --config probes/edge-pinned-fetch/wrangler.jsonc --var "BENCHMARK_EXPIRES_AT:${EXPIRES_AT_MS}"
```

Call the returned `workers.dev` URL at `/probe` up to three times. Then delete the probe Worker:

```sh
CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false pnpm exec wrangler delete --config probes/edge-pinned-fetch/wrangler.jsonc
```

A candidate working TLS result requires a complete HTTP status for the pinned-IP case with `github.com` as the expected hostname, and an explicit `tls_rejected` outcome for the same IP with `invalid.example`. A complete HTTP response from the mismatch case is a safety failure. `option_rejected` means the required API is unavailable. A timeout, generic connection error, malformed response, or header-limit result is inconclusive. The hostname control must return `tls_http_response`; the HTTP/80 control should return an HTTP status. The recorded trial and its exact outputs are in [edge-results.json](./edge-results.json).

This probe tests only the fixed destination and Cloudflare runtime used for that deployment. It does not validate redirects, DNS rebinding, mixed A/AAAA records, private/reserved addresses, response-size handling, or every public origin. It is diagnostic evidence, not an article fetcher or an activation gate by itself.
