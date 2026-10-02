# Save Markdown articles to GitHub

In article details, paste or upload Markdown and optionally check **Also save to GitHub** before choosing **Save Markdown copy**. The checkbox starts unchecked each time the editor opens. Potem saves the copy in D1 first, then sends that saved revision to GitHub. Unchecked saves make no GitHub write. The original link and read state remain independent.

Production targets **`Pajdzik/Kamilpedia`**, branch **`main`**, folder **`Articles`**. This repository is public: checked articles are public there. Files always inherit the destination repository's visibility. The destination and last confirmed backup status appear below the save button. This is an optional copy of owner-provided Markdown, not automatic extraction from the original website.

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

`POST /api/articles/:id/github` accepts `{expectedRevision}` and saves the persisted copy. Both routes require an owner session; POST also requires same-origin/CSRF validation. Capture tokens cannot use either route. Responses are private/no-store. A stale revision is rejected before sending content. The Worker rechecks D1 after reading the GitHub file, then supplies the current blob SHA for replacement. Concurrent GitHub conflicts return an error without blindly retrying. A destination file without this article's Potem format/ID is never replaced. Repeating a save with identical content makes no extra commit.

GitHub requests share a 10-second deadline and use bounded responses. Failures leave D1 content and the previous confirmed backup record intact. **Save saved copy to GitHub** retries the current persisted copy without replacing it or sending an unsaved draft. If GitHub committed a file but the response or D1 status update failed, retrying discovers the identical file and records success without another commit. There is no automatic mirroring or background retry queue.

## Deletion and recovery

Deleting a Potem article removes its D1 copy and backup status. It leaves the GitHub file and Git history intact; deleting a GitHub file also leaves historical commits. Manage those separately in GitHub when needed.

To restore a single copy, take everything after the first closing frontmatter delimiter, paste or upload it into article details, and save. To restore the preserved metadata through `/api/import`, convert the file to an article in the existing version-2 JSON format:

- Keep `id`, `url`, `title`, `author`, and `description` from frontmatter.
- Use `savedAt` for `createdAt` and `updatedAt`; set `readAt` to `null` because read state is not in this backup.
- Create `copy` from the exact body plus `capturedAt`, `source`, and `revision`.
- Wrap articles in `{version: 2, exportedAt: <UTC ISO timestamp>, articles: [...]}` and respect the 1 MiB/1,000-article import bounds.

Import skips existing normalized URLs, so it does not replace their copies. Use a separate database when testing a restore. Versioned JSON exports remain the complete library backup, including read state.

Automated Worker/D1 tests verify Unicode/body/frontmatter recovery through version-2 import, idempotent saves, SHA conflicts, stale revisions, destination containment, owner/CSRF protection, and GitHub outages. Browser smoke verifies checkbox opt-in, saved-revision submission, local persistence after a GitHub failure, retry, reopen, and narrow-screen layout. Live GitHub commits and deployment require the server secret and are not part of these mocked-provider checks.
