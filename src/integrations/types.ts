import type { Article, ArticleCopy, IntegrationConfiguration, IntegrationStatus } from '../contracts';

export type SavedArticle = { article: Article; copy: ArticleCopy };

/** Providers receive persisted content only. Storage and capture never depend on delivery. */
export interface ArticleIntegration {
  configuration: IntegrationConfiguration;
  status(article: Article, copy: ArticleCopy | null): Promise<IntegrationStatus>;
  deliver(saved: SavedArticle): Promise<{ integration: IntegrationStatus; unchanged: boolean }>;
}

export class IntegrationError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'IntegrationError';
  }
}
