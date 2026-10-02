# Save Markdown articles to GitHub

In article details, paste or upload Markdown and optionally check **Also save to GitHub** before choosing **Save Markdown copy**. The checkbox starts unchecked each time the editor opens. Potem saves the copy in D1 first, then sends that saved revision to GitHub. Unchecked saves make no GitHub write. The original link and read state remain independent.

The desktop bookmarklet's capture dialog also includes **Also save to GitHub**, unchecked by default. Review the captured Markdown, keep **Save this Markdown copy** enabled, optionally check GitHub, and choose **Save link**. Potem saves the URL and local Markdown before sending that saved copy to GitHub. A failed local copy save, a changed source URL, or link-only saving prevents a GitHub write. Existing copies retain their revision protection.

If GitHub fails after capture, the local copy remains saved and **Retry GitHub save for saved copy** retries its saved revision without another copy write. Retry checks that the persisted revision still matches; otherwise, open article details to review the current copy. **Done** dismisses the capture while leaving the local copy intact. The retry survives a reload, while the publishing checkbox starts unchecked again. Article details retain **Save saved copy to GitHub** for later retries.

Production targets **`Pajdzik/Kamilpedia`**, branch **`main`**, folder **`Articles`**. This repository is public: checked articles are public there. Files always inherit the destination repository's visibility. Capture shows the configured destination; article details show the last confirmed backup status. GitHub receives the saved Markdown, including browser-clipped copies, rather than fetching the source website.

## Configuration

| Worker variable | Purpose |
| --- | --- |
| `GITHUB_BACKUP_REPOSITORY` | `owner/repository`; production uses `Pajdzik/Kamilpedia` |
| `GITHUB_BACKUP_BRANCH` | Existing writable branch; defaults to `main` |
| `GITHUB_BACKUP_PATH` | Relative folder; defaults to `articles`; production uses case-sensitive `Articles` |
| `GITHUB_BACKUP_TOKEN` | Server-side secret; separate from GitHub OAuth credentials |

Create a fine-grained GitHub token limited to the target repository with **Contents: read and write**. GitHub's [contents API](https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents) requires Base64 file content and the current blob SHA for replacement. The Worker uses API version `2026-03-10`. The target branch must already exist and permit commits from the token; branch protection may reject writes.

Set `GITHUB_BACKUP_TOKEN` as a Production secret on `read-it-later-production` under **Workers & Pages → Settings → Variables and Secrets**. Do not put it in `wrangler.jsonc`, frontend assets, or Git. The production repository/branch/folder are already configured in `wrangler.jsonc`. Local setup examples are in `.dev.vars.example`. If configuration or the secret is missing, the checkbox is disabled and D1 saves continue to work.

Apply migration `0005_github_backups.sql` with the other migrations before deploying. It records only the last confirmed destination, content hash, and backup time; it stores no credential. Standard production CI applies migrations before deploying.

## File format and conflicts

An article writes to `<folder>/<article-id>.md`. UUID filenames remain unchanged; opaque imported IDs are URI-quoted as one filename so slashes cannot escape the configured folder. The API separately encodes URL path segments and the branch reference. Relative folders reject dot segments and absolute paths.

Files contain YAML frontmatter followed by the exact saved Markdown body:

```markdown
---
potem_backup_version: 1
id: "article-id"
title: "Article title"
url: "https://example.com/article"
author: null
description: null
savedAt: "2026-10-01T00:00:00.000Z"
capturedAt: "2026-10-01T00:00:00.000Z"
source: "paste"
revision: "copy-revision"
---
# Saved article
```

String values use JSON quoting, which is valid YAML and preserves Unicode, quotes, and newlines. A body's existing frontmatter stays in the body. Authentication records, tokens, and read state are excluded. D1 remains authoritative; edits made directly in GitHub are not imported automatically.

`GET /api/articles/:id/github` returns `{backup}` with configured destination, `not_saved`, `saved`, or `outdated`, and the last confirmed time. Status describes the last successful Potem operation; it does not poll GitHub for later manual edits or deletion. Changing the title or copy marks the recorded backup outdated; read-state changes do not. Changing the destination starts a new `not_saved` status.

`GET /api/github` returns `{github: {configured, message?, repository?, branch?, folder?}}` so capture can show configuration before an article exists. It requires an owner session, returns private/no-store responses, makes no GitHub request, and never returns the token. Save-only capture tokens cannot read this configuration.

`POST /api/articles/:id/github` accepts `{expectedRevision}` and saves the persisted copy. Both routes require an owner session; POST also requires same-origin/CSRF validation. Capture tokens cannot use either route. Responses are private/no-store. A stale revision is rejected before sending content. The Worker rechecks D1 after reading the GitHub file, then supplies the current blob SHA for replacement. Concurrent GitHub conflicts return an error without blindly retrying. A destination file without this article's Potem format/ID is never replaced. Repeating a save with identical content makes no extra commit.

GitHub requests share a 10-second deadline and use bounded responses. Failures leave D1 content and the previous confirmed backup record intact. **Save saved copy to GitHub** retries the current persisted copy without replacing it or sending an unsaved draft. If GitHub committed a file but the response or D1 status update failed, retrying discovers the identical file and records success without another commit. There is no automatic mirroring or background retry queue.

## Deletion and recovery

Deleting a Potem article removes its D1 copy and backup status. It leaves the GitHub file and Git history intact; deleting a GitHub file also leaves historical commits. Manage those separately in GitHub when needed.

To restore a collection of saved files, run `pnpm github:convert --source /absolute/path/Articles --output /absolute/path/new-directory`. The converter reads a local checkout or downloaded folder only; it does not contact GitHub, start a service, or change the source. Review the private `report.json` and `import-*.json` files, then upload the batches through Settings → Import. Each file is bounded to 1 MiB and 1,000 articles. The report lists invalid files, normalized-URL duplicates, conflicting IDs, and a `read_state_not_backed_up` warning for every eligible record. Existing normalized URLs are skipped by import, preserving their current title, copy, and read state. Use a separate database to rehearse a restore. Versioned JSON exports remain the complete library backup, including read state.

To restore just a copy's text, take everything after the first closing frontmatter delimiter, paste or upload it into article details, and save.

The converter accepts the exact frontmatter fields emitted by Potem's GitHub writer and parses their JSON-quoted scalar values. It preserves the first file body's UTF-8 text and line endings, including any frontmatter already inside that body. It does not infer missing values from a filename or filesystem dates, and does not accept arbitrary YAML. Output paths must be absolute and point to a new directory outside the source tree; generated files are private to the current user. See the [offline recovery guide](github-recovery.md) for field mapping, limits, output safety, and fixture validation.

Automated Worker/D1 tests verify Unicode/body/frontmatter recovery through version-2 import, idempotent saves, SHA conflicts, stale revisions, destination containment, owner/CSRF protection, and GitHub outages. The offline recovery converter has separate writer-to-parser and temporary local Worker/D1 fixture checks. Browser smoke verifies checkbox opt-in, saved-revision submission, local persistence after a GitHub failure, retry, reopen, and narrow-screen layout. Live GitHub commits and deployment require the server secret and are not part of these mocked-provider checks.
