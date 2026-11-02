# GitHub article integration

Current files use `potem_backup_version: 2`; they include tags, description provenance, and the manual-tag protection flag. Recovery accepts frontmatter v1 and v2 and emits library JSON v3. See [article enrichment](article-enrichment.md) for metadata behavior and its release gate.

GitHub is an optional provider in the [article integrations system](integrations.md). The current UI uses a destination selector and **Also send to an integration**, with **Send saved copy to GitHub** for explicit retries. The provider uses the generic integration API and retains the backup format and conflict protections described below.

In article details, paste or upload Markdown and optionally check **Also send to an integration** (with GitHub selected) before choosing **Save Markdown copy**. The checkbox starts unchecked each time the editor opens. Potem saves the copy in D1 first, then sends that saved revision to GitHub. Unchecked saves make no GitHub write. The original link and read state remain independent.

The desktop bookmarklet's capture dialog also includes **Also send to an integration** (with GitHub selected), unchecked by default. Review the captured Markdown, keep **Save this Markdown copy** enabled, optionally check GitHub, and choose **Save link**. Potem saves the URL and local Markdown before sending that saved copy to GitHub. A failed local copy save, a changed source URL, or link-only saving prevents a GitHub write. Existing copies retain their revision protection.

If GitHub fails after capture, the local copy remains saved and **Retry sending saved copy** retries its saved revision without another copy write. Retry checks that the persisted revision still matches; otherwise, open article details to review the current copy. **Done** dismisses the capture while leaving the local copy intact. The retry survives a reload, while the publishing checkbox starts unchecked again. Article details retain **Send saved copy to GitHub** for later retries.

Production targets **`Pajdzik/Kamilpedia`**, branch **`main`**, folder **`Articles`**. This repository is public: checked articles are public there. Files always inherit the destination repository's visibility. Capture shows the configured destination; article details show the last confirmed backup status. GitHub receives the saved Markdown, including browser-clipped copies, rather than fetching the source website.

## Configuration

| Worker variable | Purpose |
| --- | --- |
| `GITHUB_BACKUP_REPOSITORY` | `owner/repository`; production uses `Pajdzik/Kamilpedia` |
| `GITHUB_BACKUP_BRANCH` | Existing writable branch; defaults to `main` |
| `GITHUB_BACKUP_PATH` | Relative folder; defaults to `articles`; production uses case-sensitive `Articles` |
| `GITHUB_BACKUP_TOKEN` | Server-side secret; separate from GitHub OAuth credentials |

Create a fine-grained GitHub token limited to the target repository with **Contents: read and write**. GitHub's [contents API](https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents) requires Base64 file content and the current blob SHA for replacement. The Worker uses API version `2026-03-10`. The target branch must already exist and permit commits from the token; branch protection may reject writes.

Set `GITHUB_BACKUP_TOKEN` as a Production secret on `read-it-later-production` under **Workers & Pages → Settings → Variables and Secrets**. Do not put it in `wrangler.jsonc`, frontend assets, or Git. The production repository/branch/folder are already configured in `wrangler.jsonc`. Local setup examples are in `.dev.vars.example`. If configuration or the secret is missing, GitHub is absent from the destination list and D1 saves continue to work.

The initial schema stores destination-scoped receipts for GitHub and hooks. Standard production CI applies migrations before deploying.

## File format and conflicts

Each article always uses `<folder>/<article-id>.md`, for example `Articles/k7m2q9x4.md`. The filename does not change when the title changes. The frontmatter carries the current title, article URL, tags, description provenance, manual-tag flag, and stable ID; the Markdown body is written byte-for-byte.

```markdown
---
potem_backup_version: 2
id: "k7m2q9x4"
title: "Article title"
url: "https://example.com/article"
author: null
description: null
tags: []
descriptionOrigin: null
tagsManuallyEdited: false
savedAt: "2026-10-01T00:00:00.000Z"
capturedAt: "2026-10-01T00:00:00.000Z"
source: "paste"
revision: "copy-revision"
---
# Saved article
```

String values use JSON quoting, which is valid YAML and preserves Unicode, quotes, and newlines. A body's existing frontmatter stays in the body. Authentication records, tokens, and read state are excluded. D1 remains authoritative; edits made directly in GitHub are not imported automatically.

The generic integration API provides configuration and local receipt status. `GET /api/integrations` discovers destinations, `GET /api/articles/:id/integrations` returns receipt-based status, and `POST /api/articles/:id/integrations/github` sends the persisted copy after checking its revision and consented destination. A send always reads the GitHub file, even when a matching local receipt exists. A deleted remote file is recreated. An occupied path can be replaced only when its Potem marker and frontmatter ID belong to that article; the current blob SHA protects replacements. If a write times out, Potem rereads GitHub and confirms success only when the remote bytes exactly match. A title edit updates frontmatter in the same stable ID path. Changing repository, branch, or folder creates a separate receipt history.

GitHub requests share a 10-second deadline and use bounded responses. Failures leave D1 content intact. Retry sends the current persisted copy without replacing it or sending an unsaved draft. There is no automatic mirroring or background retry queue.

## Deletion and recovery

Deleting a Potem article removes its D1 copy and integration receipts. It leaves the GitHub file and Git history intact; deleting a GitHub file also leaves historical commits. Manage those separately in GitHub when needed.

To restore a collection of saved files, run `pnpm github:convert --source /absolute/path/Articles --output /absolute/path/new-directory`. The converter reads a local checkout or downloaded folder only; it does not contact GitHub, start a service, or change the source. Review the private `report.json` and `import-*.json` files, then upload the batches through Settings → Import. Each file is bounded to 1 MiB and 1,000 articles. The report lists invalid files, normalized-URL duplicates, conflicting IDs, and a `read_state_not_backed_up` warning for every eligible record. Existing normalized URLs are skipped by import, preserving their current title, copy, and read state. Use a separate database to rehearse a restore. Versioned JSON exports remain the complete library backup, including read state.

To restore just a copy's text, take everything after the first closing frontmatter delimiter, paste or upload it into article details, and save.

The converter accepts the exact frontmatter fields emitted by Potem's GitHub writer and parses their JSON-quoted scalar values. It preserves the first file body's UTF-8 text and line endings, including any frontmatter already inside that body. It does not infer missing values from a filename or filesystem dates, and does not accept arbitrary YAML. Output paths must be absolute and point to a new directory outside the source tree; generated files are private to the current user. See the [offline recovery guide](github-recovery.md) for field mapping, limits, output safety, and fixture validation.

Automated Worker/D1 tests cover stable ID paths, title edits, remote deletion, ownership conflicts, ambiguous writes, destination-scoped receipts, stale revisions, and GitHub outages. The offline recovery converter has separate writer-to-parser and temporary local Worker/D1 fixture checks. Live GitHub commits and deployment require the server secret and are not part of these mocked-provider checks.
