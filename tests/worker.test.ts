import { describe, expect, it } from 'vitest';
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
