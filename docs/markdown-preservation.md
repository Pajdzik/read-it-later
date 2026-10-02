# Manual Markdown preservation (A01 decision and A02 design)

## Decision

The next unimplemented product feature is A02: a private Markdown copy attached to a saved link. The unchecked MVP items have code already; their external release checks remain pending. For A01, select owner-provided Markdown only. Automatic extraction (A04) is deferred because the existing metadata fetch has not proven DNS, redirect, or rebinding protection. No extraction packages, background jobs, paid services, or new storage bindings are needed. No deployed extraction benchmark is claimed.

Owners can paste Markdown or load a UTF-8 `.md`/`.markdown` file in article details. The file fills an editable textarea; saving is explicit. Show whether a copy exists, its capture time, source (paste/upload), and UTF-8 byte size. A failed load or save must preserve the draft and explain how to retry. Existing original-link and read controls keep their behavior. Markdown is editable text in this phase; sanitized reading and download belong to A03. External image URLs are not an offline replica.

## Storage and API

The selected implementation stores copies only in D1. GitHub Markdown backup is a deferred, optional task (A06 in the implementation tracker), with D1 remaining authoritative if backup is added later.

Add migration `0004_article_copies.sql`: one `article_copies` row per article, foreign key with `ON DELETE CASCADE`, Markdown text, `captured_at`, `source` (`paste` or `upload`), and an opaque revision. Keep copies out of ordinary list payloads. Copy writes never update article URL, title, timestamps, or read state. Saving a URL and saving a copy are separate operations so copy failures cannot undo a saved link.

`GET /api/articles/:id/copy` returns `{copy: null}` for an article without a copy, or `{copy: {markdown, capturedAt, source, revision}}`. A nonexistent article returns 404. `PUT` accepts `{markdown, source, expectedRevision}`. `expectedRevision: null` creates only when no copy exists; replacement requires the revision just read. A stale or absent expectation returns 409 without changing content. The browser asks for replacement confirmation before submitting an existing revision. Use an atomic conditional SQL write to enforce this across concurrent requests.

Both routes require the existing owner session; PUT additionally requires same-origin and CSRF checks. Capture tokens cannot access copies. Responses are private/no-store. Reject blank copies and content exceeding 262,144 UTF-8 bytes. Bound the streamed JSON envelope to 2 MiB to accommodate JSON escaping at the maximum content size; do not relax ordinary JSON request bounds. Validate source/revision and unknown fields. Never render submitted content as HTML or fetch its embedded URLs.

## Backup compatibility

Export version 2, with an optional `copy` field on each article (the same metadata/content object). Stream at a small page size with bounded copy retrieval, rather than collecting the full library in memory or querying per article. Import accepts versions 1 and 2; version 1 retains its existing behavior. Keep the existing 1 MiB/1,000-article import limits. Validate every copy before a transactional batch; insert copies only for newly inserted articles, never attach a skipped duplicate's copy to another record or overwrite an existing copy. Preserve exported capture metadata and revision. Invalid copies or storage failures roll back the whole batch. Large libraries must use bounded, valid import files; a full export can exceed the import bound, as before.

The implementation reads 25 articles and their copies in one joined query, then serializes one article per stream pull. This avoids whole-page JSON expansion for escaped text. Export remains subject to the runtime's per-invocation query budget; very large libraries can exceed that budget and require a future paged export protocol. A truncated/failed export must not be treated as a valid backup.

## Platform basis

Checked October 1, 2026: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) allow 2,000,000 bytes per string/row, 500 MB per free database, and 50 queries per free Worker invocation. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) specify 128 MB memory. The 256 KiB product bound fits within a D1 row; bounded export pages prevent accumulating copies. These limits are ceilings, not evidence of measured storage headroom or deployed performance. Monitor actual database size before considering R2.

## Acceptance evidence

Use real local D1 tests for create/read, Unicode byte boundaries, atomic stale-revision rejection, deletion cascade, owner/CSRF/token privacy, preservation of read state, and version 2 round-trip plus version 1 import. Test invalid-copy rejection and transactional rollback, duplicate policy, and storage failures. Browser smoke must cover paste, file upload, reload persistence, confirmed replacement/cancellation, and narrow layouts. Mark A02 complete only after these checks pass; keep actual deployment and A03 reading checks pending.
