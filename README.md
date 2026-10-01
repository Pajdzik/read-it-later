# Potem

A private article inbox: save URLs from desktop or mobile, open the original when ready, and explicitly mark articles read.

The Cloudflare Worker implementation includes GitHub owner login, D1 persistence, search and pagination, read/unread actions, desktop bookmarklet capture, mobile capture instructions, revocable save-only tokens, and JSON backup/restore. Markdown preservation is a later phase; no automatic source extraction is enabled.

## Develop the service

Requires Node 22.12+ and pnpm 12.4.1.

```sh
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars
pnpm db:migrate:local
pnpm dev
```

Open http://localhost:8787. The example enables an explicit local-only auth bypass; deployed environments require configured owner OAuth. Private configuration and local data remain ignored.

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:browser
```

`build` bundles the site and dry-runs the Worker deployment. `test:browser` starts a separate local Worker with temporary D1 storage and checks desktop/mobile layouts and persisted read state. It requires an installed Playwright Chromium, or an explicit `BROWSER_EXECUTABLE` path to Chrome. Frontend JS/CSS filenames and service-worker caches change with their content. Restart `pnpm dev` after frontend edits to rebuild assets.

## Project documents

- [Service design](docs/design.md): product scope, architecture, capture flows, API and archive plan.
- [Implementation tracker](docs/tasks.md): chunks, dependencies, acceptance criteria and pending release checks.
- [Capture guide](docs/capture.md): bookmarklet, iOS Shortcut and installed PWA sharing.
- [CI checks](docs/ci.md): GitHub run locations, reruns and local validation.
- [Deployment and operations](docs/deployment.md): Cloudflare bindings, OAuth setup, release checks, backups and rollback.
- [Prototype guide](docs/prototype.md): the preserved local/GitHub Markdown reader.

Local tests and a dry-run build do not mean the service is deployed. Real OAuth login and native mobile sharing still require release validation on your configured origin/devices.

## Repository map

| Path | Purpose |
| --- | --- |
| `src/` | Worker routes, owner authentication, article API and D1 repository |
| `web/` | Responsive site, capture guide and PWA source assets |
| `migrations/` | Ordered D1 SQL migrations |
| `tests/` | Real local D1 and Worker tests |
| `scripts/` | Website build and isolated browser smoke test |
| `wrangler.jsonc` | Local/staging/production binding placeholders; configure before deploy |
| `docs/` | Design, task tracker and operations |
| `server.mjs`, `public/` | Existing Node.js Markdown-reader prototype |
| `Dockerfile` | Prototype container, independent of Worker deployment |

## Run the existing prototype

```sh
mkdir -p articles
# Add Markdown files, or set ARTICLES_DIR to an existing folder.
pnpm start
```

Open http://localhost:3055. The prototype needs no dependency installation when launched with `node server.mjs`. See its guide for GitHub/local storage and authentication before exposing it publicly. No vault files are automatically migrated or changed by the new service.
