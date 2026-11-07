# CI checks

The `Checks` workflow runs for pull requests and pushes to `main`, and can be started manually. Four verification lanes run in parallel:

- **Verify core** checks TypeScript, Worker/D1 tests, native capture, builds, and Obsidian/GitHub recovery rehearsals.
- **Browser checks (desktop)** runs desktop smoke and podcast controls.
- **Browser checks (mobile)** runs Android/iPhone emulation and archive restoration.
- **Browser checks (extension)** runs extension checks when their inputs change.

Each browser lane has its own checkout, build output, and fresh local Worker/D1 databases. The **Verify** aggregate check requires core and the entire browser matrix to pass; production deployment still depends on that gate. The matrix uses `fail-fast: false` so a failing suite does not cancel the other suites' diagnostics. Existing timeouts and test coverage are retained.

Browser lanes use `mcr.microsoft.com/playwright:v1.62.1-noble`, matching `playwright` in `package.json`; each lane checks that they remain aligned. Keep those versions aligned when upgrading Playwright. The image supplies Chromium, WebKit, and OS dependencies without an apt install during CI. Before this split, recent PR runs took [2m27s](https://github.com/Pajdzik/read-it-later/actions/runs/42343990075) and [3m16s](https://github.com/Pajdzik/read-it-later/actions/runs/42177275318), with desktop (50–58s), mobile (30–37s), extension (20s when enabled), and archive (8–11s) running sequentially. Parallel lanes target roughly 1½–2 minutes of PR feedback, subject to runner availability and cache warmth. Extension ZIPs use the pinned `fflate` dependency rather than a system `zip` executable.

The image choice follows Playwright's [Docker guidance](https://playwright.dev/docs/docker) and [CI guidance](https://playwright.dev/docs/ci). The local command list below still uses `playwright install --with-deps` when a machine needs browser binaries and operating-system dependencies installed.

The production job uses the `production` GitHub Actions environment and requires `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets. The token needs Workers Scripts Edit, Containers Edit, Queues Edit, D1 Edit, and Workers R2 Storage Edit permissions for the configured production resources. Pull requests and pushes to other branches never run the production job. The preflight fails while the v1 production IDs remain placeholders; follow [prelaunch reset](prelaunch-reset.md) to create a fresh database and configure the same UUID in both Worker configs. R2 subscription activation must be completed in the Cloudflare dashboard before the job can provision storage; error `10042` indicates this account prerequisite is missing. The release then provisions the private PDF bucket, applies the v1 baseline (and future compatible additive migrations), deploys capture, builds website assets, ensures the extraction Queue, and deploys the app.

Historical Defuddle benchmark measurements remain in [the result record](worker-extraction-benchmark.md). They describe a retired Worker conversion design and are not part of current CI or the production Container capture path.

The extension suite (`pnpm test:extension`) runs only when extension sources, extension build/test scripts, package/dependency files, or its CI wiring change. Documentation-only and unrelated website/API changes skip its dependency install and test step; the regular checks still run.

The capture image/private Worker dry run runs when `capture/`, any shared backend source under `src/`, migrations, Wrangler or TypeScript config, Docker inputs, package/dependency files, or CI wiring change. UI-only and documentation-only changes skip this build. Native capture tests still run on every change. Both filters compare a PR's full change set against its merge base, and pushes compare their previous and new tips. New branches compare against the default branch. Manual workflow runs and unavailable Git history always include the filtered checks. Real Git fixture tests cover follow-up commits, advancing PR bases, renames, deletions, and missing history.

The local `capture-build` JavaScript action runs the same pinned Wrangler deployment command for staging dry runs and production deploys. Its Docker adapter routes only `docker build` through a `docker-container` Buildx builder, preserving Wrangler's platform, image tag, `--load`, and streamed Dockerfile. Other Docker commands pass through unchanged. BuildKit imports/exports all build stages with the GitHub Actions v2 cache (`scope=capture-amd64`, `mode=max`), so ffmpeg installation and pnpm dependencies survive fresh runners. `--pull` checks mutable base images for updates. Cache export errors are nonfatal and bounded to 60 seconds; image-build failures still fail the check. The JavaScript action receives cache runtime credentials directly and passes them only to child-process environments. It does not export credentials through `GITHUB_ENV` or embed them in command arguments. GitHub's normal branch cache isolation applies: PRs can restore default-branch layers, and production can reuse the preceding main-branch verification cache. The first build has to populate the cache.

See Docker's [GitHub Actions cache backend](https://docs.docker.com/build/cache/backends/gha/) and Cloudflare's [Container image management](https://developers.cloudflare.com/containers/guides/image-management/). Local `pnpm check:capture` and direct Wrangler deploy commands continue to use the normal Docker engine without the CI adapter.

## Find a run

Open the repository's **Actions** tab on GitHub and select **Checks**. Open a run to see each named step and its logs. For a pull request, the same result appears in the pull request's **Checks** section.

If the workflow was added on a stacked pull request branch, the workflow file is only on that branch until the pull request containing it is merged. GitHub will show runs associated with that branch or pull request, but the workflow won't be available from the repository's default branch until the change reaches it.

## Rerun checks

To retry a failed run, open it from **Actions → Checks**, then choose **Re-run jobs** (or **Re-run failed jobs**) from the run page. To start a fresh run manually, use **Run workflow** on the **Checks** page and select the branch. GitHub requires the workflow to exist on the default branch for manual dispatch to be available; once merged there, manual runs can target another branch.

Newer runs for the same branch cancel older in-progress runs, so a canceled run can simply be replaced by the latest push or a manual run.

## Run the same checks locally

With Node.js 22 and pnpm 12.4.1 installed, run:

```sh
pnpm install --frozen-lockfile
node --test scripts/ci-*.test.mjs
pnpm check
pnpm typecheck
pnpm test
pnpm test:capture
pnpm check:capture
pnpm build
pnpm exec playwright install --with-deps chromium webkit
pnpm test:browser
pnpm test:podcast-ui
pnpm test:extension
pnpm test:mobile
pnpm test:archive
pnpm test:obsidian
pnpm test:github
```

`test:archive` includes focused backup-envelope tests and a generated-library restore rehearsal. Its report contains counts and byte measurements only. It blocks external browser requests and verifies restored Markdown reading/download without accessing production or requiring OAuth secrets. To rehearse your own downloaded export, see [archive rehearsal](archive-rehearsal.md).

`test:mobile` creates a temporary Wrangler config, local Worker and fresh D1 directory, then runs touch flows with the Playwright Pixel 7/Chromium and iPhone 13/WebKit profiles. It covers local capture-token success/duplicate/revocation, share-target review and draft recovery, network-failure retry, read-state persistence, mobile layouts, manifest icons, and populated service-worker cache boundaries. It uses dummy local auth settings and a local HTML fixture. Browser emulation does not replace actual-device Share Sheet, install, keyboard, Safari, or Shortcuts checks; see [mobile release validation](mobile-release.md).

Browser tests must wait for navigation to finish after closing a saved copy or its details. Closing the dialog can start asynchronous `history.back()`; the list restores its scroll position and then focuses the opener in `popstate`. Wait for both the list URL and restored focus before scrolling, reloading, or opening another article. A hidden dialog or a completed click alone does not mean that the list has finished restoring. Prefer these observable states to fixed sleeps or retries.
