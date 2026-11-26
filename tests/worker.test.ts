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

  it('keeps share details in a bounded POST handoff instead of the request URL', async () => {
    const privateMarker = 'share-secret-marker-7f31';
    const assetRequests: string[] = [];
    const assets = {
      async fetch(request: Request) {
        assetRequests.push(request.url);
        return new Response('<!doctype html><html><body><main>Potem</main></body></html>', {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      },
    } as Fetcher;
    const response = await worker.fetch(new Request('https://service.example/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ title: `${privateMarker}</script><img src=x>`, text: 'Read this', url: `https://news.example/${privateMarker}#private` }),
    }), { ...unavailable, ASSETS: assets });
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(assetRequests).toEqual(['https://service.example/add']);
    expect(html).toContain('<script id="share-handoff" type="application/json">');
    expect(html).toContain(privateMarker);
    expect(html).toContain('\\u003c/script\\u003e');
    expect(html).not.toContain('</script><img');
    expect(html).not.toContain('https://service.example/add?');
  });

  it('rejects oversized share handoffs before requesting the app asset', async () => {
    const fetchAsset = vi.fn(async () => new Response('<html><body></body></html>', { headers: { 'Content-Type': 'text/html' } }));
    const response = await worker.fetch(new Request('https://service.example/add', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `text=${'x'.repeat(16 * 1024 + 1)}`,
    }), { ...unavailable, ASSETS: { fetch: fetchAsset } as unknown as Fetcher });
    expect(response.status).toBe(413);
    expect(fetchAsset).not.toHaveBeenCalled();
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
