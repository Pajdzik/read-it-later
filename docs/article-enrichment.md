# Article tags and fallback descriptions

Tags and descriptions are editable in article details. Tag chips and the tag picker filter the reading list together with search and read state. Tags are normalized with Unicode NFKC, lowercase, and collapsed whitespace. Owner edits permit ten tags of at most forty Unicode characters. Generated descriptions are labeled separately.

## Configuration and release gate

`ARTICLE_ENRICHMENT_ENABLED` is **false** in every checked-in environment. Production and staging have a native Workers AI `AI` binding; default local development has none. Set `ARTICLE_ENRICHMENT_DAILY_LIMIT` to an integer from 0 through 100 (default 100). Zero defers requests without spending inference. The enable switch pauses processing independently of capture, retaining durable pending jobs.

The initial live evaluation on October 31, 2026 (Pacific time) **failed**. On thirty synthetic topic fixtures (fifteen English, fifteen Polish), the configured `@cf/meta/llama-3.2-1b-instruct` produced **0/30 usable schema-valid responses**. Responses frequently exceeded the tag limit, omitted required fields, or ran out of output tokens. Follow-up system/user-message probes returned 0/4 valid responses; a constrained-JSON probe was rejected by the provider. The implementation uses system/user messages and application validation, and never silently accepts or repairs malformed output.

The initial thirty calls used 9,659 input and 4,854 output tokens, with median latency 1,189 ms and p95 latency 1,795 ms. Gross inference cost was approximately **$0.00124**, before Cloudflare's shared daily allowance. This is an inference cost calculation from reported token usage, not an account invoice. See the [recorded results](benchmarks/article-enrichment-1b.json) and [fixtures](../benchmarks/enrichment-fixtures.json). These are synthetic article excerpts, not an evaluation of the owner's real library. No private library data was read or sent.

Keep generation disabled. Before activation, repeat the evaluation on thirty representative English/Polish articles and require at least 27 relevant tag sets, grounded descriptions throughout, and no invalid accepted output. Review English tag consistency and the language of every generated description. Do not change models or enable production automatically. Manual tagging and filtering do not depend on inference.

Run `pnpm benchmark:enrichment --live` to evaluate the thirty public fixtures through an ephemeral local Worker and the real native AI binding. This spends thirty calls without retries, writes `.wrangler/enrichment-evaluation.json`, and does not deploy, read D1, or enable the feature. `--probe` restricts it to four development cases. Automated checks use mocks and disable remote bindings.

## Processing and cost controls

New inserts made while enabled record intent and their enrichment job in the article-save transaction. Duplicate saves, older articles, and imports receive no new intent. The queue transports `{version:1,kind:"enrichment",articleId}` alongside unchanged legacy extraction messages. Hourly recovery repairs missed notifications, materializes missing jobs, and recovers expired leases. Terminal jobs remain until deletion, preventing implicit regeneration.

Enrichment waits for extraction to finish. A reviewed browser clip sends owner-only `enrichAfterCopy:true` on creation so inference cannot race its separate Markdown PUT. Such jobs wait for a saved copy, including manual recovery of a failed copy upload. Link-only saves and terminal extraction failures can use meaningful supplied metadata; hostname/path placeholders are skipped. No enrichment path fetches the source or publishes to an integration.

Existing supplied/extracted descriptions win. Otherwise the processor tries the first meaningful prose paragraph from saved Markdown; a generated description is requested only when that fails and article text exists. The same inference request chooses two to five English tags, preferring a bounded list of existing library tags. Responses may contain fewer tags when evidence is weak. Descriptions are at most 280 Unicode characters, also obey the existing 500 UTF-16-unit metadata envelope, and use the article's language. A link-only save cannot acquire an invented description from its title.

Before sanitization, preprocessing reads at most the first 32 KiB UTF-8 of saved Markdown and uses linear delimiter scanners so malformed copies cannot cause quadratic CPU work. The complete logical prompt is bounded to 8 KiB UTF-8, including instructions and vocabulary, and output is limited to 192 tokens. The model is called through the native binding without an SDK, vector index, or added service. At the documented $0.027/M input and $0.201/M output tokens, 1,500 input plus 150 output tokens costs about $0.07 per thousand requests, before the 10,000-neuron daily allocation shared with other account usage. Extraction, D1, queue, and existing hosting costs are additional. [Cloudflare pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/).

Before each call, a D1 transaction reserves a daily attempt and increments the claimed job's attempts. Reservations are not refunded for provider failures, timeouts, crashes, or uncertain outcomes. Duplicate deliveries cannot exceed the shared allowance. Excess work is deferred to the next UTC day without consuming a retry. Transient failures receive one retry; malformed output is terminal. A successful article never regenerates after ordinary edits, recaptures, or duplicate saves.

Claims use lease tokens and expiry. The job records the prompt fingerprint and copy revision. Completion checks the current copy revision and metadata snapshot in a transaction, discarding changed/deleted inputs and fencing expired/replaced leases. Manual tag edits and description edits—including clearing—are protected. An explicit metadata-refresh recapture retains its existing owner-authorized behavior, and undo restores description provenance with the rest of its snapshot.

Logs contain article IDs, stable status/error codes, attempts, latency, bounded prompt bytes, and provider token usage when available. They contain no article text, prompts, URLs, or provider exception messages. Inspect `article_enrichment_jobs` for failures, `enrichment_daily_usage` for reserved calls per UTC day, and oldest indexed pending jobs for backlog. Operational jobs, counters, leases, and intent are not portable article data.

## API and backups

- Article DTOs add `tags`, `descriptionOrigin` (`manual`, `extracted`, `generated`, or null), and `tagsManuallyEdited`. List/detail responses include optional compact `enrichment` status. Tags and statuses load in batches.
- Owner PATCH supports `tags` alongside existing metadata. Provenance and protection cannot be patched directly. Capture tokens cannot edit tags, metadata, provenance, or reviewed-copy waiting intent.
- Authenticated `GET /api/tags` returns `{tags:[{tag,count}]}`. `GET /api/articles?tag=...` matches a normalized exact tag and combines with existing search/read-state filters and cursors.
- JSON and ZIP `library.json` exports use v3, retaining copies, tags, provenance, and protection flags. v1/v2 imports remain supported; restoration never schedules enrichment. Existing nonempty descriptions migrate as protected/manual.
- GitHub frontmatter v2 preserves the same metadata. The converter and identity reconciler still accept v1. New tags change the portable Markdown fingerprint, so an existing GitHub backup becomes outdated until the owner explicitly saves it again.

Apply migration `0012_article_enrichment.sql` before deploying the Worker. The migration also extends existing recapture snapshots so in-flight recovery and undo remain compatible. Deployment and production activation were not performed as part of implementation.
