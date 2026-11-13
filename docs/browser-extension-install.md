# Potem browser extension installation

**Release status:** the current implementation supports private Potem saves and optional article integrations. Recorded Chromium local integration coverage includes both flows. Firefox has passed a temporary-install private Review capture, but the full Firefox workflow, store distribution, and a signed Firefox package remain pending. A fresh extension test run in this checkout could not fetch dependencies because registry DNS was unavailable.

## Build packages

The production build targets `https://read.pajdzik.pl` and writes ZIP archives and unpacked folders under the ignored `dist/extension/` directory:

```sh
pnpm install --frozen-lockfile
pnpm build:extension -- --production
```

For local development, the default package targets `http://127.0.0.1:8787`. A development package cannot target an arbitrary public origin. Use a test browser profile and disposable local data when validating it. Rebuild after changing extension source; generated packages are not checked into the repository.

## Chrome (unpacked)

1. Build the production package after the compatible Potem website/API version is available.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Select **Load unpacked** and choose `dist/extension/chrome`.
4. Open the extension’s **Details → Extension options**, choose **Connect to Potem**, and sign in in the Potem tab.
5. Choose **Review before saving** or **Save automatically**. Review mode is the default.

Chrome asks for temporary access to the active tab when capture runs, plus access to the configured Potem site. It does not request access to every website, cookies, history, or GitHub credentials.

## Firefox (temporary install)

Firefox temporary add-ons are removed when the browser closes. This is suitable for local validation, not distribution.

1. Build the production package after the compatible Potem website/API version is available.
2. Open `about:debugging#/runtime/this-firefox`.
3. Select **Load Temporary Add-on…** and choose `dist/extension/firefox/manifest.json`.
4. Open the extension’s settings from `about:addons`, connect to Potem, and configure its capture mode.

For self-distribution, submit the Firefox archive for Mozilla signing and distribute Mozilla’s signed output. Signing requires the publisher’s own Mozilla account and API credentials. Chrome Web Store submission also requires the publisher’s account. Store submission and signing have not been completed.

## Saving privately or sending to an integration

The extension works without an external integration. In Options, **Optional integration** defaults to **Save privately in Potem**. Automatic private saving needs no integration setup or external-send consent.

Potem may offer configured integrations, such as GitHub or a custom article hook. To send captured pages automatically, select an integration in Options, review its destination and description, check the consent box, and choose **Enable automatic saving**. Consent is tied to the Potem origin and the selected destination. A changed or unavailable destination requires review and fresh consent.

In **Review before saving**, inspect and edit the title, author, description, and Markdown in Potem. Save privately, or explicitly choose to send the saved copy to an available integration. New capture reviews do not send to an integration by default. Potem saves the copy before delivery; integrations receive the persisted copy, not unsaved editor text. A failed delivery leaves the Potem copy saved and offers a retry.

In **Save automatically** mode, one toolbar click saves the page privately. If an integration is selected and its destination-specific consent is current, Potem also sends the saved copy there. A login, destination change, duplicate conflict, or failed stage opens the Potem result/review tab.

The checked-in default GitHub backup repository, `Pajdzik/Kamilpedia`, is public. GitHub is offered only when configured, and the available destination and its disclosure can vary by environment. Review the displayed destination before consenting to automatic sends. The extension never stores GitHub credentials; GitHub delivery uses the Worker’s server-side credential.

## Limits and troubleshooting

The extension captures top-level HTTP(S) HTML pages on desktop. It does not capture PDFs, browser-internal pages, embedded frames, selected text, images, or offline pages. Restricted pages, incognito windows, empty extraction, and captures over 256 KiB require an explicit review/recovery action. Browser shutdown clears undelivered extension requests; a draft already delivered to Potem survives navigation and login redirects in that tab’s session storage.

If integration choices are missing or stale, reconnect to Potem from Options. If a destination or its description changes, review it and confirm consent again before automatic delivery. If a duplicate contains different Markdown or metadata, review the saved version and explicitly confirm any replacement. If delivery fails after the Potem copy is saved, use **Retry sending saved copy** on the result tab. Keep the result tab open until the operation finishes.

The Firefox package declares `browsingActivity` and `websiteContent` because capture reads the active page and sends the selected content to the user’s Potem service. Extraction runs locally using the pinned Defuddle bundle; it does not make a third-party extractor request.
