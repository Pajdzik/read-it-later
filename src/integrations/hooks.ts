import type { Article, ArticleCopy, Env, IntegrationStatus } from '../contracts';
import { digest } from '../auth/core';
import { getArticle, getArticleCopy } from '../articles/repository';
import { IntegrationError, type ArticleIntegration, type SavedArticle } from './types';

type HookConfiguration = { id: string; name: string; destination: string; description: string };
type Delivery = { content_hash: string; delivered_at: string };

/** Read state and updatedAt are deliberately absent: reading is not a new delivery. */
function snapshot({ article, copy }: SavedArticle) {
  return {
    article: {
      id: article.id, url: article.url, title: article.title, author: article.author,
      description: article.description, savedAt: article.createdAt,
    },
    copy,
  };
}

function readConfiguration(env: Env): HookConfiguration[] {
  if (!env.ARTICLE_HOOKS_CONFIG?.trim()) return [];
  try {
    if (env.ARTICLE_HOOKS_CONFIG.length > 16_384) throw new Error();
    const value: unknown = JSON.parse(env.ARTICLE_HOOKS_CONFIG);
    if (!Array.isArray(value) || value.length > 10) throw new Error();
    const ids = new Set(['github']);
    return value.map((item: unknown) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error();
      const hook = item as Record<string, unknown>;
      if (Object.keys(hook).some(key => !['id', 'name', 'destination', 'description'].includes(key)) ||
          typeof hook.id !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(hook.id) || ids.has(hook.id) ||
          typeof hook.name !== 'string' || !hook.name.trim() || hook.name.length > 80 ||
          typeof hook.destination !== 'string' || !hook.destination.trim() || hook.destination.length > 512 ||
          typeof hook.description !== 'string' || !hook.description.trim() || hook.description.length > 500) throw new Error();
      ids.add(hook.id);
      return { id: hook.id, name: hook.name, destination: hook.destination, description: hook.description };
    });
  } catch {
    throw new IntegrationError(503, 'integrations_not_configured', 'The article hooks configuration is invalid. Check ARTICLE_HOOKS_CONFIG.');
  }
}

export function hookIntegrations(env: Env): ArticleIntegration[] {
  return readConfiguration(env).map(hook => {
    const configuration = {
      ...hook, configured: Boolean(env.ARTICLE_HOOKS),
      // Include the disclosure in consent so changed delivery behavior needs review.
      destinationKey: JSON.stringify([hook.id, hook.destination, hook.description]),
      ...(!env.ARTICLE_HOOKS ? { message: 'The article hooks service is not connected.' } : {}),
    };
    const previous = (id: string) => env.DB.prepare(`SELECT content_hash,delivered_at FROM article_integration_deliveries
      WHERE article_id = ? AND integration_id = ? AND destination_key = ?`)
      .bind(id, hook.id, configuration.destinationKey).first<Delivery>();
    const status = async (article: Article, copy: ArticleCopy | null): Promise<IntegrationStatus> => {
      const last = await previous(article.id);
      const hash = copy ? await digest(JSON.stringify(snapshot({ article, copy }))) : null;
      return {
        ...configuration, state: !last ? 'not_saved' : last.content_hash === hash ? 'saved' : 'outdated',
        ...(last ? { deliveredAt: last.delivered_at } : {}),
      };
    };
    return {
      configuration, status,
      async deliver(saved) {
        if (!env.ARTICLE_HOOKS) throw new IntegrationError(503, 'integration_not_configured', configuration.message!);
        const content = snapshot(saved);
        const contentHash = await digest(JSON.stringify(content));
        const last = await previous(saved.article.id);
        const unchanged = last?.content_hash === contentHash;
        if (!unchanged) {
          // A stable key lets the receiver deduplicate concurrent attempts and
          // retries after an ambiguous timeout or failed local receipt write.
          const deliveryId = await digest(JSON.stringify([hook.id, configuration.destinationKey, saved.article.id, contentHash]));
          try {
            const response = await env.ARTICLE_HOOKS.fetch(new Request(`https://article-hooks/hooks/${hook.id}`, {
              method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
              headers: { 'Content-Type': 'application/json', 'Idempotency-Key': deliveryId },
              body: JSON.stringify({ version: 1, event: 'article.delivery.requested', deliveryId,
                integration: { id: hook.id, destination: hook.destination, destinationKey: configuration.destinationKey }, ...content }),
            }));
            await response.body?.cancel();
            // The receiver must confirm durable acceptance. Never follow redirects
            // or expose arbitrary receiver response bodies to the browser.
            if (response.status !== 200 && response.status !== 201 && response.status !== 204) throw new Error();
          } catch {
            throw new IntegrationError(502, 'integration_delivery_failed', `${hook.name} could not confirm delivery. Your saved copy remains in Potem; retry to check this delivery again.`);
          }
          await env.DB.prepare(`INSERT INTO article_integration_deliveries
            (article_id,integration_id,destination_key,content_hash,delivered_at)
            SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM articles WHERE id = ?)
            ON CONFLICT(article_id,integration_id,destination_key) DO UPDATE SET
              content_hash=excluded.content_hash,delivered_at=excluded.delivered_at`)
            .bind(saved.article.id, hook.id, configuration.destinationKey, contentHash, new Date().toISOString(), saved.article.id).run();
        }
        const article = await getArticle(env.DB, saved.article.id);
        if (!article) throw new IntegrationError(409, 'revision_conflict', 'The article was deleted during delivery. The destination may retain its copy.');
        return { integration: await status(article, await getArticleCopy(env.DB, article.id)), unchanged };
      },
    };
  });
}
