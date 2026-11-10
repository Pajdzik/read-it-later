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

## Backups

JSON version 3 retains article IDs and optional Markdown copies. GitHub Markdown uses `potem_backup_version: 2` and the article ID in frontmatter. New GitHub writes use `<configured-folder>/<article-id>.md`; title edits update metadata in place. Generic integration receipts track delivery history separately for each configured repository, branch, and folder. Existing title-based remote files are not automatically renamed or adopted. See [GitHub Markdown](github-markdown.md) for the current writer and offline recovery converter.

## GitHub filenames

GitHub Markdown files use `<configured-folder>/<article-id>.md`, such as `Articles/k7m2q9x4.md`. This keeps the remote destination stable across title edits and avoids path allocation, collision suffixes, and database path mappings. Frontmatter retains the ID for offline recovery. Each send checks remote ownership and content before writing; deleting a remote file allows the next send to recreate it at the same path. Generic integration receipts are scoped to the configured repository, branch, and folder.

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

Call it **Last opened** because opening a copy does not mean finishing it. Update the pointer only when saved Markdown has successfully rendered for the current navigation. Opening Edit, viewing pending capture, a failed load, and a superseded request do not replace it. Explicit Mark as read/Mark as unread remains the existing server-owned completion state.

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
2. Update backup/recovery converters and archive helpers for short IDs within existing formats. Write GitHub backups at stable article-ID paths and verify remote ownership before replacement. Keep the offline GitHub converter for local recovery. Verify exact ID retention through full restore and atomic rejection of conflicting IDs. Reset/rebuild disposable test article data during cutover.
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
- Convert legacy JSON/GitHub fixtures using short IDs; verify matching JSON/frontmatter IDs, exact body bytes, bounded output batches, unchanged source inputs, and idempotent restore. No article-ID alias table or URL-specific ID is introduced.
- GitHub uses a stable article-ID filename, checks ownership before replacement, recreates deleted remote files, and confirms ambiguous writes by exact-byte reread. Title changes update frontmatter in place.
- Direct links work for read articles and articles beyond the first list page, including when the list request fails.
- Last opened survives browser restart and a successful Mark as read, appears in the unread view even if its article is read, and fetches the current title after rename. Failed or pending copy loads never replace it.
- Deleted, malformed, and temporarily unavailable remembered articles follow the distinct cleanup/retry behavior. Unavailable local storage and clipboard do not block reading.
- Logged-out entry and session expiry return to the requested article after authentication. Capture drafts and extension connection flows keep priority. No arbitrary external return URL is accepted.
- Delay article/copy responses, then Back, open another article, Edit, or logout; no stale reader, URL, tab title, or last-opened update appears.
- Preserve editor drafts while entering/leaving the reader. Explicit logout clears the pointer and pending return. Opening/refreshing links leaves `readAt` unchanged and makes no capture/publish request.
- Inspect the Last opened row, reader actions, long titles, keyboard focus, and status announcements at desktop and 390px widths.

## Local validation

- Worker/D1 tests cover ID collision retries, strict identity/import boundaries, stable GitHub ID paths, ownership checks, remote deletion, ambiguous writes, and destination-scoped receipts.
- Offline archive and GitHub converters validate local recovery inputs without publishing to GitHub.
- Desktop browser smoke covers real anchor links, 51 loaded rows through Back, tab titles, copy-link fallback, stale title slugs, direct landing/reload/close, Last opened, unchanged read state, sign-in through `/add`, unavailable local storage, existing capture workflows, and delayed-response guards. Desktop and 390px reader/list screenshots were inspected.
- Chromium Android and WebKit iPhone touch smoke passes across portrait, landscape, and short viewports. This is browser emulation, not a physical-device release check.
- Archive rehearsal restores 30 articles and 28 copies, compares canonical fields, confirms repeat import makes zero writes, and reads/downloads two saved copies with external browser requests blocked. GitHub and Obsidian recovery also have temporary local Worker/D1 integration coverage.
- Chromium extension/controller/bridge integration passes with real local Worker/D1, including the new Read in Potem URL. Native toolbar activation and the complete Firefox matrix retain their existing release gates.

GitHub sends use the generic integration receipt migration. Local validation used temporary databases and fixture repositories only.
