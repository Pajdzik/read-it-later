# Markdown capture when pasting or sharing a URL

Add requests a background Markdown copy by default using `captureMarkdown: true` on the owner-authenticated `POST /api/articles` route. The response confirms a saved link and durable extraction intent, not a completed copy. It returns `extraction` status instead of the former synchronous `copy`/`copyCaptureError` fields. The original URL, identity, saved date, and read state remain independent of extraction.

The iOS Shortcut's save-only `POST /api/capture` route defaults to requesting extraction, so existing `{url, title?}` payloads work. Tokens receive only a coarse `extractionRequested` flag, never Markdown, revisions, or job history. They cannot access owner status/retry endpoints or submit a copy. Explicit `captureMarkdown: false` saves a link only; omitting the field on the owner article route also remains link-only for API compatibility. Saves never fetch the source inline, and link-only saves retain supplied/fallback titles without metadata enrichment.

The scheduled Worker processes one eligible D1 job per minute, with conditional leases, three-attempt transient backoff, crash recovery, owner retry, and create-only copy completion. Saving an existing URL reuses its job and does not reset an exhausted retry budget. Background completion cannot overwrite a pasted/uploaded/browser copy or a title edited during extraction. Failure leaves the link intact and exposes a stable reason in details.

Details and the reader show capturing, retrying, ready, failed, and paused states. An open view polls while capture is pending and pauses in hidden tabs. The ready copy uses the existing sanitized reader, survives reload, and remains in version-2 exports. Reading never marks the article read automatically. A dirty editor draft remains available when a background copy arrives.

The processor accepts public complete UTF-8 HTML up to 512 KiB, parses with inert LinkeDOM/Defuddle without scripts, embedded requests, cookies, or third-party fallback APIs, and requires nonempty Markdown at most 256 KiB UTF-8. Manual redirects are bounded and validated. Blocked/authenticated/dynamic/non-HTML/oversized sources may require browser capture or paste/upload instead.

Background captures keep the compatible `source: "paste"` copy value. GitHub publishing remains an explicit separate action. The bookmarklet explicitly opts out of background extraction before saving its reviewed local draft, avoiding a race with server content.

Processing ships **paused** until the protected `ARTICLE_FETCHER` service binding is configured and `BACKGROUND_CAPTURE_ENABLED=true` is selected after staging validation. Missing binding or a false flag makes scheduled work a no-op; saves still persist intent and the owner sees “Capture paused.” The binding must enforce public DNS/CNAME/connection destinations, with TLS hostname validation. Ordinary Worker fetch or DNS preflight is not a substitute. No deployed safe-egress or CPU benchmark is claimed.

See the [design and recovery rules](background-markdown-extraction.md) and [activation instructions](deployment.md#background-markdown-extraction). Jobs and leases are operational state, omitted from portable backups; import does not fetch restored links.
