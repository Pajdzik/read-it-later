# Cloudflare deployment and operations

This service targets Workers Free with Workers Static Assets and D1. Deployment requires your own Cloudflare account and a GitHub OAuth app. No deployment or paid service is provisioned by the implementation PRs.

## Before deployment

1. Use Node 22.12+ and pnpm 12.4.1 and install the dependencies from the committed lockfile.
2. Run the repository's Worker typecheck, tests and build commands. The prototype's `npm start` is a separate Node server; do not upload it as the Worker.
3. Keep the Cloudflare account on Workers Free. Recheck [Worker limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/). Static asset requests are [free and unlimited](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/); dynamic requests and D1 operations have shared account quotas.
4. Create separate staging and production D1 databases with Wrangler. Replace the corresponding database IDs in the configuration; local development uses Wrangler's local storage rather than these remote databases. Never reuse production data for tests.
5. Replace `<account-subdomain>` in each `APP_ORIGIN` in `wrangler.jsonc` with the Workers subdomain assigned to your Cloudflare account, or use the exact custom domain routed to that Worker. Do not assume the hostname from the Worker name alone. Register a separate GitHub OAuth app for each environment with callback `<origin>/auth/github/callback`. Set `OWNER_GITHUB_ID` to the owner's immutable numeric GitHub user ID rather than their changeable login.
6. Store OAuth credentials with `wrangler secret put` for the selected environment. Never commit them or put them in frontend variables. The capture Shortcut needs its own revocable capture token, not these OAuth credentials.
7. Apply migrations to the selected remote D1 database, then deploy the Worker and built assets. Confirm environment/binding names against `wrangler.jsonc` before any command using `--remote`.

## Local development and release commands

```sh
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars
pnpm db:migrate:local
pnpm dev
```

The local-only bypass gives the loopback development UI a session without contacting GitHub. For real authentication, disable it and use a matching HTTPS origin and OAuth callback. `.dev.vars` must stay private.

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:browser
pnpm test:archive
```

The staging and production `APP_ORIGIN` and `OWNER_GITHUB_ID` values are non-secret Worker vars in `wrangler.jsonc`; replace their placeholders before deployment. Set the matching `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` as Wrangler secrets for each environment. `DEV_AUTH_BYPASS` must not be set there. Use the Wrangler executable installed by pnpm:

```sh
pnpm exec wrangler login
pnpm exec wrangler d1 create read-later-staging
pnpm exec wrangler d1 create read-later-production
# Fill the returned IDs, actual origins, and owner's numeric GitHub ID into the matching environment in wrangler.jsonc.
pnpm exec wrangler secret put GITHUB_CLIENT_ID --env staging
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET --env staging
pnpm exec wrangler d1 migrations apply read-later-staging --remote --env staging
pnpm build:web
pnpm exec wrangler deploy --env staging
```

Run validation on staging before deploying production. On a push to `main`, the `Checks` workflow applies pending production migrations and deploys the Worker after CI passes. Configure the repository's `production` Actions environment with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; the token needs Workers Scripts Edit and D1 Edit permissions for the configured production resources. Never run those commands against placeholder IDs. `pnpm build` is a dry run, not a publication. Local authentication bypass must remain absent from staging/production. Do not configure a fail-open route for an authenticated API.

## Release checklist

- [ ] Staging and production bindings are separate and migrations applied to the intended database.
- [ ] Missing OAuth/owner/origin configuration fails closed.
- [ ] Anonymous callers cannot list, export, edit or delete library data.
- [ ] Wrong GitHub identity cannot sign in; the intended owner can.
- [ ] Save, duplicate save, open original, mark read, reload and mark unread work from desktop.
- [ ] Capture token works only for saving; revocation is effective.
- [ ] iOS Shortcut tested on an actual phone, with a success and failure result.
- [ ] PWA share target tested on an installed app in a supported Android/browser environment.
- [ ] Export/import round trip verified on a separate database with matching counts/read state.
- [ ] API/database failure leaves a retryable error and the user's unsaved draft.
- [ ] Authenticated responses have no-store and are absent from service worker caches.

Record the deployment URL, commit, migration version, date and checks in a release note. Pending phone checks mean mobile release validation is incomplete. A local build and mock OAuth tests do not confirm a real OAuth deployment.

## Backups and restore

Download versioned library JSON regularly through Settings. Exports contain articles and read state, never authentication records. Keep copies outside Cloudflare. Large exports may include concurrent edits across pages: for a consistent personal backup, avoid editing while exporting.

Restore first into a separate staging database using Import, reconcile article counts and sample URLs/timestamps/read states, and repeat the import to verify duplicate skipping. Existing URL records are preserved by import; it is not an overwrite/rollback tool. If an export fails midstream, retry it; a partial JSON download is not a valid backup. The browser download waits for the full response body. Imports are limited to 1 MiB and 1,000 records each. Split larger libraries into valid versioned envelopes, retaining all fields and the format version. Never split an individual record.

Run `pnpm archive:rehearse --backup /absolute/path/export.json --report /absolute/path/report.json` before relying on a backup. This uses separate temporary local databases, validates every restored field and repeated import, and checks restored copy reading/downloading while external requests are blocked. It reads the supplied backup without changing it; its optional report contains only counts, byte measurements, and check results. The helper handles the 1 MiB/1,000-record import bounds automatically during rehearsal and rejects a single record that cannot fit. It supports up to 64 MiB input. See the [rehearsal guide](archive-rehearsal.md). This is local evidence; deployed-origin archive restoration and production storage measurements remain release checks.

For a complete database-level restore or schema migration, use [D1 export](https://developers.cloudflare.com/d1/reference/import-export/) and [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/). A complete database export also contains auth tables: keep it private and revoke sessions/capture tokens after recovery if exposure is suspected. Provider recovery retention differs by plan; recheck it instead of treating it as permanent backup.

## Rollback and quotas

Back up before destructive schema changes. Deploy additive migrations first and keep the previous Worker compatible. Roll back only to a Worker version that understands the current schema. Do not automatically reverse migrations or delete the database as a rollback step.

Inspect Workers request/error/CPU metrics and D1 storage/row metrics. Do not log article URLs, titles, bodies, cookies, bearer tokens or OAuth codes. D1 index updates count toward rows written; search may scan a small personal library. The atomic capture limiter also writes to D1. Free quota exhaustion is an outage until the relevant quota resets or capacity is freed; do not silently enable a paid plan. Use the UI's retry behavior and keep capture drafts. An operator should revisit query/index choices before scaling beyond one owner.

## Background Markdown extraction

Migration `0006_background_capture.sql` adds durable extraction intent, title origin, and leased jobs. The one-minute Cron Trigger is configured in each environment. `BACKGROUND_CAPTURE_ENABLED` defaults to `false`; the scheduled handler performs no database or source work while paused. Saves still record requested capture and show paused status. Merging this PR does not activate the processor; until activation, website URL capture no longer returns an immediate copy.

Before activation in a chosen environment:

1. Complete A01 with deployed staging evidence for connection-time public-egress enforcement and representative/worst-case Defuddle CPU/memory. Workers Free's scheduled CPU limit is 10 ms; local tests and network latency do not prove fit. Record a deliberate runtime/cost decision if it exceeds the selected plan.
2. Configure the optional `ARTICLE_FETCHER` **HTTP service binding** to a verified fetching Worker. Its `fetch` accepts the original article URL as the request URL, makes only the requested single HTTP(S) hop, and returns the upstream status/headers/body without following redirects. It must validate all DNS/CNAME/A/AAAA candidates and enforce the public-IP policy on the actual connection, keeping original-host TLS certificate checks. It must not be an unrestricted `fetch` proxy or add cookies/credentials. This repository supplies the client and test fixture boundary, not a deployed protected gateway. Do not bind VPC access that can reach private destinations without an enforced deny policy.
3. Declare the verified service under the selected environment's `services` array with `binding: "ARTICLE_FETCHER"` and its actual Worker name. Service bindings are environment-specific; do not point staging at production. Regenerate Wrangler types and run checks after configuring it.
4. Set `BACKGROUND_CAPTURE_ENABLED` to `true` in that same environment only after both gates pass. Validate real scheduled extraction, private reader status, transient retry, manual-copy priority, and iOS/Android capture. Capture-token acknowledgments confirm the request rather than successful conversion.

There is no ordinary-fetch fallback if the binding is absent. A DNS preflight followed by hostname fetch does not pin the connected address. Unsupported sources remain saved links with manual/browser capture available. See [background extraction](background-markdown-extraction.md) for protocol, limits, and acceptance cases.

To pause, set the flag to `false` and deploy the config through the existing workflow. This retains articles, intent, copies, and jobs; accepted jobs resume when enabled. Removing the Cron Trigger also stops dispatch but requires the normal trigger propagation period. Deletion cancels the article's job through the foreign key. Do not restore jobs/leases through library JSON imports, and do not backfill old links without a separate owner action.

If the configured owner ID changes, revoke existing sessions and capture tokens as part of the change; these records are for the single library rather than separate user accounts.
