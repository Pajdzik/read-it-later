export const PROTOCOL_VERSION = 2;
export const MAX_SOURCE_BYTES = 512 * 1024;
export const MAX_MESSAGE_BYTES = 12 * 1024;
export const MAX_RESPONSE_BYTES = MAX_SOURCE_BYTES;
export const MAX_TARGET_BYTES = 8 * 1024;
export const FETCH_FAILURE_HEADER = "x-safe-fetch-error";
export const FETCH_PROTOCOL_HEADER = "x-safe-fetch-protocol";

export const FETCH_ERROR_CODES = [
  "unsafe_destination", "invalid_url", "dns_error", "timeout", "network_error",
  "source_too_large", "unsupported_encoding",
] as const;
export type FetchErrorCode = typeof FETCH_ERROR_CODES[number];

export interface FetchRequestMessage {
  version: 2;
  url: string;
}

export function isFetchErrorCode(value: unknown): value is FetchErrorCode {
  return typeof value === "string" && (FETCH_ERROR_CODES as readonly string[]).includes(value);
}
