# Reading time at ingestion

Show an estimate such as **4 min read** beside the source and author in library rows and the saved reader. Calculate it when Potem saves the Markdown copy. Link-only entries, pending or failed initial captures, PDFs without extracted text, and copies without countable text have no label. Existing copies start with a null estimate and use the estimator on the next successful replacement.

[Issue #158](https://github.com/Pajdzik/read-it-later/issues/158)

## Estimator

Add a pure Worker helper that takes the complete validated Markdown, up to the existing 256 KiB limit. Use the existing `markdown-it` dependency to read tokens and count text in paragraphs, headings, lists, quotes, tables, and explicit link labels. Skip leading delimited YAML front matter, raw HTML blocks and tags, image tokens, link destinations, autolinks, and fenced, indented, and inline code. Join adjacent text across emphasis and link markup, and preserve whitespace at line and block boundaries. The saved Markdown is the sole input, so edits to the article title or description require no recalculation.

Iterate over word-like segments one Markdown block at a time with `Intl.Segmenter('en', { granularity: 'word' })`. A zero count produces `null`. For a positive count use `Math.ceil(words / 240)`, so 240 words display as 1 minute and 241 as 2 minutes. The 240-word rate is a single default for all languages, based on the reported 238 words per minute for adults reading English nonfiction. The helper runs locally and returns `null` on an estimator error so the copy can still be saved. [ECMA-402 word segmentation](https://tc39.es/ecma402/#sec-intl.segmenter) · [Brysbaert’s reading-rate study](https://biblio.ugent.be/publication/8647789)

## Persistence and API

Add a nullable, positive-integer `reading_time_minutes` column to `article_copies` and `article_capture_recovery` in migration `0006`. Write the estimate in the same guarded statement as the Markdown and revision. Keep the previous estimate with the previous Markdown in the recapture snapshot, and restore both in the undo transaction.

| Copy write | Integration point |
| --- | --- |
| Background HTML and PDF extraction | Calculate from the accepted conversion result. The existing job lease gates publication. [jobs.ts](../src/articles/jobs.ts#L184) |
| Saved reader preview, paste, upload, and extension clip | Calculate when creating an article with a copy or saving a copy for an existing article. A duplicate with an existing copy keeps that copy and its estimate. [Article creation](../src/articles/repository.ts#L183) · [Copy save](../src/articles/repository.ts#L102) |
| Recapture and undo | Publish the replacement estimate after a successful recapture. Queued, failed, or stale recaptures preserve the current estimate. Undo restores the snapshot value. [recovery.ts](../src/articles/recovery.ts#L46) |
| JSON import and ZIP restore | Recompute from imported Markdown in the shared write path. Skipped duplicates keep their current values. [library-import.ts](../src/articles/library-import.ts#L57) |

Expose `readingTimeMinutes: number | null` as read-only metadata on authenticated article and saved-copy responses. Project the scalar in article queries, so library requests can display it without reading or parsing Markdown. Return the reader’s estimate alongside Markdown and revision in `GET /api/articles/:id/copy`, and return the saved value in the corresponding `PUT` response. Explicitly project the portable fields when serializing the JSON export. Both JSON and ZIP keep their existing version 3 shapes. [JSON export](../src/articles/handler.ts#L310)

## UI and verification

Use the existing metadata lines. A manual copy save updates the visible row from the successful response. A completed background capture updates the row on the next library fetch or through the existing poll while the detail view or reader is open. If a recapture completes while the reader still displays the previous body, keep that revision’s estimate until the newer copy opens. [Library metadata](../web/app.ts#L805) · [Saved reader metadata](../web/app.ts#L2326)

- Unit-test the rounding boundaries, formatted prose, excluded markup, Polish and unspaced Japanese text, and copies containing only images or code.
- Extend the Worker tests for link-only and queued saves, HTML and PDF completion, manual replacement and stale writes, recapture and undo, and JSON and ZIP round trips. Verify that an older row with a null estimate still loads.
- Extend browser smoke coverage for the label in the library and saved reader, including an open reader that switches to a recaptured copy. Profile a 256 KiB single-paragraph copy and a maximum-size import and restore batch in the Worker to verify segmentation support and CPU headroom before release.
