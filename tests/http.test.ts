import { describe, expect, it } from 'vitest';
import { jsonResponse } from '../src/http';

describe('jsonResponse headers', () => {
  it('merges Headers and tuple inputs with caller values overriding private defaults', async () => {
    const headers = new Headers({ 'X-From-Headers': 'kept', 'Cache-Control': 'public, max-age=5' });
    const response = jsonResponse({ ok: true }, 201, [
      ['X-From-Tuples', 'kept-too'],
      ['Pragma', 'custom'],
    ], headers);

    expect(response.status).toBe(201);
    expect(response.headers.get('X-From-Headers')).toBe('kept');
    expect(response.headers.get('X-From-Tuples')).toBe('kept-too');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=5');
    expect(response.headers.get('Pragma')).toBe('custom');
    expect(await response.json()).toEqual({ ok: true });
  });
});
