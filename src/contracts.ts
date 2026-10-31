/// <reference path="./worker-bindings.d.ts" />
export interface ExtractionMessage {
  version: 1;
  articleId: string;
  generation: number;
}

export interface Env extends Pick<WorkerBindings, 'DB' | 'ASSETS'> {
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
  EXTRACTION_QUEUE?: Queue<ExtractionMessage>;
  /** Private Cloudflare Container capture service; returns Markdown and metadata, never source HTML. */
  ARTICLE_EXTRACTOR?: Fetcher;
  /** Legacy gateway binding retained for staged source-fetch compatibility. */
  ARTICLE_FETCHER?: { fetch(input: string, init: RequestInit): Promise<Response> };
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

export interface Article {
  id: string;
  url: string;
  title: string;
  author: string | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  readAt: string | null;
}

export interface ArticleCopy {
  markdown: string;
  capturedAt: string;
  source: "paste" | "upload";
  revision: string;
}

export interface GitHubBackupStatus {
  configured: boolean;
  message?: string;
  repository?: string;
  branch?: string;
  path?: string;
  url?: string;
  state?: "not_saved" | "saved" | "outdated";
  backedUpAt?: string;
}

export interface GitHubBackupConfiguration {
  configured: boolean;
  message?: string;
  repository?: string;
  branch?: string;
  folder?: string;
}

export type { IntegrationConfiguration, IntegrationStatus, IntegrationConsent } from './integrations/contracts';

export interface ApiError {
  error: { code: string; message: string };
}

export interface ArticleCursor {
  createdAt: string;
  id: string;
}

export { errorResponse } from './http.js';
