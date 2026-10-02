export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  OWNER_GITHUB_ID?: string;
  APP_ORIGIN?: string;
  DEV_AUTH_BYPASS?: string;
  GITHUB_BACKUP_REPOSITORY?: string;
  GITHUB_BACKUP_BRANCH?: string;
  GITHUB_BACKUP_PATH?: string;
  GITHUB_BACKUP_TOKEN?: string;
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

export interface ApiError {
  error: { code: string; message: string };
}

export interface ArticleCursor {
  createdAt: string;
  id: string;
}

export { errorResponse } from './http.js';
