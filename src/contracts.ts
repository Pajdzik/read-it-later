export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  OWNER_GITHUB_ID?: string;
  APP_ORIGIN?: string;
  DEV_AUTH_BYPASS?: string;
}

export type {
  ApiError, Article, ArticleCopy, ArticleCursor, ArticleStatus,
  ArticleListResponse, ArticleResponse, ArticleCopyResponse,
  SavedArticleCopyResponse, SessionResponse, CaptureToken, CaptureTokensResponse,
  CreatedCaptureTokenResponse,
  CreateArticleRequest, CreateArticleResponse, UpdateArticleRequest,
  SaveArticleCopyRequest, ImportResponse,
} from "./shared/contracts";

export { errorResponse } from './http.js';
