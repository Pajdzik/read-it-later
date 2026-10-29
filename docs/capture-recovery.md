# Recover an incorrect article capture

Open article details and choose **Recapture article** to fetch the saved original
URL again. The action works for existing copies, failed or missing captures, and
link-only/imported articles. It replaces the saved Markdown only after extraction
succeeds. The current copy remains readable while the job is queued, running, or
retrying, and stays intact if extraction fails.

**Also refresh title, author, and description** starts unchecked. When selected,
nonblank source values replace existing metadata, including owner-edited values.
Missing or blank source values preserve the current field. Without this option,
recapture preserves all metadata. Article identity, URL, saved date, and read state
remain independent.

Save or discard unsaved title/Markdown drafts before recapturing. Drafts typed
while background processing runs survive status updates. If a recapture completes
while you read the preceding copy, **New copy available** opens the replacement
when you choose; the displayed text and reading position are not interrupted.

## Undo

**Undo last recapture** restores the preceding copy, including its original capture
date and source, with a fresh revision. It also restores metadata if metadata
refresh was selected. Later edits to the copy or metadata that undo would restore
prevent undo; read-state changes do not. Undo supersedes pending capture work.

Only one preceding copy is retained per article. A failed recapture preserves the
previous undo snapshot; the next successful recapture replaces it. Undo consumes
the snapshot, and capturing a previously copy-less article has no undo copy.
Deleting an article also deletes its recovery snapshot. Snapshots and extraction
jobs are operational state and are excluded from portable JSON exports.

Recapture and undo never send to integrations. The existing integration status reflects
the changed saved revision; use the explicit integration send action to deliver it.

## API and concurrency

- `POST /api/articles/:id/extraction/recapture` accepts
  `{expectedRevision: string | null, refreshMetadata?: boolean}`. The metadata
  choice defaults to false; null asserts that no copy exists. A durably queued
  operation returns 202 with `{extraction}`. A matching active request returns
  200 with the existing generation. Different options during an active job or a
  stale revision return 409. Restarting a terminal job has a one-minute cooldown
  and returns 429 with `Retry-After: 60` during that interval.
- `POST /api/articles/:id/extraction/undo` requires `{expectedRevision: string}`.
  It returns 200 with `{extraction}`, or 409 when the snapshot is unavailable or
  subsequent edits prevent restoring it. Both operations return 404 for a missing
  article, require owner authentication and same-origin/CSRF validation, and use
  private/no-store responses. Save-only capture tokens cannot invoke them.
- The existing extraction status retains `state: "ready"` whenever a readable
  copy exists. Its optional `recovery` object independently reports `generation`,
  job `state` (queued/running/retry_wait/succeeded/failed), `attempts`, `errorCode`,
  and `nextAttemptAt`. `undoAvailable` reports whether the snapshot still matches.

The existing scheduled processor handles recapture with the same pause flag,
private extractor, attempt limit, leases, and backoff as initial capture. Queued
requests remain durable when processing is paused. Copy revision and optional
metadata baseline checks fence the final transaction. Manual copy saves supersede
pending recaptures; late workers cannot replace them. Conflict failures use
`copy_changed` or `metadata_changed` without storing source error messages.
Expired leases remain recoverable, and the original retry route can now recover
a succeeded job whose copy disappeared.

Migration `0009_capture_recovery.sql` adds the job fields and one snapshot table.
Apply it before deploying the new application Worker. Existing jobs default to
initial capture; export/import version 2 is unchanged. Use an isolated staging
database and fixture extractor to rehearse queue, replacement, failure, and undo
before production rollout. The automated D1 tests exercise the transactional
processor; browser smoke uses API fixtures to exercise UI polling and drafts.
These local checks do not establish a live staging deployment.

Recapture uses the source page as it exists now. It cannot detect semantically
incorrect extraction automatically. Paste or upload a corrected browser copy if
the source repeatedly produces unsuitable Markdown.
