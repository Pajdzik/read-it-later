import type { Env } from '../contracts';
import { digest } from '../auth/core';
import { errorResponse, PRIVATE_HEADERS } from '../http';

export interface PodcastEpisode {
  id: string;
  article_id: string;
  title: string;
  author: string | null;
  url: string;
  ready_at: string;
  bytes: number;
  duration_seconds: number;
  object_key: string;
  checksum: string;
}

const published = `FROM audio_episodes e JOIN articles a ON a.id=e.article_id
  WHERE e.state='ready' AND e.ready_at IS NOT NULL AND e.bytes>0 AND e.duration_seconds>0`;
const episodeColumns = 'e.id,e.article_id,e.title,e.author,e.url,e.ready_at,e.bytes,e.duration_seconds,e.object_key,e.checksum';
const missing = () => errorResponse(404, 'not_found', 'Podcast not found.');

/** Keep XML 1.0 valid, including when owner-supplied metadata has control characters. */
export function xml(value: string): string {
  return value.replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export function duration(seconds: number): string {
  const total = Math.floor(seconds);
  return `${Math.floor(total / 3600)}:${String(Math.floor(total / 60) % 60).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function renderFeed(origin: string, token: string, episodes: PodcastEpisode[]): string {
  const media = (id: string) => `${origin}/api/podcast/episodes/${id}.mp3?token=${encodeURIComponent(token)}`;
  const items = episodes.map(episode => `<item>
<title>${xml(episode.title)}</title>
<guid isPermaLink="false">urn:uuid:${xml(episode.id)}</guid>
<pubDate>${new Date(episode.ready_at).toUTCString()}</pubDate>
<link>${xml(`${origin}/read/${episode.article_id}`)}</link>
<description>${xml(`${episode.author ? `By ${episode.author}. ` : ''}AI-generated narration of a saved article. Original: ${episode.url}. Code blocks are available in the saved copy.`)}</description>
<itunes:author>${xml(episode.author || 'Potem')}</itunes:author>
<itunes:duration>${duration(episode.duration_seconds)}</itunes:duration>
<enclosure url="${xml(media(episode.id))}" length="${episode.bytes}" type="audio/mpeg" />
</item>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>Potem — saved articles</title>
<link>${xml(origin)}</link>
<description>Your private saved articles, narrated with AI.</description>
<language>en-US</language>
<itunes:author>Potem</itunes:author>
<itunes:explicit>false</itunes:explicit>
<itunes:type>episodic</itunes:type>
<itunes:block>Yes</itunes:block>
<itunes:category text="Education" />
<itunes:image href="${xml(`${origin}/icons/podcast-cover.png`)}" />
<image><url>${xml(`${origin}/icons/podcast-cover.png`)}</url><title>Potem — saved articles</title><link>${xml(origin)}</link></image>
<atom:link href="${xml(`${origin}/api/podcast/feed.xml?token=${encodeURIComponent(token)}`)}" rel="self" type="application/rss+xml" />
${items}
</channel>
</rss>`;
}

export async function podcastToken(request: Request, env: Env): Promise<string | null> {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (url.searchParams.getAll('token').length !== 1 || !token || !/^pod_[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const found = await env.DB.prepare('SELECT 1 AS valid FROM podcast_token WHERE singleton=1 AND token_hash=?')
    .bind(await digest(token)).first();
  return found ? token : null;
}

export async function servePodcastFeed(request: Request, env: Env): Promise<Response> {
  const token = await podcastToken(request, env);
  if (!token) return missing();
  // Bound response memory. Older media URLs remain valid until explicit deletion.
  const { results } = await env.DB.prepare(`SELECT ${episodeColumns} ${published} ORDER BY e.ready_at DESC,e.id DESC LIMIT 1000`).all<PodcastEpisode>();
  const origin = new URL(env.APP_ORIGIN!).origin;
  const body = renderFeed(origin, token, results);
  const headers = new Headers({ ...PRIVATE_HEADERS, 'Content-Type': 'application/rss+xml; charset=utf-8', 'Referrer-Policy': 'no-referrer' });
  headers.set('Content-Length', String(new TextEncoder().encode(body).byteLength));
  return new Response(request.method === 'HEAD' ? null : body, { headers });
}

function byteRange(raw: string, size: number): { offset: number; length: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw);
  if (!match || (!match[1] && !match[2])) return null;
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[2] && match[1] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start || (!match[1] && Number(match[2]) === 0)) return null;
  end = Math.min(end, size - 1);
  return { offset: start, length: end - start + 1 };
}

export async function servePodcastEpisode(request: Request, env: Env, episodeId: string): Promise<Response> {
  if (!(await podcastToken(request, env))) return missing();
  if (!/^[a-f0-9-]{36}$/.test(episodeId)) return missing();
  const episode = await env.DB.prepare(`SELECT ${episodeColumns} ${published} AND e.id=?`).bind(episodeId).first<PodcastEpisode>();
  if (!episode) return missing();
  if (!env.AUDIO_BUCKET) return errorResponse(503, 'audio_unavailable', 'Podcast audio is temporarily unavailable.');
  const headers = new Headers({ ...PRIVATE_HEADERS, 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Referrer-Policy': 'no-referrer', 'Content-Disposition': `inline; filename="${episode.id}.mp3"` });
  headers.set('ETag', `"${episode.checksum}"`);
  const rawRange = request.method === 'GET' && (!request.headers.has('If-Range') || request.headers.get('If-Range') === headers.get('ETag')) ? request.headers.get('Range') : null;
  const range = rawRange ? byteRange(rawRange, episode.bytes) : undefined;
  if (range === null) {
    headers.set('Content-Range', `bytes */${episode.bytes}`);
    return new Response(null, { status: 416, headers });
  }
  if (range) headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${episode.bytes}`);
  headers.set('Content-Length', String(range?.length ?? episode.bytes));
  if (request.method === 'HEAD') {
    const object = await env.AUDIO_BUCKET.head(episode.object_key);
    if (!object || object.size !== episode.bytes) return errorResponse(503, 'audio_unavailable', 'Podcast audio is temporarily unavailable.');
    return new Response(null, { headers });
  }
  const object = await env.AUDIO_BUCKET.get(episode.object_key, range ? { range } : undefined);
  if (!object || object.size !== episode.bytes) {
    if (object) await object.body.cancel();
    return errorResponse(503, 'audio_unavailable', 'Podcast audio is temporarily unavailable.');
  }
  return new Response(object.body, { status: range ? 206 : 200, headers });
}
