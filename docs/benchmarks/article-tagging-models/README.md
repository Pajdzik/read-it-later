# Tagging-only model comparison — November 4, 2026

**GLM-4.7-Flash passes the tagging-only corpus gate: 30/30 useful English tag sets. Production remains disabled.** The corpus has 25 English excerpts from the owner's public Kamilpedia archive and five original Polish articles. All responses were schema-valid, and every tag and complete set has a recorded agent review against the exact supplied text. This qualifies GLM as the available candidate for a staging check; it is not a production activation or a ranking against an untested model.

| Model / stage | Calls | Structurally valid | Useful sets | Outcome |
| --- | ---: | ---: | ---: | --- |
| Llama 3.2 1B, six public development cases | 6 | 0 | 0 | Fails this prompt/configuration; not run on the final corpus |
| GLM-4.7-Flash, six public development cases | 6 | 6 | 6 | Proceeded to the frozen corpus |
| GLM-4.7-Flash, frozen corpus | 30 | 30 | 30 | Passes the 27/30 tagging-only gate |
| GPT-6 Luna, access checks | 2 | Unassessed | Unassessed | Provider billing failure; no model output or usage |

There was also one GLM interface smoke call. Its raw tags were valid, but the initial envelope adapter mistakenly treated an empty `tool_calls` array as an actual tool call. That adapter check was fixed before development/full evaluation. The original report is retained as `glm-smoke.json`, with an explanatory review; it is not counted as a model-quality failure. No model fields were repaired, no excessive tags were discarded, and no first JSON object was extracted from arbitrary text.

The [summary](summary.json) and [reservation ledger](calls.json) account for **45 new dispatches**, of which 43 returned usage: **33,829 input and 1,248 output tokens**, with **$0.0022563195 known estimated inference cost** before allowances. The two Luna billing failures supplied no usage, so complete aggregate cost remains unknown rather than being reported as zero. Historical 60-call experiments are separate and unchanged.

The full 30-case GLM evaluation used **23,941 input and 483 output tokens**, cost approximately **$0.0016416305**, and had **716 ms median / 2,477 ms p95 latency**. Development included a 7,721 ms outlier; the complete GLM sample including that development and smoke work has 741 ms median / 4,566 ms p95. These are small samples, not latency guarantees. Pricing comes from the [GLM model page](https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/): $0.0605/M input and $0.40/M output tokens. Luna's configured pricing is $0.10/M input and $0.50/M output, as documented in [official OpenAI documentation](https://developers.openai.com/api/docs/models/gpt-6-luna).

## Review and its limits

The [rubric](review-rubric.md) was frozen before full-corpus calls. It judges topic coverage and retrieval usefulness, allows synonyms and reasonable related topics, and explicitly permits a related password topic for a passkey article. It does not use expected keyword substrings, exact labels, ASCII-only tests, or another model as the judge. Descriptions are evaluated separately from this release and are not generated.

See [GLM results](glm-evaluation.json), [per-tag judgments](glm-evaluation.review.json), and the [computed gate](glm-evaluation.gate.json). Each review is tied to the complete report and exact input/request/raw-output digest. Offline review checks the frozen article identities and supplied text, rebuilds requests from saved input using current preprocessing and request construction, reparses raw provider envelopes with current strict validation, and rejects stale requests or accepted invalid output.

Three cases have partial coverage/specificity: anti-AI hype, rapid historical project execution, and Transformer-based generative AI. The anti-AI source's prose is fenced as code, so existing preprocessing leaves mostly its informative title; this result demonstrates title classification rather than full-body understanding. The HTTP-header set also includes a generic but related `abuse` tag. These limitations are recorded rather than hidden. Passing reflects an agent's usefulness judgments on these public excerpts, not human review, all possible future articles, or the full current library.

[Development inputs](../../../benchmarks/tagging-development-fixtures.json) contain four public English archive excerpts and two original Polish articles, all disjoint from the [unchanged frozen 30-case corpus](../../../benchmarks/enrichment-library-fixtures.json). Revisions, source URLs, excerpt policies and content hashes are recorded. No private library or production D1 data was read. Model configurations use the same tagging instructions and article text, with documented provider-specific schema constraints where supported; this compares deployable configurations rather than isolating model weights alone.

## Reproduce

Run offline checks without spending inference:

```sh
pnpm test:enrichment-evaluator
pnpm benchmark:enrichment --review docs/benchmarks/article-tagging-models/glm-evaluation.json --judgments docs/benchmarks/article-tagging-models/glm-evaluation.review.json --output .wrangler/glm-rechecked.json
```

The second command exits 0 for the recorded passing gate. Changing prompts, preprocessing, model parameters, raw output or review bindings makes it fail. The earlier combined-generation reports remain historical failed experiments; their stricter description requirements and subjective judgments were not rewritten to manufacture a passing tagging result.

Live commands require configured Wrangler authentication. Each reserves its attempt before dispatch, records failures/uncertain outcomes, makes one native binding request per case, never retries automatically, and refuses to overwrite an existing report:

```sh
pnpm benchmark:tagging --live --model glm --output .wrangler/glm-development-new.json
pnpm benchmark:tagging --live --model llama --output .wrangler/llama-development-new.json
pnpm benchmark:tagging --live --model luna --cases development-1-en --output .wrangler/luna-access-new.json
pnpm benchmark:tagging --live --model glm --stage evaluation --output .wrangler/glm-evaluation-new.json
```

Development runs make six calls; evaluation runs make thirty. `--cases` selects explicit IDs for small interface probes. Use `--review-template REPORT --output REVIEW` to create a blank sheet, complete every semantic judgment, then use `--review REPORT --judgments REVIEW`. A live run always exits 1 pending review. The user explicitly removed the 100-call task cap: new experiments use an append-only `.wrangler/tagging-calls.json` ledger with `maximum: null`. The old ledger was not reset. The production daily attempt cap remains independently limited to 100.

GLM uses `chat_template_kwargs.enable_thinking=false`, `max_completion_tokens=192`, and a JSON schema containing exactly `tags`. Luna uses the Responses format, `reasoning.effort=none`, `max_output_tokens=192`, `store=false`, and strict structured output. Luna requests use the `default` AI Gateway with caching/log collection disabled and at most one Gateway attempt. The 1B baseline retains its native messages input and `max_tokens=192`. Serialized complete requests, including schemas and roles, stay at or below 8 KiB. All exact requests, provider envelopes, usage and latency are retained.

## Luna access and next operating step

Luna returned an AI Gateway billing failure (access-check code 2021), before a model response. The current OAuth login also receives 403/code 10000 when reading Gateway inventory/balance, so the exact balance cannot be inspected. No applicable OpenAI key was present in the project's environment files. Luna remains **unassessed**, not worse than GLM.

To resume Luna, configure Unified Billing credit/access on the `default` AI Gateway, or store an OpenAI provider key under its `default` alias. [Cloudflare documents the credential and billing behavior](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/). Never paste a key in chat. Recheck one case first, then the disjoint development set and, if promising, all thirty evaluation cases. No billing purchase or credential change was made by this task.

The implementation pins GLM for tagging only. All checked-in `ARTICLE_ENRICHMENT_ENABLED` values remain false. Next is an explicit staging activation/check and owner-approved production enablement with the daily cap retained. New saves are eligible; existing-library backfill remains a separate action. This task performs no deployment, activation or backfill.

Application code supports GLM exclusively. Llama/Luna adapters and pricing live in `benchmarks/tagging-models.ts`; the old combined description-generation experiment lives in `benchmarks/legacy-enrichment.ts`. Neither is imported by the application. The GLM comparator calls the application request builder and parser directly, preserving offline verification against production behavior. Historical evidence stays unchanged, and `benchmark:tagging` now defaults to GLM.

## Implementation validation

Passed 198 Worker/D1 tests across 17 files with remote bindings disabled, all 14 evaluator tests, all project and benchmark type checks, and the web/Worker build (Wrangler dry run only). The recorded GLM review also passes offline against the current implementation. Regression coverage includes complete request byte limits, Unicode/escaping, relevant vocabulary, exact output contracts, one request without repair, manual edits, attempts/retries, leases and extraction independence. Browser/capture and backup paths were unchanged. Removing alternative model support from application code required zero new live calls; existing exact-request/output evidence verifies the unchanged GLM behavior.
