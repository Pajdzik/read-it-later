import { env as bindings } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/contracts';
import worker from '../src/worker';
import { digest } from '../src/auth/core';
import { xml } from '../src/audio/feed';
import { recoverAudioJobs } from '../src/audio';

const origin = 'http://localhost:8787';
const send = vi.fn(async () => {});
const env: Env = { ...bindings, APP_ORIGIN: origin, DEV_AUTH_BYPASS: 'true', ARTICLE_AUDIO_ENABLED: 'true', AUDIO_FREE_CHARACTERS: '1000000', AUDIO_MONTHLY_BUDGET_USD: '10', AUDIO_QUEUE: { send } as unknown as Queue<import('../src/contracts').AudioMessage> };
function request(path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) {
  return new Request(origin + path, { method, headers: { ...(method === 'POST' || method === 'DELETE' ? { Origin: origin, 'X-CSRF-Token': 'dev-bypass' } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function token(): Promise<string> {
  const response = await worker.fetch(request('/api/podcast/token', 'POST', {}), env);
  expect(response.status).toBe(201);
  return (await response.json() as { feedUrl: string }).feedUrl;
}
async function article() {
  const at = '2026-11-01T00:00:00.000Z';
  await bindings.DB.prepare('INSERT INTO articles(id,url,normalized_url,title,author,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .bind('podcast1', 'https://example.com/article?a=1&b=2', 'https://example.com/article', 'A <title> & "quotation"', 'Author & friend', at, at).run();
  await bindings.DB.prepare('INSERT INTO article_copies(article_id,markdown,captured_at,source,revision) VALUES(?,?,?,?,?)')
    .bind('podcast1', '# Article\n\nAn article to listen to. Another complete sentence.', at, 'paste', 'revision-one').run();
}
async function published() {
  await article();
  const id = crypto.randomUUID();
  const key = `audio/episodes/${id}.mp3`;
  const data = new TextEncoder().encode('ID3podcast-media-fixture');
  const object = await bindings.AUDIO_BUCKET.put(key, data);
  await bindings.DB.prepare(`INSERT INTO audio_episodes(id,article_id,title,author,url,copy_revision,voice,normalizer_version,narration_text,state,created_at,ready_at,bytes,duration_seconds,object_key,checksum)
    VALUES(?,?,?,?,?,?,?,?,?,'ready',?,?,?,?,?,?)`)
    .bind(id,'podcast1','A <title> & "quotation"','Author & friend','https://example.com/share/private-path-marker?invite=private-query-marker#private-fragment-marker','revision-one','en-US-Chirp3-HD-Charon',1,'An article.','2026-11-01T00:00:00.000Z','2026-11-02T00:00:00.000Z',data.byteLength,612.5,key,object!.etag).run();
  const feedUrl = await token();
  const secret = new URL(feedUrl).searchParams.get('token')!;
  return { id, key, data, feedUrl, mediaUrl: `${origin}/api/podcast/episodes/${id}.mp3?token=${secret}` };
}

async function transcriptChunk(episodeId: string) {
  const key = `audio/chunks/${episodeId}/0.wav`;
  await bindings.AUDIO_BUCKET.put(key, 'audio chunk fixture');
  await bindings.DB.prepare(`INSERT INTO audio_chunks(episode_id,chunk_index,text,request_characters,state,object_key)
    VALUES(?,0,'Saved narration fixture.',24,'succeeded',?)`).bind(episodeId, key).run();
  return key;
}

beforeEach(async () => {
  send.mockClear();
  await bindings.DB.batch([
    bindings.DB.prepare('DELETE FROM audio_episodes'),
    bindings.DB.prepare('DELETE FROM articles'),
    bindings.DB.prepare('DELETE FROM audio_monthly_usage'),
    bindings.DB.prepare('DELETE FROM podcast_token'),
  ]);
});

describe('private podcast endpoints', () => {
  it('requires owner authentication and CSRF for settings, tokens, and audio generation', async () => {
    const owner: Env = { ...env, DEV_AUTH_BYPASS: undefined, APP_ORIGIN: 'https://service.example', GITHUB_CLIENT_ID: 'client', GITHUB_CLIENT_SECRET: 'secret', OWNER_GITHUB_ID: '123' };
    for (const path of ['/api/podcast/settings', '/api/articles/podcast1/audio']) {
      const response = await worker.fetch(new Request('https://service.example' + path), owner);
      expect(response.status).toBe(401);
    }
    const denied = await worker.fetch(new Request(origin + '/api/podcast/token', { method: 'POST', body: '{}' }), env);
    expect(denied.status).toBe(403);
    const capture = await worker.fetch(new Request('https://service.example/api/podcast/token', { method: 'POST', headers: { Authorization: 'Bearer rlcap_saveonly' }, body: '{}' }), owner);
    expect(capture.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it('shows the URL once, stores only a hash, and revokes both RSS and enclosure access on rotation', async () => {
    const episode = await published();
    const secret = new URL(episode.feedUrl).searchParams.get('token')!;
    const row = await bindings.DB.prepare('SELECT * FROM podcast_token').first();
    expect(row).toMatchObject({ token_hash: await digest(secret) });
    expect(JSON.stringify(row)).not.toContain(secret);
    const settings = await (await worker.fetch(request('/api/podcast/settings'), env)).json();
    expect(settings).toMatchObject({ readyEpisodes: 1, token: { createdAt: expect.any(String) } });
    expect(JSON.stringify(settings)).not.toContain(secret);
    const replacement = await token();
    expect((await worker.fetch(new Request(episode.feedUrl), env)).status).toBe(404);
    expect((await worker.fetch(new Request(episode.mediaUrl), env)).status).toBe(404);
    const feed = await worker.fetch(new Request(replacement), env);
    expect(feed.status).toBe(200);
    expect(await feed.text()).toContain(`urn:uuid:${episode.id}`);
    expect((await worker.fetch(request('/api/podcast/token', 'DELETE'), env)).status).toBe(204);
    expect((await worker.fetch(new Request(replacement), env)).status).toBe(404);
    expect(send).not.toHaveBeenCalled();
  });

  it('publishes valid escaped metadata and completed files with immutable identity', async () => {
    const episode = await published();
    await bindings.DB.prepare("INSERT INTO audio_episodes(id,article_id,title,url,copy_revision,voice,normalizer_version,narration_text,state,created_at) VALUES(?,NULL,'unfinished','https://example.com','x','voice',1,'text','generating',?)").bind(crypto.randomUUID(),'2026-11-03T00:00:00.000Z').run();
    const response = await worker.fetch(new Request(episode.feedUrl), env);
    const rss = await response.text();
    expect(response.headers.get('Content-Type')).toContain('application/rss+xml');
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(rss).toContain('<title>A &lt;title&gt; &amp; &quot;quotation&quot;</title>');
    expect(rss).toContain(`length="${episode.data.byteLength}" type="audio/mpeg"`);
    expect(rss).toContain('<itunes:duration>0:10:12</itunes:duration>');
    expect(rss).not.toContain('unfinished');
    expect(rss).not.toMatch(/private-(?:path|query|fragment)-marker/);
    expect(rss).toContain(`<link>${origin}/read/podcast1</link>`);
    expect(xml('before\u0000after\ud800')).toBe('beforeafter');
    const head = await worker.fetch(new Request(episode.feedUrl, { method: 'HEAD' }), env);
    expect(await head.text()).toBe('');
    expect(Number(head.headers.get('Content-Length'))).toBe(new TextEncoder().encode(rss).byteLength);
    expect(send).not.toHaveBeenCalled();
  });

  it('uses the hostname when a legacy episode title was derived from a private source link', async () => {
    const episode = await published();
    await bindings.DB.prepare("UPDATE audio_episodes SET title='example.com/share/private-path-marker' WHERE id=?")
      .bind(episode.id).run();
    await bindings.DB.prepare("UPDATE articles SET title='Renamed after narration' WHERE id='podcast1'").run();
    const response = await worker.fetch(new Request(episode.feedUrl), env);
    expect(response.status).toBe(200);
    const rss = await response.text();
    expect(rss).toContain('<title>example.com</title>');
    expect(rss).not.toMatch(/private-(?:path|query|fragment)-marker/);
  });

  it('serves native podcast HEAD and range probes without generation or read-state changes', async () => {
    const episode = await published();
    const head = await worker.fetch(new Request(episode.mediaUrl, { method: 'HEAD' }), env);
    expect(head.status).toBe(200);
    expect(head.headers.get('Content-Length')).toBe(String(episode.data.byteLength));
    expect(await head.text()).toBe('');
    const first = await worker.fetch(new Request(episode.mediaUrl, { headers: { Range: 'bytes=0-1' } }), env);
    expect(first.status).toBe(206);
    expect(first.headers.get('Content-Range')).toBe(`bytes 0-1/${episode.data.byteLength}`);
    expect(new TextDecoder().decode(await first.arrayBuffer())).toBe('ID');
    const suffix = await worker.fetch(new Request(episode.mediaUrl, { headers: { Range: 'bytes=-7' } }), env);
    expect(new TextDecoder().decode(await suffix.arrayBuffer())).toBe('fixture');
    const invalid = await worker.fetch(new Request(episode.mediaUrl, { headers: { Range: 'bytes=999999-' } }), env);
    expect(invalid.status).toBe(416);
    const full = await worker.fetch(new Request(episode.mediaUrl, { headers: { Range: 'bytes=0-1', 'If-Range': '"stale"' } }), env);
    expect(full.status).toBe(200);
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(episode.data);
    expect(await bindings.DB.prepare('SELECT read_at FROM articles WHERE id=?').bind('podcast1').first()).toEqual({ read_at: null });
    expect(send).not.toHaveBeenCalled();
  });

  it('fails safely when stored media no longer matches published length', async () => {
    const episode = await published();
    await bindings.AUDIO_BUCKET.put(episode.key, 'incomplete');
    for (const headers of [{}, { Range: 'bytes=0-1' }] as Record<string, string>[]) {
      expect((await worker.fetch(new Request(episode.mediaUrl, { headers }), env)).status).toBe(503);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps completed episodes, then deletes all audio and transcript data after article deletion', async () => {
    const episode = await published();
    const chunk = await transcriptChunk(episode.id);
    const ledger = { month: '2026-11', used_characters: 24, reserved_characters: 3, attempts: 2 };
    await bindings.DB.prepare('INSERT INTO audio_monthly_usage VALUES(?,?,?,?)').bind(...Object.values(ledger)).run();
    await worker.fetch(request('/api/articles/podcast1', 'DELETE'), env);
    expect((await worker.fetch(new Request(episode.mediaUrl), env)).status).toBe(404);
    expect(await (await worker.fetch(new Request(episode.feedUrl), env)).text()).not.toContain(`urn:uuid:${episode.id}`);
    // Simulate an older data remnant for which cleanup was marked complete.
    await bindings.DB.prepare('UPDATE audio_episodes SET cleanup_at=NULL WHERE id=?').bind(episode.id).run();
    await recoverAudioJobs({ ...env, ARTICLE_AUDIO_ENABLED: 'false' });
    expect(await bindings.AUDIO_BUCKET.head(episode.key)).toBeNull();
    expect(await bindings.AUDIO_BUCKET.head(chunk)).toBeNull();
    expect(await bindings.DB.prepare('SELECT id FROM audio_episodes').first()).toBeNull();
    expect(await bindings.DB.prepare('SELECT episode_id FROM audio_chunks').first()).toBeNull();
    expect(await bindings.DB.prepare('SELECT * FROM audio_monthly_usage').first()).toEqual(ledger);
  });

  it('retries failed object removal after deleting audio from a retained article', async () => {
    const episode = await published();
    const chunk = await transcriptChunk(episode.id);
    const failedBucket: R2Bucket = {
      ...bindings.AUDIO_BUCKET,
      async delete() { throw new Error('Temporary object storage failure'); },
    };
    const response = await worker.fetch(request('/api/articles/podcast1/audio', 'DELETE'), { ...env, AUDIO_BUCKET: failedBucket });
    expect(response.status).toBe(204);
    expect(await bindings.DB.prepare('SELECT state FROM audio_episodes WHERE id=?').bind(episode.id).first()).toEqual({ state: 'deleted' });
    expect(await bindings.DB.prepare('SELECT text FROM audio_chunks').first()).toEqual({ text: 'Saved narration fixture.' });
    expect((await worker.fetch(new Request(episode.mediaUrl), env)).status).toBe(404);
    await recoverAudioJobs(env);
    expect(await bindings.AUDIO_BUCKET.head(episode.key)).toBeNull();
    expect(await bindings.AUDIO_BUCKET.head(chunk)).toBeNull();
    expect(await bindings.DB.prepare('SELECT id FROM audio_episodes').first()).toBeNull();
    expect(await bindings.DB.prepare('SELECT episode_id FROM audio_chunks').first()).toBeNull();
    expect(await bindings.DB.prepare('SELECT markdown FROM article_copies').first()).not.toBeNull();
  });

  it('lists stored fit summaries and invalidates them when a copy revision changes', async () => {
    await article();
    const list = async () => {
      const response = await worker.fetch(request('/api/articles?status=all'), env);
      expect(response.status).toBe(200);
      return (await response.json() as { items: { podcastFit?: { tier: string } }[] }).items[0]?.podcastFit;
    };
    // Browsing an old copy does not analyze or backfill it.
    expect(await list()).toBeUndefined();
    expect(await bindings.DB.prepare('SELECT podcast_suitability FROM article_copies').first()).toEqual({ podcast_suitability: null });
    await recoverAudioJobs(env);
    expect(await list()).toMatchObject({ tier: 'poor' });
    await bindings.DB.prepare('UPDATE article_copies SET revision=?,markdown=? WHERE article_id=?')
      .bind('revision-two', 'A complete paragraph about the story. '.repeat(35), 'podcast1').run();
    expect(await list()).toBeUndefined();
    await recoverAudioJobs(env);
    expect(await list()).toMatchObject({ tier: 'good' });
  });

  it('does not start synthesis while browsing status, settings, RSS, or media', async () => {
    await article();
    const response = await worker.fetch(request('/api/articles/podcast1/audio'), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ audio: { state: 'none' } });
    const feedUrl = await token();
    expect((await worker.fetch(new Request(feedUrl), env)).status).toBe(200);
    expect(await bindings.DB.prepare('SELECT COUNT(*) AS n FROM audio_episodes').first()).toEqual({ n: 0 });
    expect(await bindings.DB.prepare('SELECT COUNT(*) AS n FROM audio_monthly_usage').first()).toEqual({ n: 0 });
    expect(send).not.toHaveBeenCalled();
  });
});
