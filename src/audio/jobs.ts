import { AudioError, type AudioEnv, type AudioMessage, type AudioStatus, type PodcastSuitability } from './contracts';
import MarkdownIt from 'markdown-it';

const VOICE = 'en-US-Chirp3-HD-Charon';
const NORMALIZER_VERSION = 1;
const MAX_CHUNK_BYTES = 4500;
const AUDIO_MAX_BYTES = 16 * 1024 * 1024;
const LEASE_MS = 5 * 60_000;
const ASSEMBLY_LEASE_MS = 12 * 60_000;
const ASSEMBLY_MAX_BYTES = 512 * 1024 * 1024;
const RATE_PER_MILLION = 30;
const encoder = new TextEncoder();

function enabled(env: AudioEnv): boolean { return env.ARTICLE_AUDIO_ENABLED === 'true'; }
function uuid(): string { return crypto.randomUUID(); }
function nowIso(): string { return new Date().toISOString(); }
function monthPacific(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit' }).formatToParts(date);
  return `${parts.find(p => p.type === 'year')!.value}-${parts.find(p => p.type === 'month')!.value}`;
}
function integerSetting(value: string | undefined, fallback: number): number {
  const n = Number(value); return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}
function budget(env: AudioEnv): number {
  const n = Number(env.AUDIO_MONTHLY_BUDGET_USD ?? '10');
  return Number.isFinite(n) && n >= 0 ? n : 10;
}
function cost(chars: number): number { return chars * RATE_PER_MILLION / 1_000_000; }
async function notify(env:AudioEnv,message:AudioMessage):Promise<void>{try{await env.AUDIO_QUEUE?.send(message);}catch{/* D1 remains authoritative; recovery republishes queued work. */}}

type MarkdownAudioAnalysis = { narration: string; suitability: PodcastSuitability };

function analyzeMarkdown(markdown: string, title?: string, author?: string | null): MarkdownAudioAnalysis {
  // MarkdownIt's token stream preserves readable inline text and table cells while
  // dropping raw HTML (including script/style bodies) and link destinations.
  const safeMarkdown=markdown.replace(/<(script|style|iframe|object|svg|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'').replace(/<[^>]*>/g,'');
  const tokens = new MarkdownIt({ html: false, linkify: false, typographer: false }).parse(safeMarkdown.replace(/\r\n?/g,'\n'),{});
  const blocks: string[] = [];
  const proseBlocks: string[] = [];
  let current: string[] = [];
  let heading=false; let titleHeadingSkipped=false; let rowCells:string[]=[]; let codeBlocks=0; let codeCharacters=0;
  const flush = () => {
    const text=current.join('').replace(/[\t ]+/g,' ').trim();
    if(text && !(heading && !titleHeadingSkipped && title && text.toLocaleLowerCase()===title.trim().toLocaleLowerCase())) { blocks.push(text); proseBlocks.push(text); }
    if(text && heading && title && text.toLocaleLowerCase()===title.trim().toLocaleLowerCase())titleHeadingSkipped=true;
    current=[];
  };
  for (const token of tokens) {
    if (token.type === 'heading_open') { flush(); heading=true; }
    else if (token.type === 'heading_close') { flush(); heading=false; }
    else if (token.type === 'paragraph_open' || token.type === 'tr_open' || token.type === 'list_item_open') { flush(); if(token.type==='tr_open')rowCells=[]; }
    else if (token.type === 'paragraph_close' || token.type === 'list_item_close') flush();
    else if (token.type === 'td_open' || token.type === 'th_open') flush();
    else if (token.type === 'td_close' || token.type === 'th_close') { const cell=current.join('').replace(/[\t ]+/g,' ').trim(); if(cell)rowCells.push(cell); current=[]; }
    else if (token.type === 'tr_close') { flush(); if(rowCells.length) { const row=rowCells.join(', '); blocks.push(row); proseBlocks.push(row); } rowCells=[]; }
    else if (token.type === 'fence' || token.type === 'code_block') { flush(); codeBlocks++; codeCharacters += encoder.encode(token.content).byteLength; blocks.push('Code block omitted. Read it in the saved article.'); }
    else if (token.type === 'inline') {
      for (const child of token.children ?? []) {
        if (child.type === 'text' || child.type === 'code_inline' || child.type === 'html_inline') { if(child.type!=='html_inline') current.push(child.content); }
        else if (child.type === 'image') current.push(child.content || String(child.attrGet('alt') ?? ''));
        else if (child.type === 'softbreak' || child.type === 'hardbreak') current.push(' ');
      }
    }
  }
  flush();
  const intro=[title?.trim(),author?.trim() ? `By ${author.trim()}` : ''].filter(Boolean);
  const narration=[...intro,...blocks].join('\n\n').replace(/[\t ]+/g,' ').trim();
  const spokenText=proseBlocks.join('\n\n');
  const spokenWords=spokenText.split(/\s+/).filter(Boolean).length;
  const spokenCharacters=encoder.encode(spokenText).byteLength;
  const codeShare=codeCharacters+spokenCharacters ? codeCharacters/(codeCharacters+spokenCharacters) : 0;
  const codeSharePercent=Math.round(codeShare*100);
  const tier: PodcastSuitability['tier'] = spokenWords < 50 || (codeShare > 0.5 && spokenWords < 300)
    ? 'poor'
    : spokenWords >= 150 && codeShare <= 0.15 ? 'good' : 'mixed';
  const reason=tier === 'good'
    ? codeBlocks ? `Mostly prose; ${codeBlocks} code ${codeBlocks === 1 ? 'block is' : 'blocks are'} skipped in narration.` : 'Mostly prose with no code blocks.'
    : codeShare > 0.15 ? `Code makes up about ${codeSharePercent}% of the copy, and is skipped in narration.`
      : tier === 'poor' ? 'There is very little prose to narrate.' : 'This is a short narration.';
  return { narration, suitability: { tier, reason, spokenWords, codeBlocks, codeSharePercent } };
}

export function normalizeMarkdown(markdown: string, title?: string, author?: string | null): string {
  return analyzeMarkdown(markdown, title, author).narration;
}

export async function getPodcastFitStatuses(db: D1Database, articleIds: string[]): Promise<Map<string, PodcastSuitability>> {
  if (!articleIds.length) return new Map();
  const placeholders=articleIds.map(() => '?').join(',');
  const rows=await db.prepare(`SELECT c.article_id,c.markdown,a.title,a.author
    FROM article_copies c JOIN articles a ON a.id=c.article_id
    WHERE c.article_id IN (${placeholders})`).bind(...articleIds).all<Record<string,unknown>>();
  const result=new Map<string,PodcastSuitability>();
  for(const row of rows.results ?? []) {
    const analysis=analyzeMarkdown(String(row.markdown),String(row.title),row.author == null ? null : String(row.author));
    result.set(String(row.article_id),analysis.suitability);
  }
  return result;
}

export function chunkNarration(text: string, maxBytes = MAX_CHUNK_BYTES): string[] {
  if (maxBytes < 8) throw new Error('maxBytes must be at least 8');
  const pieces = text.split(/(?<=[.!?])\s+|\n\n+/u).map(s => s.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  const append = (piece: string) => {
    const candidate = current ? `${current} ${piece}` : piece;
    if (encoder.encode(candidate).byteLength <= maxBytes) { current = candidate; return; }
    let rest=piece;
    if(current){
      let prefix='';
      for(const char of piece){if(encoder.encode(`${current} ${prefix}${char}`).byteLength>maxBytes)break;prefix+=char;}
      if(prefix){chunks.push(`${current} ${prefix}`);rest=piece.slice(prefix.length);}else chunks.push(current);
    }
    current = '';
    let segment = '';
    for (const char of rest) {
      if (encoder.encode(segment + char).byteLength > maxBytes) { chunks.push(segment); segment = ''; }
      segment += char;
    }
    current = segment;
  };
  for (const piece of pieces) append(piece);
  if (current) chunks.push(current);
  return chunks;
}

function estimateSeconds(text: string): number { return Math.max(1, Math.ceil(text.trim().split(/\s+/).filter(Boolean).length / 2.5)); }

function status(row: Record<string, unknown> | null, env: AudioEnv, suitability: PodcastSuitability | null = null): AudioStatus {
  if (!row || row.state === 'deleted') return { enabled: enabled(env), state: 'none', episodeId: null, sourceRevision: null, characters: 0, estimatedDurationSeconds: 0, estimatedCostUsd: 0, errorCode: null, suitability };
  const state = String(row.state);
  return { enabled: enabled(env), state: (['queued','generating','ready','failed'].includes(state) ? state : 'none') as AudioStatus['state'], episodeId: String(row.id), sourceRevision: String(row.copy_revision), characters: Number(row.characters ?? encoder.encode(String(row.narration_text ?? '')).byteLength), estimatedDurationSeconds: Number(row.duration_seconds) || estimateSeconds(String(row.narration_text ?? '')), estimatedCostUsd: cost(Number(row.characters ?? encoder.encode(String(row.narration_text ?? '')).byteLength)), errorCode: row.error_code == null ? null : String(row.error_code), suitability };
}

export async function getAudioStatus(env: AudioEnv, articleId: string): Promise<AudioStatus> {
  const copy = await env.DB.prepare(`SELECT c.revision,c.markdown,a.title,a.author FROM article_copies c JOIN articles a ON a.id=c.article_id WHERE c.article_id=?`).bind(articleId).first<Record<string,unknown>>();
  const analysis = copy ? analyzeMarkdown(String(copy.markdown),String(copy.title),copy.author == null ? null : String(copy.author)) : null;
  const suitability = analysis?.suitability ?? null;
  const row = await env.DB.prepare(`SELECT e.*, (SELECT SUM(request_characters) FROM audio_chunks c WHERE c.episode_id=e.id) AS characters FROM audio_episodes e WHERE e.article_id=? AND e.state!='deleted'`).bind(articleId).first<Record<string, unknown>>();
  if (row) return status(row, env, suitability);
  if (!copy) return status(null,env,null);
  const narration = analysis!.narration;
  const characters = encoder.encode(narration).byteLength;
  return {enabled:enabled(env),state:'none',episodeId:null,sourceRevision:String(copy.revision),characters,estimatedDurationSeconds:estimateSeconds(narration),estimatedCostUsd:cost(characters),errorCode:null,suitability};
}

export async function prepareAudio(env: AudioEnv, articleId: string, expectedRevision: string): Promise<AudioStatus> {
  if (!enabled(env)) throw new AudioError(404, 'audio_disabled', 'Private article audio is unavailable.');
  if (!env.AUDIO_BUCKET || !env.AUDIO_QUEUE || !env.ARTICLE_EXTRACTOR) throw new AudioError(503,'audio_unavailable','Audio storage or processing is unavailable.');
  const existing = await env.DB.prepare(`SELECT e.*, (SELECT SUM(request_characters) FROM audio_chunks c WHERE c.episode_id=e.id) AS characters FROM audio_episodes e WHERE e.article_id=? AND e.state!='deleted'`).bind(articleId).first<Record<string, unknown>>();
  if (existing) {
    if (existing.state !== 'failed') return status(existing, env);
    const current=await env.DB.prepare(`SELECT revision FROM article_copies WHERE article_id=?`).bind(articleId).first<Record<string,unknown>>();
    if(!current||String(current.revision)!==expectedRevision)throw new AudioError(409,'revision_conflict','The saved copy changed. Refresh it before retrying audio.');
    if(String(existing.copy_revision)!==expectedRevision){
      // Failed snapshots may be replaced by a new revision. Finished episodes remain
      // pinned and idempotent, and provider-ambiguous chunks are never auto-replayed.
      await env.DB.prepare(`UPDATE audio_episodes SET state='deleted',generation=generation+1,lease_token=NULL,lease_expires_at=NULL,cleanup_at=? WHERE id=? AND state='failed'`).bind(nowIso(),String(existing.id)).run();
    }else{
      // Explicit prepare is the only retry path. Reuse succeeded chunk objects and
      // advance the generation for every remaining chunk, including ambiguous calls.
      const generation = Number(existing.generation) + 1;
      await env.DB.batch([
        env.DB.prepare(`UPDATE audio_episodes SET state='queued',generation=?,assembly_attempts=0,error_code=NULL,lease_token=NULL,lease_expires_at=NULL WHERE id=? AND state='failed'`).bind(generation,String(existing.id)),
        env.DB.prepare(`UPDATE audio_chunks SET state=CASE WHEN state='succeeded' THEN state ELSE 'queued' END,generation=?,error_code=NULL,lease_token=NULL,lease_expires_at=NULL WHERE episode_id=? AND changes()>0`).bind(generation,String(existing.id)),
      ]);
      const chunks = await env.DB.prepare(`SELECT chunk_index FROM audio_chunks WHERE episode_id=? AND state='queued' ORDER BY chunk_index`).bind(String(existing.id)).all<Record<string,unknown>>();
      const next=chunks.results?.[0] ?? await env.DB.prepare(`SELECT chunk_index FROM audio_chunks WHERE episode_id=? ORDER BY chunk_index LIMIT 1`).bind(String(existing.id)).first<Record<string,unknown>>();
      if (next) await notify(env,{version:1,episodeId:String(existing.id),chunkIndex:Number(next.chunk_index),generation});
      const retried = await env.DB.prepare(`SELECT e.*, (SELECT SUM(request_characters) FROM audio_chunks c WHERE c.episode_id=e.id) AS characters FROM audio_episodes e WHERE e.id=?`).bind(String(existing.id)).first<Record<string,unknown>>();
      return status(retried,env);
    }
  }
  const source = await env.DB.prepare(`SELECT a.title,a.author,a.url,c.markdown,c.revision FROM articles a JOIN article_copies c ON c.article_id=a.id WHERE a.id=?`).bind(articleId).first<Record<string, unknown>>();
  if (!source) throw new AudioError(404, 'copy_not_found', 'Save an article copy before preparing audio.');
  if (String(source.revision) !== expectedRevision) throw new AudioError(409, 'revision_conflict', 'The saved copy changed. Refresh it before preparing audio.');
  const narration = analyzeMarkdown(String(source.markdown),String(source.title),source.author == null ? null : String(source.author)).narration;
  if (!narration) throw new AudioError(422, 'empty_narration', 'The saved copy has no narratable text.');
  const chunks = chunkNarration(narration);
  const total = chunks.reduce((n, chunk) => n + encoder.encode(chunk).byteLength, 0);
  if (total > 1_000_000) throw new AudioError(413, 'article_too_long', 'This copy is too long to prepare as one audio episode.');
  const id = uuid(); const created = nowIso();
  const statements: D1PreparedStatement[] = [env.DB.prepare(`INSERT INTO audio_episodes(id,article_id,title,author,url,copy_revision,voice,normalizer_version,narration_text,state,created_at) SELECT ?,a.id,a.title,a.author,a.url,?, ?, ?, ?, 'queued', ? FROM articles a JOIN article_copies c ON c.article_id=a.id WHERE a.id=? AND c.revision=? AND NOT EXISTS(SELECT 1 FROM audio_episodes e WHERE e.article_id=a.id AND e.state!='deleted')`).bind(id, expectedRevision, VOICE, NORMALIZER_VERSION, narration, created, articleId, expectedRevision)];
  chunks.forEach((text, index) => statements.push(env.DB.prepare(`INSERT INTO audio_chunks(episode_id,chunk_index,text,request_characters,state) SELECT ?,?,?,?,'queued' WHERE EXISTS(SELECT 1 FROM audio_episodes WHERE id=?)`).bind(id, index, text, encoder.encode(text).byteLength, id)));
  await env.DB.batch(statements);
  const row = await env.DB.prepare(`SELECT e.*, (SELECT SUM(request_characters) FROM audio_chunks c WHERE c.episode_id=e.id) AS characters FROM audio_episodes e WHERE e.article_id=? AND e.state!='deleted'`).bind(articleId).first<Record<string, unknown>>();
  if (!row) throw new AudioError(409, 'revision_conflict', 'The saved copy changed. Refresh it before preparing audio.');
  if (chunks.length) await notify(env,{ version: 1, episodeId: String(row.id), chunkIndex: 0, generation: Number(row.generation) || 1 });
  return status(row, env);
}

export async function removeAudio(env: AudioEnv, articleId: string): Promise<void> {
  const now = nowIso();
  const rows = await env.DB.prepare(`SELECT id,object_key FROM audio_episodes WHERE article_id=? AND state!='deleted'`).bind(articleId).all<Record<string, unknown>>();
  await env.DB.prepare(`UPDATE audio_episodes SET state='deleted',generation=generation+1,lease_token=NULL,lease_expires_at=NULL,cleanup_at=? WHERE article_id=? AND state!='deleted'`).bind(now, articleId).run();
  for (const row of rows.results ?? []) {
    if (env.AUDIO_BUCKET && row.object_key) { try { await env.AUDIO_BUCKET.delete(String(row.object_key)); } catch { /* durable cleanup retries */ } }
    const chunks = await env.DB.prepare('SELECT object_key FROM audio_chunks WHERE episode_id=? AND object_key IS NOT NULL').bind(String(row.id)).all<Record<string, unknown>>();
    for (const chunk of chunks.results ?? []) if (env.AUDIO_BUCKET) { try { await env.AUDIO_BUCKET.delete(String(chunk.object_key)); } catch { /* durable cleanup retries */ } }
  }
}

export async function getAudioUsage(env: AudioEnv): Promise<{ month: string; usedCharacters: number; reservedCharacters: number; freeCharacters: number; budgetUsd: number; estimatedCostUsd: number }> {
  const month = monthPacific(); const row = await env.DB.prepare('SELECT used_characters,reserved_characters FROM audio_monthly_usage WHERE month=?').bind(month).first<Record<string, unknown>>();
  const usedCharacters=Number(row?.used_characters ?? 0); const reservedCharacters=Number(row?.reserved_characters ?? 0); const freeCharacters=integerSetting(env.AUDIO_FREE_CHARACTERS, 0);
  return { month, usedCharacters, reservedCharacters, freeCharacters, budgetUsd: budget(env), estimatedCostUsd: cost(Math.max(0,usedCharacters+reservedCharacters-freeCharacters)) };
}

function base64Url(data: Uint8Array): string { let s = ''; for (const b of data) s += String.fromCharCode(b); return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
async function boundedText(response: Response, maximum: number): Promise<string> {
  if (!response.body) throw new Error('body_missing');
  const reader=response.body.getReader(); const parts:Uint8Array[]=[]; let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maximum){await reader.cancel();throw new Error('response_too_large');}parts.push(value);}
  const joined=new Uint8Array(size);let offset=0;for(const part of parts){joined.set(part,offset);offset+=part.byteLength;}
  return new TextDecoder('utf-8',{fatal:true}).decode(joined);
}
async function accessToken(env: AudioEnv): Promise<string> {
  if (!env.GOOGLE_TTS_SERVICE_ACCOUNT_JSON || !env.GOOGLE_TTS_PROJECT_ID) throw new AudioError(500, 'tts_not_configured', 'Audio speech service is not configured.');
  const account = JSON.parse(env.GOOGLE_TTS_SERVICE_ACCOUNT_JSON) as { client_email?: string; private_key?: string; token_uri?: string };
  if (!account.client_email || !account.private_key) throw new AudioError(500, 'tts_not_configured', 'Audio speech service credentials are invalid.');
  const toBytes = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const pem = account.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  const key = await crypto.subtle.importKey('pkcs8', toBytes(pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const now = Math.floor(Date.now()/1000); const header = base64Url(encoder.encode(JSON.stringify({alg:'RS256',typ:'JWT'})));
  const tokenUri='https://oauth2.googleapis.com/token';
  const claim = base64Url(encoder.encode(JSON.stringify({iss:account.client_email,scope:'https://www.googleapis.com/auth/cloud-platform',aud:tokenUri,iat:now,exp:now+3600})));
  const unsigned = `${header}.${claim}`; const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(unsigned)));
  let response:Response;
  try { response = await fetch(tokenUri, { method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'}, body:`grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${unsigned}.${base64Url(sig)}`,signal:AbortSignal.timeout(15_000) }); }
  catch { throw new AudioError(502,'tts_auth_failed','Audio speech service authentication failed.'); }
  if (!response.ok) throw new AudioError(502, 'tts_auth_failed', 'Audio speech service authentication failed.');
  let body:{access_token?:string};
  try { body=JSON.parse(await boundedText(response,64*1024)) as {access_token?:string}; }
  catch { throw new AudioError(502,'tts_auth_failed','Audio speech service authentication failed.'); }
  if (!body.access_token) throw new AudioError(502, 'tts_auth_failed', 'Audio speech service did not return an access token.');
  return body.access_token;
}

async function synthesize(env: AudioEnv, text: string, onSubmitted: () => void): Promise<Uint8Array> {
  const token = await accessToken(env);
  // Every outcome after dispatch may be billed, including malformed provider
  // responses that fail before synthesize can return valid WAV bytes.
  onSubmitted();
  let response: Response;
  try { response = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', { method:'POST', headers:{authorization:`Bearer ${token}`,'x-goog-user-project':env.GOOGLE_TTS_PROJECT_ID!,'content-type':'application/json'}, body:JSON.stringify({input:{text},voice:{languageCode:'en-US',name:VOICE},audioConfig:{audioEncoding:'LINEAR16',sampleRateHertz:24000, speakingRate:1.0}}), signal:AbortSignal.timeout(90_000) }); }
  catch { const error=new AudioError(502, 'provider_timeout_ambiguous', 'Speech request outcome is uncertain and will not be retried automatically.'); error.submitted=true; throw error; }
  if (!response.ok) { const error=new AudioError(response.status >= 500 ? 502 : 422, 'tts_provider_error', 'Audio speech service rejected the request.'); error.submitted=true; throw error; }
  let json: string;
  try { const length=Number(response.headers.get('content-length')??0); if(length>24*1024*1024) throw new Error('response_too_large'); json=await boundedText(response,24*1024*1024); }
  catch { const error=new AudioError(502, 'provider_timeout_ambiguous', 'Speech response was interrupted and will not be retried automatically.'); error.submitted=true; throw error; }
  let body: { audioContent?: string };
  try { body = JSON.parse(json) as { audioContent?: string }; }
  catch { const error=new AudioError(502, 'provider_timeout_ambiguous', 'Speech response was incomplete and will not be retried automatically.'); error.submitted=true; throw error; }
  if (typeof body.audioContent !== 'string') { const error=new AudioError(502, 'tts_response_invalid', 'Audio speech service returned an invalid response.'); error.submitted=true; throw error; }
  if(body.audioContent.length>Math.ceil(AUDIO_MAX_BYTES*4/3)+8) { const error=new AudioError(502, 'tts_response_too_large', 'Audio speech response exceeded its size limit.'); error.submitted=true; throw error; }
  const decoded = atob(body.audioContent);
  if (decoded.length < 44 || decoded.length > AUDIO_MAX_BYTES) { const error=new AudioError(502, 'tts_response_too_large', 'Audio speech response exceeded its size limit.'); error.submitted=true; throw error; }
  const bytes = Uint8Array.from(decoded, c => c.charCodeAt(0));
  if (String.fromCharCode(...bytes.slice(0,4)) !== 'RIFF' || String.fromCharCode(...bytes.slice(8,12)) !== 'WAVE') { const error=new AudioError(502, 'tts_response_invalid', 'Audio speech service did not return WAV audio.'); error.submitted=true; throw error; }
  const header = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if (header.getUint16(22,true) !== 1 || header.getUint32(24,true) !== 24000 || header.getUint16(34,true) !== 16) { const error=new AudioError(502, 'tts_response_invalid', 'Audio speech service returned WAV with unexpected audio settings.'); error.submitted=true; throw error; }
  return bytes;
}

async function runChunk(env: AudioEnv, message: AudioMessage): Promise<void> {
  if (!enabled(env)) return;
  if (!env.AUDIO_BUCKET) throw new Error('audio_bucket_missing');
  const row = await env.DB.prepare(`SELECT c.*,e.generation AS episode_generation,e.state AS episode_state,e.lease_token AS episode_lease FROM audio_chunks c JOIN audio_episodes e ON e.id=c.episode_id WHERE c.episode_id=? AND c.chunk_index=?`).bind(message.episodeId,message.chunkIndex).first<Record<string, unknown>>();
  if (!row || row.episode_state === 'deleted' || Number(row.generation) !== message.generation || row.state === 'ambiguous') return;
  if (row.state === 'succeeded') {
    await maybeAssemble(env,message.episodeId,Number(row.episode_generation));
    return;
  }
  const month = monthPacific(); const free = integerSetting(env.AUDIO_FREE_CHARACTERS,0); const cap = free + Math.floor(budget(env) * 1_000_000 / RATE_PER_MILLION);
  const token = uuid(); const expiry = new Date(Date.now()+LEASE_MS).toISOString(); const now = nowIso(); const amount = Number(row.request_characters);
  const reservation = env.DB.prepare(`INSERT INTO audio_monthly_usage(month,used_characters,reserved_characters,attempts) VALUES(?,0,0,0) ON CONFLICT(month) DO NOTHING`).bind(month);
  const claimEpisode = env.DB.prepare(`UPDATE audio_episodes SET state='generating',error_code=NULL WHERE id=? AND generation=? AND state IN ('queued','generating')`).bind(message.episodeId,Number(row.episode_generation));
  const claim = env.DB.prepare(`UPDATE audio_chunks SET state='running',lease_token=?,lease_expires_at=?,reserved_month=?,error_code=NULL WHERE episode_id=? AND chunk_index=? AND generation=? AND state IN ('queued','failed') AND EXISTS(SELECT 1 FROM audio_episodes WHERE id=? AND generation=? AND state='generating')`).bind(token,expiry,month,message.episodeId,message.chunkIndex,message.generation,message.episodeId,Number(row.episode_generation));
  const reserve = env.DB.prepare(`UPDATE audio_monthly_usage SET reserved_characters=reserved_characters+?,attempts=attempts+1 WHERE month=? AND used_characters+reserved_characters+?<=? AND EXISTS(SELECT 1 FROM audio_chunks WHERE episode_id=? AND chunk_index=? AND state='running' AND lease_token=? AND generation=?)`).bind(amount,month,amount,cap,message.episodeId,message.chunkIndex,token,message.generation);
  const results = await env.DB.batch([reservation,claimEpisode,claim,reserve]);
  if ((results[1].meta.changes ?? 0) === 0 || (results[2].meta.changes ?? 0) === 0) return;
  if ((results[3].meta.changes ?? 0) === 0) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE audio_chunks SET state='queued',lease_token=NULL,lease_expires_at=NULL WHERE episode_id=? AND chunk_index=? AND lease_token=?`).bind(message.episodeId,message.chunkIndex,token),
      env.DB.prepare(`UPDATE audio_episodes SET state='failed',error_code='budget_exceeded',lease_token=NULL,lease_expires_at=NULL WHERE id=? AND generation=?`).bind(message.episodeId,Number(row.episode_generation)),
    ]);
    throw new AudioError(429,'budget_exceeded','Monthly audio budget has been reached.');
  }
  let providerSubmitted = false;
  let accounted = false;
  let checkpointed = false;
  let checkpointing = false;
  try {
    // OAuth exchange happens before synthesize dispatch. Once the TTS POST begins,
    // conservatively retain the reservation unless the request is certainly rejected.
    const wav = await synthesize(env,String(row.text), () => { providerSubmitted = true; });
    await env.DB.prepare(`UPDATE audio_monthly_usage SET used_characters=used_characters+?,reserved_characters=MAX(0,reserved_characters-?) WHERE month=?`).bind(amount,amount,month).run();
    accounted = true;
    const key = `audio/chunks/${message.episodeId}/${message.chunkIndex}-${message.generation}-${token}.wav`;
    await env.DB.prepare(`INSERT OR IGNORE INTO audio_object_cleanup(object_key,created_at) VALUES(?,?)`).bind(key,nowIso()).run();
    await env.AUDIO_BUCKET.put(key,wav,{httpMetadata:{contentType:'audio/wav'},customMetadata:{episodeId:message.episodeId,chunkIndex:String(message.chunkIndex)}});
    checkpointing=true;
    const saved = await env.DB.prepare(`UPDATE audio_chunks SET state='succeeded',object_key=?,bytes=?,lease_token=NULL,lease_expires_at=NULL WHERE episode_id=? AND chunk_index=? AND generation=? AND lease_token=? AND EXISTS(SELECT 1 FROM audio_episodes WHERE id=? AND generation=? AND state!='deleted')`).bind(key,wav.byteLength,message.episodeId,message.chunkIndex,message.generation,token,message.episodeId,Number(row.episode_generation)).run();
    checkpointing=false;
    if ((saved.meta.changes ?? 0) === 0) { await env.AUDIO_BUCKET.delete(key); await env.DB.prepare(`DELETE FROM audio_object_cleanup WHERE object_key=?`).bind(key).run(); }
    else { checkpointed=true; try { await env.DB.prepare(`DELETE FROM audio_object_cleanup WHERE object_key=? AND EXISTS(SELECT 1 FROM audio_chunks WHERE object_key=? AND state='succeeded')`).bind(key,key).run(); } catch { /* recovery ignores cleanup entries that remain referenced */ } }
    if ((saved.meta.changes ?? 0) > 0) {
      const next=await env.DB.prepare(`SELECT chunk_index FROM audio_chunks WHERE episode_id=? AND state='queued' ORDER BY chunk_index LIMIT 1`).bind(message.episodeId).first<Record<string,unknown>>();
      if(next) { try { await env.AUDIO_QUEUE?.send({version:1,episodeId:message.episodeId,chunkIndex:Number(next.chunk_index),generation:message.generation}); } catch { /* recovery republishes durable queued work */ } }
    }
  } catch (error) {
    if(checkpointed)return;
    if(checkpointing)return;
    const submitted = providerSubmitted || (error instanceof AudioError && error.submitted);
    const ambiguous = error instanceof AudioError && error.code === 'provider_timeout_ambiguous';
    if (submitted && !ambiguous && !accounted) await env.DB.prepare(`UPDATE audio_monthly_usage SET used_characters=used_characters+?,reserved_characters=MAX(0,reserved_characters-?) WHERE month=?`).bind(amount,amount,month).run();
    else if (!submitted) await env.DB.prepare(`UPDATE audio_monthly_usage SET reserved_characters=MAX(0,reserved_characters-?) WHERE month=?`).bind(amount,month).run();
    await env.DB.prepare(`UPDATE audio_chunks SET state=?,error_code=?,lease_token=NULL,lease_expires_at=NULL WHERE episode_id=? AND chunk_index=? AND lease_token=?`).bind(ambiguous?'ambiguous':'failed',error instanceof AudioError?error.code:'tts_provider_error',message.episodeId,message.chunkIndex,token).run();
    await env.DB.prepare(`UPDATE audio_episodes SET state='failed',error_code=?,lease_token=NULL,lease_expires_at=NULL WHERE id=? AND generation=? AND state!='deleted'`).bind(error instanceof AudioError?error.code:'tts_provider_error',message.episodeId,Number(row.episode_generation)).run();
    if (ambiguous) return;
    throw error;
  }
  await maybeAssemble(env,message.episodeId,Number(row.episode_generation));
}

async function maybeAssemble(env: AudioEnv, episodeId: string, generation: number): Promise<void> {
  const pending = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audio_chunks WHERE episode_id=? AND state!='succeeded'`).bind(episodeId).first<Record<string, unknown>>();
  if (Number(pending?.n) !== 0) return;
  if (!env.ARTICLE_EXTRACTOR) throw new AudioError(502,'assembler_unavailable','Audio assembly service is unavailable.');
  const lease = uuid();
  const leaseUntil = new Date(Date.now()+ASSEMBLY_LEASE_MS).toISOString();
  const claimed = await env.DB.prepare(`UPDATE audio_episodes SET state='generating',lease_token=?,lease_expires_at=?,assembly_attempts=assembly_attempts+1 WHERE id=? AND generation=? AND state IN ('queued','generating') AND assembly_attempts<3 AND (lease_token IS NULL OR lease_expires_at<?)`).bind(lease,leaseUntil,episodeId,generation,nowIso()).run();
  if ((claimed.meta.changes ?? 0) === 0) return;
  const key = `audio/episodes/${episodeId}/${generation}-${lease}.mp3`;
  let published=false;
  let finalizing=false;
  try {
    const chunks = await env.DB.prepare(`SELECT object_key FROM audio_chunks WHERE episode_id=? ORDER BY chunk_index`).bind(episodeId).all<Record<string, unknown>>();
    const response = await env.ARTICLE_EXTRACTOR.fetch(new Request('https://capture/assemble-audio',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({version:1,episodeId,chunkKeys:(chunks.results??[]).map(r=>String(r.object_key))}),signal:AbortSignal.timeout(10*60_000)}));
    if (!response.ok || !response.body) throw new AudioError(502,'assembly_failed','Audio assembly failed.');
    const length = Number(response.headers.get('content-length') ?? 0);
    if (!Number.isSafeInteger(length) || length <= 0 || length > ASSEMBLY_MAX_BYTES) throw new AudioError(502,'assembly_too_large','Assembled audio exceeded its size limit or omitted its length.');
    const duration = Number(response.headers.get('x-audio-duration-seconds'));
    if (!Number.isFinite(duration) || duration <= 0) throw new AudioError(502,'assembly_invalid','Audio assembly returned invalid duration metadata.');
    const fixed=new FixedLengthStream(length);
    await env.DB.prepare(`INSERT OR IGNORE INTO audio_object_cleanup(object_key,created_at) VALUES(?,?)`).bind(key,nowIso()).run();
    const [object]=await Promise.all([
      env.AUDIO_BUCKET!.put(key,fixed.readable,{httpMetadata:{contentType:'audio/mpeg'}}),
      response.body.pipeTo(fixed.writable),
    ]);
    const head = await env.AUDIO_BUCKET!.head(key);
    if (!head || head.size <= 0 || head.size > ASSEMBLY_MAX_BYTES) { await env.AUDIO_BUCKET!.delete(key); throw new AudioError(502,'assembly_invalid','Assembled audio has invalid size.'); }
    const checksum = object?.etag ?? head.etag;
    finalizing=true;
    const saved=await env.DB.prepare(`UPDATE audio_episodes SET state='ready',ready_at=?,bytes=?,duration_seconds=?,object_key=?,checksum=?,error_code=NULL,lease_token=NULL,lease_expires_at=NULL WHERE id=? AND generation=? AND lease_token=? AND state='generating'`).bind(nowIso(),head.size,duration,key,checksum,episodeId,generation,lease).run();
    finalizing=false;
    if((saved.meta.changes??0)===0){await env.AUDIO_BUCKET!.delete(key);await env.DB.prepare(`DELETE FROM audio_object_cleanup WHERE object_key=?`).bind(key).run();}
    else {
      published=true;
      await env.DB.prepare(`DELETE FROM audio_object_cleanup WHERE object_key=? AND EXISTS(SELECT 1 FROM audio_episodes WHERE object_key=? AND state='ready')`).bind(key,key).run();
      await cleanupReadyChunks(env,episodeId);
    }
  } catch (error) {
    if(published||finalizing)return;
    await env.DB.prepare(`UPDATE audio_episodes SET state=CASE WHEN assembly_attempts>=3 THEN 'failed' ELSE 'generating' END,error_code='assembly_retry',lease_token=NULL,lease_expires_at=NULL WHERE id=? AND generation=? AND lease_token=? AND state='generating'`).bind(episodeId,generation,lease).run();
    throw error;
  }
}

async function cleanupReadyChunks(env:AudioEnv,episodeId:string):Promise<void>{
  if(!env.AUDIO_BUCKET)return;
  const chunks=await env.DB.prepare(`SELECT chunk_index,object_key FROM audio_chunks WHERE episode_id=? AND state='succeeded' AND object_key IS NOT NULL`).bind(episodeId).all<Record<string,unknown>>();
  for(const chunk of chunks.results??[]){
    const key=String(chunk.object_key);
    try{await env.AUDIO_BUCKET.delete(key);await env.DB.prepare(`UPDATE audio_chunks SET object_key=NULL,bytes=0 WHERE episode_id=? AND chunk_index=? AND state='succeeded' AND object_key=?`).bind(episodeId,Number(chunk.chunk_index),key).run();}
    catch{/* recovery will retry while the object key remains checkpointed */}
  }
}

function validAudioMessage(value: unknown): value is AudioMessage {
  if(!value||typeof value!=='object'||Array.isArray(value)) return false;
  const v=value as Record<string,unknown>;
  return v.version===1&&typeof v.episodeId==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v.episodeId)
    &&Number.isSafeInteger(v.chunkIndex)&&Number(v.chunkIndex)>=0&&Number.isSafeInteger(v.generation)&&Number(v.generation)>0
    &&Object.keys(v).every(k=>['version','episodeId','chunkIndex','generation'].includes(k));
}

export async function consumeAudioBatch(batch: MessageBatch<unknown>, env: AudioEnv): Promise<void> {
  for (const message of batch.messages) {
    const body = message.body;
    if (!validAudioMessage(body)) { message.ack(); continue; }
    try { await runChunk(env,body); message.ack(); }
    catch (error) {
      const pending = await env.DB.prepare(`SELECT c.state,e.state AS episode_state FROM audio_chunks c JOIN audio_episodes e ON e.id=c.episode_id WHERE c.episode_id=? AND c.chunk_index=?`).bind(body.episodeId,body.chunkIndex).first<Record<string,unknown>>();
      if (pending?.state === 'failed' || pending?.state === 'ambiguous' || (error instanceof AudioError && error.code === 'budget_exceeded')) { message.ack(); continue; }
      message.retry({delaySeconds:60});
    }
  }
}

export async function recoverAudioJobs(env: AudioEnv): Promise<void> {
  const now = nowIso();
  await env.DB.prepare(`UPDATE audio_chunks SET state='ambiguous',lease_token=NULL,lease_expires_at=NULL,error_code='provider_outcome_unknown' WHERE state='running' AND lease_expires_at<?`).bind(now).run();
  await env.DB.prepare(`UPDATE audio_episodes SET state='failed',lease_token=NULL,lease_expires_at=NULL,error_code='provider_outcome_unknown' WHERE state='generating' AND EXISTS(SELECT 1 FROM audio_chunks c WHERE c.episode_id=audio_episodes.id AND c.state='ambiguous')`).run();
  await env.DB.prepare(`UPDATE audio_episodes SET state=CASE WHEN assembly_attempts>=3 THEN 'failed' ELSE 'generating' END,lease_token=NULL,lease_expires_at=NULL,error_code='assembly_retry' WHERE state='generating' AND lease_expires_at<? AND NOT EXISTS(SELECT 1 FROM audio_chunks c WHERE c.episode_id=audio_episodes.id AND c.state!='succeeded')`).bind(now).run();
  if(env.AUDIO_BUCKET){
  const orphanCutoff=new Date(Date.now()-60*60_000).toISOString();
  const orphaned=await env.DB.prepare(`SELECT object_key FROM audio_object_cleanup WHERE created_at<? AND NOT EXISTS(SELECT 1 FROM audio_chunks WHERE object_key=audio_object_cleanup.object_key) AND NOT EXISTS(SELECT 1 FROM audio_episodes WHERE object_key=audio_object_cleanup.object_key) ORDER BY created_at LIMIT 100`).bind(orphanCutoff).all<Record<string,unknown>>();
    for(const item of orphaned.results??[]){const key=String(item.object_key);try{await env.AUDIO_BUCKET.delete(key);await env.DB.prepare(`DELETE FROM audio_object_cleanup WHERE object_key=? AND NOT EXISTS(SELECT 1 FROM audio_chunks WHERE object_key=?) AND NOT EXISTS(SELECT 1 FROM audio_episodes WHERE object_key=?)`).bind(key,key,key).run();}catch{/* retain for the next pass */}}
    const expired=await env.DB.prepare(`SELECT id,object_key FROM audio_episodes WHERE state='deleted' AND cleanup_at IS NOT NULL AND cleanup_at<=? LIMIT 25`).bind(now).all<Record<string,unknown>>();
    for(const episode of expired.results??[]){
      const chunks=await env.DB.prepare(`SELECT object_key FROM audio_chunks WHERE episode_id=? AND object_key IS NOT NULL`).bind(String(episode.id)).all<Record<string,unknown>>();
      try{if(episode.object_key)await env.AUDIO_BUCKET.delete(String(episode.object_key));for(const chunk of chunks.results??[])await env.AUDIO_BUCKET.delete(String(chunk.object_key));await env.DB.prepare(`UPDATE audio_episodes SET cleanup_at=NULL WHERE id=? AND state='deleted'`).bind(String(episode.id)).run();}catch{/* retry on a later recovery pass */}
    }
    const ready=await env.DB.prepare(`SELECT c.episode_id,c.chunk_index,c.object_key FROM audio_chunks c JOIN audio_episodes e ON e.id=c.episode_id WHERE e.state='ready' AND c.state='succeeded' AND c.object_key IS NOT NULL LIMIT 100`).all<Record<string,unknown>>();
    for(const chunk of ready.results??[]){const key=String(chunk.object_key);try{await env.AUDIO_BUCKET.delete(key);await env.DB.prepare(`UPDATE audio_chunks SET object_key=NULL,bytes=0 WHERE episode_id=? AND chunk_index=? AND object_key=?`).bind(String(chunk.episode_id),Number(chunk.chunk_index),key).run();}catch{/* retain checkpoint for another pass */}}
  }
  if(!enabled(env)||!env.AUDIO_QUEUE)return;
  const rows = await env.DB.prepare(`SELECT c.episode_id,c.chunk_index,c.generation FROM audio_chunks c JOIN audio_episodes e ON e.id=c.episode_id WHERE c.state='queued' AND e.state IN ('queued','generating') AND NOT EXISTS(SELECT 1 FROM audio_chunks a WHERE a.episode_id=c.episode_id AND a.state IN ('running','failed','ambiguous')) AND c.chunk_index=(SELECT MIN(n.chunk_index) FROM audio_chunks n WHERE n.episode_id=c.episode_id AND n.state='queued') LIMIT 100`).all<Record<string,unknown>>();
  for (const row of rows.results ?? []) await notify(env,{version:1,episodeId:String(row.episode_id),chunkIndex:Number(row.chunk_index),generation:Number(row.generation)});
  const assembly=await env.DB.prepare(`SELECT e.id,e.generation,c.chunk_index FROM audio_episodes e JOIN audio_chunks c ON c.episode_id=e.id AND c.chunk_index=0 WHERE e.state='generating' AND e.lease_token IS NULL AND NOT EXISTS(SELECT 1 FROM audio_chunks n WHERE n.episode_id=e.id AND n.state!='succeeded') LIMIT 50`).all<Record<string,unknown>>();
  for(const row of assembly.results??[])await notify(env,{version:1,episodeId:String(row.id),chunkIndex:Number(row.chunk_index),generation:Number(row.generation)});
}
