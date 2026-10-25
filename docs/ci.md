# CI checks

The `Checks` workflow runs on every push and pull request. It installs the pinned pnpm and Node.js versions, checks TypeScript in every runtime, runs unit tests, builds the Worker in dry-run mode, installs Chromium and WebKit for Playwright, runs the desktop browser smoke and Android/iPhone mobile emulation against fresh local Worker/D1 databases, and rehearses archive restoration in a separate temporary local D1 database. After all checks pass on a push to `main`, it applies pending production D1 migrations and deploys the production Worker.

The production job uses the `production` GitHub Actions environment and requires `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets. The token needs Workers Scripts Edit and D1 Edit permissions for the configured production resources. Pull requests and pushes to other branches never run the production job.

The same verification job runs synthetic Defuddle fixtures in the local Workers runtime and `pnpm build:benchmark` to package the fixture-only benchmark Worker. These checks require no Docker or Cloudflare credentials and do not deploy it. [Actual Cloudflare CPU measurements](worker-extraction-benchmark.md) are recorded separately; passing local tests does not establish a production CPU-budget fit.

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
pnpm test:prototype
pnpm test:archive
pnpm test:obsidian
pnpm test:github
```

`test:archive` includes focused backup-envelope tests and a generated-library restore rehearsal. Its report contains counts and byte measurements only. It blocks external browser requests and verifies restored Markdown reading/download without accessing production or requiring OAuth secrets. To rehearse your own downloaded export, see [archive rehearsal](archive-rehearsal.md).

`test:mobile` creates a temporary Wrangler config, local Worker and fresh D1 directory, then runs touch flows with the Playwright Pixel 7/Chromium and iPhone 13/WebKit profiles. It covers local capture-token success/duplicate/revocation, share-target review and draft recovery, network-failure retry, read-state persistence, mobile layouts, manifest icons, and populated service-worker cache boundaries. It uses dummy local auth settings and a local HTML fixture. Browser emulation does not replace actual-device Share Sheet, install, keyboard, Safari, or Shortcuts checks; see [mobile release validation](mobile-release.md).

Browser tests must wait for navigation to finish after closing a saved copy or its details. Closing the dialog can start asynchronous `history.back()`; the list restores its scroll position and then focuses the opener in `popstate`. Wait for both the list URL and restored focus before scrolling, reloading, or opening another article. A hidden dialog or a completed click alone does not mean that the list has finished restoring. Prefer these observable states to fixed sleeps or retries.
