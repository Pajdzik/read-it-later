export class ValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'ValidationError'; }
}

export const MAX_URL_LENGTH = 8 * 1024;
export const MAX_TITLE_LENGTH = 500;
export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_IMPORT_BYTES = 1024 * 1024;
export const MAX_IMPORT_ITEMS = 1000;

export function normalizeArticleUrl(input: unknown): { url: string; normalizedUrl: string } {
  if (typeof input !== 'string' || !input.trim()) throw new ValidationError('url must be a non-empty string');
  const url = input.trim();
  if (new TextEncoder().encode(url).byteLength > MAX_URL_LENGTH) throw new ValidationError('url is too long');
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new ValidationError('url must be a valid absolute HTTP(S) URL'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new ValidationError('url must use HTTP or HTTPS');
  if (!parsed.hostname || parsed.username || parsed.password) throw new ValidationError('url must not contain credentials');
  parsed.hostname = parsed.hostname.toLowerCase();
  if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) parsed.port = '';
  parsed.hash = '';
  // Keep retained query bytes and ordering intact; URLSearchParams would turn
  // `%20` into `+` and silently change otherwise meaningful source URLs.
  const rawQuery = parsed.search.slice(1);
  const kept = rawQuery.split('&').filter((part) => {
    if (!part) return false;
    let key = part.split('=', 1)[0].replaceAll('+', ' ');
    try { key = decodeURIComponent(key); } catch { /* preserve malformed but URL-accepted query data */ }
    const lower = key.toLowerCase();
    return !(lower.startsWith('utm_') || lower === 'fbclid' || lower === 'gclid');
  });
  const base = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  return { url, normalizedUrl: `${base}${kept.length ? `?${kept.join('&')}` : ''}` };
}

export function validateTitle(input: unknown, fallback: string): string {
  if (input === undefined) return fallback;
  if (typeof input !== 'string') throw new ValidationError('title must be a string');
  const title = input.trim();
  if (!title || title.length > MAX_TITLE_LENGTH) throw new ValidationError('title must contain 1 to 500 characters');
  return title;
}

export function defaultTitle(url: string): string {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop();
  const title = path ? `${parsed.hostname}${parsed.pathname}` : parsed.hostname;
  return title.slice(0, MAX_TITLE_LENGTH) || parsed.hostname;
}

export function parseObject(value: unknown, allowed: string[], required: string[] = []): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ValidationError('body must be a JSON object');
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) if (!allowed.includes(key)) throw new ValidationError(`unknown field: ${key}`);
  for (const key of required) if (!(key in object)) throw new ValidationError(`missing field: ${key}`);
  return object;
}

export async function readJson(request: Request, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new BodyTooLargeError();
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new BodyTooLargeError(); }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ValidationError('body must contain valid JSON'); }
}

export class BodyTooLargeError extends Error {
  constructor() { super('request body is too large'); this.name = 'BodyTooLargeError'; }
}
