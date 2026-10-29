import type { Env, IntegrationConfiguration, IntegrationStatus } from '../contracts';
import { getArticle, getArticleCopy } from '../articles/repository';
import { githubIntegration } from './github';
import { hookIntegrations } from './hooks';
import { IntegrationError, type ArticleIntegration } from './types';

/** Adding a provider changes the registry, never the article save/capture pipeline. */
export function articleIntegrations(env: Env): ArticleIntegration[] {
  const github = githubIntegration(env);
  return [...(github ? [github] : []), ...hookIntegrations(env)];
}

export function integrationConfigurations(env: Env): IntegrationConfiguration[] {
  return articleIntegrations(env).map(provider => provider.configuration);
}

export async function integrationStatuses(env: Env, id: string): Promise<IntegrationStatus[]> {
  const article = await getArticle(env.DB, id);
  if (!article) throw new IntegrationError(404, 'not_found', 'Article not found.');
  const copy = await getArticleCopy(env.DB, id);
  return Promise.all(articleIntegrations(env).map(provider => provider.status(article, copy)));
}

export async function deliverArticle(env: Env, id: string, integrationId: string, expectedRevision: string, expectedDestinationKey: string) {
  const provider = articleIntegrations(env).find(item => item.configuration.id === integrationId);
  if (!provider) throw new IntegrationError(404, 'integration_not_found', 'This integration is unavailable. Review the configured integrations.');
  if (!provider.configuration.configured) throw new IntegrationError(503, 'integration_not_configured', provider.configuration.message || 'This integration is not configured.');
  if (provider.configuration.destinationKey !== expectedDestinationKey) {
    throw new IntegrationError(409, 'destination_changed', 'The integration destination changed. Review it before sending this copy.');
  }
  const article = await getArticle(env.DB, id);
  if (!article) throw new IntegrationError(404, 'not_found', 'Article not found.');
  const copy = await getArticleCopy(env.DB, id);
  if (!copy) throw new IntegrationError(409, 'copy_required', 'Save a Markdown copy before sending it to an integration.');
  if (copy.revision !== expectedRevision) throw new IntegrationError(409, 'revision_conflict', 'The saved copy changed. Reload it before sending.');
  return provider.deliver({ article, copy });
}
