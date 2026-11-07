import { env as bindings } from 'cloudflare:workers';
import { createMessageBatch } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { consumeAudioBatch, getAudioStatus, getAudioUsage, prepareAudio, recoverAudioJobs, type AudioEnv, type AudioMessage } from '../src/audio';

let credentials = '';
function wav(): Uint8Array {
  const bytes = new Uint8Array(48);
  const view = new DataView(bytes.buffer);
  const text = new TextEncoder();
  bytes.set(text.encode('RIFF'), 0); view.setUint32(4, 40, true);
  bytes.set(text.encode('WAVEfmt '), 8); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 24000, true);
  view.setUint32(28, 48000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  bytes.set(text.encode('data'), 36); view.setUint32(40, 4, true);
  return bytes;
}

function setup() {
  const messages: AudioMessage[] = [];
  const metrics = () => ({ backlogCount: messages.length, backlogBytes: 0 });
  const queue = {
    send: vi.fn(async (body: AudioMessage) => { messages.push(body); return { metadata: { metrics: metrics() } }; }),
    sendBatch: vi.fn(async (batch: Iterable<MessageSendRequest<AudioMessage>>) => { for (const { body } of batch) messages.push(body); return { metadata: { metrics: metrics() } }; }),
    metrics: vi.fn(async () => metrics()),
  } satisfies Queue<AudioMessage>;
  const assembler = vi.fn(async () => new Response(new TextEncoder().encode('ID3completed-fixture'), { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '20', 'X-Audio-Duration-Seconds': '600' } }));
  const env: AudioEnv = { DB: bindings.DB, AUDIO_BUCKET: bindings.AUDIO_BUCKET, AUDIO_QUEUE: queue, ARTICLE_EXTRACTOR: { fetch: assembler } as unknown as Fetcher,
    ARTICLE_AUDIO_ENABLED: 'true', AUDIO_FREE_CHARACTERS: '1000000', AUDIO_MONTHLY_BUDGET_USD: '10', GOOGLE_TTS_PROJECT_ID: 'fixture-project', GOOGLE_TTS_SERVICE_ACCOUNT_JSON: credentials };
  const provider = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'fixture-access-token' });
    if (url === 'https://texttospeech.googleapis.com/v1/text:synthesize') return Response.json({ audioContent: btoa(String.fromCharCode(...wav())) });
    throw new Error('Unexpected network request');
  });
  vi.stubGlobal('fetch', provider);
  const deliver = async (body: AudioMessage) => consumeAudioBatch(createMessageBatch('read-it-later-audio-test', [{ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body }]), env);
  const drain = async () => {
    for (let i = 0; messages.length && i < 30; i++) await deliver(messages.shift()!);
    expect(messages).toHaveLength(0);
  };
  return { env, messages, queue, provider, assembler, deliver, drain };
}
async function source(id: string, markdown: string) {
  const now = new Date().toISOString();
  await bindings.DB.batch([
    bindings.DB.prepare('INSERT INTO articles(id,url,normalized_url,title,created_at,updated_at) VALUES(?,?,?,?,?,?)').bind(id, `https://example.com/${id}`, `https://example.com/${id}`, 'Article', now, now),
    bindings.DB.prepare('INSERT INTO article_copies(article_id,markdown,captured_at,source,revision) VALUES(?,?,?,?,?)').bind(id, markdown, now, 'paste', 'revision-one'),
  ]);
}
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  credentials = JSON.stringify({ client_email: 'fixture@fixture-project.iam.gserviceaccount.com', private_key: `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----` });
});
beforeEach(async () => {
  await bindings.DB.batch([bindings.DB.prepare('DELETE FROM audio_episodes'), bindings.DB.prepare('DELETE FROM articles'), bindings.DB.prepare('DELETE FROM audio_monthly_usage')]);
});
afterEach(() => vi.unstubAllGlobals());

describe('durable narration pipeline', () => {
  it('deduplicates concurrent prepare, progresses multiple chunks, and reuses completed work on duplicate delivery', async () => {
    const s = setup();
    await source('audio001', 'This is a complete article sentence. '.repeat(180));
    const prepared = await Promise.all([prepareAudio(s.env, 'audio001', 'revision-one'), prepareAudio(s.env, 'audio001', 'revision-one')]);
    expect(prepared[0].episodeId).toBe(prepared[1].episodeId);
    const initial = s.messages[0];
    await s.drain();
    const ready = await getAudioStatus(s.env, 'audio001');
    expect(ready).toMatchObject({ state: 'ready', episodeId: prepared[0].episodeId });
    const count = await bindings.DB.prepare('SELECT COUNT(*) AS n FROM audio_chunks WHERE episode_id=?').bind(ready.episodeId).first<{ n: number }>();
    expect(count!.n).toBeGreaterThan(1);
    expect(s.provider.mock.calls.filter(([url]) => String(url).includes('text:synthesize'))).toHaveLength(count!.n);
    expect(s.assembler).toHaveBeenCalledTimes(1);
    await s.deliver(initial);
    expect(s.assembler).toHaveBeenCalledTimes(1);
    expect(s.provider.mock.calls.filter(([url]) => String(url).includes('text:synthesize'))).toHaveLength(count!.n);
    expect((await getAudioUsage(s.env)).reservedCharacters).toBe(0);
    expect(await bindings.DB.prepare('SELECT read_at FROM articles WHERE id=?').bind('audio001').first()).toEqual({ read_at: null });
  });

  it('atomically prevents concurrent episodes from exceeding the shared generation budget', async () => {
    const s = setup(); s.env.AUDIO_FREE_CHARACTERS = '100'; s.env.AUDIO_MONTHLY_BUDGET_USD = '0';
    await source('audio001', 'word '.repeat(9)); await source('audio002', 'word '.repeat(9));
    await prepareAudio(s.env, 'audio001', 'revision-one'); await prepareAudio(s.env, 'audio002', 'revision-one');
    const first = s.messages.shift()!; const second = s.messages.shift()!;
    await Promise.all([s.deliver(first), s.deliver(second)]);
    const statuses = await Promise.all([getAudioStatus(s.env, 'audio001'), getAudioStatus(s.env, 'audio002')]);
    expect(statuses.filter(value => value.state === 'ready')).toHaveLength(1);
    expect(statuses.filter(value => value.errorCode === 'budget_exceeded')).toHaveLength(1);
    const usage = await getAudioUsage(s.env);
    expect(usage.usedCharacters + usage.reservedCharacters).toBeLessThanOrEqual(100);
    expect(s.provider.mock.calls.filter(([url]) => String(url).includes('text:synthesize'))).toHaveLength(1);
    expect(await bindings.DB.prepare("SELECT COUNT(*) AS n FROM audio_chunks WHERE state='running'").first()).toEqual({ n: 0 });
  });

  it('retains uncertain request charges and never automatically regenerates after a timeout', async () => {
    const s = setup(); await source('audio001', 'An article with an uncertain speech request.');
    s.provider.mockImplementation(async input => {
      if (String(input).includes('oauth2.googleapis.com')) return Response.json({ access_token: 'token' });
      throw new DOMException('Timed out', 'TimeoutError');
    });
    await prepareAudio(s.env, 'audio001', 'revision-one');
    const message = s.messages.shift()!; await s.deliver(message);
    expect(await getAudioStatus(s.env, 'audio001')).toMatchObject({ state: 'failed', errorCode: 'provider_timeout_ambiguous' });
    expect((await getAudioUsage(s.env)).reservedCharacters).toBeGreaterThan(0);
    const calls = s.provider.mock.calls.length;
    await recoverAudioJobs(s.env); await s.deliver(message);
    expect(s.messages).toHaveLength(0);
    expect(s.provider.mock.calls).toHaveLength(calls);
  });

  it('accounts for successful synthesis even when writing its audio fails', async () => {
    const s = setup(); await source('audio001', 'Speech generation is billed even if our storage fails.');
    s.env.AUDIO_BUCKET = { put: async () => { throw new Error('storage offline'); } } as unknown as R2Bucket;
    await prepareAudio(s.env, 'audio001', 'revision-one');
    await s.deliver(s.messages.shift()!);
    expect((await getAudioUsage(s.env)).usedCharacters).toBeGreaterThan(0);
    expect(await getAudioStatus(s.env, 'audio001')).toMatchObject({ state: 'failed' });
    await recoverAudioJobs(s.env);
    expect(s.messages).toHaveLength(0);
  });

  it('keeps malformed successful provider responses in the spending estimate', async () => {
    const s = setup(); await source('audio001', 'A dispatched request can be billed despite invalid audio.');
    s.provider.mockImplementation(async input => String(input).includes('oauth2.googleapis.com')
      ? Response.json({ access_token: 'token' }) : Response.json({ audioContent: 'invalid base64!' }));
    await prepareAudio(s.env, 'audio001', 'revision-one');
    await s.deliver(s.messages.shift()!);
    expect((await getAudioUsage(s.env)).usedCharacters).toBeGreaterThan(0);
    expect(await getAudioStatus(s.env, 'audio001')).toMatchObject({ state: 'failed' });
  });

  it('retries assembly without regenerating speech and permits an explicit retry after the attempt limit', async () => {
    const s = setup(); await source('audio001', 'The complete audio chunks should survive assembly failures.');
    s.assembler.mockImplementation(async () => new Response(null, { status: 503 }));
    await prepareAudio(s.env, 'audio001', 'revision-one');
    const message = s.messages.shift()!;
    for (let i = 0; i < 3; i++) await s.deliver(message);
    expect(await getAudioStatus(s.env, 'audio001')).toMatchObject({ state: 'failed' });
    const speechCalls = s.provider.mock.calls.filter(([url]) => String(url).includes('text:synthesize')).length;
    expect(speechCalls).toBe(1);
    s.assembler.mockImplementation(async () => new Response(new TextEncoder().encode('ID3completed-fixture'), { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '20', 'X-Audio-Duration-Seconds': '600' } }));
    await prepareAudio(s.env, 'audio001', 'revision-one');
    await s.drain();
    expect(await getAudioStatus(s.env, 'audio001')).toMatchObject({ state: 'ready' });
    expect(s.provider.mock.calls.filter(([url]) => String(url).includes('text:synthesize'))).toHaveLength(speechCalls);
  });

  it('does not lose durable intent when the initial queue notification fails', async () => {
    const s = setup(); await source('audio001', 'Save generation intent before notifying the queue.');
    s.queue.send.mockRejectedValueOnce(new Error('queue temporarily offline'));
    const prepared = await prepareAudio(s.env, 'audio001', 'revision-one');
    expect(prepared.state).toBe('queued');
    expect(s.provider).not.toHaveBeenCalled();
    await recoverAudioJobs(s.env); await s.drain();
    expect(await getAudioStatus(s.env, 'audio001')).toMatchObject({ state: 'ready' });
  });

  it('does not synthesize after deletion or while generation is disabled', async () => {
    const s = setup(); await source('audio001', 'Queued work must respect deletion and the generation pause.');
    await prepareAudio(s.env, 'audio001', 'revision-one');
    const message = s.messages.shift()!;
    s.env.ARTICLE_AUDIO_ENABLED = 'false'; await s.deliver(message);
    expect(s.provider).not.toHaveBeenCalled();
    s.env.ARTICLE_AUDIO_ENABLED = 'true';
    await bindings.DB.prepare('DELETE FROM articles WHERE id=?').bind('audio001').run();
    await s.deliver(message); await recoverAudioJobs(s.env);
    expect(s.provider).not.toHaveBeenCalled();
  });

  it('replaces an unpublished failed snapshot after copy edits while keeping a finished episode pinned', async () => {
    const s = setup(); await source('audio001', 'The original saved copy.');
    const old = await prepareAudio(s.env, 'audio001', 'revision-one');
    await bindings.DB.prepare("UPDATE audio_episodes SET state='failed',error_code='tts_provider_error' WHERE id=?").bind(old.episodeId).run();
    await bindings.DB.prepare('UPDATE article_copies SET revision=?,markdown=? WHERE article_id=?').bind('revision-two', 'The edited saved copy has new prose.', 'audio001').run();
    const fresh = await prepareAudio(s.env, 'audio001', 'revision-two');
    expect(fresh.episodeId).not.toBe(old.episodeId);
    expect(fresh.sourceRevision).toBe('revision-two');
    await s.drain();
    expect(await getAudioStatus(s.env, 'audio001')).toMatchObject({ state: 'ready', episodeId: fresh.episodeId });
    await bindings.DB.prepare('UPDATE article_copies SET revision=?,markdown=? WHERE article_id=?').bind('revision-three', 'Another edit after publishing.', 'audio001').run();
    const retained = await prepareAudio(s.env, 'audio001', 'revision-three');
    expect(retained).toMatchObject({ state: 'ready', episodeId: fresh.episodeId, sourceRevision: 'revision-two' });
    expect(s.messages).toHaveLength(0);
  });

  it('retains the published MP3 if a later cleanup metadata operation fails', async () => {
    const s = setup(); await source('audio001', 'Publishing must commit before optional staging cleanup.');
    let cleanupFailed = false;
    s.env.DB = new Proxy(bindings.DB, { get(target, property) {
      if (property === 'prepare') return (sql: string) => {
        if (!cleanupFailed && sql.startsWith('DELETE FROM audio_object_cleanup') && sql.includes('audio_episodes')) {
          cleanupFailed = true;
          throw new Error('Temporary cleanup metadata outage after publication');
        }
        return target.prepare(sql);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const prepared = await prepareAudio(s.env, 'audio001', 'revision-one');
    await s.drain();
    expect(cleanupFailed).toBe(true);
    expect(await getAudioStatus(s.env, 'audio001')).toMatchObject({ state: 'ready' });
    const row = await bindings.DB.prepare('SELECT object_key FROM audio_episodes WHERE id=?').bind(prepared.episodeId).first<{ object_key: string }>();
    expect(await bindings.AUDIO_BUCKET.head(row!.object_key)).not.toBeNull();
  });
});
