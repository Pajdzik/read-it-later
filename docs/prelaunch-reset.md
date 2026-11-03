# Initialize the clean pre-launch database

This revision starts a new schema with `migrations/0001_initial.sql`. It does not
upgrade the previous database. The app and capture Worker must use the same fresh
D1 database. Production bindings point to the fresh `read-later-production-v1`
database. Staging IDs remain unset. Production CI checks that both Workers use
the same fresh database before modifying resources.

The reset discards the old library, sessions, capture tokens, operational jobs,
archive sessions, and delivery receipts. Keep the existing database until the new
deployment is verified; it is not an input to this reset. Older Potem JSON formats
and opaque IDs are no longer accepted. Current version-3 exports and current
GitHub Markdown remain supported for future backups.

## Local development

Use a new local persistence directory to avoid the old migration ledger:

```sh
pnpm build:web
pnpm exec wrangler d1 migrations apply DB --local --persist-to .wrangler/prelaunch-v1
pnpm exec wrangler dev --persist-to .wrangler/prelaunch-v1
```

The regular `pnpm dev` and `pnpm db:migrate:local` commands use Wrangler's default
local storage. Delete that disposable local D1 storage before returning to those
commands if it still contains the old schema. The automated tests and smoke
runners initialize their own isolated databases from the new baseline.

## Staging and production cutover

1. Finish local verification. Keep automatic production deployment stopped until
   the fresh database bindings have been reviewed. Do not apply this baseline to
   `read-later-production` or its existing migration ledger.
2. Pause the old capture processor and stop accepting writes during the cutover.
   Discard old extraction notifications before resuming the queue. The previous
   database remains available as a record of the disposable pre-launch deployment.
3. Create a fresh database for the selected environment. For production:

   ```sh
   pnpm exec wrangler d1 create read-later-production-v1 --env production --update-config=false
   ```

   Set the returned UUID in **both** `wrangler.jsonc` and
   `capture/wrangler.jsonc`, under `env.production.d1_databases` for binding `DB`.
   Both names must remain `read-later-production-v1`. Staging uses its own fresh
   `read-later-staging-v1` database and matching staging bindings.
4. Initialize the selected fresh database:

   ```sh
   pnpm exec wrangler d1 migrations apply DB --remote --env production
   ```

5. Deploy the matching capture service and app through the normal production CI
   sequence: private PDF bucket, baseline migrations, capture Worker, website
   build, extraction queue, then app Worker. Do not run the old app against the
   fresh schema or the new app against the previous schema. Re-enable capture
   after both Workers reference the new database.
6. Sign in again and create new capture tokens. Verify save/read, background
   HTML/PDF capture, manual copies, and a current-format export/restore. Verify
   both Workers' database bindings before allowing normal writes.
7. Remove disposable old PDF objects after the old capture service and jobs have
   stopped. A fresh database cannot discover objects tracked only by the previous
   database. Do not remove objects belonging to newly captured PDFs.

GitHub files now use `<configured-folder>/<article-id>.md`; there is no filename
reconciliation or old path mapping to restore. New sends verify ownership and
the current remote SHA before replacing a file. No GitHub files are changed by
the database reset itself.

## Save and recovery contract

A capture-requesting save writes article changes and its eligible initial job in
one D1 transaction. A database failure returns `503 storage_unavailable` and
rolls back both. A queue notification failure after commit still returns save
success: the durable job is republished by hourly recovery. Paused capture still
records jobs. Existing copies and existing jobs, including terminal failures,
are preserved on duplicate saves. Imports never create capture jobs.

The baseline retains PDF cleanup triggers, asset publication guards, archive
commit fencing, capture leases and generations, and copy revision checks.

Command syntax was checked against the installed Wrangler version. See the
[D1 command reference](https://developers.cloudflare.com/d1/wrangler-commands/).
