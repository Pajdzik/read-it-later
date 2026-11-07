import { env as bindings } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chunkNarration, consumeAudioBatch, normalizeMarkdown, prepareAudio, recoverAudioJobs } from '../src/audio';
import type { Env } from '../src/contracts';
import type { AudioMessage } from '../src/audio';

describe('private article narration', () => {
  it('converts Markdown to narration, preserves row reading order, and omits executable HTML and code', () => {
    const text = normalizeMarkdown(`# Saved title\n\n## A useful section\n\nRead [the source](https://example.com) and see **important** facts.\n\n| left | right |\n| --- | --- |\n| one | two |\n\n<script>secret()</script>\n\n\`\`\`ts\nconst answer = 42;\n\`\`\``, 'Saved title', 'Ada');
    expect(text).toContain('Saved title\n\nBy Ada');
    expect(text).toContain('A useful section');
    expect(text).toContain('the source and see important facts.');
    expect(text).toContain('one, two');
    expect(text).toContain('Code block omitted. Read it in the saved article.');
    expect(text).not.toContain('const answer');
    expect(text).not.toContain('Heading:');
    expect(text).not.toContain('https://example.com');
    expect(text).not.toContain('secret()');
  });

  it('splits text on safe boundaries and caps each request by UTF-8 bytes', () => {
    const source = `${'A long sentence. '.repeat(400)} ${'長'.repeat(2000)}`;
    const chunks = chunkNarration(source);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(chunk => new TextEncoder().encode(chunk).byteLength <= 4500)).toBe(true);
    expect(chunks.join(' ')).toContain('長'.repeat(100));
  });
});

const send = vi.fn(async (_message: AudioMessage) => {});
const ttsEnv: Env = {
  ...bindings,
  ARTICLE_AUDIO_ENABLED: 'true',
  AUDIO_MONTHLY_BUDGET_USD: '10',
  AUDIO_FREE_CHARACTERS: '0',
  AUDIO_QUEUE: { send } as unknown as Queue<AudioMessage>,
  GOOGLE_TTS_PROJECT_ID: 'audio-test-project',
};
const testOrigin = 'https://example.com/article';

async function serviceAccount(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]), hash: 'SHA-256' }, true, ['sign','verify']);
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  let encoded = ''; for (const byte of der) encoded += String.fromCharCode(byte);
  return JSON.stringify({ client_email: 'audio-test@example.iam.gserviceaccount.com', private_key: `-----BEGIN PRIVATE KEY-----\n${btoa(encoded)}\n-----END PRIVATE KEY-----` });
}

async function seedCopy(text: string): Promise<{ articleId: string; revision: string }> {
  const articleId = `audio-${crypto.randomUUID()}`;
  const revision = `revision-${crypto.randomUUID()}`;
  const at = new Date().toISOString();
  await bindings.DB.prepare(`INSERT INTO articles(id,url,normalized_url,title,created_at,updated_at) VALUES(?,?,?,?,?,?)`).bind(articleId,testOrigin,testOrigin,`Audio ${articleId}`,at,at).run();
  await bindings.DB.prepare(`INSERT INTO article_copies(article_id,markdown,captured_at,source,revision) VALUES(?,?,?,?,?)`).bind(articleId,text,at,'paste',revision).run();
  return {articleId,revision};
}

function message(body: AudioMessage) {
  return { body, ack: vi.fn(), retry: vi.fn() };
}

function validWav(): Uint8Array {
  const bytes=new Uint8Array(46); const view=new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF'),0); view.setUint32(4,38,true); bytes.set(new TextEncoder().encode('WAVEfmt '),8); view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true); view.setUint32(24,24000,true); view.setUint32(28,48000,true); view.setUint16(32,2,true); view.setUint16(34,16,true); bytes.set(new TextEncoder().encode('data'),36); view.setUint32(40,2,true);
  return bytes;
}

function ttsFetch(options: { uncertain?: boolean } = {}) {
  const calls: string[] = [];
  vi.stubGlobal('fetch',vi.fn(async (input: RequestInfo | URL) => {
    const url=String(input); calls.push(url);
    if(url==='https://oauth2.googleapis.com/token')return Response.json({access_token:'test-token'});
    if(url==='https://texttospeech.googleapis.com/v1/text:synthesize'){
      if(options.uncertain)throw new Error('simulated network loss after dispatch');
      return Response.json({audioContent:btoa(String.fromCharCode(...validWav()))});
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
  return calls;
}

describe('audio chunk durability and billing', () => {
  beforeEach(async () => {
    send.mockClear();
    await bindings.DB.prepare('DELETE FROM audio_episodes').run();
    await bindings.DB.prepare('DELETE FROM articles').run();
    await bindings.DB.prepare('DELETE FROM audio_monthly_usage').run();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('publishes one chunk at a time, checkpoints each result, and does not rebill completed chunks', async () => {
    const source=await seedCopy('A'.repeat(4700));
    const calls=ttsFetch();
    const env:Env={...ttsEnv,GOOGLE_TTS_SERVICE_ACCOUNT_JSON:await serviceAccount(),ARTICLE_EXTRACTOR:{fetch:async()=>new Response(new Uint8Array([73,68,51]),{headers:{'content-type':'audio/mpeg','content-length':'3','x-audio-duration-seconds':'240'}})} as unknown as Fetcher};
    const status=await prepareAudio(env,source.articleId,source.revision);
    expect(status.state).toBe('queued'); expect(send).toHaveBeenCalledTimes(1);
    const first=send.mock.calls[0]![0];
    await consumeAudioBatch({messages:[message(first)]} as unknown as MessageBatch<unknown>,env);
    const checkpoint=await bindings.DB.prepare('SELECT state,object_key FROM audio_chunks WHERE episode_id=? AND chunk_index=0').bind(status.episodeId).first<Record<string,unknown>>();
    expect(checkpoint?.state).toBe('succeeded'); expect(String(checkpoint?.object_key)).toContain(`-${first.generation}-`);
    for(let cursor=1;cursor<send.mock.calls.length;cursor++)await consumeAudioBatch({messages:[message(send.mock.calls[cursor]![0])]} as unknown as MessageBatch<unknown>,env);
    const chunks=await bindings.DB.prepare('SELECT state,object_key FROM audio_chunks WHERE episode_id=? ORDER BY chunk_index').bind(status.episodeId).all<Record<string,unknown>>();
    expect(chunks.results?.length).toBeGreaterThanOrEqual(2);
    expect(chunks.results?.every(row=>row.state==='succeeded'&&row.object_key===null)).toBe(true);
    expect(calls.filter(url=>url.endsWith(':synthesize'))).toHaveLength(chunks.results?.length);
    expect(await bindings.DB.prepare('SELECT used_characters FROM audio_monthly_usage').first()).toMatchObject({used_characters:expect.any(Number)});
    expect((await bindings.DB.prepare('SELECT state FROM audio_episodes WHERE id=?').bind(status.episodeId).first<Record<string,unknown>>())?.state).toBe('ready');
  });

  it('keeps a submitted provider attempt billable when R2 storage fails', async () => {
    const source=await seedCopy('A sentence that should be synthesized and stored.');
    ttsFetch();
    const base=bindings.AUDIO_BUCKET;
    const bucket=new Proxy(base,{get(target,key){if(key==='put')return async()=>{throw new Error('simulated R2 failure');};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    const env:Env={...ttsEnv,AUDIO_BUCKET:bucket,GOOGLE_TTS_SERVICE_ACCOUNT_JSON:await serviceAccount(),ARTICLE_EXTRACTOR:{fetch:async()=>new Response('ID3',{headers:{'x-audio-duration-seconds':'1'}})} as unknown as Fetcher};
    const status=await prepareAudio(env,source.articleId,source.revision);
    await consumeAudioBatch({messages:[message(send.mock.calls[0]![0])]} as unknown as MessageBatch<unknown>,env);
    const chunk=await bindings.DB.prepare('SELECT state FROM audio_chunks WHERE episode_id=?').bind(status.episodeId).first();
    const usage=await bindings.DB.prepare('SELECT used_characters,reserved_characters FROM audio_monthly_usage').first();
    expect(chunk?.state).toBe('failed');
    expect(Number(usage?.used_characters)).toBeGreaterThan(0);
    expect(Number(usage?.reserved_characters)).toBe(0);
  });

  it('keeps ambiguous provider timeouts reserved and recovery does not retry them', async () => {
    const source=await seedCopy('A sentence with an ambiguous delivery outcome.');
    const calls=ttsFetch({uncertain:true});
    const env:Env={...ttsEnv,GOOGLE_TTS_SERVICE_ACCOUNT_JSON:await serviceAccount(),ARTICLE_EXTRACTOR:{fetch:async()=>new Response('ID3',{headers:{'x-audio-duration-seconds':'1'}})} as unknown as Fetcher};
    const status=await prepareAudio(env,source.articleId,source.revision);
    await consumeAudioBatch({messages:[message(send.mock.calls[0]![0])]} as unknown as MessageBatch<unknown>,env);
    expect(calls.filter(url=>url.endsWith(':synthesize'))).toHaveLength(1);
    expect((await bindings.DB.prepare('SELECT state FROM audio_chunks WHERE episode_id=?').bind(status.episodeId).first<Record<string,unknown>>())?.state).toBe('ambiguous');
    const usage=await bindings.DB.prepare('SELECT used_characters,reserved_characters FROM audio_monthly_usage').first();
    expect(usage).toMatchObject({used_characters:0,reserved_characters:expect.any(Number)});
    const prior=send.mock.calls.length;
    await recoverAudioJobs(env);
    expect(send).toHaveBeenCalledTimes(prior);
  });
});
