// Shared by the app, gateway Worker, and native fetcher.
export const SOURCE_HOP_TIMEOUT_MS = 5_000;
export const CONTAINER_STARTUP_TIMEOUT_MS = 10_000;
export const SOURCE_TOTAL_TIMEOUT_MS = 20_000;
export const MAX_SOURCE_HTML_BYTES = 2 * 1024 * 1024;

export const MAX_SOURCE_PDF_BYTES = 20 * 1024 * 1024;
export const CONVERSION_TIMEOUT_MS = 45_000;
// Covers source, metadata, storage, virtual transport and response reads; leaves
// room for Container startup within the app's 90-second capture deadline.
export const EXECUTOR_TIMEOUT_MS = 75_000;
