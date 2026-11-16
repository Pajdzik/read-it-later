import { parentPort, workerData } from "node:worker_threads";
import { parseHTML } from "linkedom";
import { parseArticleMetadata, type ArticleDocument, type ArticleMetadata } from "../src/articles/metadata";
import { splitMarkdownFrontMatter } from "../src/articles/markdown-front-matter";
import type { SourceDocument } from "../src/articles/source-fetch";

export type TextSource = Exclude<SourceDocument, { kind: "pdf" }>;
export type InspectedSource = { metadata: ArticleMetadata } & (
  { kind: "markdown"; markdown: string } | { kind: "html"; shell?: { feedUrl?: string } }
);

function findShell(document: ArticleDocument, sourceUrl: string): { feedUrl?: string } | undefined {
  const body = document.body;
  if (!body.querySelector("noscript") || !document.querySelector("script[src]")) return;
  for (const element of body.querySelectorAll("script, style, noscript, template")) element.remove();
  if (body.textContent?.trim() || body.querySelector("img, picture, video, audio, iframe, svg, canvas, object, embed")) return;

  const origin = new URL(sourceUrl).origin;
  for (const link of document.head.querySelectorAll('link[rel~="alternate"][type="application/rss+xml"][href]')) {
    try {
      const url = new URL(link.getAttribute("href")!, sourceUrl);
      if (url.origin === origin && !url.username && !url.password) return { feedUrl: url.href };
    } catch { /* Ignore invalid advertised URLs. */ }
  }
  return {};
}

function inspect(source: TextSource): InspectedSource {
  if (source.kind === "markdown") {
    const { body, fields } = splitMarkdownFrontMatter(source.markdown);
    const field = (key: string, limit: number) => {
      const value: unknown = fields?.get(key);
      return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) || undefined : undefined;
    };
    return { kind: "markdown", markdown: body, metadata: {
      title: field("title", 500), author: field("author", 200), description: field("description", 500),
    } };
  }
  const document = parseHTML(source.html).document;
  return { kind: "html", metadata: parseArticleMetadata(document), shell: findShell(document, source.url) };
}

// Conversion has no network capability, even if a dependency introduces an async fallback.
globalThis.fetch = async () => { throw new Error("extraction_network_disabled"); };
try {
  parentPort!.postMessage({ result: inspect(workerData as TextSource) });
} catch { parentPort!.postMessage({ error: "conversion_failed" }); }
