# Offline GitHub Markdown recovery (G01)

Status: implemented and fixture-validated October 2, 2026. Actual backup folders and production imports remain pending owner review.

## Purpose

Turn a local checkout or downloaded folder of Potem GitHub Markdown backups into
the existing version-2 JSON import format. The GitHub writer already preserves
article IDs, URLs, titles, optional metadata, saved dates, capture metadata and
exact Markdown bodies. Recovery previously required constructing JSON by hand;
this converter makes that documented recovery path practical.

Run `pnpm github:convert --source /absolute/path/Articles --output /absolute/path/new-directory`.
The output contains a private `report.json` and compact `import-001.json` batches.
Review the report, then import the batches through Settings. Existing normalized
URLs keep their service records and copies. The converter works entirely offline;
it reads the selected folder without changing it, loading credentials, contacting
GitHub or importing into any service.

## Source format and mapping

Accept the format produced by `articleMarkdown` in `src/articles/github.ts`:
an opening `---`, `potem_backup_version: 1`, JSON scalar metadata lines and a
closing `---`, followed by the exact body. Accept LF or CRLF header lines and
an optional UTF-8 BOM before the opening delimiter; preserve all body characters
and line endings. Split only the first header, including its closing line ending.
A second frontmatter block belongs to the body. Reject malformed UTF-8,
unterminated headers, duplicate fields, unknown fields and unsupported versions.
Parse metadata values as JSON scalars; arbitrary YAML, aliases, tags, sequences
and objects are outside this writer's format and are rejected.

Require all writer fields: `id`, `title`, `url`, `author`, `description`, `savedAt`,
`capturedAt`, `source`, `revision`. Preserve strings exactly, including quoted
Unicode and newlines, and preserve null optional metadata. Validate against the
existing import limits: nonempty ID up to 128 characters, nonblank title up to
500, author/description null or nonblank strings up to 200/500, absolute HTTP(S)
URL without credentials up to 8 KiB UTF-8, canonical UTC timestamps, paste/upload
source and a revision matching `[A-Za-z0-9_-]{1,128}`. IDs come from metadata;
filenames never supply IDs or paths.

Map `savedAt` to both `createdAt` and `updatedAt`. Set `readAt` to null and include
`read_state_not_backed_up` in every eligible record's warnings: GitHub files do
not preserve read state. Preserve `capturedAt`, `source` and `revision` verbatim.
Require a nonblank Markdown body within 256 KiB UTF-8. Exclude oversized or empty
copies rather than claiming a successful full recovery. Do not infer missing
fields from the filename, filesystem dates or current time. GitHub backup status
and authentication data are absent from recovered portable records.

## Discovery, duplicates and output

Recursively inspect regular `.md`/`.markdown` files in deterministic relative-path
order. Skip hidden directories and report symlinks without following them. Bound
each read to 1 MiB, discovery to 10,000 candidates and aggregate source reads to
64 MiB. Check resolved paths and symlink parents before opening files; use
no-follow reads where supported. Individual invalid files are excluded with
specific reasons, while aggregate-limit or operational failures abort without
publishing a partial conversion.

The first valid, importable record for a normalized URL wins; report later records
as duplicates with the winner's path. An ID already used by a different normalized
URL is excluded as `conflicting_article_id`. Invalid or oversized records never
claim an ID or URL. Do not merge different bodies or revisions.

Reuse the archive envelope validator and splitter. Every output batch is at most
1 MiB and 1,000 records, with no record split. Exclude a single record that cannot
fit because of JSON escaping. Validate the full output against the 64 MiB backup
limit before writing. An empty conversion emits a report and no batches.

Both paths must be absolute. Require a new output directory with an existing
parent resolving outside the source tree. Reject existing destinations, including
symlinks, and output ancestors of the source. Write the directory with mode 0700
and files with mode 0600/exclusive creation; remove newly created partial output
if writing fails. Never overwrite an existing file.

The report contains format/version, conversion time, discovered/eligible/
duplicate/excluded/copied/unread/batch counts, skipped symlinks and per-file
relative paths, outcomes, reasons, warnings and duplicate/conflict winner paths.
Totals must reconcile. Do not include article bodies, URLs, titles or credentials
in the report or stdout; stdout contains counts only. Reports and import files
remain private because paths and article data can be sensitive.

## Acceptance

Temporary-fixture unit tests cover exact Unicode/quoted/newline metadata and
Markdown body recovery; LF/CRLF/BOM/nested frontmatter; opaque and encoded-looking
IDs independent of filenames; strict headers and malformed UTF-8; timestamps,
schemes, credentials and field limits; normalized URL duplicates and conflicting
IDs; source-byte preservation; empty/oversized/JSON-escaped records; aggregate
bounds; symlink/hidden-directory handling and unsafe/existing output refusal;
private file modes and bounded multiple batches. Include a writer-to-converter
round trip using the actual `articleMarkdown` function so format drift is caught.

A temporary local Worker/D1 rehearsal imports generated batches, exports and
reconciles every persisted field, repeats the import with zero writes, and proves
that an existing normalized-URL record retains its title, copy and read state.
Use synthetic fixtures only and clear credentials from child environments.
Run the converter tests in CI plus existing syntax, typecheck, Worker/D1 tests
and dry-run build. Document the command and the loss of read state in README
and the GitHub Markdown guide. Actual GitHub folders, production imports and
deployed/device release checks remain pending.

Implementation evidence: parser and converter fixtures run with
`pnpm test:github`. The suite bundles the actual `articleMarkdown` writer for a
format round trip and runs generated batches through a temporary local
Worker/D1 instance. The fixture imports two records, skips an existing
normalized URL, exports and reconciles the persisted fields, then repeats the
import with zero writes. It verifies the existing record's title, copy, and read
state stay intact. These synthetic fixtures do not establish that any actual
GitHub folder was inspected or recovered.
