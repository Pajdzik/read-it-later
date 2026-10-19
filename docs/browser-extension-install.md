# Potem browser extension installation

**Release status:** implementation and Chromium local integration checks pass; an isolated Firefox temporary-install run also verified a private Review capture. The full Firefox workflow, store distribution, and a signed Firefox package are not available yet. Do not use a development build with real captures.

## Build packages

The release build targets the fixed production Potem origin and writes local archives plus unpacked folders under the ignored `dist/extension/` directory:

```sh
pnpm install --frozen-lockfile
pnpm build:extension -- --production
```

For local development, the default package targets `http://127.0.0.1:8787`. A development package cannot target an arbitrary public origin. Use a test profile and disposable local data when validating it.

## Chrome (unpacked)

1. Build the production package after the compatible Potem website/API version is available.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Select **Load unpacked** and choose `dist/extension/chrome`.
4. Open the extension’s **Details → Extension options**, then choose **Connect to Potem** and sign in.
5. Select Review mode, or review the current repository, branch, folder, and visibility before enabling Simple mode’s one-time automatic-publishing consent.

Chrome asks only for temporary access to the active tab when the toolbar action runs, plus the configured Potem site. It does not request access to every website, cookies, history, or GitHub credentials.

## Firefox (temporary development install)

Firefox temporary add-ons are removed when the browser closes. This is suitable for local validation, not distribution.

1. Build the production package after the compatible Potem website/API version is available.
2. Open `about:debugging#/runtime/this-firefox`.
3. Select **Load Temporary Add-on…** and choose `dist/extension/firefox/manifest.json`.
4. Open the extension’s settings from `about:addons`, connect to Potem, and configure its capture mode.

For self-distribution, submit the Firefox archive for Mozilla signing and distribute Mozilla’s signed output. Signing requires the developer’s own Mozilla account and API credentials. Chrome Web Store submission likewise requires the publisher’s own account. These account actions and store submissions are separate release work.

## Modes and publishing behavior

Review mode is the default. It opens Potem with the extracted URL, title, author, description, Markdown, safe rendered preview, and UTF-8 byte count. The URL is locked. Save privately, explicitly save the persisted Markdown copy to the configured GitHub destination, save the link alone after an extraction problem, or cancel.

Simple mode needs a one-time consent tied to the current Potem origin and exact GitHub repository, branch, and folder. It sends the URL and metadata to Potem, saves Markdown in D1, then asks the Worker to publish that saved revision. A changed destination, duplicate conflict, login, or failed stage opens the Potem result tab for review. GitHub retries reuse the saved copy revision; they do not upload editor text or rewrite the copy.

The production default repository, `Pajdzik/Kamilpedia`, is public. Anything published there can be read by anyone. The extension stores no GitHub credentials; the Worker retains its own server-side credential.

## Limits and troubleshooting

The extension captures top-level HTTP(S) HTML pages on desktop. It does not capture PDFs, browser-internal pages, embedded frames, selected text, images, or offline pages. Restricted pages, incognito windows, empty extraction, and captures over 256 KiB need an explicit review or retry action. Browser shutdown clears undelivered extension requests; an already delivered Potem draft survives tab navigation and login redirects in that tab’s session storage.

If Simple mode becomes unavailable, reconnect and verify the destination and consent in Options. If a duplicate has different Markdown or metadata, review the saved version and explicitly confirm replacement. If GitHub fails after the Potem copy is saved, use **Retry GitHub save for saved copy** on the result tab. Keep the browser result tab open until the operation finishes.

The extension package reports `browsingActivity` and `websiteContent` as required Firefox data categories because capture reads the active page and sends the selected content to the user’s Potem service. Source-page content is extracted locally using the pinned Defuddle bundle; no third-party extractor request is made.
