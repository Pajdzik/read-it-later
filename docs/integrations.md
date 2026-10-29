# Optional article integrations

Potem stores articles and Markdown copies independently of external destinations. Saving, reading, importing, and background extraction work with no integrations configured. Sending a copy is an explicit additional action; it never receives an unsaved editor draft. GitHub login and GitHub backup configuration are separate concerns.

In article details, select a destination and check **Also send to an integration** before saving Markdown. Alternatively use **Send saved copy to …** after a copy exists. The browser capture dialog offers the same destination choice. Choices start unchecked in a new editor. Each destination has its own confirmed status, and a failed delivery leaves the local copy intact. Capture retries remember the saved revision and destination across reloads, so a retry cannot silently send new content or switch recipients. A removed or changed destination requires a fresh review.

The browser extension defaults to Review mode. Options → **Optional integration** defaults to **Save privately in Potem**. Automatic private saving needs no external integration. To enable automatic delivery as well, connect to Potem, select an integration, review its destination and description, and confirm the consent checkbox. Changing the destination or its disclosure invalidates that consent. Previous GitHub-only extension preferences require setup again after upgrading.

## Provider interface

`src/integrations/types.ts` defines `ArticleIntegration`: public configuration, saved-copy status, and `deliver({article, copy})`. `src/integrations/registry.ts` discovers providers and checks the requested saved revision and destination identity before delivery. The UI discovers providers through the API and contains no provider-specific publishing flow.

The GitHub adapter retains the existing writer, path reservations, readable filenames, conflict protection, and backup receipts. Existing `GITHUB_BACKUP_*` configuration works without a data migration of those records. GitHub appears only when its repository and token are configured. See [GitHub Markdown](github-markdown.md) for repository setup and recovery. The legacy `/api/github` and `/api/articles/:id/github` endpoints remain available to existing clients.

## Custom delivery hooks

A private service binding lets an independently deployed integration service handle destinations such as Kindle, email delivery, or another archive. There is no built-in Kindle email/EPUB transport in Potem: the receiving service implements that provider-specific work. Adding a configured hook needs no article API or frontend changes.

Add the `ARTICLE_HOOKS` service binding in the applicable Wrangler environment, alongside its existing service bindings:

```jsonc
"services": [
  // Keep existing services here.
  { "binding": "ARTICLE_HOOKS", "service": "my-article-integrations" }
],
"vars": {
  // Keep existing variables here.
  "ARTICLE_HOOKS_CONFIG": "[{\"id\":\"kindle\",\"name\":\"Kindle\",\"destination\":\"My reading device\",\"description\":\"Send a saved article to my Kindle delivery service.\"}]"
}
```

Configuration accepts up to ten hooks with unique lowercase IDs (letters, digits and hyphens; `github` is reserved), a name, destination, and description. These fields are public to the signed-in owner: keep credentials and private routing addresses in the receiving service's secrets. Use a destination identifier that changes whenever the actual recipient changes, even if its display name stays the same. Changing a hook's ID, destination, or description changes its consent identity and starts a new delivery history. A configured hook without the service binding is displayed as unavailable. Invalid configuration disables delivery discovery while local article/copy saves remain available.

The core calls the bound service's `fetch` handler at `POST https://article-hooks/hooks/:id`. This URL is an internal service address, not a user-supplied webhook URL. [Cloudflare HTTP service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/) route the request to the configured Worker. Keep that receiver private, with no public route, or authenticate any separate public entrypoint it exposes. Credentials and receiver response bodies are never sent to the frontend.

The JSON contract is:

```json
{
  "version": 1,
  "event": "article.delivery.requested",
  "deliveryId": "stable-sha256-id",
  "integration": {
    "id": "kindle",
    "destination": "My reading device",
    "destinationKey": "public-configuration-identity"
  },
  "article": {
    "id": "k7m2q9x4",
    "url": "https://example.com/article",
    "title": "Article title",
    "author": null,
    "description": null,
    "savedAt": "2026-10-01T00:00:00.000Z"
  },
  "copy": {
    "markdown": "# Article\n\nSaved body.\n",
    "source": "paste",
    "capturedAt": "2026-10-01T00:00:00.000Z",
    "revision": "saved-copy-revision"
  }
}
```

The same `deliveryId` is sent in `Idempotency-Key`. It is stable for a destination and exact article/copy snapshot, including after an ambiguous network failure. The receiver **must deduplicate by this key**, including concurrent requests, before performing external side effects. Potem suppresses already-confirmed identical deliveries, but cannot guarantee exactly-once sending across two services. A new copy revision or changed article metadata produces a new key; read-state changes do not.

Return `200`, `201`, or `204` only after successful delivery or durable, deduplicated acceptance. The UI's “sent” status records this acceptance; device arrival is the receiver's responsibility. Long-running conversion/email work belongs in the receiver's durable queue. Potem awaits the hook request with a 10-second deadline, ignores its response body, rejects redirects and other statuses (including `202`), and records a receipt only after confirmation. Failures require an explicit retry. An in-flight article change produces an `outdated` status. Deleting an article removes its receipts, while external copies remain at their destinations.

Apply migration `0008_article_integrations.sql` before deploying. It stores hook receipts with a cascading article foreign key; it does not alter existing GitHub tables or export/import formats.

## API

All routes require an owner session, return private/no-store responses, and reject save-only capture tokens. POST additionally requires same-origin and CSRF validation.

| Route | Response/action |
| --- | --- |
| `GET /api/integrations` | `{integrations: IntegrationConfiguration[]}`; no remote request or credential |
| `GET /api/articles/:id/integrations` | `{integrations: IntegrationStatus[]}`; local confirmed receipts, not a remote poll |
| `POST /api/articles/:id/integrations/:integrationId` | `{expectedRevision, expectedDestinationKey}` → `{integration, unchanged}` |

Configuration provides `id`, `name`, `description`, `configured`, `destination`, `destinationKey`, and an optional availability message. Status adds `not_saved`, `saved`, or `outdated`, optional `deliveredAt`, and an optional provider result URL. `expectedDestinationKey` is mandatory, including for manual sends. The endpoint accepts no article body, webhook URL, credential, or arbitrary provider parameters.

Validation covers hook discovery without GitHub, disabled/invalid configuration, revision/destination protection, independent receipts, failure recovery and stable retry keys, no delivery on local save, metadata/read-state handling, owner/CSRF restrictions, and deletion cleanup. Chromium extension integration exercises a synthetic Kindle destination, consent, review, automatic private saving without integrations, destination changes, and same-revision retry against temporary Worker/D1 storage. Provider requests are mocked; no real Kindle or GitHub delivery occurs in these tests.
