# Gemma 4 tagging evaluation — November 5, 2026

**Gemma 4 26B A4B meets the unchanged tagging-only gate: 28/30 useful English tag sets, with all 30 responses structurally valid.** The five Polish articles produced three useful sets; the twenty-five English articles all produced useful sets. The two unsuccessful sets used accurate English categories but were too generic to identify the articles' specific subjects. Production remains disabled and GLM remains the sole application model.

| Same frozen 30-case corpus | GLM-4.7 Flash, recorded baseline | Gemma 4 26B A4B |
| --- | ---: | ---: |
| Schema-valid responses | 30/30 | 30/30 |
| Useful complete tag sets, agent review | 30/30 | 28/30 |
| Useful sets on Polish articles | 5/5 | 3/5 |
| Input / output tokens | 23,941 / 483 | 24,745 / 426 |
| Median / p95 latency | 716 / 2,477 ms | 605 / 2,259 ms |
| Estimated cost, before allowances | $0.0016416305 | $0.0026023 |
| Cost extrapolated to 1,000 articles | $0.0547 | $0.0867 |

All thirty complete serialized requests are **identical between models**, including the system/user messages, supplied article text, strict tags-only JSON schema, disabled thinking, temperature zero, 8 KiB complete request budget and 192-token completion limit. The only dispatch difference is the requested model ID. No prompt tuning, extra examples, vocabulary changes, repair requests or retries were used. Responses are parsed through the same strict chat-completion/output validation. The requested Gemma ID is `@cf/google/gemma-4-26b-a4b-it`; the raw provider envelopes identify its backend with an `-external` suffix, preserved verbatim.

Gemma was slightly faster in these separate single-run samples, but that is not a controlled or statistically conclusive performance result. Its full-run standard-token cost was about 1.59 times GLM's. Both meet the threshold, while this recorded comparison favors retaining GLM for its more specific Polish tags and lower cost. No automatic model switch is made.

## Review evidence

The [original review rubric](../article-tagging-models/review-rubric.md) and [frozen 25-English/5-Polish corpus](../../../benchmarks/enrichment-library-fixtures.json) are unchanged. Six public development excerpts remain disjoint from the corpus. Two initial smoke cases (one English and one Polish) passed review, followed by the four remaining development cases, then the full thirty. There were no extra probe calls.

See the exact [full evaluation](evaluation.json), [agent judgments for every returned tag](evaluation.review.json), and [computed gate](evaluation.gate.json). Reviews bind to complete inputs, parameters, raw output and parsed tags; offline gates reject missing/stale review, changed corpus membership, changed preprocessing/requests, invalid output, or accepted non-English tags. This is agent review of public excerpts, not owner approval, a private-library evaluation, or a guarantee about future saves. No descriptions were generated or evaluated.

The two complete sets rejected as insufficiently useful were:

- **B-drzewo (B-tree):** Gemma returned `computer science`, `data structures`, `databases`; GLM returned `b-trees`, `data structures`, `databases`. Gemma's set lacks a specific tree/indexing label.
- **Kolejka (informatyka), queue:** Gemma returned only `computer science`, `data structures`; GLM included `fifo` and `queue`. The entire Gemma set is generic umbrella categories.

Gemma also improved specificity in some English cases: it included `project management` for the rapid-project-execution article and `transformer model` for the Transformer/generative-AI article. Five English sets have partial coverage or specificity, recorded individually rather than hidden. The feedback article, for example, has useful leadership/communication labels but lacks a direct feedback label.

Two source/preprocessing limitations deserve explicit attention. The anti-AI-hype evaluation article loses its fenced prose and is classified mainly from its informative title. The **Attention Is All You Need development case** contains the recognizable paper title/arXiv metadata rather than its technical abstract. The earlier GLM development review overstated what technical content was actually supplied; [a hash-bound correction](review-addendum.json) records that error while preserving the historical report and judgments. That development case is outside the thirty-case release corpus, so it does not change either full-corpus score. Gemma's review explicitly marks the case as partial title/identity-based classification.

## Attempts and cost

There were **36 new dispatches**, all returning usage: **29,392 input and 506 output tokens**, including **640 cached input tokens**. Total median latency was 618 ms and p95 was 2,379 ms. The conservative standard-token inference estimate is **$0.003091** before shared allowances, using [Gemma's documented $0.10/M input and $0.30/M output rates](https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/). Cached input is counted at the standard input rate because this model page does not publish a cache discount.

Raw responses also reported **278.090896 neurons** across all calls. At [Cloudflare's $0.011 per 1,000 neurons](https://developers.cloudflare.com/workers-ai/platform/pricing/), these imply approximately **$0.003059** before allowances. This separate provider-usage estimate is slightly lower; no undocumented cached-token rate was inferred or applied. Neither calculation is an account invoice.

The append-only [ledger snapshot](calls.json) contains the prior 45 comparison reservations followed by new reservations **46–81**. The previous raw reports, judgments, ledger and separate summary remain unchanged. The older 60-call synthetic combined-generation investigation remains in its original ledger and is not mixed into this run. The user's expanded experiment budget permits these calls; the independently enforced production daily limit remains 100.

## Reproduce

Offline review and regressions spend no inference:

```sh
pnpm test:enrichment-evaluator
pnpm benchmark:enrichment --review docs/benchmarks/article-tagging-gemma/evaluation.json --judgments docs/benchmarks/article-tagging-gemma/evaluation.review.json --output .wrangler/gemma-rechecked.json
```

For a new run, configure Wrangler authentication and use fresh output paths; the harness refuses to overwrite old live evidence:

```sh
pnpm benchmark:tagging --live --model gemma --cases development-1-en,development-5-pl --output .wrangler/gemma-smoke-new.json
# Review smoke output before continuing.
pnpm benchmark:tagging --live --model gemma --cases development-2-en,development-3-en,development-4-en,development-6-pl --output .wrangler/gemma-development-new.json
# Review all development output before continuing.
pnpm benchmark:tagging --live --model gemma --stage evaluation --output .wrangler/gemma-evaluation-new.json
```

Each live run exits 1 until its output has received semantic review; a raw run cannot declare itself qualified. Create a blank review using `--review-template REPORT --output REVIEW`, complete every judgment against the exact model request, then run `--review REPORT --judgments REVIEW`. The harness reserves before dispatch, records uncertain/failed attempts, makes no automatic retries, uses the installed Wrangler/workerd with compatibility date `2026-08-01`, and starts only an authenticated loopback evaluation Worker with a remote AI binding. It never deploys, reads production D1 or changes the enable switch.

Gemma support and pricing live only in `benchmarks/tagging-models.ts`. The application still supports GLM exclusively. All checked-in enrichment switches remain false.

Validation passed: 198 Worker/D1 tests across 17 files with remote bindings disabled, 15 evaluator tests, all project/benchmark type checks, the web/Worker build (dry run only), and offline replay of the Gemma gate. The built Worker contains GLM only; the Gemma adapter is absent. Browser/capture and backup paths were unchanged.
