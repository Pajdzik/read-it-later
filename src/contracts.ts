/// <reference path="./worker-bindings.d.ts" />
import type { AudioMessage } from './audio/contracts';

export interface ExtractionMessage {
  version: 1;
  articleId: string;
  generation: number;
}

export interface EnrichmentMessage { version: 1; kind: 'enrichment'; articleId: string }
export type ArticleMessage = ExtractionMessage | EnrichmentMessage;
export type { AudioMessage } from './audio/contracts';
export type DescriptionOrigin = 'manual' | 'extracted' | 'generated' | null;
export interface EnrichmentStatus {
  state: 'queued' | 'running' | 'retry_wait' | 'deferred' | 'succeeded' | 'failed' | 'skipped';
  paused: boolean;
}

export interface Env extends Pick<WorkerBindings, "DB" | "ASSETS">, Partial<Pick<WorkerBindings, "PDF_BUCKET" | "MANAGED_CONVERSION_ENABLED">> {
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  OWNER_GITHUB_ID?: string;
  APP_ORIGIN?: string;
  DEV_AUTH_BYPASS?: string;
  GITHUB_BACKUP_REPOSITORY?: string;
  GITHUB_BACKUP_BRANCH?: string;
  GITHUB_BACKUP_PATH?: string;
  GITHUB_BACKUP_TOKEN?: string;
  /** Optional destinations served by the private ARTICLE_HOOKS service. */
  ARTICLE_HOOKS?: Fetcher;
  ARTICLE_HOOKS_CONFIG?: string;
  BACKGROUND_CAPTURE_ENABLED?: string;
  /** Durable delivery notifications; D1 remains authoritative for job state. */
  EXTRACTION_QUEUE?: Queue<ArticleMessage>;
  /** Only the non-streaming text-generation capability is needed here. */
  AI?: { run(model: '@cf/zai-org/glm-4.7-flash', inputs: AiModels['@cf/zai-org/glm-4.7-flash']['inputs']): Promise<unknown> };
  ARTICLE_ENRICHMENT_ENABLED?: string;
  ARTICLE_ENRICHMENT_DAILY_LIMIT?: string;
  /** Private Cloudflare Container capture service; returns Markdown and metadata, never source HTML. */
  ARTICLE_EXTRACTOR?: Fetcher;
  /** Narration is explicitly requested by the owner; feed reads never create jobs. */
  AUDIO_BUCKET?: WorkerBindings['AUDIO_BUCKET'];
  AUDIO_QUEUE?: Queue<AudioMessage>;
  ARTICLE_AUDIO_ENABLED?: string;
  AUDIO_MONTHLY_BUDGET_USD?: string;
  AUDIO_FREE_CHARACTERS?: string;
  GOOGLE_TTS_PROJECT_ID?: string;
  GOOGLE_TTS_SERVICE_ACCOUNT_JSON?: string;
}

export interface ExtractionStatus {
  state: "none" | "queued" | "running" | "retry_wait" | "ready" | "failed";
  attempts: number;
  errorCode: string | null;
  nextAttemptAt: string | null;
  paused: boolean;
  recovery?: {
    generation: number;
    state: 'queued' | 'running' | 'retry_wait' | 'succeeded' | 'failed';
    attempts: number;
    errorCode: string | null;
    nextAttemptAt: string | null;
  };
  undoAvailable: boolean;
}

export interface OriginalPdf {
  id: string;
  checksum: string;
  bytes: number;
  capturedAt: string;
  sourceUrl: string;
}

export interface Article {
  originalPdf?: OriginalPdf;
  id: string;
  url: string;
  title: string;
  author: string | null;
  description: string | null;
  tags: string[];
  descriptionOrigin: DescriptionOrigin;
  tagsManuallyEdited: boolean;
  createdAt: string;
  updatedAt: string;
  readAt: string | null;
  readingTimeMinutes: number | null;
}

export interface ArticleCopy {
  markdown: string;
  capturedAt: string;
  source: "paste" | "upload";
  revision: string;
}

export interface SavedArticleCopy extends ArticleCopy { readingTimeMinutes: number | null }

export type { IntegrationConfiguration, IntegrationStatus, IntegrationConsent } from './integrations/contracts';

export interface ApiError {
  error: { code: string; message: string };
}

export interface ArticleCursor {
  createdAt: string;
  id: string;
}

export { errorResponse } from './http.js';
