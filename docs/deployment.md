# Cloudflare deployment and operations

The base app runs on Workers with Workers Static Assets and D1. Optional automatic capture uses a private Cloudflare Container and requires Workers Paid. Deployment requires your own Cloudflare account and a GitHub OAuth app. No deployment or paid service is provisioned by the implementation PRs.

## Before deployment

1. Use Node 22.12+ and pnpm 12.4.1 and install the dependencies from the committed lockfile.
2. Run the repository's Worker typecheck, tests and build commands. The prototype's `npm start` is a separate Node server; do not upload it as the Worker.
3. Workers Free supports the base app with background capture paused. Automatic capture requires an explicit Workers Paid decision (see below). Recheck [Worker limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/). Static asset requests are [free and unlimited](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/); dynamic requests and D1 operations have shared account quotas.
4. Create separate staging and production D1 databases with Wrangler. Replace the corresponding database IDs in the configuration; local development uses Wrangler's local storage rather than these remote databases. Never reuse production data for tests.
5. Set each `APP_ORIGIN` in `wrangler.jsonc` to the exact public origin routed to that Worker. Production uses `https://read.pajdzik.pl`; staging uses its configured Workers subdomain. Register a separate GitHub OAuth app for each environment with homepage `<origin>` and callback `<origin>/auth/github/callback`. For production, the callback must be `https://read.pajdzik.pl/auth/github/callback`; the OAuth start and callback must use the same hostname so the browser sends its state-binding cookie. Set `OWNER_GITHUB_ID` to the owner's immutable numeric GitHub user ID rather than their changeable login.
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

Run validation on staging before deploying production. On a push to `main`, the `Checks` workflow builds and deploys the private capture service, applies pending production migrations, and deploys the app Worker after CI passes. The GitHub-hosted Ubuntu runner supplies Docker; no local Docker installation is needed for this release path. Configure the repository's `production` Actions environment with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; the token needs Workers Scripts Edit, Containers Edit, and D1 Edit permissions scoped to the intended account/resources. Workers access must cover both the app and capture Workers. See [Cloudflare token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/). Never run those commands against placeholder IDs. `pnpm build` is a dry run, not a publication. Local authentication bypass must remain absent from staging/production. Do not configure a fail-open route for an authenticated API.

## Release checklist

- [ ] Apply `0007_github_paths.sql` before releasing readable GitHub filenames. For the short-ID testing cutover, migrate retained JSON/Markdown with `pnpm backup:migrate`, then rebuild the disposable article library; the ID format change does not rekey existing rows automatically. After restoring into an existing GitHub destination, use Settings → Find existing GitHub backups before resuming backup writes. Preserve auth/configuration and unrelated repository files. See [article URLs](article-urls.md).
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

Migration `0006_background_capture.sql` supplies durable intent, title origin, and fenced D1 jobs. The one-minute Cron Trigger stays in the application Worker. The private executor in `capture/` handles both source fetching and conversion, with no D1 binding, OAuth credentials, GitHub token, or public route. `ARTICLE_EXTRACTOR` binds the app to the matching environment's capture service. `BACKGROUND_CAPTURE_ENABLED` remains `false` in all environments, so saving continues and scheduled capture does no work until activation.

### Cost and capacity

This executor requires [Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/), starting at $5 USD/month. [Container pricing](https://developers.cloudflare.com/containers/platform/pricing/) currently includes 25 GiB-hours of memory, 375 vCPU-minutes, and 200 GB-hours of disk monthly, shared across the account. The configured `basic` instance has 1 GiB memory, 1/4 vCPU, and 4 GB disk; maximum instances is one per environment, with a 30-second idle timeout. No container starts on an empty cron tick. CPU is billed for actual use; provisioned memory and disk are billed while awake, including idle time. Other Workers/Durable Objects/D1/logging usage and account workloads also count.

For planning, 30 captures/day × 30 days × 45 seconds awake per isolated capture is 11.25 GiB-hours and 45 GB-hours of disk. The conservative assumption of full 1/4-vCPU utilization throughout is 168.75 vCPU-minutes. Those Container figures fit the included allowance; the expected total for a small personal library is approximately $5/month before tax and other workloads. At 100 captures/day under the same assumptions, Container overage is approximately $0.34/month. These are estimates, not a spending cap; cold starts, retries, staging, and continuous backlog change the result. Measure staging and review account usage after activation. Sleeping limits idle expense; it does not impose a dollar limit.

### Build and deploy the executor first

The normal production release builds the image in GitHub Actions. Docker runs on the hosted Ubuntu runner, so Docker Desktop is optional for contributors. Local image building and Wrangler's full Container dry run require a local Docker-compatible engine. From the repository root:

```sh
pnpm typecheck
pnpm test
pnpm test:capture
pnpm check:capture
```

The native tests use a real Node extraction thread and deterministic DNS fixtures; Worker tests exercise the private response protocol and fenced D1 completion. Neither suite contacts arbitrary article origins. `pnpm build` validates the base app separately. CI runs these capture checks and the full image dry run on pushes and pull requests without deployment credentials. Production publishing runs only on a push to `main` after verification passes, using the protected `production` environment's Cloudflare secrets.

1. Confirm Workers Paid is acceptable for the selected account; do not silently change billing. Replace staging origins in both Wrangler configurations and use an isolated staging D1 database.
2. Deploy the private executor before an app version that refers to it. Its `workers_dev` and `preview_urls` settings are false. Keep it without routes or custom domains. Do not attach private-network bindings, outbound hostname proxies, or application secrets. Native DNS must produce real destination addresses, and native sockets must retain numeric destination pinning.

```sh
pnpm exec wrangler deploy --config capture/wrangler.jsonc --env staging
pnpm build:web
pnpm exec wrangler deploy --env staging
```

The first executor deployment can need several minutes for provisioning. The production workflow builds and deploys the executor first, then migrates D1 and deploys the app. If executor deployment fails, subsequent migration/app deployment steps do not run. A standalone app deployment command still does not update the executor. The commands above are an optional manual staging path; they require Docker on the machine running them, while the normal production CI path does not require Docker on your computer. Capture remains paused until the separate activation gate passes.

3. While the flag is still false, validate deployment configuration and private-only access. Temporarily enable staging capture to test real scheduled processing against controlled public, blocked, redirected, dual-stack, mixed public/private DNS, rebinding, oversized, truncated, and slow-stream sources. Check original-host TLS validation and absence of third-party extraction requests. Record cold-start latency, worst-case HTML conversion time/memory, and account usage. The 5-second conversion limit needs measurement on the 1/4-vCPU instance; local desktop speed does not establish this fit.
4. Verify transient backoff, generation/lease fencing, manual-copy priority, edited-title protection, and reader polling. The app's 90-second service deadline is shorter than the two-minute lease. An expired result cannot commit, even if an executor survives cancellation. Copies remain create-only.
5. Deploy the production executor using `--config capture/wrangler.jsonc --env production`, then the app with `--env production`. Set `BACKGROUND_CAPTURE_ENABLED=true` in production only after the staging evidence passes. Confirm a real scheduled capture before calling activation complete. Do not interpret a successful token save as extraction success.

To pause, set the app flag to `false` and deploy the normal app configuration. This retains articles, intents, copies, and jobs. Already accepted intents resume when enabled; terminal jobs still need manual retry. Deleting an article cancels its job through the foreign key. Import/restore does not restore jobs or fetch links. Disable the flag before rolling the executor back to an incompatible protocol; the app has no ordinary-fetch fallback.

If the configured owner ID changes, revoke existing sessions and capture tokens as part of the change; these records are for the single library rather than separate user accounts.
