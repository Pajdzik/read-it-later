import { parseHTML } from 'linkedom';

const MAX_HTML_BYTES = 512 * 1024;
const MAX_TITLE = 500;
const MAX_AUTHOR = 200;
const MAX_DESCRIPTION = 500;

export interface ArticleMetadata {
  title?: string;
  author?: string;
  description?: string;
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (entity, code: string) => {
    if (code[0] === "#") {
      const hex = code[1]?.toLowerCase() === "x";
      const point = Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    }
    return ({ amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " } as Record<string, string>)[code.toLowerCase()] ?? entity;
  });
}

function clean(value: string | undefined, limit: number): string | undefined {
  const text = value ? decodeEntities(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() : "";
  return text ? text.slice(0, limit) : undefined;
}

function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of tag.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

export function parseArticleMetadata(html: string): ArticleMetadata {
  const meta = new Map<string, string>();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = parseAttributes(match[0]);
    const key = (attrs.property || attrs.name || "").toLowerCase();
    const value = clean(attrs.content, MAX_DESCRIPTION);
    if (key && value && !meta.has(key)) meta.set(key, value);
  }
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1];
  let socialAuthor: string | undefined;
  for (let index = 1; index <= 4 && !socialAuthor; index++) {
    const label = meta.get(`twitter:label${index}`);
    if (label && /author|written\s+by|byline/i.test(label)) socialAuthor = meta.get(`twitter:data${index}`);
  }
  const description = meta.get("og:description") || meta.get("twitter:description") || meta.get("description");
  let lead: string | undefined;
  if (!description) {
    const { document } = parseHTML(html);
    const content = document.querySelector("article, main, [role='main'], .content, .article-content, .post-content") ?? document.body;
    lead = clean(content.querySelector("p")?.textContent || undefined, MAX_DESCRIPTION);
  }
  return {
    title: clean(meta.get("og:title") || meta.get("twitter:title") || titleTag, MAX_TITLE),
    author: clean(meta.get("author") || meta.get("article:author") || socialAuthor, MAX_AUTHOR),
    description: clean(description, MAX_DESCRIPTION) || lead,
  };
}

async function readBounded(response: Response, requireComplete = false): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (requireComplete && bytes + value.byteLength > MAX_HTML_BYTES) throw new Error('Source HTML exceeds the capture limit');
      const chunk = value.subarray(0, MAX_HTML_BYTES - bytes);
      chunks.push(chunk);
      bytes += chunk.byteLength;
      if (chunk.byteLength !== value.byteLength || (!requireComplete && bytes === MAX_HTML_BYTES)) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const all = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(all);
}

export async function fetchArticlePage(url: string, includeHtml = false): Promise<{ metadata: ArticleMetadata; html?: string; url: string }> {
  try {
    const response = await fetch(url, {
      headers: { Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1", "User-Agent": "PotemReader/1.0" },
      signal: AbortSignal.timeout(4500),
    });
    if (!response.ok || !/html|xhtml/i.test(response.headers.get("content-type") || "")) {
      await response.body?.cancel();
      return { metadata: {}, url };
    }
    const html = await readBounded(response, includeHtml);
    return { metadata: parseArticleMetadata(html), ...(includeHtml ? { html } : {}), url: response.url || url };
  } catch {
    return { metadata: {}, url };
  }
}

export async function fetchArticleMetadata(url: string): Promise<ArticleMetadata> {
  return (await fetchArticlePage(url)).metadata;
}
