# TypeScript migration

All maintained application, build, and conversion code uses TypeScript. Existing JavaScript tests and integration harnesses remain JavaScript, as requested, and load migrated modules through `node --import tsx`. JavaScript is generated for browsers, the Node prototype, and Wrangler test harnesses. The migration preserves API responses, data formats, authentication, storage behavior, and browser asset URLs.

## Runtime boundaries

| Configuration | Sources | Environment |
| --- | --- | --- |
| `tsconfig.json` | Worker, Worker tests, Vitest configuration | Cloudflare bindings and Web Worker APIs |
| `web/tsconfig.json` | Main app, Markdown renderer, capture help, extractor entry | Browser DOM |
| `web/tsconfig.sw.json` | Service worker | Service worker globals |
| `public/tsconfig.json` | Prototype browser UI | Browser DOM |
| `tsconfig.node.json` | Prototype server, build/conversion/rehearsal scripts | Node APIs, DOM types for Playwright callbacks |

Each configuration enables strict checking and emits no files. Node and Cloudflare globals stay in separate configurations to avoid masking runtime mistakes. `pnpm typecheck` covers every configuration; `pnpm check` is its alias. External JSON and errors are narrowed at their boundaries. Portable backup, converter/report, prototype article/auth, DOM element, and HTTP types describe the existing contracts.

## Execution and builds

Pinned `tsx` runs Node TypeScript tooling on the existing Node 22.12+ baseline. Type checking is a separate required step because `tsx` and esbuild transpile without checking types. Scripts import TypeScript sources directly; generated Wrangler harnesses still import the Worker entry through Wrangler.

`pnpm build:web` uses esbuild to compile the main app, capture page, service worker, and Defuddle entry into `dist/web`. HTML keeps the existing asset URLs. App/CSS names and the service-worker cache version derive from generated content. The bookmarklet's serialized capture function remains self-contained. TypeScript sources and compiler configuration are excluded from served assets.

`pnpm build:prototype` writes the Node server to `dist/prototype/server.mjs` and browser assets to `dist/prototype/public`. `pnpm start` builds and launches that bundle. The source and built server resolve the same repository-root `.env` and default article directory; both serve the generated public assets. Docker uses a build stage with TypeScript tooling and a runtime stage containing only the generated prototype; the runtime needs no npm dependencies.

## Implementation ownership

Three Luna subagents migrate the Node server, browser code, and Node conversion/rehearsal scripts respectively. The coordinating agent integrates package scripts, runtime configurations, builds, CI, Docker, and documentation, then reviews the changes together.

## Verification

Run strict typechecks, Worker/D1 tests, both builds and the Worker dry run, the browser smoke test, backup-envelope tests and archive rehearsal, and Obsidian/GitHub converter tests and local restore rehearsals. Verify the prototype bundle with a temporary Markdown fixture: list/read/update state, static assets, health, and a browser interaction. All data checks use isolated temporary fixtures and local databases.

Verified locally: strict checks across all five configurations; 37 Worker/D1, 8 backup-envelope, 10 Obsidian, and 12 GitHub converter tests; Worker dry-run deployment; browser capture and desktop/mobile smoke; prototype fixture/browser smoke; archive restoration (30 articles, 28 copies); and both converter restore rehearsals. Frozen-lockfile installation passes. Docker image execution remains unverified because the local Docker daemon is unavailable.
