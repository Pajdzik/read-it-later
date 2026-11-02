# Article enrichment quality investigation — November 1, 2026

**Failed; keep generation disabled.** The exact production-request probe produced 2/4 schema-valid responses, neither requiring a generated description. Both description-generation cases failed. The Polish passkey set also added an unsupported password topic. The 30-case representative evaluation was not run; its 27/30 gate has not been reached.

The [summary](summary.json) accounts for **60 new calls** out of the task's 100-call maximum, 12,149 input tokens and 5,189 output tokens. Median latency was 653 ms; p95 was 1,411 ms. Estimated inference cost is **$0.001371012**, before allowance, at [$0.027/M input and $0.201/M output tokens](https://developers.cloudflare.com/workers-ai/models/llama-3.2-1b-instruct/). All calls returned usage; invalid outputs are included. This is an estimate, not an account invoice. Historical calls are not included in these totals.

| Experiment | Calls | Schema-valid | Relevant complete tag sets | Gate |
| --- | ---: | ---: | ---: | --- |
| JSON input, tag-only, three variants | 12 | 2 | 1 | Failed |
| JSON input, description-only, three variants | 12 | 0 | Not applicable | Failed |
| JSON input, combined, three variants | 12 | 1 | 1 | Failed: generated description adds an unsupported storage claim |
| Plain input, tag-only | 4 | 3 | 2 | Failed: Polish tags and invented domain |
| Plain input, description-only | 4 | 0 | Not applicable | Failed |
| Plain input, combined, three variants | 12 | 4 | 2 | Failed |
| Exact production request, combined | 4 | 2 | 1 | Failed |

These rows reuse four synthetic development articles (database indexes and passkeys, each in English and Polish). They are neither independent library samples nor a 30-article owner-library evaluation. Schema validity alone does not establish semantic quality. All 16 isolated description attempts failed. The sole schema-valid generated description across combined probes claimed efficient storage despite the source saying indexes consume storage. The plain Polish tag-only response included `fałszywa domena`, `usługa` and an invented `passkey.com` domain. Every accepted tag and effective description has a recorded **agent**, not human, judgment. Invalid whole responses are disqualified with an explanation and never salvaged.

## Evidence

Each experiment has a complete `.json` report, a `.review.json` with source evidence and exact result hashes, and a `.gate.json` with computed failures. For example: [production report](production-probe.json), [agent judgments](production-probe.review.json), [gate](production-probe.gate.json). Reports retain exact message arrays, generation parameters, source text, raw provider envelopes, usage and latency. The [reservation ledger](calls.json) numbers all 60 attempts in dispatch order. The temperature is zero; upstream model/runtime changes can still change subsequent results.

The [frozen corpus](../../../benchmarks/enrichment-library-fixtures.json) contains 25 unique English archive excerpts from public `Pajdzik/Kamilpedia` revision `485c94f5a379900d34dfb60711da1813cd187f38`, plus five original Polish Wikipedia excerpts. Each entry records its supplied title/description/text, source URL/revision and content hash. English excerpts retain their inspected opening lines, not entire originals; Polish excerpts retain up to six substantive paragraphs. Wikipedia attribution and license information are retained. Corpus SHA-256 is `579d9cf2549176f649a0b0b64452f9adc36ab28a60e2360699cbd207937b8966`. The corpus was frozen before combined tuning. No private repository or production D1 data was used.

## Reproduce offline

Install with `pnpm install --frozen-lockfile`, then run:

```sh
pnpm test:enrichment-evaluator
pnpm benchmark:enrichment --review docs/benchmarks/article-enrichment-quality/production-probe.json --judgments docs/benchmarks/article-enrichment-quality/production-probe.review.json --output .wrangler/production-rechecked.json
```

The second command must exit **1**, reporting two invalid generated-description responses and a Polish tag-quality failure. Reviewing results whose production source has changed adds `source_changed_since_run`; their recorded judgments remain historical evidence, not approval of current code. Tests also verify all checked-in report/review hashes, accounting and corpus hashes offline.

To create a blank review sheet without inference:

```sh
pnpm benchmark:enrichment --review-template .wrangler/my-run.json --output .wrangler/my-run.review.json
```

Read every complete source/request/response. Fill the reviewer identity, timestamp, complete-set judgment, each tag's relevance and English judgment with evidence, and description grounding/language/sentence judgments with factual support. Do not substitute substring matching or an automatic second model. A missing, blank or stale judgment fails the gate. Sentence checks apply to generated descriptions; preserved prose paragraphs keep their original fallback behavior.

## Live protocol for a separately authorized follow-up

**The current task's live experiments stopped at 60 calls. Do not reset or remove `.wrangler/enrichment-calls.json` to bypass that budget.** The commands below document the experiment protocol; they are not an instruction to spend more calls now. Every live command exits 1 pending semantic review and refuses to overwrite an existing report. Use a new output path for a new run. Preserve reports and the ledger even after failures or timeouts. An uncertain outcome consumes its reservation; do not retry automatically. A stale ledger lock requires checking for a running evaluator before recovering it.

The existing ephemeral local Worker uses installed Wrangler 4.145.0/workerd 1.20260930.2, compatibility date `2026-08-01`, a loopback-only authenticated endpoint, and a remote native `AI` binding. It has no D1, queues, deployed Worker or production enable flag. Wrangler authentication must already be configured. No SDK, JSON mode, response repair or model upgrade is used.

The initial protocol, in order, is:

```sh
pnpm benchmark:enrichment --live --diagnostic tags --variant all --output .wrangler/tags-new.json
pnpm benchmark:enrichment --live --diagnostic description --variant all --output .wrangler/descriptions-new.json
pnpm benchmark:enrichment --live --diagnostic combined --variant all --output .wrangler/combined-new.json
```

Each command makes 12 calls: four cases times `minimal`, `vocabulary`, and `examples`. Vocabulary is limited to five labels whose whole words occur in the source, without expected benchmark answers. Description-only `vocabulary` also makes the same-language/no-list instruction explicit. `examples` uses separate user/assistant turns rather than embedding an answer in instructions.

The refinement protocol used four `--diagnostic tags --variant plain` calls, four `--diagnostic description --variant plain` calls, twelve `--diagnostic combined --variant plain-all` calls, and four `--probe` calls. `plain-all` compares no example, a Polish example and an English example. The exact production candidate uses plain text without examples because it yielded the most schema-valid small combined responses; it remains unqualified.

Only after reviewed production probes pass in both languages, run the frozen 30-case corpus with `--live --output .wrangler/library-new.json`, then review it offline:

```sh
pnpm benchmark:enrichment --review .wrangler/library-new.json --judgments .wrangler/library-new.review.json --generation-report .wrangler/production-new.json --generation-judgments .wrangler/production-new.review.json --output .wrangler/library-new.reviewed.json
```

The full gate requires 27/30 relevant **complete** sets; English evidence for every accepted tag; factual grounding and correct article language for descriptions; a single sentence and non-null description in designated generation cases; schema-valid outputs; and reviewed combined production diagnostics covering generation in both languages. Three irrelevant sets are allowed only when their tags still have complete English/evidence judgments. The full gate never passes on keyword overlap alone, and no evaluation command enables production.

## Remaining limitation and options

Within these bounded experiments, this 1B model did not reliably obey the combined schema and description constraints. More focused same-model prompt experiments or an owner-approved change to the product contract remain possible. Any larger model, increased production token allowance, extra production request or activation requires a separate explicit decision. Manual tagging and existing description fallbacks remain available. Mocked tests establish scheduling and validation behavior, not readiness of the model.

Validation: all 212 Worker/D1 tests passed with `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false pnpm exec vitest run --maxWorkers=1`; the 97 affected tests passed separately under default scheduling. The default parallel suite hit the existing extraction benchmark's five-second timeout (211 tests passed); that benchmark passed alone without raising its timeout. All nine offline evaluator tests, `pnpm typecheck` and `pnpm build` passed. Browser/backup checks were not run because those paths are unchanged. The recorded production semantic review correctly exits 1.
