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

export interface ApiError {
  error: { code: string; message: string };
}

export interface ArticleCursor {
  createdAt: string;
  id: string;
}

export type ArticleStatus = "unread" | "read" | "all";

export interface ArticleListResponse {
  items: Article[];
  nextCursor: string | null;
}

export interface ArticleResponse {
  article: Article;
}

export interface ArticleCopyResponse {
  copy: ArticleCopy | null;
}

export interface SavedArticleCopyResponse {
  copy: ArticleCopy;
}

export interface SessionResponse {
  authenticated: boolean;
  csrfToken?: string;
}

export interface CaptureToken {
  id: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface CaptureTokensResponse {
  items: CaptureToken[];
}

export interface CreatedCaptureTokenResponse {
  id: string;
  token: string;
  label: string;
  createdAt: string;
}

export interface CreateArticleRequest {
  url: string;
  title?: string;
}

export interface CreateArticleResponse {
  article: Article;
  duplicate: boolean;
  metadataUpdated?: boolean;
}

export interface UpdateArticleRequest {
  read?: boolean;
  title?: string;
}

export interface SaveArticleCopyRequest {
  markdown: string;
  source: ArticleCopy["source"];
  expectedRevision: string | null;
}

export interface ImportResponse {
  imported: number;
  skipped: number;
}

export const MAX_URL_LENGTH = 8 * 1024;
export const MAX_TITLE_LENGTH = 500;
export const MAX_AUTHOR_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 500;
export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_IMPORT_BYTES = 1024 * 1024;
export const MAX_IMPORT_ITEMS = 1000;
export const MAX_COPY_BYTES = 256 * 1024;
export const MAX_COPY_ENVELOPE_BYTES = 2 * 1024 * 1024;
