export const PROTOCOL_VERSION = 1;
export const MAX_SOURCE_BYTES = 512 * 1024;
export const MAX_MESSAGE_BYTES = 12 * 1024;
export const MAX_RESPONSE_BYTES = 768 * 1024;
export const MAX_TARGET_BYTES = 8 * 1024;
export const FETCH_FAILURE_HEADER = "x-safe-fetch-error";

export const FETCH_ERROR_CODES = [
  "unsafe_destination", "invalid_url", "dns_error", "timeout", "network_error",
  "source_too_large", "unsupported_encoding",
] as const;
export type FetchErrorCode = typeof FETCH_ERROR_CODES[number];

export interface FetchRequestMessage {
  version: 1;
  url: string;
}

export type FetchResponseMessage =
  | { version: 1; ok: true; status: number; headers: Record<string, string>; body: string }
  | { version: 1; ok: false; error: FetchErrorCode };

export function isFetchErrorCode(value: unknown): value is FetchErrorCode {
  return typeof value === "string" && (FETCH_ERROR_CODES as readonly string[]).includes(value);
}
