import { extractArticleMarkdown } from "../src/articles/extraction";
import { parseArticleMetadata } from "../src/articles/metadata";

/** Simulate the private executor protocol; source/executor tests cover actual fetching. */
export async function captureFixture(html: string): Promise<Response> {
  return Response.json({ version: 1, ok: true, article: {
    markdown: await extractArticleMarkdown(html, "https://source.example.com/article"),
    metadata: parseArticleMetadata(html),
  } });
}
