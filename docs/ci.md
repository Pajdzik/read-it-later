# CI checks

The `Checks` workflow runs for pull requests and pushes to `main`, and can be started manually. It runs two verification jobs in parallel: **Verify core** checks TypeScript, Worker/D1 tests, native capture and conversion, builds, and Obsidian and GitHub Markdown recovery rehearsals; **Browser checks** runs desktop browser smoke, conditional extension checks, Android/iPhone mobile emulation, and archive restoration against fresh local Worker/D1 databases. Browser checks run in the official Playwright Docker image. The **Verify** aggregate check passes only when both jobs pass, and production deployment depends on that gate. After all checks pass on a push to `main`, it verifies the app and capture Workers use the same fresh production D1 UUID before provisioning or migrating anything, then provisions private PDF storage, applies production migrations, deploys the private capture service, builds website assets, ensures the extraction Queue exists, and deploys the application Worker. The required initial baseline setup is in the [prelaunch reset guide](prelaunch-reset.md).

The browser image is pinned to `mcr.microsoft.com/playwright:v1.62.1-noble`, matching the `playwright` version in `package.json`; CI checks that they remain aligned. Keep those versions aligned when upgrading Playwright so the browser binaries and package driver stay compatible. This uses the image's preinstalled Chromium, WebKit, and OS dependencies instead of running `playwright install --with-deps` on the GitHub-hosted runner. The split targets complete CI wall time below five minutes while retaining all checks and the existing job timeouts. Historical Actions logs show the avoidable setup cost: run [40264606094](https://github.com/Pajdzik/read-it-later/actions/runs/40264606094) spent 19m20s in the apt dependency install (03:33:45–03:53:05 UTC), run [40259020137](https://github.com/Pajdzik/read-it-later/actions/runs/40259020137) spent 13m56s, while healthy run [40264613267](https://github.com/Pajdzik/read-it-later/actions/runs/40264613267) completed in 3m14s. Extension ZIPs are created with the pinned `fflate` dependency, so packaging does not require a system `zip` executable.

The image choice follows Playwright's [Docker guidance](https://playwright.dev/docs/docker) and [CI guidance](https://playwright.dev/docs/ci). The local command list below still uses `playwright install --with-deps` when a machine needs browser binaries and operating-system dependencies installed.

The production job uses the `production` GitHub Actions environment and requires `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets. The token needs Workers Scripts Edit, Containers Edit, Queues Edit, D1 Edit, and Workers R2 Storage Edit permissions for the configured production resources. Pull requests and pushes to other branches never run the production job. The preflight fails while the v1 production IDs remain placeholders; follow [prelaunch reset](prelaunch-reset.md) to create a fresh database and configure the same UUID in both Worker configs. R2 subscription activation must be completed in the Cloudflare dashboard before the job can provision storage; error `10042` indicates this account prerequisite is missing. The release then provisions the private PDF bucket, applies the v1 baseline (and future compatible additive migrations), deploys capture, builds website assets, ensures the extraction Queue, and deploys the app.

Historical Defuddle benchmark measurements remain in [the result record](worker-extraction-benchmark.md). They describe a retired Worker conversion design and are not part of current CI or the production Container capture path.

The extension suite (`pnpm test:extension`) runs only when extension sources, extension build/test scripts, package/dependency files, or its CI wiring change. Documentation-only and unrelated website/API changes skip that step; the regular checks still run. Pull requests compare their complete change set against the base branch; pushes compare the previous and new tip, so a documentation-only follow-up push can skip the suite even if its PR still includes extension changes. New branches compare against the default branch. Manual workflow runs always include the extension suite, and unavailable Git history causes it to run rather than silently skip.

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
pnpm check
pnpm typecheck
pnpm test
pnpm build
pnpm exec playwright install --with-deps chromium webkit
pnpm test:browser
pnpm test:extension
pnpm test:mobile
pnpm test:archive
pnpm test:obsidian
pnpm test:github
```

`test:archive` includes focused backup-envelope tests and a generated-library restore rehearsal. Its report contains counts and byte measurements only. It blocks external browser requests and verifies restored Markdown reading/download without accessing production or requiring OAuth secrets. To rehearse your own downloaded export, see [archive rehearsal](archive-rehearsal.md).

`test:mobile` creates a temporary Wrangler config, local Worker and fresh D1 directory, then runs touch flows with the Playwright Pixel 7/Chromium and iPhone 13/WebKit profiles. It covers local capture-token success/duplicate/revocation, share-target review and draft recovery, network-failure retry, read-state persistence, mobile layouts, manifest icons, and populated service-worker cache boundaries. It uses dummy local auth settings and a local HTML fixture. Browser emulation does not replace actual-device Share Sheet, install, keyboard, Safari, or Shortcuts checks; see [mobile release validation](mobile-release.md).

Browser tests must wait for navigation to finish after closing a saved copy or its details. Closing the dialog can start asynchronous `history.back()`; the list restores its scroll position and then focuses the opener in `popstate`. Wait for both the list URL and restored focus before scrolling, reloading, or opening another article. A hidden dialog or a completed click alone does not mean that the list has finished restoring. Prefer these observable states to fixed sleeps or retries.
