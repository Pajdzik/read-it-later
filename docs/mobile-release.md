# Mobile release validation

Status: automated local mobile rehearsal and read-only deployed checks recorded October 6, 2026. Automated and physical-device results are recorded separately. M06 and M08 remain pending until their physical-device and deployed acceptance checks pass.

## Automated scope

`pnpm test:mobile` runs Playwright touch flows with Android Chromium and iPhone WebKit profiles against a fresh temporary local Worker/D1. CI installs both browser engines. The existing `pnpm test:browser` desktop smoke remains a separate check.

The runner covers anonymous sign-in, Add/save and duplicate handling, reading a saved Markdown copy, explicit read/unread across reload, search/filter navigation, settings, dialog close/recovery, long titles/URLs, narrow portrait and short landscape layouts, and wide reader content. It uses a local HTML fixture, and verifies failed-save draft retention, ambiguous shared text, logged-out `/add` recovery, and that GET share-target navigation never saves before confirmation. It does not exercise real OAuth.

It derives share-navigation names from the manifest, validates referenced icon responses and PNG dimensions, waits for service-worker activation and a populated public cache, and checks that private API responses are `no-store` and absent from caches. It also exercises local capture-token success, duplicate, and revocation using a temporary token; this confirms the HTTP contract, not the iOS Shortcuts app. The runner uses dummy auth settings and removes its temporary database, tokens, processes, and browsers after the run.

## Automated local evidence — October 6, 2026

`pnpm test:mobile` passed against a fresh local Worker and temporary D1 database using Wrangler 4.145.0. The runner uses an isolated temporary Wrangler config and wrapper, a credential-scrubbed environment, dummy local auth values, a local HTML fixture, and a temporary token that is removed with the database. It does not read `.dev.vars`, use production data, or fetch external article sites. Chromium completed as version 151.0.7922.34 with Playwright's Pixel 7 Android/touch profile (412×839); WebKit completed as version 26.5 with the iPhone 13/touch profile (390×664). Both ran portrait, 360×560 short portrait, and 844×390 landscape views.

The run covered anonymous sign-in, manifest-driven GET share navigation, no save before confirmation, ambiguous text, logged-out draft recovery after reload, duplicate preservation, Add failure and retry while offline, a 500-character title and long URL, local HTML-to-Markdown extraction, title-to-reader navigation, search and read filters, explicit read/unread persistence, settings/theme, dialog close and draft recovery, and wide reader content. It waited for an activated service worker and confirmed its populated cache contains the hashed public JS/CSS and public icons; API/session responses were `private, no-store` and no API or `/add` route appeared in the cache. Local `/api/capture` returned success, duplicate, and revoked-token rejection responses using a temporary bearer token. This verifies the HTTP contract, not the iOS Shortcuts app. No browser runtime errors were reported.

The checks exposed two mobile UI defects and both were fixed: share-target guidance appeared behind the open Add dialog, so the success/ambiguity message now appears within Add; and the narrow reader's table maximum width exceeded its available modal content width by 6 CSS pixels, so wide blocks now stay within their parent while remaining horizontally scrollable. The implementation and integrating agents inspected selected Chromium and WebKit screenshots, including the share guidance, reader, landscape Add, and settings views.

Screenshots (local emulation):

- Chromium Android: `/tmp/read-it-later-mobile-chromium-android-portrait-anonymous.png`, `/tmp/read-it-later-mobile-chromium-android-portrait-logged-out-draft.png`, `/tmp/read-it-later-mobile-chromium-android-portrait-add-review.png`, `/tmp/read-it-later-mobile-chromium-android-portrait-ambiguous-share.png`, `/tmp/read-it-later-mobile-chromium-android-portrait-reader.png`, `/tmp/read-it-later-mobile-chromium-android-landscape-short.png`, `/tmp/read-it-later-mobile-chromium-android-landscape-add-review.png`, `/tmp/read-it-later-mobile-chromium-android-short-portrait-settings.png`.
- WebKit iPhone: `/tmp/read-it-later-mobile-webkit-iphone-portrait-anonymous.png`, `/tmp/read-it-later-mobile-webkit-iphone-portrait-logged-out-draft.png`, `/tmp/read-it-later-mobile-webkit-iphone-portrait-add-review.png`, `/tmp/read-it-later-mobile-webkit-iphone-portrait-ambiguous-share.png`, `/tmp/read-it-later-mobile-webkit-iphone-portrait-reader.png`, `/tmp/read-it-later-mobile-webkit-iphone-landscape-short.png`, `/tmp/read-it-later-mobile-webkit-iphone-landscape-add-review.png`, `/tmp/read-it-later-mobile-webkit-iphone-short-portrait-settings.png`.

Other local checks passed: `pnpm typecheck`; `pnpm test` (7 files, 43 tests); `pnpm build` (web/prototype builds and Wrangler dry run); existing `pnpm test:browser`; and `pnpm test:mobile`. Dependency installation used `pnpm install --frozen-lockfile`. The bundled environment provided Node 24.19.0 and pnpm 11.19.0; CI continues to install the repository's declared pnpm 12.4.1 and Node 22. The `pnpm` lockfile was unchanged.

## Read-only deployed evidence — October 6, 2026

The production origin `https://read-it-later-production.pajdzik.workers.dev` returned 200 for the public shell, health endpoint, `/add?url=` fixture, capture guide, manifest, service worker, and all manifest icons. The manifest reports the `/add` GET share target with `title`, `text`, and `url`; PNG icons were 192×192 and 512×512. `/api/session` returned `authenticated: false` with `private, no-store`. `/api/articles`, `/api/export`, and `/api/capture-tokens` rejected anonymous requests with 401 and `private, no-store`. No production state was changed.

Read-only browser emulation on production passed on Chromium 151.0.7922.34 using Pixel 7 and WebKit 26.5 using iPhone 13. Both showed anonymous sign-in, retained a logged-out `/add` URL draft, and activated a service worker whose populated cache contained only the six public assets. Root inspected `/tmp/potem-production-mobile-anonymous.png`, `/tmp/potem-production-mobile-share-draft.png`, `/tmp/potem-production-iphone-anonymous.png`, and `/tmp/potem-production-iphone-share-draft.png`. The latest successful main CI/deploy run was [run 37571252253](https://github.com/Pajdzik/read-it-later/actions/runs/37571252253), at commit `008499aea576aaa024b2b27700bc351bb66b7c28`.

These checks did not sign in or use an authenticated production account. They do not verify deployed save/read/export behavior or prove that local changes are deployed. Actual iPhone Safari and Shortcuts behavior, Android installation and OS Share Sheet behavior, and physical keyboard behavior remain pending. No `adb` or `simctl` device tooling was available on the host.

## Deployed and physical-device scope

The existing production URL is `https://read-it-later-production.pajdzik.workers.dev`. The read-only public-shell, health, manifest/icon, anonymous API rejection, and cache-header checks are recorded above. Authenticated production behavior requires a separate release check on the deployed commit; local results do not establish it.

For an iPhone/iPad release check, verify Safari sign-in, paste/save/read/reload, portrait/landscape and keyboard reachability, and the Share Sheet Shortcut using a disposable capture token. Confirm success, duplicate, revoked-token error, and network failure, then revoke the test token.

For an Android release check, install the app in a browser supporting Web Share Target, share one URL and title into it, confirm no save before review, save and reopen the copy, and check ambiguous text and logged-out draft recovery. Also verify network failure retains the draft and private responses are absent from service-worker caches. Record OS/browser/version, origin, deployed commit, date, and results. Browser emulation does not validate installation, OS Share Sheets, on-screen keyboards, or actual Safari/Chrome device behavior.

Physical-device results remain pending until observed or supplied by the owner, so M06 and M08 remain incomplete.
