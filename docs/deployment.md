# Cloudflare deployment and operations

## Initial cutover

The [fresh D1 prelaunch reset](prelaunch-reset.md) is mandatory before the first release of this schema. It documents the `0001_initial.sql` baseline, new staging and production database names, required matching IDs in both Worker configs, cutover order, and verification. Production CI checks the app and capture database bindings before provisioning or migration and stops with a link to that guide while the IDs are placeholders. Do not apply the new baseline to the retired database.

The retired gateway and Worker Defuddle paths are not part of deployment. For historical design and measurement context, see [retired Worker fetch experiments](worker-safe-fetch.md) and the [historical Defuddle benchmark results](worker-extraction-benchmark.md).

## Requirements and configuration

- Use Node.js 22.12 or newer and pnpm 12.4.1. Install with `pnpm install --frozen-lockfile`.
- Use separate Cloudflare D1 databases, Queues, R2 buckets, and capture services for staging and production. The app and its matching capture Worker must reference the same environment D1 UUID.
- Automatic HTML/PDF capture uses Cloudflare Containers, Workers AI, and private R2 storage. It requires Workers Paid and R2 account activation. The configured Container uses one `basic` instance per environment. This is not a spending cap; review current [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [Containers](https://developers.cloudflare.com/containers/platform/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/), and [R2](https://developers.cloudflare.com/r2/platform/pricing/) usage and limits.
- Register a separate GitHub OAuth app for each environment. Its callback is `<APP_ORIGIN>/auth/github/callback`. Set `OWNER_GITHUB_ID` to the owner's immutable numeric GitHub ID. Store `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` as Wrangler secrets; never place them in frontend variables or commit them. The capture Shortcut uses a separate revocable save token.
- Production and staging currently have `BACKGROUND_CAPTURE_ENABLED=false` and `MANAGED_CONVERSION_ENABLED=false`. Keep capture disabled until the matching fresh D1 database has been initialized and that environment's capture Worker, AI, R2, Queue, and app bindings have been verified. Enable the two flags together for an environment only after those checks. These checked-in values describe intended configuration, not live deployment state.

## Local development and checks

```sh
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars
pnpm db:migrate:local
pnpm dev
```

The local-only auth bypass gives the loopback development UI a session without GitHub. Keep `.dev.vars` private. The disposable local database uses the baseline schema; after local persistence has been initialized with an older schema, use the separate storage path described in the [prelaunch reset guide](prelaunch-reset.md).

Before release, run `pnpm check`, `pnpm test`, `pnpm test:capture`, `pnpm check:capture`, and `pnpm build`. `pnpm check:capture` builds the Container image and needs a Docker-compatible CLI and engine. The regular `Checks` workflow runs the full verification suite on pull requests and deploys production only after checks pass on `main`.

## Release path

The production workflow checks Cloudflare credentials and fresh D1 IDs before it changes remote resources. It then ensures the private PDF bucket exists, applies migrations to `read-later-production-v1`, deploys the private capture Worker, builds website assets, ensures the extraction Queue exists, and deploys the app Worker. The protected GitHub Actions `production` environment needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The token needs Workers Scripts Edit, Containers Edit, Queues Edit, D1 Edit, and Workers R2 Storage Edit for the intended account/resources. The hosted Ubuntu runner supplies Docker.

For staging, create the fresh `read-later-staging-v1` database and set its matching UUID in both Wrangler configs as described in the reset guide. Configure the staging OAuth secrets and origin, then apply the baseline to the `DB` binding, deploy the capture Worker, build the website assets, ensure the staging Queue, and deploy the app Worker. Use Wrangler's environment selection (`--env staging`) for every remote command and verify the selected database name before applying migrations. Do not copy production IDs, queues, buckets, or OAuth credentials into staging.

## Queues, capture, and recovery

The app publishes extraction messages containing only an article ID and generation. D1 remains authoritative for job state, URL, retry deadlines, and leases. Queue consumers process one job at a time per environment. The hourly Cron Trigger recovers expired leases and republishes unfinished jobs after missed notifications. A queue notification failure after the durable save does not undo the save; recovery republishes unfinished work. See [save and recovery contract](prelaunch-reset.md#save-and-recovery-contract) for retry behavior and monitoring.

In staging, verify link-only saves, queued capture, retry, recapture, redirect checks, HTML and PDF preservation, private PDF access, and behavior when the converter or Queue is unavailable. Confirm source fetching rejects unsafe targets and redirects, respects response and time bounds, and connects using the native pinned executor. Review Container, Workers AI, D1, R2, and Queue usage before enabling production capture. Keep article URLs, page contents, cookies, tokens, and OAuth data out of logs.

Use the app's versioned library export for regular personal backups and test restores against a separate fresh database before relying on them. Exports do not include operational job state or authentication records. Keep D1 exports private because they can contain auth tables. For database-level recovery, use Cloudflare's [D1 export](https://developers.cloudflare.com/d1/reference/import-export/) and [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/); confirm provider retention before treating it as a backup.

## Rollback and ongoing operations

Back up before schema changes and use additive migrations for compatible releases. Roll back application code only to a version that understands the deployed schema; do not reverse migrations or delete a database as a rollback step. The fresh baseline is not compatible with the retired database schema, so the previous Worker must not be redeployed against the new database.

Monitor Worker errors/CPU, Queue backlog age and retries, D1 storage/rows, R2 objects, and Container/Workers AI use after release. Remove obsolete PDF objects only after D1 references and pending jobs are confirmed. Recheck account pricing and limits when workloads, plans, or Cloudflare products change.
