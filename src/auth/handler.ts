import type { Env } from '../contracts.js';
import { errorResponse } from '../contracts.js';
import { BodyTooLargeError, parseObject, readJson, ValidationError } from '../articles/validation.js';
import {
  authConfigured, bindingCookie, clearBindingCookie, clearSessionCookie, cookie, digest,
  getSession, isLoopbackRequest, isResponse, randomToken, requireSession, sessionCookie, validateCaptureToken,
} from './core.js';

const PRIVATE = { 'Cache-Control': 'private, no-store', 'Pragma': 'no-cache' };
const BINDING_COOKIE = 'read_later_oauth_binding';
const SESSION_SECONDS = 30 * 24 * 60 * 60;

function fail(status: number, code: string, message: string): Response { return errorResponse(status, code, message); }
function isKnownDbError(_error: unknown): Response { return fail(503, 'storage_unavailable', 'The service is temporarily unavailable. Please retry.'); }
function respond(body: unknown, init: ResponseInit = {}): Response {
  return Response.json(body, { ...init, headers: { ...PRIVATE, ...init.headers } });
}

export async function handleAuth(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  try {
    if (url.pathname === '/api/session' && method === 'GET') {
      if (env.DEV_AUTH_BYPASS === 'true' && isLoopbackRequest(request, env)) return respond({ authenticated: true, csrfToken: 'dev-bypass' });
      const session = await getSession(request, env);
      return respond(session ? { authenticated: true, csrfToken: session.csrfToken } : { authenticated: false });
    }
    if (url.pathname === '/auth/github' && method === 'GET') return await beginOAuth(env);
    if (url.pathname === '/auth/github/callback' && method === 'GET') return await finishOAuth(request, env);
    if (url.pathname === '/auth/logout' && method === 'POST') {
      const session = await requireSession(request, env, true);
      if (isResponse(session)) return session;
      if (session.tokenHash !== 'dev-bypass') await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(session.tokenHash).run();
      return new Response(null, { status: 204, headers: { ...PRIVATE, 'Set-Cookie': clearSessionCookie() } });
    }
    if (url.pathname === '/api/capture-tokens' && (method === 'GET' || method === 'POST')) {
      const session = await requireSession(request, env, method !== 'GET');
      if (isResponse(session)) return session;
      if (method === 'GET') {
        const result = await env.DB.prepare('SELECT id, label, created_at, revoked_at FROM capture_tokens ORDER BY created_at DESC, id DESC').all<{ id: string; label: string; created_at: string; revoked_at: string | null }>();
        return respond({ items: (result.results || []).map((row) => ({ id: row.id, label: row.label, createdAt: row.created_at, revokedAt: row.revoked_at })) });
      }
      const body = parseObject(await readJson(request), ['label'], ['label']);
      if (typeof body.label !== 'string' || !body.label.trim() || body.label.trim().length > 100) throw new ValidationError('label must contain 1 to 100 characters');
      const id = crypto.randomUUID(); const token = `rlcap_${randomToken(32)}`; const createdAt = new Date().toISOString();
      await env.DB.prepare('INSERT INTO capture_tokens (id, token_hash, label, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)')
        .bind(id, await digest(token), body.label.trim(), createdAt).run();
      return respond({ id, token, label: body.label.trim(), createdAt }, { status: 201 });
    }
    const revoke = /^\/api\/capture-tokens\/([^/]+)$/.exec(url.pathname);
    if (revoke && method === 'DELETE') {
      const session = await requireSession(request, env, true);
      if (isResponse(session)) return session;
      await env.DB.prepare('UPDATE capture_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').bind(new Date().toISOString(), revoke[1]).run();
      return new Response(null, { status: 204, headers: PRIVATE });
    }
    return null;
  } catch (error) {
    if (error instanceof BodyTooLargeError) return fail(413, 'body_too_large', error.message);
    if (error instanceof ValidationError) return fail(400, 'invalid_request', error.message);
    return isKnownDbError(error);
  }
}

async function beginOAuth(env: Env): Promise<Response> {
  if (!authConfigured(env)) return fail(503, 'auth_unavailable', 'Owner sign-in is not configured.');
  try {
    const state = randomToken(); const binding = randomToken();
    const now = Date.now(); const expiry = new Date(now + 10 * 60_000).toISOString();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM oauth_states WHERE rowid IN (SELECT rowid FROM oauth_states WHERE expires_at <= ? LIMIT 100)').bind(new Date(now).toISOString()),
      env.DB.prepare('INSERT INTO oauth_states (state_hash, browser_binding_hash, expires_at) VALUES (?, ?, ?)').bind(await digest(state), await digest(binding), expiry),
    ]);
    const authorize = new URL('https://github.com/login/oauth/authorize');
    authorize.searchParams.set('client_id', env.GITHUB_CLIENT_ID!);
    authorize.searchParams.set('redirect_uri', `${env.APP_ORIGIN!.replace(/\/$/, '')}/auth/github/callback`);
    authorize.searchParams.set('scope', 'read:user'); authorize.searchParams.set('state', state);
    return new Response(null, { status: 302, headers: { ...PRIVATE, Location: authorize.toString(), 'Set-Cookie': bindingCookie(binding, env, 600) } });
  } catch (error) { return isKnownDbError(error); }
}

async function finishOAuth(request: Request, env: Env): Promise<Response> {
  if (!authConfigured(env)) return fail(503, 'auth_unavailable', 'Owner sign-in is not configured.');
  const url = new URL(request.url); const state = url.searchParams.get('state'); const code = url.searchParams.get('code');
  const binding = cookie(request, BINDING_COOKIE);
  if (!state || !code || !binding || state.length > 200) return fail(403, 'oauth_state', 'Sign-in could not be verified. Start again.');
  try {
    const stateHash = await digest(state); const bindingHash = await digest(binding);
    const deleted = await env.DB.prepare(`DELETE FROM oauth_states WHERE state_hash = ? AND browser_binding_hash = ? AND expires_at > ?`)
      .bind(stateHash, bindingHash, new Date().toISOString()).run();
    if (!(deleted.meta?.changes ?? 0)) return fail(403, 'oauth_state', 'Sign-in could not be verified. Start again.');
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: `${env.APP_ORIGIN!.replace(/\/$/, '')}/auth/github/callback` }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenResponse.ok) return oauthFailure(env);
    const tokenData = await tokenResponse.json() as { access_token?: unknown; error?: unknown };
    if (typeof tokenData.access_token !== 'string' || !tokenData.access_token) return oauthFailure(env);
    const userResponse = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'read-later' }, signal: AbortSignal.timeout(10_000) });
    if (!userResponse.ok) return oauthFailure(env);
    const user = await userResponse.json() as { id?: unknown };
    if (typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || String(user.id) !== env.OWNER_GITHUB_ID) return oauthFailure(env);
    const rawSession = randomToken(); const csrf = randomToken(); const createdAt = new Date();
    await env.DB.prepare('INSERT INTO sessions (token_hash, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .bind(await digest(rawSession), csrf, new Date(createdAt.getTime() + SESSION_SECONDS * 1000).toISOString(), createdAt.toISOString()).run();
    await env.DB.prepare('DELETE FROM sessions WHERE rowid IN (SELECT rowid FROM sessions WHERE expires_at <= ? LIMIT 100)')
      .bind(createdAt.toISOString()).run();
    const headers = new Headers({ ...PRIVATE, Location: `${env.APP_ORIGIN!.replace(/\/$/, '')}/add` });
    headers.append('Set-Cookie', sessionCookie(rawSession, env, SESSION_SECONDS));
    headers.append('Set-Cookie', clearBindingCookie(env));
    return new Response(null, { status: 302, headers });
  } catch { return oauthFailure(env); }
}

function oauthFailure(env: Env): Response {
  return new Response('Sign-in failed. Check that you are using the configured owner account, then try again.', {
    status: 403, headers: { ...PRIVATE, 'Content-Type': 'text/plain; charset=utf-8', 'Set-Cookie': clearBindingCookie(env) },
  });
}
