# Implementation tracker

Source of truth: [design.md](design.md). Status: MVP implemented and validated locally by Luna subagents and the integrating agent. Deployment and actual-device release checks remain pending. For A01, manual copies plus browser-side extraction from the already open page are supported; server-side extraction remains deferred because safe-fetch protections and deployed cost remain unproven.

Check off a task only after its acceptance criteria pass. Each chunk should be one reviewable change; split further if needed. The integrating agent owns shared contracts, migrations, dependencies, and release checks. A subagent receives the task ID, prerequisite commits, owned paths, relevant design sections, and required evidence. It returns changed files, checks/results, and unresolved issues. It must not deploy, modify secrets, or refactor another chunk's files without explicit assignment.

## Completed preparation

- [x] P01 Inspect the repository and preserve the existing Markdown-reader prototype.
- [x] P02 Remove personal default paths/branding and ignore local data and Worker artifacts.
- [x] P03 Write the service design and check current Cloudflare/MDN documentation.
- [x] P04 Create this dependency-ordered tracker.

## MVP chunks

| ID | Chunk | Depends on | Suggested owned paths |
| --- | --- | --- | --- |
| M01 | Worker foundation and shared contracts | Design | `src/worker.ts`, `src/contracts.ts`, tooling/config |
| M02 | D1 schema and article repository | M01 | `migrations/`, `src/articles/repository.ts` |
| M03 | Owner authentication and capture tokens | M01, M02 | `src/auth/`, auth migration, auth tests |
| M04 | Library and capture API | M02, M03 | `src/articles/validation.ts`, API handlers/tests |
| M05 | Responsive inbox | M01; integrate after M04 | `web/` inbox assets and UI checks |
| M06 | Desktop/mobile capture | M03, M04, M05 | Add UI, PWA files, capture guides |
| M07 | Portable export/import | M02, M03, M04 | transfer handlers, format fixtures/tests |
| M08 | Free-tier deployment and release | M05, M06, M07 | deployment config, release docs/checks |

- [x] **M01 — Establish the Worker foundation and freeze contracts.** Create TypeScript configuration, pinned Wrangler/build tooling, local dev/check/build/test scripts, static asset routing, public health endpoint and shared DTO/error definitions. Leave the prototype start/check commands available with clearly distinct new commands. Centralize route wiring so future subagents can supply handlers without competing edits.
  Acceptance: a fresh checkout installs from lockfile, typechecks and builds; local Worker serves the app shell and health; `/api/*` cannot fall through to SPA HTML; no Node filesystem/listening-server dependency in the Worker bundle; configuration contains no secrets. Confirm the design's API and import format in fixtures before parallel work.

- [x] **M02 — Add D1 persistence.** Create article/auth-table migrations and parameterized repository methods for save, get, list, title/read update, and deletion. The integrating agent assigns migration numbers; M03 adds auth behavior rather than duplicating base schema. Implement stable keyset ordering and unique normalized URL handling.
  Acceptance: apply migrations to fresh local D1; concurrent duplicate saves leave one record; repeated read writes preserve the first timestamp; unread clears it; pagination neither drops nor repeats equal-timestamp items on a fixed dataset. Test reads and writes against local D1 rather than an in-memory mock alone. Verify query plans use intended list indexes.

- [ ] **M03 — Implement private owner access.** Add GitHub OAuth, browser-bound one-time state, hashed persistent sessions, fixed numeric owner allowlist, logout, CSRF protection, settings token creation/list/revocation, and the capture limiter. Use mocked provider responses for automated tests and a real local callback for manual validation. Keep production auth fail-closed.
  Acceptance: anonymous library calls fail; wrong owner fails; expired/replayed/unbound state fails; missing deployment auth configuration fails closed; cross-origin cookie writes fail; logout survives a new isolate; token plaintext is only returned at creation. Capture tokens cannot access any library or settings route. Revocation and limits work across independent Worker instances. No secrets in logs or built client assets.

- [x] **M04 — Implement the article HTTP API.** Connect validation/normalization to M02 persistence and M03 guards. Implement documented create/list/detail/update/delete/capture responses, body limits and safe error mapping. Do not fetch remote article pages. Add the session endpoint and error fixtures if not delivered in M03.
  Acceptance: HTTP(S) saves work; credentials and unsafe schemes fail; tracking-only duplicates collapse while meaningful query/path differences stay distinct. Duplicate saves preserve read/title state. Search wildcard input is literal; invalid cursors and limits fail predictably. Storage failure returns a retryable failure, never success. Unauthorized and capture-token scope tests cover all routes.

- [x] **M05 — Build the responsive inbox.** Start against M01 fixtures if M04 is still running, then integrate real APIs. Default Unread, with Read/All, search, pagination, original links, explicit read/unread actions, title edits, delete confirmation, token settings, theme, and keyboard support. Port existing styling selectively into `web/`; avoid changing the preserved prototype to serve both products.
  Acceptance: save → list → open original → mark read → reload → mark unread works; another device sees persisted state after refresh. Opening a link alone does not mark read. Mutation failures preserve correct state; empty/loading/session-expiry/errors are usable. Verify narrow phone and desktop layouts, focus order, labels, and contrast. Never insert title or URL as unsanitized HTML.

- [ ] **M06 — Add capture from desktop and mobile.** Deliver the Add route, bookmarklet installation and browser-side Markdown extraction, iOS Shortcut instructions or importable Shortcut artifact if available, manifest/icons/service worker, and a supported PWA share-target flow. Use the same create API for browser saves. Add confirmation and login-draft recovery. Explain Shortcut token rotation and paste fallback.
  Acceptance: the bookmarklet opens the source URL/title and editable Markdown draft on a normal desktop page, saves a copy only after confirmation, preserves existing copies, and retains the URL when extraction or copy saving fails; a CSP-blocked page has a documented paste fallback. On an actual iOS device, a shared URL reaches the capture API and reports success/duplicate/revoked-token failure. On an actual supported Android/browser setup, installed PWA sharing prefills the form. Generic shared text and logged-out drafts recover correctly; GET does not save; private responses are never cached. If devices are unavailable, record those checks as pending and do not claim mobile release validation.

- [x] **M07 — Deliver backup and restore.** Add versioned JSON export and bounded atomic import, UI download/upload actions, duplicate/conflicting-ID policy and fixtures. Exclude all sessions, OAuth state and capture tokens. Document how to split imports exceeding MVP limits.
  Acceptance: export a library containing unread/read records and Unicode titles, import into empty D1, and reconcile counts/URLs/dates/read state. Reimport changes nothing; invalid input and a mid-batch failure leave no partial writes; existing URL conflicts do not overwrite state. Exports do not include credentials. Check a multi-page export and document concurrent-edit consistency.

- [ ] **M08 — Prepare and validate free deployment.** Configure separate local/staging/production D1 bindings, asset routing, secrets and origin/owner settings. Document account setup, GitHub OAuth callback, migrations, deployment, backups/restore, quota monitoring, and migration-compatible rollback. Recheck current Worker/D1 quotas and chosen rate-limiter availability/cost; keep paid services disabled. Deployment is a separate action when requested, not part of this planning change.
  Acceptance: production build and integration checks pass; once deployment is authorized, release smoke checks run on a `workers.dev` origin with private access, desktop/mobile capture, read-state persistence, and export/restore verified. Test quota/storage failures without consuming actual account limits. Record URL, migration version, evidence and any pending device checks. Do not declare the service shipped while required checks remain pending.

## Archive chunks: after MVP

| ID | Chunk | Depends on |
| --- | --- | --- |
| A01 | Preservation feasibility and safe-fetch decision | M08 |
| A02 | Markdown copy storage and manual capture | A01 |
| A03 | In-site Markdown reader and download | A02 |
| A04 | Durable automatic capture, if feasible | A01, A02 |
| A05 | Archive release and backup validation | A03; A04 if enabled |
| A06 | Optional GitHub Markdown backup | A02, M03 |

- [ ] **A01 — Test archive feasibility before committing infrastructure.** Evaluate Readability/Markdown conversion in the deployed runtime against public static, large, dynamic, blocked and malformed HTML fixtures. Measure CPU/memory/output size. Prove DNS/redirect/rebinding protections for automatic fetching or select manual/browser-clipped Markdown only. Write a decision record with package versions, measured limits and costs.
  Acceptance: a concrete supported route is documented. Automatic extraction is explicitly gated if it exceeds free limits or safe-fetch enforcement is unresolved. No paid service is enabled to mask an unsuccessful spike.
  Current evidence: the decision record selects manual/browser-clipped Markdown because safe-fetch protection is unresolved. No deployed extraction benchmark or package/runtime measurements were run, so A01 remains unchecked.

- [x] **A02 — Store and accept Markdown copies.** Add a separate copy table, owner-only paste/upload, UTF-8 byte limit, revision-checked replacement confirmation, and copy status in article details. Keep original URL and read state independent. Only expand schema for automatic jobs when A04 is selected.
  Acceptance: manual browser-clipped Markdown survives reload, stays private, rejects oversized input, and does not change read state. URL saving continues to work when copy storage fails. Deleting an article deletes its copy. Backup format advances with backward-compatible import of version 1.
  Evidence: local D1 covers Unicode byte boundaries, atomic concurrent/stale revision behavior, owner/CSRF/token checks, deletion cascade, v2 round-trip, v1 import, duplicate policy, and rollback. Browser smoke covers paste/upload, failed-save draft retention, replacement cancellation/confirmation, reload persistence, and narrow layout. Deployed release checks remain pending.

- [x] **A03 — Read preserved copies safely.** Add sanitized in-site rendering, Open original, capture metadata, readable narrow-screen layout, and Markdown download with frontmatter. Disable raw HTML and dangerous protocols. Explain external image dependency.
  Acceptance evidence: local browser smoke covers raw HTML, encoded dangerous schemes, credentials in links, valid absolute/relative/root/fragment links, text-only image references with zero image requests, headings, fenced code, wide tables, long text, unavailable original, missing and failed copy requests, replacement refresh, reload persistence, draft retention, and unchanged read state. It checks the sanitized DOM allowlist and validates a downloaded UTF-8 file's quoted metadata and exact Markdown body, including quote/Unicode/newline frontmatter. Screenshots: `/tmp/potem-a03-desktop.png` and `/tmp/potem-a03-mobile.png` (390px). Local checks passed: syntax, TypeScript, 37 Worker/D1 tests, dry-run build, and browser smoke. Deployment and device release checks remain pending under A05.

- [ ] **A04 — Implement durable server-side capture only after A01 passes.** The desktop bookmarklet now extracts locally from the already open page; this avoids adding a Worker fetch path. Add leased D1 jobs, scheduled bounded processing, three-attempt backoff, manual retry, SSRF-safe streamed fetching, extraction and atomic completion only if A01's safe-fetch and cost gates are satisfied. The normal save API must commit the URL before scheduling preservation. Document schedule/quota impact.
  Acceptance: worker crash recovery, duplicate job claims, exhausted retries, unsafe redirects/private destinations, oversized responses, and extraction errors are covered. Original-link saving works during extraction failures. Test representative extraction CPU against the selected plan. Current status: deferred because safe-fetch and deployed cost evidence remain unavailable. Browser-side extraction does not add jobs or automatic server fetching.

- [ ] **A05 — Validate archive backup and release.** Export/import copy content and metadata without auth secrets; test restoring a preserved library. Run the archive behavior on the deployed origin and record supported source types, missing images and failed extraction behavior.
  Acceptance: a restored copy can be read/downloaded while its source is unavailable. No archive failures silently replace the last successful copy. Document measured storage headroom and when an R2 migration would become useful.
  Local rehearsal delivered: [archive rehearsal](archive-rehearsal.md) adds read-only supplied-backup validation, byte-bounded imports, two fresh local D1 databases, exact field reconciliation before/after repeat import, restored reader/download checks with external requests blocked, and private count/byte reports. Eight helper tests and the fixture rehearsal pass: 30 articles, 28 copies, two import batches, two reader samples, 1,282,262 JSON bytes and 1,376,256 measured local D1 bytes. Supplied-file checks cover opaque IDs, duplicate/newline titles, pagination, exact downloads, immutable input/report hardlinks, version 1 and invalid UTF-8. SIGTERM cleanup was verified.
  Still pending: deployed-origin authenticated archive/restore verification, actual-device release checks, and measured production/account D1 storage headroom. Fixture measurements do not establish production capacity; A05 remains unchecked.

- [x] **A06 — Save Markdown copies to a configured GitHub repository.** Implemented as an unchecked **Also save to GitHub** checkbox and a saved-copy retry action. At the owner's request, production targets the public `Pajdzik/Kamilpedia` repository, `main`, at `Articles/<id>.md`; files inherit repository visibility. Original URL, title, and capture metadata are in quoted frontmatter. D1 remains authoritative for content and read state. Repository/branch/folder are configurable; a separate server-side token is scoped to repository contents. Automatic mirroring and background retries are deferred.
  Acceptance: local Worker/D1 and browser checks cover Unicode/content/metadata recovery through version-2 import, idempotent retries, revision and blob-SHA conflict protection, unrelated-file protection, owner/CSRF access, and GitHub failure without undoing a D1 save. Files and client assets exclude credentials/auth records. The [GitHub Markdown guide](github-markdown.md) documents configuration, status limits, deletion/history, and recovery. Live GitHub commit verification remains pending deployment and configuration of `GITHUB_BACKUP_TOKEN`.

- [x] **G01 — Recover GitHub Markdown backups offline.** `scripts/github-convert.ts` converts local Potem GitHub Markdown files into bounded version-2 import batches and a private report. It preserves writer metadata/body bytes, reports missing read state, applies deterministic normalized-URL duplicate and conflicting-ID rules, and rejects unsafe source/output conditions. `pnpm test:github` passes 12 parser/converter tests, the actual-writer round trip, and a temporary local Worker/D1 rehearsal. The fixture imports two records, skips one existing normalized URL, reconciles the exported records, then repeats with zero writes while preserving the existing record's title, copy, and read state. Actual GitHub folders, production import, and deployed/device release checks remain pending. See the [offline recovery guide](github-recovery.md).

## Optional migration

- [ ] **X01 — Import the existing Obsidian library.** The offline converter is implemented in `scripts/obsidian-convert.ts`, with temporary-vault coverage and a local Worker/D1 restore rehearsal in `pnpm test:obsidian`. It reports valid, duplicate, and excluded records and preserves source bytes in fixtures. Fixture import/export/reimport checks reconcile records and preserve an existing normalized-URL record with its copy and read state. The owner's actual vault has not been read; owner review, actual import, and retirement of the old flow remain pending.
  Acceptance: dry-run and import counts reconcile; original vault files are byte-identical afterward; existing service records remain intact; malformed source files are reported individually. Retire the old flow only after owner review of the reconciliation. Fixture evidence alone does not complete X01.
  Fixture evidence (October 2, 2026): ten converter unit tests pass. The temporary Worker/D1 rehearsal imports three eligible records with one existing-URL skip, exports and reconciles three records, then reimports with zero writes and three skips. The existing record's title, dates, read state, and Markdown copy remain unchanged. No actual-vault or production import was attempted.

## Parallel work and handoff

After M01/M02 land, M03 can build auth while M05 builds the UI against frozen fixtures. M04 integrates after M03; M06 and M07 can run in parallel once their prerequisites land, with the integrating agent owning shared route wiring and any overlapping UI controls. A03 and A04 can work separately after A02, provided A01 authorizes automatic fetching. Do not parallelize migrations or lockfile edits without one designated owner.

Every handoff includes task ID, implementation summary, changed paths, commands/results, manual evidence, and remaining limitations. Use targeted tests for state transitions, boundaries, persistence, auth, and hostile input; avoid tests that merely mirror styling or implementation internals. Only widen validation after a new change or unresolved failure. Completed tasks are checked only where local evidence is available. M03 implementation passes mocked-provider/security tests but its real OAuth callback check is pending. M06 local browser smoke now exercises the generated bookmarklet against a separate source origin and real temporary Worker/D1: Markdown output, absence of third-party extraction requests, explicit-save behavior, existing-copy protection, copy-failure reload/retry, URL-change detachment, and blocked-script fallback. Desktop and 390px capture-review screenshots were inspected. Actual iOS and Android sharing checks remain pending. M08 configuration, CI and operations instructions are delivered; remote deployment/release checks remain pending.

Browser capture evidence (October 2, 2026): 37 Worker/D1 tests, `pnpm typecheck`, `pnpm test:browser`, and `pnpm build` dry-run pass. The browser smoke uses a separate source origin and real temporary Worker/D1; it covers Markdown output, no third-party extraction requests, explicit-save behavior, existing-copy protection, copy-failure reload/retry, URL-change detachment, and blocked-script fallback. Inspected screenshots: `/tmp/potem-browser-capture-desktop.png` and `/tmp/potem-browser-capture-mobile.png` (390px). Deployment and real-device sharing remain pending.

GitHub capture follow-up evidence (October 2, 2026): the capture dialog includes the default-unchecked **Also save to GitHub** option and owner-only destination configuration. Syntax checks, TypeScript checks, all 38 Worker/D1 tests, browser smoke, and the dry-run build pass. API coverage verifies configuration validation, absence of credentials, and rejection of save-only token access. Browser coverage verifies unchecked captures make no GitHub write, opted-in saves send the revision returned by D1, failed local saves block GitHub, and GitHub failure/reload/retry performs only one local copy write. **Done** preserves the saved copy. Desktop and 390px screenshots were inspected. Deployment and live GitHub commit verification remain pending.


## Implementation evidence

- Foundation snapshot: 4 real local D1 repository tests and TypeScript checks pass independently of later PRs.
- Integrated backend: 17 Worker/D1 tests pass, including OAuth state/owner restrictions, session logout/expiry, capture scope/rate/revocation, bounded request parsing, import atomic rollback and first-page export failure.
- Website: strict DOM TypeScript checks, content-hashed production asset build, desktop 1440px and phone 390px browser smoke pass. The committed `pnpm test:browser` uses temporary local D1, verifies read state after reload, last-page controls, draft recovery, ambiguous shared text, and capture guide routing. CI runs these checks on Ubuntu.
- Deployment: Wrangler dry run passes; no Cloudflare resources or real credentials have been provisioned by these PRs.
- Prototype: strict TypeScript checks and the isolated fixture/browser smoke pass; its built runtime uses only Node built-ins. Docker image execution has not been verified in this environment.

PR stack (merge in order): [design #1](https://github.com/Pajdzik/read-it-later/pull/1), [foundation #2](https://github.com/Pajdzik/read-it-later/pull/2), [API #3](https://github.com/Pajdzik/read-it-later/pull/3), [website #4](https://github.com/Pajdzik/read-it-later/pull/4). Each implementation layer depends on the previous one.
