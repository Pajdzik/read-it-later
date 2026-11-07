import type { Env } from '../contracts';
import { digest, isResponse, randomToken, requireSession } from '../auth/core';
import { isArticleId } from '../articles/identity';
import { getArticle } from '../articles/repository';
import { parseObject, readJson, ValidationError } from '../articles/validation';
import { errorResponse, exceptionResponse, jsonResponse, PRIVATE_HEADERS } from '../http';
import { AudioError, getAudioStatus, getAudioUsage, prepareAudio, removeAudio } from './index';
import { servePodcastEpisode, servePodcastFeed } from './feed';

const methodNotAllowed = () => errorResponse(405, 'method_not_allowed', 'This podcast action is not supported.');

export async function handleAudio(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const article = /^\/api\/articles\/([^/]+)\/audio$/.exec(url.pathname);
  const media = /^\/api\/podcast\/episodes\/([^/]+)\.mp3$/.exec(url.pathname);
  const feed = url.pathname === '/api/podcast/feed.xml';
  const settings = url.pathname === '/api/podcast/settings';
  const token = url.pathname === '/api/podcast/token';
  if (!article && !media && !feed && !settings && !token) return null;
  try {
    if (feed || media) {
      if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed();
      return feed ? await servePodcastFeed(request, env) : await servePodcastEpisode(request, env, media![1]);
    }
    const auth = await requireSession(request, env, method !== 'GET');
    if (isResponse(auth)) return auth;
    if (settings && method === 'GET') {
      const current = await env.DB.prepare('SELECT created_at FROM podcast_token WHERE singleton=1').first<{ created_at: string }>();
      const ready = await env.DB.prepare("SELECT COUNT(*) AS count FROM audio_episodes e JOIN articles a ON a.id=e.article_id WHERE e.state='ready'").first<{ count: number }>();
      return jsonResponse({ enabled: env.ARTICLE_AUDIO_ENABLED === 'true', token: current ? { createdAt: current.created_at } : null, usage: await getAudioUsage(env), readyEpisodes: ready?.count ?? 0 });
    }
    if (token && method === 'POST') {
      if (request.body) parseObject(await readJson(request), []);
      const raw = `pod_${randomToken(32)}`;
      const createdAt = new Date().toISOString();
      await env.DB.prepare('INSERT INTO podcast_token(singleton,token_hash,created_at) VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET token_hash=excluded.token_hash,created_at=excluded.created_at')
        .bind(await digest(raw), createdAt).run();
      const feedUrl = new URL('/api/podcast/feed.xml', env.APP_ORIGIN!);
      feedUrl.searchParams.set('token', raw);
      return jsonResponse({ feedUrl: feedUrl.toString(), createdAt }, 201);
    }
    if (token && method === 'DELETE') {
      await env.DB.prepare('DELETE FROM podcast_token WHERE singleton=1').run();
      return new Response(null, { status: 204, headers: PRIVATE_HEADERS });
    }
    if (article) {
      if (!isArticleId(article[1])) throw new ValidationError('Article ID must contain eight lowercase letters or digits.');
      if (!(await getArticle(env.DB, article[1]))) return errorResponse(404, 'not_found', 'Article not found.');
      if (method === 'GET') return jsonResponse({ audio: await getAudioStatus(env, article[1]) });
      if (method === 'POST') {
        const body = parseObject(await readJson(request), ['expectedRevision'], ['expectedRevision']);
        if (typeof body.expectedRevision !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.expectedRevision)) throw new ValidationError('expectedRevision must be a valid saved copy revision');
        const audio = await prepareAudio(env, article[1], body.expectedRevision);
        return jsonResponse({ audio }, audio.state === 'ready' ? 200 : 202);
      }
      if (method === 'DELETE') {
        await removeAudio(env, article[1]);
        return new Response(null, { status: 204, headers: PRIVATE_HEADERS });
      }
    }
    return methodNotAllowed();
  } catch (error) {
    if (error instanceof AudioError) return errorResponse(error.status, error.code, error.message);
    return exceptionResponse(error, 'podcast.request', { status: 503, code: 'storage_unavailable', message: 'Podcast is temporarily unavailable. Please retry.' });
  }
}
