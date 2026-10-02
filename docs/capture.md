# Capture links

Potem accepts links from the Add form, desktop bookmarklet, iOS Shortcut, and (in supported installed browsers) the PWA share target. Every capture is a draft until you confirm it in the website, except the iOS Shortcut, which posts directly to the capture API.

## Desktop bookmarklet

1. Sign in to Potem and open **Capture help** (or `/capture.html`).
2. Drag **Save to Potem** into the browser bookmarks bar.
3. On an article page, activate that bookmark. It opens `/add` with the current page URL and title prefilled, then extracts the visible document to an editable Markdown draft in the Potem tab.
4. Review the URL, title, and Markdown, then press **Save link**. The link is saved first and Potem then attempts to save the copy. The **Save this Markdown copy** checkbox starts checked; uncheck it to save only the link. Existing copies are protected from replacement. If copy saving fails, the link stays saved and the draft remains available; retry or save link-only.

If you installed the older link-only bookmarklet, replace it by dragging the current **Save to Potem** link from Capture help into your bookmarks bar after deployment.

Potem uses a bundled, pinned version of Defuddle in the source page. Extraction stays in your browser; content is sent only to your Potem tab over a one-use, origin-checked message and is never placed in a URL. Extraction disables Defuddle's async third-party fallback. The source page's CSP may block the script, or its opener policy may block the handoff. In either case the URL/title prefill remains when the browser permits the Potem tab to open; use the Markdown paste fallback from article details. Shared URLs and the one-time handoff channel are removed from the address bar after the app stores the link draft.

## iOS Shortcut

Create a capture token under **Settings → Capture tokens**. The plaintext token appears only once. Create a Shortcut named “Save to Potem” and enable it in the Share Sheet:

1. Accept URLs and Safari web pages as Shortcut input.
2. Add **Get URLs from Shortcut Input**. If the share input contains several URLs, ask to choose one or repeat the capture action for each; send exactly one URL per request.
3. Add **Get Contents of URL**. Set the URL to `https://YOUR-APP-ORIGIN/api/capture`, method to `POST`, and request body to JSON.
4. Add the `Authorization` header with value `Bearer YOUR_CAPTURE_TOKEN`.
5. Send JSON with `url` set to the single URL from step 2. Add `title` only when the Shortcut Input has a non-empty name; omit the key when it is blank.
6. Show the response. A successful response includes `duplicate`; true means the link was already present. A failed request should be shown as an error.

Replace the origin with the deployed Potem origin and token with the one-time value from Settings. Do not put a capture token in a bookmarklet, URL, or shared shortcut. Revoke a lost token in Settings and create another. The capture token can add links only; it cannot read or change the library.

## PWA sharing

On a browser that supports Web Share Target, install Potem using the browser’s install command. Sharing an article to the installed app opens `/add` with the URL/title/text for review. If shared text contains several links and no URL field identifies the intended one, paste the desired link into the form. Support varies by browser; iOS users should use the Shortcut or paste fallback.

Potem’s service worker caches only versioned public app assets. It does not cache account pages, article data, or API responses, and it does not support offline saves.
