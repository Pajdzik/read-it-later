export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  OWNER_GITHUB_ID?: string;
  APP_ORIGIN?: string;
  DEV_AUTH_BYPASS?: string;
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

export interface ApiError {
  error: { code: string; message: string };
}

export interface ArticleCursor {
  createdAt: string;
  id: string;
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return Response.json({ error: { code, message } } satisfies ApiError, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
