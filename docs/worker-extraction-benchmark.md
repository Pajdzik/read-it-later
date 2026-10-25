# Defuddle on Cloudflare Workers

The extractor was deployed as an isolated Cloudflare Worker and exercised directly on Free (October 19, 2026) and Paid (October 25, 2026 UTC). Extraction remains in the application Worker; the separate fetch-only gateway handles source fetching. Neither benchmark changes production bindings or enables capture. The account owner enabled Workers Paid before the second trial.

## Result

**The Paid trial completed all 70 requests with the expected outcomes and complete CPU telemetry.** The largest structured fixture used at most 5,641 ms of CPU against the configured 30,000 ms budget. The Free trial below did not reliably support the accepted input range. These results support keeping Defuddle in the Worker; deployed fetcher integration and scheduled application behavior remain staging checks.

## Paid-plan trial (October 25, 2026 UTC)

The temporary Worker used the same Defuddle 0.19.4, LinkeDOM 0.18.13, metadata parser, extraction function, fixture sources, and `2026-08-01` compatibility date as the Free trial. Cloudflare accepted `cpu_ms: 30000` and reported 6 ms startup time. The measured deployment was `9d5837e1-b6a5-42a7-9fc3-686b8f53d7b8`; it has been deleted.

Ten sequential requests per fixture produced:

| Synthetic fixture | HTML bytes | Expected results | Median CPU (ms) | Maximum CPU (ms) | Maximum Worker wall time (ms) |
| --- | ---: | --- | ---: | ---: | ---: |
| Empty baseline | 0 | 10/10 baseline responses | 0 | 1 | 2 |
| Small formatted article | 1,632 | 10/10 extracted | 68 | 176 | 188 |
| Typical article layout, links/code/table | 25,110 | 10/10 extracted | 160 | 296 | 310 |
| Large structured article | 524,035 | 10/10 extracted | 5,355 | 5,641 | 6,590 |
| Navigation-heavy page | 524,252 | 10/10 extracted | 1,720 | 2,245 | 2,757 |
| Malformed but readable HTML | 24,557 | 10/10 extracted | 138 | 192 | 203 |
| Markdown output overflow | 320,186 | 10/10 intentionally rejected | 83 | 121 | 137 |

All 70 HTTP responses were 200, including the benchmark's deliberate policy-rejection response for oversized Markdown. All 70 invocation outcomes were `ok`, with no recorded `exceededCpu` or `exceededMemory` outcome. The [sanitized Paid report](benchmarks/worker-extraction-paid.json) includes every HTTP outcome, CPU/wall measurement, and deployed version.

The live `wrangler tail` stream delivered CPU measurements for only 50/70 requests, so the original runner correctly exited nonzero for incomplete telemetry. A subsequent Workers Logs query, restricted to the benchmark Worker and its unique `x-benchmark-run` header, returned all 70 invocation records. Every record matched a unique fixture/sample and the deployed version; all 50 overlapping CPU, wall-time, and version measurements agreed exactly. The stored-log records complete the report without filling missing values with estimates. Raw request headers and client network metadata are excluded.

These are Cloudflare invocation measurements, not desktop timers or client round-trip latency. Fixture generation, metadata parsing, Defuddle, validation, and JSON serialization are included. The HTTP benchmark's CPU budget matches the [30-second budget for every-minute Paid Cron](https://developers.cloudflare.com/workers/platform/limits/#cpu-time), but the benchmark does not run the scheduled job, source fetcher, or D1 persistence. Peak heap was not measured. Ten sequential requests per shape do not establish a production percentile, cold-start guarantee, concurrency limit, or coverage of every possible 512-KiB page. Keep capture paused until staging verifies the full application path and resource behavior.

## Free-plan trial (October 19, 2026)

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

Cloudflare documents a [10 ms Free CPU budget](https://developers.cloudflare.com/workers/platform/limits/#cpu-time) and some flexibility for occasional overruns. The successful above-budget requests are not evidence of a reliable Free fit. The 10 ms values on terminated traces are limits, not completed conversion timings. No peak-heap measurement was taken. The later Paid trial above completes the fixture CPU measurements with a larger budget.

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

The runtime experiments do not relax source-fetch protection. Production remains paused until the existing `ARTICLE_FETCHER` boundary enforces public destinations at connection time, including redirects, while retaining TLS hostname validation. A DNS preflight followed by ordinary hostname fetch does not establish pinning. The Paid fixture CPU trial has passed; source-fetch validation and full scheduled capture remain separate staging checks. See [background extraction](background-markdown-extraction.md) and [deployment](deployment.md#background-markdown-extraction).
