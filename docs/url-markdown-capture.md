# Markdown capture when pasting a URL

The ordinary Add form previously saved only URL metadata. It now enables **Save a Markdown copy of the article** by default and sends `captureMarkdown: true` to the owner-authenticated `POST /api/articles` route. Successful captures open the existing sanitized reader. The stored copy remains available from article details after reload and is included in version-2 exports.

The metadata request supplies both metadata and source HTML, with a 4.5-second timeout and a 512 KiB HTML bound. Capture rejects incomplete responses rather than archiving truncated text. Defuddle and LinkeDOM parse HTML without running scripts or fetching embedded resources; asynchronous third-party extractors are disabled. A fixed inert DOM parser adapter supports the browser bundle's Markdown converter in Workers without keeping request documents in global state. Copies must be nonempty and at most 256 KiB UTF-8.

The URL is committed before extraction and copy storage. Source or copy failures return a successful link save with `copy: null` and `copyCaptureError`; the UI reports that Markdown was not saved. Retry by adding the URL again. Duplicate URLs preserve article IDs, saved dates, read state, and existing copies. Copy insertion uses `expectedRevision: null`, so concurrent captures cannot replace owner-edited content. Copy failures never trigger GitHub writes.

Omitting or clearing `captureMarkdown` preserves the existing link-only API behavior. Capture tokens cannot set it to true or read copies. Bookmarklets continue saving their reviewed browser draft separately; blocked bookmarklets retain their link-only/paste fallback. GitHub publishing remains an explicit separate action in article details.

URL captures use the existing `source: "paste"` schema value, shared with browser clips, for compatibility with exports, restore tools, and GitHub backups. The UI labels this **captured or pasted Markdown**. No database migration is required.

This synchronous capture reuses the existing source fetch; it does not introduce durable extraction jobs, authenticated browsing, an offline image archive, or full DNS/rebinding safeguards. Earlier A01/A04 safe-fetch and deployed performance gates in `markdown-preservation.md` and `tasks.md` still apply to expanding capture into a background service. Deployed quota/CPU measurements remain unverified.

Regression coverage includes real Worker/D1 extraction, formatted/Unicode content, reload retrieval, preserved duplicate revisions/read state, failed-source retry, truncated-HTML rejection, and capture-token denial. Browser smoke exercises the default Add flow, automatic reader display, exact persisted bytes/revision after reload, mobile layout, failed-source reporting, and the existing bookmarklet/editor flows.
