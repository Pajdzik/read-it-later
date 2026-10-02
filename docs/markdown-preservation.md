# Markdown preservation and browser capture (A01 decision and A02 design)

## Decision

For A01, server-side fetching and extraction were deferred because the existing metadata fetch has not proven DNS, redirect, or rebinding protection. A02 now also supports browser-side capture: the user invokes a bookmarklet on the open page; a pinned Defuddle bundle extracts that document locally with `useAsync: false`, and sends editable Markdown to the Potem tab over a one-use origin-checked message. This does not add server fetching, background jobs, paid services, or storage bindings. No deployed server extraction benchmark is claimed.

Owners can capture from the desktop bookmarklet, paste Markdown, or load a UTF-8 `.md`/`.markdown` file in article details. The capture is editable and saves only after the user presses Save. For compatibility with the current copy schema, browser clips use the existing `source: "paste"` value. Potem saves the URL first and then creates a copy with `expectedRevision: null`; an existing copy is never replaced silently. The copy checkbox can be cleared to save only the link, and copy failures leave the URL and editable draft intact. A changed URL cannot receive the source page's captured Markdown. Show whether a copy exists, its capture time, source (paste/upload), and UTF-8 byte size. Existing original-link and read controls keep their behavior. Markdown is editable text; sanitized reading and download belong to A03. External image URLs are not an offline replica.

## Storage and API

The selected implementation stores authoritative copies in D1. The optional [GitHub Markdown saving integration](github-markdown.md) (A06) adds an unchecked **Also save to GitHub** checkbox. It writes the saved copy to the configured external repository after D1 succeeds. Production targets the public `Pajdzik/Kamilpedia` repository under `Articles`; only checked saves publish copies there. D1 remains authoritative.

The same opt-in is available in browser capture. An owner-only configuration route supplies destination details before the article exists. Capture publishes only the revision returned by a successful local copy save. GitHub failures retain the local copy and offer a separate saved-revision retry; changed copies require review in article details. Capture retry never rewrites or replaces the D1 copy, and **Done** leaves that copy intact. Unchecked, link-only, and changed-URL captures do not send Markdown to GitHub.

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
