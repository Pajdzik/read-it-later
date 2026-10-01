import type { Env } from '../contracts.js';
import { errorResponse } from '../contracts.js';

const SESSION_COOKIE = 'read_later_session';
const BINDING_COOKIE = 'read_later_oauth_binding';
const encoder = new TextEncoder();

export function randomToken(bytes = 32): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...data)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function cookie(request: Request, name: string): string | null {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const value = part.trim(); const split = value.indexOf('=');
    if (split >= 0 && value.slice(0, split).trim() === name) {
      try { return decodeURIComponent(value.slice(split + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

function isLoopbackOrigin(value: string | undefined): boolean {
  try { const u = new URL(value || ''); return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname); } catch { return false; }
}

export function origin(env: Env): string | null {
  try {
    const u = new URL(env.APP_ORIGIN || '');
    if (u.protocol !== 'https:' && !(env.DEV_AUTH_BYPASS === 'true' && isLoopbackOrigin(env.APP_ORIGIN))) return null;
    if (u.username || u.password || u.pathname !== '/' || u.search || u.hash) return null;
    return u.origin;
  } catch { return null; }
}

export function authConfigured(env: Env): boolean {
  return Boolean(origin(env) && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.OWNER_GITHUB_ID && /^\d+$/.test(env.OWNER_GITHUB_ID));
}

export interface Session { tokenHash: string; csrfToken: string; }

export async function getSession(request: Request, env: Env): Promise<Session | null> {
  if (env.DEV_AUTH_BYPASS === 'true' && isLoopbackOrigin(env.APP_ORIGIN) && isLoopbackRequest(request, env)) return { tokenHash: 'dev-bypass', csrfToken: 'dev-bypass' };
  if (!authConfigured(env)) return null;
  const raw = cookie(request, SESSION_COOKIE);
  if (!raw) return null;
  const tokenHash = await digest(raw);
  const row = await env.DB.prepare('SELECT csrf_token, expires_at FROM sessions WHERE token_hash = ?')
    .bind(tokenHash).first<{ csrf_token: string; expires_at: string }>();
  await env.DB.prepare('DELETE FROM sessions WHERE rowid IN (SELECT rowid FROM sessions WHERE expires_at <= ? LIMIT 100)')
    .bind(new Date().toISOString()).run();
  if (!row) return null;
  if (row.expires_at <= new Date().toISOString()) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    return null;
  }
  return { tokenHash, csrfToken: row.csrf_token };
}

export async function requireSession(request: Request, env: Env, write = false): Promise<Session | Response> {
  if (env.DEV_AUTH_BYPASS === 'true' && isLoopbackOrigin(env.APP_ORIGIN) && isLoopbackRequest(request, env)) {
    if (write && (request.headers.get('Origin') !== origin(env) || request.headers.get('X-CSRF-Token') !== 'dev-bypass')) return errorResponse(403, 'csrf', 'Request verification failed.');
    return { tokenHash: 'dev-bypass', csrfToken: 'dev-bypass' };
  }
  if (!authConfigured(env)) return errorResponse(503, 'auth_unavailable', 'Owner sign-in is not configured.');
  const session = await getSession(request, env);
  if (!session) return errorResponse(401, 'unauthorized', 'Sign in is required.');
  if (write) {
    const expected = origin(env);
    if (!expected || request.headers.get('Origin') !== expected) return errorResponse(403, 'forbidden', 'Request origin is not allowed.');
    if (!constantTimeEqual(request.headers.get('X-CSRF-Token') || '', session.csrfToken)) return errorResponse(403, 'csrf', 'Request verification failed.');
  }
  return session;
}

export function isResponse(value: unknown): value is Response { return value instanceof Response; }

function isLoopbackRequest(request: Request, env: Env): boolean {
  try {
    const target = new URL(request.url); const configured = new URL(env.APP_ORIGIN || '');
    return target.origin === configured.origin && isLoopbackOrigin(target.origin);
  } catch { return false; }
}

export function constantTimeEqual(a: string, b: string): boolean {
  const aa = encoder.encode(a); const bb = encoder.encode(b);
  let mismatch = aa.length ^ bb.length;
  const n = Math.max(aa.length, bb.length);
  for (let i = 0; i < n; i++) mismatch |= (aa[i % (aa.length || 1)] || 0) ^ (bb[i % (bb.length || 1)] || 0);
  return mismatch === 0;
}

export function sessionCookie(value: string, env: Env, maxAge: number): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
export function bindingCookie(value: string, env: Env, maxAge: number): string {
  const secure = origin(env)?.startsWith('https://') ? '; Secure' : '';
  return `${BINDING_COOKIE}=${encodeURIComponent(value)}; Path=/auth/github; HttpOnly${secure}; SameSite=Lax; Max-Age=${maxAge}`;
}
export function clearSessionCookie(): string { return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`; }
export function clearBindingCookie(env: Env): string {
  const secure = origin(env)?.startsWith('https://') ? '; Secure' : '';
  return `${BINDING_COOKIE}=; Path=/auth/github; HttpOnly${secure}; SameSite=Lax; Max-Age=0`;
}

export async function validateCaptureToken(request: Request, env: Env): Promise<{ id: string } | Response> {
  if (!authConfigured(env)) return errorResponse(503, 'auth_unavailable', 'Owner sign-in is not configured.');
  const authorization = request.headers.get('Authorization') || '';
  const match = /^Bearer ([A-Za-z0-9_-]{40,80})$/.exec(authorization);
  if (!match) return errorResponse(401, 'unauthorized', 'A valid capture token is required.');
  const tokenHash = await digest(match[1]);
  const row = await env.DB.prepare('SELECT id FROM capture_tokens WHERE token_hash = ? AND revoked_at IS NULL')
    .bind(tokenHash).first<{ id: string }>();
  if (!row) return errorResponse(401, 'unauthorized', 'A valid capture token is required.');
  const windowStart = Math.floor(Date.now() / 60_000);
  const result = await env.DB.prepare(`INSERT INTO capture_rate_buckets (token_id, window_start, count)
    VALUES (?, ?, 1) ON CONFLICT(token_id, window_start) DO UPDATE SET count = count + 1 RETURNING count`)
    .bind(row.id, windowStart).first<{ count: number }>();
  if (!result) return errorResponse(503, 'storage_unavailable', 'Capture limit could not be checked.');
  if (result.count > 60) return errorResponse(429, 'rate_limited', 'Capture limit reached. Try again in a minute.');
  await env.DB.prepare('DELETE FROM capture_rate_buckets WHERE rowid IN (SELECT rowid FROM capture_rate_buckets WHERE window_start < ? LIMIT 100)')
    .bind(windowStart - 2).run();
  return { id: row.id };
}
