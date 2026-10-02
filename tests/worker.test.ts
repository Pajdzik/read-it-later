import { describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import worker from '../src/worker';
import type { Env } from '../src/contracts';

const unavailable = { ...env, APP_ORIGIN: undefined, OWNER_GITHUB_ID: undefined, DEV_AUTH_BYPASS: undefined } as Env;
describe('integrated Worker routing', () => {
  it('serves public health and rejects unknown API routes as private JSON', async () => {
    const health = await worker.fetch(new Request('https://service.example/healthz'), unavailable);
    expect(await health.json()).toEqual({ ok: true });
    const unknown = await worker.fetch(new Request('https://service.example/api/unknown'), unavailable);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('Content-Type')).toContain('application/json');
    expect(unknown.headers.get('Cache-Control')).toContain('no-store');
    expect(unknown.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });
  it('fails closed for library and capture when owner authentication is not configured', async () => {
    for (const [path, method] of [['/api/articles','GET'],['/api/export','GET'],['/api/capture','POST']] as const) {
      const response = await worker.fetch(new Request(`https://service.example${path}`, {method}), unavailable);
      expect(response.status).toBe(503);
      expect(response.headers.get('Cache-Control')).toContain('no-store');
    }
  });
});

describe('export storage failures', () => {
  it('returns a retryable error before starting an export when the first query fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = {
      ...env, APP_ORIGIN: 'http://localhost:8787', DEV_AUTH_BYPASS: 'true',
      DB: { prepare() { throw new Error('simulated storage outage'); } },
    } as unknown as Env;
    const response = await worker.fetch(new Request('http://localhost:8787/api/export'), broken);
    expect(response.status).toBe(503);
    expect(await response.json()).toHaveProperty('error');
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({ event: 'request_error', category: 'articles.request' });
    log.mockRestore();
  });
});
