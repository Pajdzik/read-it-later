# Managed HTML/PDF capture and complete archives

HTML and PDF URLs use the same durable background capture flow. Saving a link
commits the article and intent immediately, then publishes a Queue notification.
The consumer calls the private Container for that article and generation; the
phone/browser can close after acknowledgment. An hourly sweep repairs missed
notifications and expired leases and cleans unreferenced PDFs and archive sessions.

## Processing and trust boundary

The Container fetches source documents using native public-IP-pinned Node sockets.
Every redirect retains the existing destination, TLS, encoding and deadline
checks. HTML is limited to 2 MiB; PDFs to 20 MiB. PDF and octet-stream responses
must begin with `%PDF-`; filename extensions are not authoritative. HTML still
requires a supported UTF-8 HTML content type and recognizable document markup.

HTML metadata parsing stays in the inert, network-disabled thread with a
five-second wall-clock and bounded heap. Its title/author/description rules remain
unchanged. Server-side Markdown conversion now uses Workers AI `toMarkdown`,
through the static `potem.convert` outbound hostname. The final fetched HTML URL
is supplied as `html.hostname`; no site-specific CSS selector is used. Embedded
image conversion and OG image conversion are explicitly disabled: no image
inference, summarization or OCR is requested. Defuddle remains a browser-clip and
historical benchmark dependency; it is no longer in the production Container.

**Keep outbound interception static and host-specific.** Do not add catch-all
outbound handlers, allow/deny lists, dynamic outbound overrides, or HTTPS
interception to this Container. Those settings promote interception of source
traffic and can invalidate the native socket pinning boundary.

Managed conversion has a 45-second local deadline. Its returned Markdown must be
nonempty and at most 256 KiB UTF-8. Generated document/Contents/Page headings alone do not count as extracted PDF text. The executor has a separate 75-second deadline covering source fetch, metadata, D1/R2 staging, virtual transport and response reads; caller disconnects cancel it. The application still enforces the 90-second capture deadline and two-minute D1 job lease. Conversion, storage and source errors
are reduced to stable codes; dependency diagnostics and document content are not
logged. Managed output quality requires live staging review; fixture adapters do
not establish Cloudflare conversion fidelity.

## Original PDFs and recovery

The private capture Worker and app bind the same environment-specific D1 and R2
resources. The outbound handler registers a staged `pdf_assets` row, writes the
PDF with its SHA-256 checksum, and converts those exact bytes. The Container does
not receive database credentials or an R2 API token.

Results can contain `originalPdf` plus Markdown, or `originalPdf` plus a safe
`conversionError`. The processor attaches the asset under the current job lease.
Scans without embedded text, encrypted/corrupt conversion failures and output
overflow can therefore retain an original without creating a truncated copy.
Transient conversion and storage failures use existing bounded retries, including lookup and download of a stored original. A failed copyless recapture can preserve the first original while leaving any existing original/copy intact. Initial retries reuse the preserved file; explicit recapture fetches the URL again.

Successful recapture replaces the original/copy pair transactionally. The existing
one-step recovery snapshot retains the preceding PDF reference, and undo restores
the pair. Failed recaptures preserve the existing pair; manual copy writes and
stale/deleted jobs retain their existing fencing protections.

Authenticated article detail/list/PATCH responses optionally include
`originalPdf: {id,checksum,bytes,capturedAt,sourceUrl}`. IDs are opaque asset UUIDs;
object keys and credentials are not exposed. `GET /api/articles/:id/pdf` streams
the private file with single-byte-range support and sandbox/no-store headers.
`?download=1` requests an attachment. Reader links include `asset=<id>` to select the PDF matching the displayed copy; this can select the current or retained undo original while a recapture completes. Owner sessions are required; capture tokens
cannot read originals. Opening/downloading never changes read state. Reader and
details provide Open saved PDF and Download PDF; a custom PDF viewer is deferred.

Unreferenced objects are a durable cleanup queue in D1. Creation/replacement/
deletion schedules cleanup after 24 hours. Current articles, recovery snapshots,
and active import/export sessions protect their references. Cleanup claims an
unreferenced asset before R2 deletion; triggers prohibit publishing a deleting
asset. Failed deletions retry on later ticks. Cleanup failures do not block other
capture jobs. Expired archive sessions are removed independently of capture
enablement. Buckets must stay private; do not enable r2.dev or a public domain.

## Portable archive format and restore

Settings offers **Export complete archive** and **Restore archive**. JSON export
is explicitly labeled as excluding PDF originals; existing version-1/2 JSON
imports remain supported.

The complete archive is streaming, uncompressed ZIP64, containing:

- `library.json`: the existing version-2 article/copy envelope;
- `manifest.json`: `{version:1,exportedAt,pdfs:[{articleId,id,checksum,bytes,capturedAt,sourceUrl}]}`;
- `pdf/<asset-id>.pdf`: one file per referenced original.

ZIP64 supports binary archives over 4 GiB without buffering the whole archive.
PDFs are already compressed, so entries use the stored method. The exporter takes
an atomic D1 snapshot of article/copy data and pins original references for the
stream's lifetime, up to 24 hours. Export excludes auth, jobs and undo history.
Metadata limits are 100,000 articles, 64 MiB library JSON, and 16 MiB manifest JSON.
PDFs retain the 20 MiB individual limit.

The browser reads the ZIP64 directory and file slices, validates entry names,
overlaps, CRC32 checksums, PDF signatures and SHA-256 checksums before starting a
restore. Restore supports this application's stored ZIP64 format, not arbitrary
third-party ZIP files. It does not expand files into filesystem paths or buffer
the entire binary archive. Archive metadata batches allow 2 MiB so a full 256 KiB Markdown copy still fits even with worst-case JSON escaping. Ordinary JSON import retains its 1 MiB bound.

All archive routes use owner-session authentication and existing write Origin/
CSRF checks:

| Route | Contract |
| --- | --- |
| `GET /api/archive` | Stream the complete ZIP download |
| `POST /api/archive/imports` | `{}` creates a 24-hour staging session and returns `{id}` |
| `POST /api/archive/imports/:id/records` | Stage bounded `{library,pdfs}` metadata batches, at most 2 MiB each |
| `PUT /api/archive/imports/:id/files/:archiveAssetId` | Upload one bounded PDF; verify expected signature, size and checksum |
| `POST /api/archive/imports/:id/complete` | `{}` verifies all expected files and closes metadata/file uploads |
| `POST /api/archive/imports/:id/commit` | `{}` merges the next bounded article batch; returns `{imported,skipped,done}` |

Metadata and files are staged before any library changes. Each commit batch is
transactional with its progress markers. Metadata batching counts the full envelope, including PDF manifest entries, and commit queries cap returned bytes in SQL. Completion checks and seals the session in one write. Each commit claims a transaction nonce and checks that its session is active and its records remain uncommitted, preventing stale requests from recreating deleted articles or publishing expired sessions. Existing normalized URLs are skipped
without attaching incoming copies/PDFs; ID conflicts retain existing data and
produce an error. Restore is additive and batch-transactional, not an all-library
rollback operation. Repeating an archive skips existing articles. A partially
committed restore can be resumed by restoring the same archive; committed records
are preserved. Staged, skipped and abandoned files become cleanup candidates after
the session expires. An empty archive is supported.

## Rollout and validation

Migrations `0010_pdf_assets.sql` and `0011_archive_commit_guard.sql` are additive and must be applied before deploying the capture service and app. Both app and capture configs set
`MANAGED_CONVERSION_ENABLED=false`, including production. Existing background
intent remains durable while paused. Enable only after staging validation.

1. Configure the staging owner, exact origin and real D1 ID in both configs;
   current staging values are placeholders. Keep staging resources separate from
   production. Configure OAuth secrets and an account token with Workers/Containers,
   D1, R2 and Workers AI deployment permissions through the normal secret workflow.
2. Provision private Standard R2 buckets `read-it-later-pdfs-staging` and, when
   releasing production, `read-it-later-pdfs-production`. CI checks/provisions the
   production bucket before deployment. Do not apply bucket-wide expiry rules:
   cleanup must honor D1 references.
3. Build assets, apply migrations and deploy the private capture service. Provision
   the environment Queue with `pnpm queue:ensure --env staging --execute`, then
   deploy the compatible app with managed conversion disabled. Use environment-specific
   commands; the `capture:deploy` helper describes the older fetch gateway and is
   not the managed-conversion release path.
4. In staging, set `MANAGED_CONVERSION_ENABLED=true` in both app and capture
   configuration, and `BACKGROUND_CAPTURE_ENABLED=true` in the app, then redeploy.
5. Save representative HTML with navigation, code, links and tables; review full
   article text/metadata and relative link resolution. Save tagged/untagged PDFs,
   a scan and an encrypted/corrupt fixture. Check preserved bytes, safe errors,
   pause/retry, private-only access, recapture/undo, and actual latency/resource use.
6. Export the staging archive and restore it into a fresh isolated D1/R2 pair.
   Compare article IDs, dates/read state, copy revisions/text, PDF checksums and
   repeat-import behavior. Verify browser and physical-device PDF access.
7. Enable production only after these gates pass. To pause conversion, disable
   the app flag first; reader access, manual copies, archives and cleanup remain
   available. Rolling back application code does not reverse D1 migrations.

Local checks: `pnpm typecheck`, `pnpm test`, `pnpm test:capture`, `pnpm build`,
`pnpm test:browser`, `pnpm test:mobile`, and `pnpm test:archive`. The Worker/D1/R2
suite and browser smoke exercise complete PDF archive round trips with a fixture
converter. `pnpm check:capture` additionally requires a working Docker engine.
`pnpm types` and `pnpm types:capture` regenerate the committed bindings.

References: [Markdown conversion](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/),
[conversion options](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/conversion-options/),
[Container binding handlers](https://developers.cloudflare.com/containers/configuration/workers-connections/),
and [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).

## Local and remote-converter evidence (October 31, 2026)

The real remote Workers AI converter passed one synthetic HTML fixture (article
text, clutter removal, bold, relative link, code and table) and one 626-byte PDF
fixture with two embedded text lines. Observed round-trip wall times were 199 ms
and 133 ms; these single samples establish no latency percentile or CPU budget.
The trial used an isolated local Worker/D1/R2 with the app's August 1 compatibility
date and a remote AI binding. The pinned local workerd supports dates only through
October 7, so it cannot run the capture Worker's October 19 configuration locally.
No production library or settings were changed. See the [sanitized fixture report](benchmarks/managed-conversion-fixtures.json).

Type checks, Worker/D1/R2 tests, native capture/fetch tests, app and capture-Worker
packaging, desktop/mobile browser smoke, and the existing archive rehearsal pass.
The full Docker image build could not run because Docker Desktop did not expose
an engine; capture-Worker packaging was checked with `--containers-rollout=none`.
Deployed Container routing, remote staging R2/D1, real-world article fidelity,
physical-device PDF viewing and production rollout remain explicit release gates.

## Review regressions

An independent subagent reproduced the real converter's nonempty outline for both
blank and image-only PDFs. Regression coverage now distinguishes these outlines
from real headings, bounds manifest-heavy restores and D1 query results, and
interleaves session finalization and stale commits to verify publication fences.
Native HTTP tests verify deadline cancellation, stalled-response cancellation and
recovery after a disconnected caller. Storage fault tests cover original lookup,
attachment, R2 downloads and interrupted stored-file streams.
