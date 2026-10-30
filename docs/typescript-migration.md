# TypeScript migration

Historical migration record: the Node.js Markdown-reader prototype described in earlier implementation notes was retired; its source, browser UI, and Docker deployment are no longer maintained. The current application is Cloudflare-only. TypeScript remains in the Worker, browser app, build/conversion scripts, and Node capture/fetch tooling. JavaScript tests and integration harnesses load TypeScript modules through `node --import tsx`.

## Runtime boundaries

| Configuration | Sources | Environment |
| --- | --- | --- |
| `tsconfig.json` | Worker, Worker tests, Vitest configuration | Cloudflare bindings and Web Worker APIs |
| `web/tsconfig.json` | Main app, Markdown renderer, capture help, extractor entry | Browser DOM |
| `web/tsconfig.sw.json` | Service worker | Service worker globals |
| `tsconfig.node.json` | Build, conversion, and rehearsal scripts | Node APIs, DOM types for Playwright callbacks |

Each maintained configuration enables strict checking and emits no files. Node and Cloudflare globals stay in separate configurations to avoid masking runtime mistakes. `pnpm typecheck` covers every configuration; `pnpm check` is its alias. External JSON and errors are narrowed at their boundaries. Portable backup, converter/report, capture executor, DOM element, and HTTP types describe current contracts.

## Execution and builds

Pinned `tsx` runs Node TypeScript tooling on the existing Node 22.12+ baseline. Type checking is a separate required step because `tsx` and esbuild transpile without checking types. Scripts import TypeScript sources directly; generated Wrangler harnesses still import the Worker entry through Wrangler.

`pnpm build:web` uses esbuild to compile the main app, capture page, service worker, and Defuddle entry into `dist/web`. HTML keeps the existing asset URLs. App/CSS names and the service-worker cache version derive from generated content. The bookmarklet's serialized capture function remains self-contained. TypeScript sources and compiler configuration are excluded from served assets.

`pnpm start` aliases `pnpm dev`, which builds the maintained website and runs it through Wrangler. The former prototype build and runtime were removed; see [prototype retirement](prototype.md). The root `tsconfig.node.json` remains for current scripts, including Cloudflare capture tooling and offline converters.

## Implementation ownership

Historical ownership note: the original TypeScript migration used separate work for the Node server, browser code, and conversion/rehearsal scripts. Those migration records do not describe the current runtime set.

## Verification

Current checks include strict typechecks, Worker/D1 tests, Cloudflare dry-run builds, browser smoke, backup-envelope tests and archive rehearsal, plus Obsidian/GitHub converter tests and local restore rehearsals. All data checks use isolated temporary fixtures and local databases.

Historical verification before prototype retirement included strict checks across five configurations, Worker dry runs, prototype fixture/browser smoke, and the other listed recovery/browser checks. Those results remain historical evidence only; current validation no longer builds or tests the retired prototype. The private capture executor and fetcher retain separate Docker/Container build and test workflows.
