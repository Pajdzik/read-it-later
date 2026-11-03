# Markdown capture when pasting or sharing a URL

> **Superseded proposal.** The design and rollout text below is retained as a historical record. Its references to live production configuration and earlier API behavior are not current operating instructions.

## Current behavior

Capture requests create a D1 article and initial extraction job atomically. The Worker sends a Queue notification after commit; the queue consumer invokes the private capture service. Retries and recaptures persist job state before notification. A failed notification does not require a separate intent/materialization pass. Restores do not fetch URLs or create jobs.

The current bindings are placeholders and capture remains disabled pending the [fresh database reset](prelaunch-reset.md). Use [unified ingestion](unified-ingestion.md) for the current processing, PDF, and archive contract. GitHub delivery is an explicit generic integration; it is not part of URL capture.

## Historical capture proposal

<details>
<summary>Original proposal and validation record (superseded)</summary>

Add requests a background Markdown copy by default using `captureMarkdown: true` on the owner-authenticated `POST /api/articles` route. The response confirms a saved link and durable extraction intent, not a completed copy. It returns `extraction` status instead of the former synchronous `copy`/`copyCaptureError` fields. The original URL, identity, saved date, and read state remain independent of extraction.

The iOS Shortcut's save-only `POST /api/capture` route defaults to requesting extraction, so existing `{url, title?}` payloads work. Tokens receive only `{ok:true, extractionRequested}` with HTTP 200 for both new and duplicate saves; the response does not reveal stored article metadata or whether the URL was already saved. Tokens never receive Markdown, revisions, or job history, cannot access owner status/retry endpoints, and cannot submit a copy. Explicit `captureMarkdown: false` saves a link only; omitting the field on the owner article route also remains link-only for API compatibility. Saves never fetch the source inline, and link-only saves retain supplied/fallback titles without metadata enrichment.

The Worker publishes queue notifications after durable saves and processes delivered D1 jobs sequentially, with conditional leases, three-attempt transient backoff, crash recovery, owner retry, and create-only copy completion. An hourly recovery sweep repairs missing jobs and republishes unfinished work. Saving an existing URL reuses its job and does not reset an exhausted retry budget. Background completion cannot overwrite a pasted/uploaded/browser copy or a title edited during extraction. Failure leaves the link intact and exposes a stable reason in details.

Article indicators, details and the reader show queued, capturing, retrying, ready, or failed states. A service-wide pause appears once above the library; it is not repeated beside each article and does not hide a saved-copy checkmark. An open view polls while capture is pending and pauses in hidden tabs. The ready copy uses the existing sanitized reader, survives reload, and remains in version-2 exports. Reading never marks the article read automatically. A dirty editor draft remains available when a background copy arrives.

The private Cloudflare Container executor accepts public UTF-8 HTML up to 2 MiB or PDFs up to 20 MiB. Native Node connections pin validated public IPs; redirects and downloads remain bounded. Inert LinkeDOM parses HTML metadata in a bounded thread, and Cloudflare `toMarkdown` converts fetched HTML/PDF bytes with a 45-second managed-conversion deadline. Nonempty Markdown must fit within 256 KiB UTF-8. PDF originals are preserved privately before conversion, including on text-extraction failure. Blocked/authenticated/dynamic/unsupported/oversized sources may require a reviewed browser clip or manual Markdown instead. Defuddle remains in browser clips, not server-side conversion.

The 2 MiB source bound accommodates large prerendered pages: the Cursor article `/blog/git-at-any-scale` returned 718,354 bytes with the capture user agent on 2026-10-27, after production recorded `source_too_large` for article `h4r92shc`. HTML metadata parsing retains its five-second thread deadline; managed conversion has a separate 45-second deadline and 256 KiB Markdown output limit.

Background captures keep the compatible `source: "paste"` copy value. GitHub publishing remains an explicit separate action. The bookmarklet explicitly opts out of background extraction before saving its reviewed local draft, avoiding a race with server content.

Checked-in Wrangler configuration enables processing in production and disables it in local defaults and staging. The production service binding points to the private `ARTICLE_EXTRACTOR` Container. See the [production activation evidence](unified-ingestion.md#production-activation-evidence-october-31-2026) for the verified deployment and the limits of its smoke checks. A missing binding or false flag makes scheduled work a no-op; saves still persist intent and the owner sees “Capture paused.” The executor resolves all returned addresses, rejects a mixed public/private result, and connects to a selected public numeric IP using native Node HTTP(S), preserving the original hostname for TLS verification. Defuddle runs outside the app Worker in a thread with a 5-second deadline and bounded heap. Workers Paid is required; local tests do not establish deployed security, latency, or costs.

See the [design and recovery rules](background-markdown-extraction.md) and [activation instructions](deployment.md#background-markdown-extraction). Jobs and leases are operational state, omitted from portable backups; import does not fetch restored links.

</details>
