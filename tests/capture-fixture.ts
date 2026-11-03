import type { ArticleMetadata } from "../src/articles/metadata";

/** Model the current private executor response; source/executor tests cover fetching and parsing. */
export function captureFixture(markdown: string, metadata: ArticleMetadata = {}): Response {
  return Response.json({ version: 1, ok: true, article: { markdown, metadata } });
}
