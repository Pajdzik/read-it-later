# Archive restore rehearsal (A05)

## Next unfinished archive work

A03's saved-copy reader and download are merged. A04 remains deferred by the manual-only A01 decision. A05 is next: prove that portable backups recover preserved text, metadata, and read state, and measure storage rather than assuming headroom. This change delivers repeatable local restore evidence and an operator command. A05 remains unchecked until the separate deployed-origin release checks pass.

## Operator workflow

Add `pnpm archive:rehearse`, using a built-in representative library by default or `--backup /absolute/path/export.json` for a downloaded version-1 or version-2 backup. An optional `--report /absolute/path/report.json` writes a count/byte/check report. The report path must be new: existing files, symlinks, and hardlinks are never overwritten. Read supplied files without modifying them. Report no article IDs, URLs, titles, bodies, credentials, or input filesystem paths. Reject malformed files with a generic error and nonzero exit status. Bound supplied files to 64 MiB; reject unexpected envelope fields (including authentication records).

Run the actual Worker, migrations, and D1 with an isolated temporary directory, generated local configuration, loopback origin, and local-only bypass. Never accept a remote URL, environment, database, or `--remote` option. Disable loading `.dev.vars` and `.env`; use local assets and migration paths. Import the input in bounded batches, export a canonical library, stop the source Worker, and restore that export into a second independently migrated empty local D1 database. Export again and compare every article/copy field independent of list order and `exportedAt`. Reimport and require zero new articles. Detect skipped/duplicate input records rather than reporting them as a successful complete restore. Delete temporary databases and private downloads on success or failure and stop child processes cleanly.

The helper splits versioned envelopes at the existing HTTP import limits (1 MiB UTF-8 JSON and 1,000 articles), preserves every field and format version, and never splits an individual article. A single serialized record that exceeds the import bound fails before the rehearsal starts. Byte counts include JSON escaping and envelope overhead. Empty libraries and version 1 remain supported; version 1 canonicalizes to the current version-2 export. No production write, source fetch, GitHub commit, or secret is needed.

## Verification and report

Use a deterministic default library with both paste/upload copies, Unicode and escaped text, read/unread state, records without copies, more than one export page, and data exceeding one import envelope. Verify exact exported/restored field equality and repeat-import idempotency. In Chromium, open representative restored paste/upload copies and download them through the actual UI while blocking all non-loopback requests. Validate UTF-8 Markdown body and quoted capture/source/revision frontmatter, and unchanged read state. Failure to read or download fails the rehearsal. For supplied backups with no copies, report zero reader samples explicitly.

Report article/read/unread/copy counts, input and canonical JSON bytes, total/max Markdown UTF-8 bytes, batch counts, reader sample count, and measured restored local D1 database bytes from D1 result metadata. Label local database size as a rehearsal measurement; it is not production/account usage. No production headroom is inferred from fixture data or Markdown bytes. The current Free per-database limit is 500 MB; use the deployed D1 storage metrics for actual remaining capacity. Reassess text storage/R2 before approaching the measured database limit, when growth consumes the available operational margin, or when retaining binary assets becomes a requirement. R2 adoption needs a separate cost/architecture decision.

## Validation and release boundary

Add focused Node tests for UTF-8/escaped envelope splitting, item and byte boundaries, oversized single records, empty/v1 input, unexpected authentication fields, and content-preserving reports. Add the fixture rehearsal to CI after the existing browser checks. Run syntax, TypeScript, existing Worker/D1 tests, build, browser smoke, helper tests, and the rehearsal.

Local success proves the supplied export is recoverable by the current code in fresh local D1. It does not prove deployed authentication, provider recovery, production storage headroom, actual-device behavior, or GitHub backup configuration. Record those separately before checking A05 complete. Supported sources are owner-pasted/browser-clipped Markdown and UTF-8 `.md`/`.markdown` uploads; remote images remain references and automatic extraction remains deferred.

References: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 result metadata](https://developers.cloudflare.com/d1/worker-api/return-object/), [D1 storage metrics](https://developers.cloudflare.com/d1/observability/metrics-analytics/).

## Local evidence (October 2, 2026)

All existing checks passed: syntax, TypeScript, 37 Worker/D1 tests, dry-run build, and browser smoke. `pnpm test:archive` passes eight helper tests and the complete fixture rehearsal. The fixture restored 30 articles (10 read, 20 unread) and 28 copies (14 paste, 14 upload) through two import batches. It compared 1,282,262 canonical JSON bytes, downloaded two restored copies, and measured 1,376,256 local D1 bytes via `meta.size_after`. Reimport added zero articles and preserved all fields.

An additional supplied-file review covered 71 records with duplicate/newline titles, opaque IDs with quotes/brackets/slashes/Unicode, copies beyond the first list page, a horizontal-rule-only copy, exact downloads, version-1 input, malformed UTF-8, rejected remote options, and an unchanged input hash after success and refused hardlink report output. SIGTERM during setup removed the temporary database directory and stopped local child processes. These are local measurements and checks, not deployed release evidence.
