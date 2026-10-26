# Article URLs and returning to the last article

Status: implemented and validated locally with Luna subagents. Current article data and backups are disposable test data. Deployment and migration of the existing live library/GitHub backup set have not been performed. October 18, 2026.

## Decision

Give every article opened in Potem a URL containing its eight-character article ID and a readable title slug:

```text
https://read.pajdzik.pl/read/k7m2q9x4/why-we-read
```

The ID identifies the article. The optional last segment makes a copied URL recognizable. Generate it from the saved article title; never use it to look up an article. Duplicate titles, title edits, and stale title slugs must all work. `/read/k7m2q9x4` works too and gains the current title slug after loading.

Use this same ID in the database, APIs, JSON exports, and GitHub Markdown backups. The owner has confirmed the app is still in testing and current data does not require preservation. One short article ID is authoritative everywhere. Existing UUID article links can stop working at the transition. Update the extension's generated article links to the new path.

While an article is open, set the tab title to `Why we read · Potem`. Restore `potem — your reading list` when returning to the list. This gives browser tabs and history a readable label as well as a recognizable URL.

## Short article IDs

Use exactly eight lowercase ASCII letters/digits (`[a-z0-9]{8}`), generated with `crypto.getRandomValues` and an unbiased selection from the 36-character alphabet. This provides 36^8 = 2,821,109,907,456 possible IDs. IDs are case-sensitive; generated URLs always use lowercase. Generate the complete ID independently; never truncate an old UUID. There is no new dependency and no title-derived identity.

Use the existing `articles.id TEXT PRIMARY KEY` to enforce uniqueness. On an article-ID collision during creation, generate a new candidate and retry, up to five attempts. This retry applies only to the ID conflict; duplicate normalized source URLs keep the existing article and ID, and other database errors fail normally. An exhausted allocation fails the transaction and reports a retryable error. Authentication continues to guard every article lookup: an article ID is an address, not an access token.

All article foreign keys, copy access, capture jobs, read/edit/delete requests, pagination, and GitHub backup records use this single ID. The current text primary-key schema already supports short IDs; no additional column or schema migration is needed just to change ID format. Replace article UUID generation and enforce the short-ID contract at article API/import boundaries. Unrelated session tokens, capture tokens, OAuth state, and Markdown revision tokens keep their current generation and validation.

Article DTOs retain the existing `id` field. Resolve a reader path with `GET /api/articles/:id`, then load the copy through `GET /api/articles/:id/copy`. The title slug is never sent to the lookup API. No new reader lookup API is required. An invalid ID returns 400; an unknown valid ID returns 404. Keep existing owner-session and private/no-store policies; capture tokens grant no read access.

## Backups and the testing transition

The backup shapes do not need to change. JSON version 2 still contains `id` and the optional Markdown copy; GitHub Markdown still uses `potem_backup_version: 1` and an `id` frontmatter field. Their existing string-ID fields can hold short IDs. Imports of current-format data preserve supplied short IDs exactly, including through a full restore; an ID assigned to a different normalized URL rejects the entire import. Existing normalized-URL duplicates retain their stored article and ID.

New GitHub backups use readable title-based filenames such as `Articles/why-we-read.md`, with `id: "k7m2q9x4"` in YAML frontmatter. The database records the article's assigned backup path. The writer, recovery converter, JSON import, and database must agree on the frontmatter ID; the filename carries no identity contract. Repeated restore must preserve both the article ID and its reader URL. Preserve saved Markdown bytes and existing metadata through conversion. GitHub Markdown remains a text/capture backup and does not acquire read-state fields through this change.

Default cutover: clear the disposable test article library and start with newly generated short IDs. Reset article rows and dependent copies/jobs/backup-status records together; keep authentication, tokens, configuration, and unrelated repository files outside the reset. Do not rewrite primary keys piecemeal across an active library. Test backups can be regenerated from the new library, and old UUID-named backup files can be retired rather than retained as aliases. Old bookmarks, last-opened browser pointers, and UUID links are allowed to expire.

If retaining an existing backup's contents is useful, convert it once before import:

1. Read a JSON export and/or local GitHub Markdown backup folder, and validate it using the existing backup parsers. Produce output in a separate directory.
2. Build one old-ID → short-ID mapping for the entire conversion, including all import batches and matching Markdown files. Reserve existing valid short IDs first and preserve them. Allocate collision-checked IDs for legacy records; never independently rekey each representation of the same article. Reject inconsistent old-ID/normalized-URL identities rather than guessing. Keep the mapping as a migration report, not an application dependency.
3. Write converted JSON batches with the existing version and limits. For Markdown, replace the `id` scalar and assign a readable title-based filename using the rules below, retaining all other metadata and the exact body bytes. Record old path → new path alongside the ID mapping. Do not rewrite IDs or links inside article bodies.
4. Validate the converted outputs, import into an empty test library, then verify IDs, counts, metadata, copies, read state where backed up, and reader URLs. Reimport must make no changes. Old-format data goes through this converter rather than adding a runtime legacy-ID lookup path.
5. If replacing the existing GitHub backup set, use the verified mapping to rename only recognized Potem files and update their ID frontmatter together in one repository commit. Preserve unrelated files and repository history. Rebuild backup-status metadata against the new destination paths; do not reuse old content hashes. For a clean reset, fresh backups can replace the test set instead. Before publishing, produce a concrete diff for review; this design does not mutate the remote repository.

New GitHub/Obsidian recovery conversions must also emit or retain valid short IDs. Update fixtures and archive helpers to use short IDs and verify the unchanged JSON/Markdown format contracts. Version-1 JSON input without copies may continue through the same short-ID import contract; legacy UUID or opaque IDs require conversion first. There is no obligation to preserve current test identifiers or old reader links.

## Readable GitHub filenames

Keep the repository pleasant to browse and each Markdown file independently identifiable:

| Location | Example | Purpose |
| --- | --- | --- |
| Reader URL | `/read/k7m2q9x4/why-we-read` | Stable article address with a readable title |
| GitHub filename | `Articles/why-we-read.md` | Human-readable name in the repository |
| YAML frontmatter | `id: "k7m2q9x4"` | Permanent identity carried with the file |
| Database mapping | Article `k7m2q9x4` → repository, branch, `Articles/why-we-read.md` | Find the same file on subsequent writes |

Frontmatter already includes `id`, and `article_github_backups` already records the confirmed `path`. Recovery must continue to parse the ID from metadata rather than infer it from a filename. Keeping the ID inside the file allows recovery without the database, including after a manual filename change.

On the first backup attempt, choose `<title-slug>.md` within the configured folder. Use the title-slug normalization from the reader URL, with filename portability checks for reserved basenames. A title with no usable slug falls back to `saved-article.md`. Generate one basename only; article titles cannot supply path separators or escape the configured folder. If another article or unrelated file owns that path, try `why-we-read-2.md`, `why-we-read-3.md`, and so on, with a bounded limit of 100 candidates. The article ID remains in frontmatter rather than being appended to the filename.

Reserve the chosen path in D1 before the first remote write. The existing backup-status row is written only after a successful GitHub operation, so it cannot alone make the first attempt repeatable. Add a destination-path reservation keyed by article ID, repository, branch, and configured folder, with unique ownership of each destination path. Keep the existing confirmed content hash/time separate from an unconfirmed reservation. Resolve concurrent saves through that reservation and reuse it after a timeout or Worker restart. A failed network request must not allocate another filename.

Always verify a remote file's Potem marker and frontmatter ID before replacing it, and use its current blob SHA. An occupied candidate belonging to another article is skipped only during initial allocation. If an already assigned file is replaced with unrelated content, report a conflict rather than overwrite it or silently create a replacement elsewhere. A concurrent remote creation must be rechecked before selecting another candidate. Exhausted candidates or unresolved conflicts leave D1 article content and previous confirmed backup status intact.

Keep the assigned filename stable when the article's title changes. Update the full `title` in frontmatter on the next backup; subsequent writes reuse the stored path. This keeps title edits from creating extra files and keeps existing GitHub links useful. Automatic filename renaming on title edits is outside this feature.

During backup migration or a repository-aware restore, rebuild destination mappings by reading recognized files' frontmatter IDs and their current paths. Use Settings → **Find existing GitHub backups**, backed by owner/CSRF-protected `POST /api/github/reconcile`. The scan is limited to 100 direct Markdown files and 4 MiB advertised size under a shared 10-second deadline; exceeding that bound reports a limit error. Ordinary saves do not scan the folder. Do not regenerate a path from an article's latest title when a matching backup already exists. Multiple files claiming the same article ID are a reported conflict, not a reason to choose one silently. A JSON-only restore recovers article identity and content; reconcile the target GitHub folder before resuming publication to an existing backup set. Neither JSON export nor Markdown needs a new field or format version for this mapping.

## Reading flow

| Action | Result |
| --- | --- |
| Open an article title or lead | Show the existing reader and add one article entry to browser history. Update the URL and tab title. |
| Refresh or open a bookmarked article URL | Authenticate, look up the exact short article ID, and reopen its saved copy, even if it is read or absent from the current list page. |
| Browser Back after opening from the list | Close the reader and return to the previous list with its filter, search, loaded rows, scroll, and focus restored. |
| Browser Forward | Reopen the article identified by the URL. |
| Close or Escape | Return to the preceding list entry if Potem created that reader entry. For a direct article landing, replace the current entry with `/`; closing must not send the user to an unrelated site. |
| Mark as read | Keep the existing behavior: after the server confirms success, close the reader and refresh the list. Preserve the last-opened shortcut. A failure keeps the article and its URL open. |
| Rename an article | Retain its short ID, update the current slug and tab title with history replacement, and keep old title-slug links working. |
| Open original | Keep the existing external link. Opening an external page alone does not update read state or the last-opened saved-copy shortcut. |

Use one navigation controller for intentional opens, initial URL restoration, `popstate`, and close actions. Render functions must not independently push history entries. A `popstate` restoration must never push another entry. Use `pushState` for a new article navigation and `replaceState` for normalization or title changes; these have different session-history behavior. See [MDN's History API guide](https://developer.mozilla.org/en-US/docs/Web/API/History_API/Working_with_the_History_API).

Store only navigation metadata in `history.state`: a versioned Potem marker, article ID, and enough information to recognize the preceding in-app list entry. Keep list rows, rendered Markdown, and editor drafts in memory. Reload may rebuild the list; the URL must independently identify the article.

Retain the existing focus behavior. Closing returns focus to the opener when it still exists; after a read action removes the row, focus the active list filter. Opening the reader focuses its heading. Returning to the list restores its scroll without a jump to the top.

## Remembering the last article

A URL restores the article while its tab or bookmark exists. Add a small **Last opened** shortcut above the library so the article is also discoverable after closing the reader or restarting the browser:

```text
Unread       Read       All

Last opened
Why we read                                  Open again →

Saved articles…
```

Use a single compact row with the current title as a real article link. On phones, let the title wrap and put the action below it if necessary. Hide the row when there is no valid remembered article. Showing it must not change the selected list filter or insert an article into the unread list.

Call it **Last opened** because opening a copy does not mean finishing it. Update the pointer only when saved Markdown has successfully rendered for the current navigation. Opening Edit, viewing pending capture, a failed load, and a superseded request do not replace it. Explicit Mark read/Mark unread remains the existing server-owned completion state.

Persist one small versioned local-storage record:

```json
{
  "version": 1,
  "articleId": "k7m2q9x4",
  "openedAt": "2026-10-19T00:00:00.000Z"
}
```

Fetch the remembered article by ID after authentication to obtain its current title and URL. Store no Markdown, title, original source URL, or article DTO in local storage. This is a browser-local convenience; opening Potem on another device still shows that device's own last-opened article. A copied article link works on another device after owner sign-in.

The pointer survives closing the reader, marking it read, and browser restarts. Clear it on explicit logout or confirmed deletion of that article. On a remembered-article 404, remove the pointer and hide the shortcut. A temporary network/server failure must preserve the pointer; show a small retry action without claiming the article was deleted. Malformed or unsupported stored records are discarded. Storage failures must not block reading or URL navigation.

Opening `/` shows the list and shortcut, without automatically opening a remembered article. An explicit article URL always takes precedence over the remembered pointer.

## URL and loading rules

- Build links with `URL`, exactly one `/read/` ID segment, and at most one optional slug segment. Encode the slug as a path component. Validate the article ID against `[a-z0-9]{8}`; never slice, case-fold, or otherwise guess a supplied ID.
- Generate the title slug from the saved title: Unicode normalization, lowercase letters, letters/numbers retained, other runs replaced by hyphens, trimmed and limited to 80 Unicode code points. If no slug remains, omit the title segment. URL encoding handles non-Latin titles.
- Parse article navigation on `/read/:id` and `/read/:id/:slug`. Replace the existing query-based reader entry and its extension result link; UUID query links need no compatibility handler. Existing `/add` title fields, extension handoff, and `/extension-connect` retain their meanings. Generated article links do not inherit capture or connection parameters.
- Treat the title segment as untrusted decoration. Render the fetched article title with `textContent`; never display a URL-provided title as authenticated article metadata. Normalize a missing or stale slug only after a successful fetch using history replacement.
- Validate invalid IDs, malformed path encoding, missing IDs, and extra path segments before fetching. Show an article-link error with **Back to list**; do not guess an ID or fall back to the remembered article. Verify direct navigation and refresh through the existing SPA asset fallback.
- Parse the initial article intent before loading the list. After authentication, load that article independently of list pagination and list failures. Direct links to read articles must work while the default filter remains Unread.
- Show a loading state for the requested article. Keep its URL on copy/network failures so Retry and refresh can try the same article. For a confirmed article 404, show **This article is no longer in your library** and **Back to list**; do not silently open another article.
- Keep the existing missing-copy fallback: show the pending/failed capture reader when appropriate, otherwise open article details to add Markdown. Retain the article URL, but do not update the last-opened saved-copy pointer. Edit is a temporary UI state; refreshing the article URL attempts reading again.
- Use one navigation generation or abort guard across the initial article fetch and the subsequent copy fetch. Back, another article selection, edit, or logout invalidates both stages. Late responses must not reopen an old article, alter the URL/tab title, or overwrite the remembered pointer.
- Opening, restoring, and copying an article URL performs no read-state mutation. Keep private API responses and reader content outside service-worker caches. The requested title slug is intentionally visible in the browser URL and history; the link still requires owner authentication.

Add **Copy article link** to the reader header beside Open original. Copy the canonical same-origin article URL and announce success. If clipboard access fails, expose a selectable URL. The title/lead and Last opened shortcut should use real anchors so Open in new tab, copying a link, and modifier-click work normally; intercept only ordinary same-tab activation.

## Sign-in and existing capture flows

The OAuth callback currently returns to `/add`, so restoring the article after login requires an explicit handoff:

1. Before leaving for GitHub, save a validated short article ID and timestamp in tab-local `sessionStorage` as a pending reader return. Save no arbitrary return URL or article body.
2. After sign-in, recover existing capture/extension drafts first. Active capture or extension connection work takes precedence and must not be replaced by a reader navigation.
3. If no capture/connection work is active, consume the pending reader return, look up the article, replace the callback landing with its canonical `/read/:id/:slug` URL, and open it. An explicit current article URL takes precedence over an older stored return.
4. Expire pending returns after 30 minutes; clear them when consumed, cancelled, or on explicit logout. If capture takes precedence, defer the valid return until the capture workflow finishes and the user returns to the library.

Apply the same preservation before the existing API-401 redirect. Hide the last-opened shortcut and discard private DOM whenever authentication is lost. The browser-local pointer may remain through session expiry; it is displayed only after authentication. No server-side arbitrary redirect parameter is needed.

## Implementation scope

1. Replace article UUID generation with a shared short-ID generator and bounded collision retries. Keep the existing `id` field, text primary key, article APIs, and foreign keys. Tighten article-ID validation and update fixtures.
2. Update backup/recovery converters and archive helpers for short IDs within existing formats. Add readable filename allocation and durable destination-path reservations to the GitHub writer; reuse confirmed paths and frontmatter identity checks. Provide the one-time backup converter with a shared ID/path mapping and an optional verified GitHub file-migration diff. Verify exact ID retention through full restore and atomic rejection of conflicting IDs. Reset/rebuild disposable test article data during cutover.
3. Add a small typed URL/navigation module for article link generation, parsing, history transitions, and current navigation ownership. Integrate with `initialize`, `openArticleById`, `openSavedCopy`, reader close handlers, and logout in `web/app.ts`.
4. Convert article entry controls to anchors; update extension result links to use the same URL helper. Add the Copy article link control and the accessible Last opened row in `web/index.html`, with responsive styles in `web/app.v1.css`.
5. Add browser-local last-opened and tab-local sign-in return helpers with defensive storage handling. Keep render-only functions free of persistence/navigation effects.
6. Extend existing real-browser smoke coverage for the transitions below. No extraction or deployed-environment changes are part of this design update.

Cross-device last-opened synchronization and restoring a position within an article are possible later extensions. V1 restores the article at its beginning. They are separate from existing read/unread status and do not need to block useful article URLs.

## Acceptance checks

- Open from title, lead, and Last opened; verify short ID, readable slug, tab title, Copy article link, refresh, and a new-tab direct link. Verify short paths also work through the deployed-equivalent SPA fallback locally.
- Back/Forward/Close/Escape behave correctly for list navigation and direct article landings. Closing a direct landing stays in Potem; repeated open/close does not create history loops. Restore list filter, search, loaded pages, scroll, and focus in the same tab.
- Extension results use short-ID reader paths. Duplicate titles, edited titles, stale slugs, and Unicode titles work. Malformed IDs/paths show a usable error. UUID query bookmarks are outside the compatibility contract.
- Newly saved/imported articles use one unique eight-character primary ID. Force a collision and verify bounded retry, concurrent allocation, rollback on exhaustion, duplicate-URL ID retention, and consistent copy/job/GitHub references.
- Export v2 and restore into a fresh database; reconcile IDs, copies, metadata, read state, and reader URLs exactly. Current-format short IDs are retained; invalid IDs or ID/URL conflicts cause no partial writes. V1 JSON without copies follows the same short-ID contract.
- Convert legacy JSON/GitHub fixtures with one shared mapping; verify matching JSON/frontmatter IDs, readable assigned filenames, exact body bytes, bounded output batches, unchanged source inputs, and idempotent restore. Recognized-file rename diffs leave unrelated repository content alone. No article-ID alias table or URL-specific ID is introduced.
- GitHub filename allocation covers duplicate titles, Unicode/punctuation/empty slugs, reserved basenames, unrelated occupied paths, concurrent initial saves, and a timeout after remote commit but before confirmed D1 status. Retry finds the same assigned file. Title changes update metadata without creating another file. ID-based recovery works after a manual rename, and duplicate frontmatter identities are reported during reconciliation.
- Direct links work for read articles and articles beyond the first list page, including when the list request fails.
- Last opened survives browser restart and a successful Mark read, appears in the unread view even if its article is read, and fetches the current title after rename. Failed or pending copy loads never replace it.
- Deleted, malformed, and temporarily unavailable remembered articles follow the distinct cleanup/retry behavior. Unavailable local storage and clipboard do not block reading.
- Logged-out entry and session expiry return to the requested article after authentication. Capture drafts and extension connection flows keep priority. No arbitrary external return URL is accepted.
- Delay article/copy responses, then Back, open another article, Edit, or logout; no stale reader, URL, tab title, or last-opened update appears.
- Preserve editor drafts while entering/leaving the reader. Explicit logout clears the pointer and pending return. Opening/refreshing links leaves `readAt` unchanged and makes no capture/publish request.
- Inspect the Last opened row, reader actions, long titles, keyboard focus, and status announcements at desktop and 390px widths.

## Local validation

- `pnpm check` and all 84 Worker/D1 tests pass. Collision retries, strict identity/import boundaries, GitHub reservations, concurrent saves, lost-response retries, renamed-file reconciliation, and owner/CSRF access have runtime coverage. An independent Luna review found no additional short-ID backend correctness issues.
- All 37 standalone archive/converter/migration tests pass. The new command is `pnpm backup:migrate --json /absolute/export.json --github-dir /absolute/Articles --output /absolute/new-directory`; either input can be omitted. It creates private converted files and an ID/path mapping without modifying inputs or publishing to GitHub.
- Desktop browser smoke covers real anchor links, 51 loaded rows through Back, tab titles, copy-link fallback, stale title slugs, direct landing/reload/close, Last opened, unchanged read state, sign-in through `/add`, unavailable local storage, existing capture workflows, and delayed-response guards. Desktop and 390px reader/list screenshots were inspected.
- Chromium Android and WebKit iPhone touch smoke passes across portrait, landscape, and short viewports. This is browser emulation, not a physical-device release check.
- Archive rehearsal restores 30 articles and 28 copies, compares canonical fields, confirms repeat import makes zero writes, and reads/downloads two saved copies with external browser requests blocked. GitHub and Obsidian recovery also have temporary local Worker/D1 integration coverage.
- Chromium extension/controller/bridge integration passes with real local Worker/D1, including the new Read in Potem URL. Native toolbar activation and the complete Firefox matrix retain their existing release gates.

Migration `0007_github_paths.sql` must be applied before running the new GitHub writer. It adds durable filename reservations and seeds existing confirmed paths. Rebuilding existing test data and replacing remote backups remain explicit cutover operations; local validation used temporary databases and fixture repositories only.
