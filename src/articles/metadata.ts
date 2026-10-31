import { parseHTML } from 'linkedom';

export type ArticleDocument = ReturnType<typeof parseHTML>["document"];

const MAX_TITLE = 500;
const MAX_AUTHOR = 200;
const MAX_DESCRIPTION = 500;

export interface ArticleMetadata {
  title?: string;
  author?: string;
  description?: string;
}

function clean(value: string | undefined, limit: number): string | undefined {
  const text = value ? value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() : "";
  return text ? text.slice(0, limit) : undefined;
}

export function parseArticleMetadata(input: string | ArticleDocument): ArticleMetadata {
  const document = typeof input === "string" ? parseHTML(input).document : input;
  const meta = new Map<string, string>();
  for (const element of document.querySelectorAll("meta")) {
    const key = (element.getAttribute("property") || element.getAttribute("name") || "").toLowerCase();
    const value = clean(element.getAttribute("content") || undefined, MAX_DESCRIPTION);
    if (key && value && !meta.has(key)) meta.set(key, value);
  }
  const titleTag = document.querySelector("title")?.textContent || undefined;
  let socialAuthor: string | undefined;
  for (let index = 1; index <= 4 && !socialAuthor; index++) {
    const label = meta.get(`twitter:label${index}`);
    if (label && /author|written\s+by|byline/i.test(label)) socialAuthor = meta.get(`twitter:data${index}`);
  }
  const description = meta.get("og:description") || meta.get("twitter:description") || meta.get("description");
  const content = document.querySelector("[data-article-part='body'], [itemprop='articleBody']") ??
    document.querySelector("article, main, [role='main'], .content, .article-content, .post-content") ?? document.body;
  const lead = clean(content.querySelector("p")?.textContent || undefined, MAX_DESCRIPTION);
  const repeatsHeadline = description && [...document.querySelectorAll("h1")].some(heading =>
    clean(heading.textContent || undefined, MAX_DESCRIPTION)?.toLowerCase() === description.toLowerCase());
  return {
    title: clean(meta.get("og:title") || meta.get("twitter:title") || titleTag, MAX_TITLE),
    author: clean(meta.get("author") || meta.get("article:author") || socialAuthor, MAX_AUTHOR),
    description: (repeatsHeadline ? lead : clean(description, MAX_DESCRIPTION)) || lead,
  };
}
