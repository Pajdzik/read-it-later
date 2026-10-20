import { DOMParser, parseHTML } from 'linkedom';

// The full bundle's Markdown converter expects a DOMParser. Install a fixed,
// inert parser before loading it; each call creates a separate document.
class ArticleDOMParser {
  parseFromString(html: string, type: 'text/html' | 'image/svg+xml' | 'text/xml') {
    return new DOMParser().parseFromString(type === 'text/html' ? `<html><body>${html}</body></html>` : html, type);
  }
}
if (!('DOMParser' in globalThis)) Object.defineProperty(globalThis, 'DOMParser', { value: ArticleDOMParser });
if (!('window' in globalThis)) Object.defineProperty(globalThis, 'window', { value: Object.freeze({ DOMParser: ArticleDOMParser }) });

export class ArticleExtractionError extends Error {}

/** Parse the already fetched HTML without scripts or third-party extraction requests. */
export async function extractArticleMarkdown(html: string, url: string): Promise<string> {
  const { document } = parseHTML(html);
  const { default: Defuddle } = await import('defuddle/full');
  const result = new Defuddle(document, { url, markdown: true, useAsync: false, removeHiddenElements: false }).parse();
  const markdown = result.content;
  if (markdown.startsWith('Partial conversion completed with errors. Original HTML:')) throw new ArticleExtractionError('Article conversion failed. Use the bookmarklet or paste Markdown in article details.');
  if (!markdown.trim()) throw new ArticleExtractionError('No article text could be extracted.');
  if (new TextEncoder().encode(markdown).byteLength > 256 * 1024) throw new ArticleExtractionError('The extracted article exceeds the 256 KiB Markdown limit.');
  return markdown;
}
