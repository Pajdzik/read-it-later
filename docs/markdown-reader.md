# Preserved Markdown reader (A03)

## Scope and experience

A02 already stores private, revision-checked Markdown copies. A03 is the next product feature: read the last saved copy inside Potem and download it as a portable Markdown file. Automatic extraction, changes to the existing GitHub backup feature, infrastructure changes, and deployed release validation remain outside this task.

Clicking an article title or lead opens its saved Markdown in a dedicated, accessible reader. If no copy exists, either control opens article details so the user can add one. **Edit**, **Mark read/unread**, and **Open original** share one action row. The reader shows the article title, optional author, capture date/source, **Open original**, and a close/back control. It uses a comfortable reading width, existing theme colors, and a narrow-screen layout with horizontally scrollable code and tables. Opening or downloading a copy never changes read state. The existing paste/upload editor and revision checks keep working, and entering/leaving the reader preserves unsaved edits.

Without a copy, show the existing clear missing-copy message and original-link fallback. Failed requests cannot look like a missing copy. Reader/download controls use only the successfully loaded/saved revision, never an unsaved draft. After a successful replacement they reflect the new copy. Stale requests for a different article or detached detail view cannot populate its controls or open a stale reader. Reader DOM and private content are discarded on close/logout and are never put in persistent browser storage or service-worker caches.

## Rendering policy

Use a maintained Markdown parser (`markdown-it`, with raw HTML disabled) and browser DOM sanitizer (`DOMPurify`) bundled with the existing esbuild pipeline. Pin dependencies and their TypeScript types in the lockfile. Support headings, emphasis, lists, blockquotes, fenced code, tables, and relative links without a handwritten parser or syntax highlighting dependency.

Resolve Markdown links against the article's submitted source URL, including root-relative and fragment references. Permit HTTP(S) destinations only, reject embedded credentials, and open links with `target="_blank"` and `rel="noopener noreferrer"`. Reject script/data/file and other unsafe protocols, including encoded/obfuscated forms. Render raw HTML as literal text. Omit embedded images and show escaped descriptive image-reference text instead: no image, iframe, media, stylesheet, script, or other content-directed network fetch. Explain that image references still depend on their external source and this is a preserved text copy.

Sanitize the final generated markup with a small explicit allowlist of Markdown HTML tags and required attributes; no raw event handlers, style, SVG, MathML, forms, arbitrary IDs, or resource-loading attributes. Return a sanitized DOM fragment and attach it directly without subsequently feeding it to another markup processor. Keep the restrictive existing CSP unchanged. Browser tests must demonstrate actual sanitized DOM behavior rather than relying only on CSP to prevent execution.

## Download

Generate a UTF-8 `text/markdown` Blob locally from the loaded copy, avoiding a new API route or server-side renderer. Download a safe, deterministic `.md` filename derived from article ID. Use YAML frontmatter containing `title`, `url`, `capturedAt`, `source`, and `revision`; encode scalar values as JSON-quoted strings (valid YAML 1.2) to preserve Unicode, quotes, colons, and newlines and prevent frontmatter injection. Separate frontmatter from the original Markdown body with a blank line and preserve the body's bytes exactly. Do not include authentication records or credentials. Revoke the object URL after the download starts.

## Validation and completion

Extend the existing real-browser smoke test for title and lead reader entry, the shared action row, saved-copy rendering and download, missing-copy fallback, replacement refresh, drafts, reload, and unchanged read state. Include hostile raw HTML, obfuscated dangerous links, remote image markers, valid relative links, headings, fenced code, wide tables, long text, Unicode and quoted/frontmatter-like metadata. Assert no injected active nodes/attributes and no image requests. Check reader content and the shared action row at desktop and 390px widths and capture screenshots for visual review. Simulate an unavailable original while reading the saved copy. Validate the downloaded metadata/body, not merely that a download event occurred.

Run the repository's syntax check, TypeScript checks, Worker/D1 tests, dry-run build, and browser smoke. Mark A03 complete only after local evidence passes, update README/tracker, and leave A05 deployed archive/restore checks pending. No deployment or secrets changes are part of this PR.

References: [markdown-it](https://github.com/markdown-it/markdown-it), [DOMPurify security and configuration](https://github.com/cure53/DOMPurify).
