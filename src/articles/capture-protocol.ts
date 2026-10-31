import type { OriginalPdf } from "../contracts";
import type { ArticleMetadata } from "./metadata";

export const MAX_MARKDOWN_BYTES = 256 * 1024;
// JSON escaping can expand a Markdown byte to six bytes.
export const MAX_CAPTURE_RESPONSE_BYTES = 2 * 1024 * 1024;
export const CAPTURE_TIMEOUT_MS = 90_000; // Includes cold start; less than the two-minute D1 lease.

export const captureErrorCodes = [
  "capture_paused", "invalid_url", "unsafe_destination", "redirect_loop", "timeout",
  "network_error", "invalid_redirect", "too_many_redirects", "redirect_downgrade",
  "upstream_http", "unvalidated_redirect", "unsupported_content", "unsupported_encoding",
  "source_too_large", "empty_source", "invalid_encoding", "malformed_html", "invalid_html",
  "conversion_failed", "conversion_timeout", "converter_unavailable", "pdf_no_text", "markdown_too_large", "invalid_pdf", "pdf_storage_unavailable", "capture_busy", "capture_unavailable", "invalid_capture_response",
] as const;

export class SourceFetchError extends Error {
  constructor(readonly code: string, readonly retryable: boolean, readonly retryAfterSeconds?: number) {
    super(code);
    this.name = "SourceFetchError";
  }
}

export interface CapturedArticle {
  markdown: string;
  metadata: ArticleMetadata;
  originalPdf?: OriginalPdf;
  conversionError?: { code: string; retryable: boolean };
}

export type CaptureResult =
  | { version: 1; ok: true; article: CapturedArticle }
  | { version: 1; ok: false; error: { code: string; retryable: boolean; retryAfterSeconds?: number } };
