# Defuddle on Cloudflare Workers

Worker-first trial, October 19, 2026. The extractor was deployed as an isolated Cloudflare Worker and exercised directly. This replaces the Container proposal in PR #56; the app's existing Worker-based processor and protected-fetch boundary are retained. No Container, Docker image, extra production service binding, or account-plan change is introduced.

## Result

**Defuddle runs in the deployed Workers runtime. The current Free CPU budget does not reliably support the accepted input range.** The next runtime trial should use Workers Paid's larger CPU budget, with extraction still inside the Worker. Containers have not been shown necessary for extraction.

The benchmark used Defuddle 0.19.4, LinkeDOM 0.18.13, the existing metadata parser and inert extraction function, and the app's `2026-08-01` compatibility date. Input construction, metadata parsing, Markdown conversion, output validation, and JSON response are included in the measured invocation. Cloudflare reported 5 ms Worker startup time. Runtime measurements below come from `wrangler tail`'s `cpuTime`, not client latency or a desktop timer.

The account's Free plan was confirmed by Cloudflare API error **100328** when a separate attempt requested `cpu_ms: 30000`: “CPU limits are not supported for the Free plan.” No subscription was created or changed. The failed attempt did not change the active benchmark deployment.

Five sequential requests per fixture produced:

| Synthetic fixture | HTML bytes | HTTP 200 responses | CPU evidence |
| --- | ---: | ---: | --- |
| Empty baseline | 0 | 5/5 | Median 0 ms, maximum 1 ms |
| Small formatted article | 1,632 | 5/5 | Median 102 ms; observed 56–343 ms |
| Typical article layout, links/code/table | 25,110 | 5/5 | One delivered trace measured 200 ms; four CPU samples missing |
| Large structured article | 524,035 | 0/5 | Three delivered traces report `exceededCpu` |
| Navigation-heavy page | 524,252 | 0/5 | Two delivered traces report `exceededCpu` |
| Malformed but readable HTML | 24,557 | 0/5 | Two delivered traces report `exceededCpu` |
| Markdown output overflow | 320,186 | 0/5 | Two delivered traces report `exceededCpu` before the expected output rejection |

All non-200 responses were HTTP 503. Only **20 of 35** invocation traces were delivered, so unobserved CPU/outcomes remain `null` in the [sanitized measurement report](benchmarks/worker-extraction-free.json). Quantiles are omitted for groups with incomplete telemetry. HTTP results are recorded for every request. CPU-limit outcomes after the larger cases also affect subsequent requests, so the malformed/output-overflow failures do not establish their isolated CPU cost. No cold-isolate or percentile guarantee is inferred from this small run.

Successful extraction preserved bold formatting, absolute URLs resolved from relative links, and title/author metadata. All six fixture shapes additionally pass local Cloudflare-runtime tests, including complete near-512-KiB input and explicit rejection above 256 KiB Markdown. Local tests do not enforce the production CPU policy.

Cloudflare documents a [10 ms Free CPU budget](https://developers.cloudflare.com/workers/platform/limits/#cpu-time) and some flexibility for occasional overruns. The successful above-budget requests are not evidence of a reliable Free fit. Paid every-minute Cron invocations have a 30-second CPU budget; **that plan's full-input CPU and memory fit has not yet been measured**. The 10 ms values on terminated traces are limits, not completed conversion timings. No peak-heap measurement was taken.

## Reproduce

The benchmark Worker accepts only a fixed set of synthetic fixture IDs. It has no database, storage, application credentials, user HTML/URLs, or source fetching. Deployment exposes that fixture-only endpoint on workers.dev for twenty minutes; the handler expires after that. The checked-in config is expired by default. The temporary Worker used for the recorded trial was removed after measurement.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build:benchmark
pnpm benchmark:deploy
```

For a Paid-plan trial, after enabling Workers Paid on the selected account:

```sh
pnpm benchmark:deploy --cpu-ms 30000
```

The deploy helper uses a temporary config and sets the twenty-minute expiry. It never changes billing or production bindings. `--dry-run` validates packaging without publishing.

Start tailing in one terminal, then run the requests in another, substituting the URL returned by deployment:

```sh
pnpm exec wrangler tail --config benchmarks/wrangler.jsonc --format json > dist/benchmark-tail.log
pnpm benchmark:extraction --url https://BENCHMARK.WORKERS_SUBDOMAIN.workers.dev --tail dist/benchmark-tail.log --out dist/benchmark-report.json --samples 10
```

The runner saves a report and exits nonzero for missing telemetry or failed requests. In particular, the recorded Free run is a failed-capacity experiment, not an all-green performance check. Raw tail files contain client network metadata; keep them local. The report persists only fixture IDs, byte counts, HTTP status, CPU/wall time, invocation outcome, run identity, and Worker version. Stop tailing and remove the temporary Worker when finished:

```sh
pnpm exec wrangler delete --config benchmarks/wrangler.jsonc
```

CI runs the functional fixture tests and Worker packaging dry run without Docker or deployment credentials. It does not publish the benchmark or change production extraction settings.

## Remaining capture boundary

The runtime experiment does not relax source-fetch protection. Production remains paused until the existing `ARTICLE_FETCHER` boundary enforces public destinations at connection time, including redirects, while retaining TLS hostname validation. A DNS preflight followed by ordinary hostname fetch does not establish pinning. Source-fetch validation and the Paid Worker runtime trial remain separate activation checks. See [background extraction](background-markdown-extraction.md) and [deployment](deployment.md#background-markdown-extraction).
