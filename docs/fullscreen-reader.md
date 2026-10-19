# Full-screen article reader

Design specification prepared before implementation on October 18, 2026.

Opening an article replaces the library visually with an edge-to-edge reading surface on desktop and mobile. The browser keeps its normal controls; the app does not request browser Fullscreen API access. Keep the native modal dialog for focus containment, Escape, and the return to the opening article or editor.

## Layout

```text
┌──────────────────────────────────────────────┐
│  ← Back                     Open original ↗  │  compact sticky toolbar
│                                              │
│             Article title                    │
│             By Author                        │
│             ▸ About this copy                │  collapsed metadata
│                                              │
│             Article text begins here.        │
│             One uninterrupted scroll.        │
│             …                                │
└──────────────────────────────────────────────┘
```

- Surface: existing `--white`, `--ink`, `--green`, `--muted`, and `--line` tokens in both themes. No inset modal frame, rounded corners, shadow, background dimming, library navigation, or permanent bottom toolbar.
- Toolbar: approximately 56px high plus the top safe area, with a visible Back control and the existing Open original link. Use existing small icons, borders, focus rings, and green links. Back has a minimum 44px touch target. The toolbar stays available during long reads and never overlays the text.
- Reading column: a shared maximum width of 42rem for the toolbar contents, title, author, disclosure, pending state, and article. Center it on desktop; use 16px side gutters on phones and 24–32px on larger screens, respecting safe areas. All blocks align to the same edges.
- Typography: retain Georgia for the title and body, system sans for controls and metadata. Body is 18px with roughly 1.7 line height on desktop and 17px on phones. Keep title sizing responsive and avoid an empty band above it. Remove the body's first-child top margin.
- Secondary information: put capture metadata and the image-reference explanation in a native `details` disclosure labeled “About this copy,” collapsed each time another article opens. Keep source access visible in the toolbar. The article should begin within roughly the first 220px on a phone with an ordinary two-line title.
- Scrolling: the dialog is the single vertical scroll container, sized to `100dvh` with a `100vh` fallback. Lock background page scrolling only while the reader is open. Code and tables scroll horizontally within the column; long URLs wrap. Short landscape screens must still allow reading and exiting.

## Behavior and validation

Preserve saved-copy rendering, unsaved editor drafts, pending/failed capture actions, stale-request guards, privacy cleanup on close/logout, and the rule that opening a copy does not mark it read. Reset the reader scroll to the top on a fresh open and when pending capture becomes readable. Focus the article title without scrolling; return focus on close. Avoid animations and new dependencies.

Verify exact viewport coverage at desktop, phone, and landscape sizes; consistent column alignment; no horizontal page or dialog overflow with wide Markdown; a reachable Back control after a long scroll; metadata disclosure behavior; focus and background scroll restoration; both themes; and pending-to-ready capture. Run the existing typecheck, Worker/D1 suite, dry-run build, desktop browser smoke, and Chromium/WebKit mobile smoke. Inspect desktop and phone screenshots before opening the PR.

## Visual review

The implementation retains the warm light surface, dark green theme, green controls, and Georgia reading type. Desktop uses a centered column; the phone version uses 16px gutters. Local review captures use a synthetic article and contain no private library content.

Local validation on October 18, 2026: `pnpm check`, all 72 Worker/D1 tests, `pnpm build` (deployment dry run), `pnpm test:browser`, and `pnpm test:mobile` pass. Mobile emulation covers Chromium 151 with Pixel 7 and WebKit 26.5 with iPhone 13, including short landscape screens. The new checks exercise exact viewport coverage, aligned content, wide Markdown, the metadata disclosure, Back after a long scroll, initial focus and explicit opener restoration, scroll reset, and background scroll locking/restoration. Explicit opener tracking fixes Safari touch behavior, where tapping a button does not reliably make it the active element. Light/dark phone and desktop screenshots were inspected. Physical-device validation remains separate.
