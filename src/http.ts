import type { ApiError } from './contracts.js';
import { BodyTooLargeError, ValidationError } from './articles/validation.js';

export const PRIVATE_HEADERS = { 'Cache-Control': 'private, no-store', 'Pragma': 'no-cache' };

export function jsonResponse(
  value: unknown,
  status = 200,
  headers: HeadersInit = {},
  privateHeaders: HeadersInit = PRIVATE_HEADERS,
): Response {
  const mergedHeaders = new Headers(privateHeaders);
  new Headers(headers).forEach((headerValue, name) => mergedHeaders.set(name, headerValue));
  return Response.json(value, { status, headers: mergedHeaders });
}

export function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } } satisfies ApiError, status, {}, { 'Cache-Control': 'private, no-store' });
}

export function logUnexpectedError(category: string): void {
  console.error(JSON.stringify({ event: 'request_error', category }));
}

export function exceptionResponse(
  error: unknown,
  category: string,
  fallback: { status: number; code: string; message: string },
): Response {
  if (error instanceof BodyTooLargeError) return errorResponse(413, 'body_too_large', error.message);
  if (error instanceof ValidationError) return errorResponse(400, 'invalid_request', error.message);
  logUnexpectedError(category);
  return errorResponse(fallback.status, fallback.code, fallback.message);
}
