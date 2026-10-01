# Read Later

A personal article inbox: save a URL from desktop or mobile, open the original when ready, and explicitly mark it read. A later phase will preserve Markdown copies.

## Project documents

- [Service design](docs/design.md): scope, capture flows, architecture, data model, API, security, and hosting.
- [Implementation tasks](docs/tasks.md): dependency-ordered chunks with acceptance criteria and boundaries for future subagents.
- [Prototype guide](docs/prototype.md): setup for the existing local/GitHub Markdown reader.

## Current state

The repository contains a working Node.js Markdown reader. URL ingestion, D1 storage, mobile capture, and Cloudflare deployment are **planned**, not implemented. Keep the prototype available until the replacement passes its release checks.

```sh
mkdir -p articles
# Add Markdown files here, or set ARTICLES_DIR to an existing folder.
npm start
```

Open http://localhost:3055. No dependency installation is needed for this prototype. See the prototype guide for authentication and configuration before exposing it publicly.

```sh
npm run check
```

## Repository map

| Path | Purpose |
| --- | --- |
| `server.mjs` | Existing Node HTTP server, local/GitHub storage and OAuth |
| `public/` | Existing responsive Markdown reader |
| `docs/` | Design, implementation tracker, and prototype operations |
| `.env.example` | Prototype configuration template; `.env` stays local |
| `Dockerfile` | Prototype container; not a Cloudflare deployment |

The proposed Worker will use `src/`, `web/`, `migrations/`, and `wrangler.jsonc` once implementation starts. These do not exist yet.
