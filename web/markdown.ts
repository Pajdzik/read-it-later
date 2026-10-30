import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";

const allowedTags = [
  "a", "blockquote", "br", "code", "em", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "img", "li", "ol", "p", "pre", "s", "strong", "table", "tbody", "td",
  "th", "thead", "tr", "ul",
];
const allowedAttributes = ["alt", "decoding", "href", "loading", "referrerpolicy", "rel", "src", "start", "target"];

function linkUrl(href: string, sourceUrl: string): string | null {
  const raw = href.trim();
  if (!raw || /[\u0000-\u0020\u007f]/.test(raw)) return null;

  // A percent-encoded scheme must not be reinterpreted as an ordinary relative path.
  const colon = raw.indexOf(":");
  const boundary = raw.search(/[/?#]/);
  if (colon > 0 && (boundary < 0 || colon < boundary)) {
    let scheme = raw.slice(0, colon);
    try {
      for (let i = 0; i < 3; i++) {
        const decoded = decodeURIComponent(scheme);
        if (decoded === scheme) break;
        scheme = decoded;
      }
    } catch {
      return null;
    }
    if (/^[a-z][a-z0-9+.-]*$/i.test(scheme)) {
      const original = raw.slice(0, colon);
      if (scheme !== original || !/^https?$/i.test(scheme)) return null;
    }
  }

  try {
    const resolved = new URL(raw, sourceUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
    if (resolved.username || resolved.password) return null;
    return resolved.href;
  } catch {
    return null;
  }
}

function imageUrl(src: string, sourceUrl: string): string | null {
  const raw = src.trim();
  if (!raw || /[\u0000-\u0020\u007f]/.test(raw)) return null;

  try {
    const resolved = new URL(raw, sourceUrl);
    if (resolved.protocol !== "https:" || resolved.username || resolved.password) return null;
    return resolved.href;
  } catch {
    return null;
  }
}

function titleKey(title: string): string {
  // Captured headings can lose spaces around line breaks and use curly quotes.
  // Keep punctuation and symbols so distinct titles (e.g. C and C++) stay distinct.
  return title.normalize("NFKC").toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/gu, "");
}

/** Render a stored copy; an optional title identifies a heading already shown by the reader. */
export function renderMarkdown(markdown: string, sourceUrl: string, articleTitle?: string): DocumentFragment {
  const parser = new MarkdownIt({
    html: false,
    linkify: false,
    typographer: false,
    breaks: false,
  });

  parser.core.ruler.after("inline", "resolve-safe-links", (state) => {
    for (const block of state.tokens) {
      if (block.type !== "inline" || !block.children) continue;
      const links: Array<{ rejected: boolean }> = [];
      for (const token of block.children) {
        if (token.type === "link_open") {
          const safe = linkUrl(String(token.attrGet("href") || ""), sourceUrl);
          const record = { rejected: !safe };
          links.push(record);
          if (safe) {
            token.attrSet("href", safe);
            token.attrSet("target", "_blank");
            token.attrSet("rel", "noopener noreferrer");
          }
          token.meta = { ...token.meta, rejectedLink: record.rejected };
        } else if (token.type === "link_close") {
          const record = links.pop();
          token.meta = { ...token.meta, rejectedLink: record?.rejected ?? true };
        }
      }
    }
  });
  parser.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
    const token = tokens[index];
    if (token.meta?.rejectedLink) return "";
    return renderer.renderToken(tokens, index, options);
  };
  parser.renderer.rules.link_close = (tokens, index, options, _env, renderer) =>
    tokens[index].meta?.rejectedLink ? "" : renderer.renderToken(tokens, index, options);
  parser.renderer.rules.image = (tokens, index) => {
    const token = tokens[index];
    const alt = String(token.content || token.attrGet("alt") || "").trim();
    const src = imageUrl(String(token.attrGet("src") || ""), sourceUrl);
    if (!src) return `Image reference: ${parser.utils.escapeHtml(alt || "image")}`;
    return `<img src="${parser.utils.escapeHtml(src)}" alt="${parser.utils.escapeHtml(alt)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
  };

  const html = parser.render(markdown);
  const fragment = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: allowedTags,
    ALLOWED_ATTR: allowedAttributes,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    FORBID_TAGS: ["style", "script", "svg", "math", "iframe", "form", "video", "audio", "source", "link", "meta"],
    FORBID_ATTR: ["style", "id", "class", "srcset", "name", "form", "onerror", "onclick"],
    RETURN_DOM_FRAGMENT: true,
  });
  const opening = fragment.firstElementChild;
  if (articleTitle && opening?.matches("h1, h2, h3, h4, h5, h6") &&
      titleKey(articleTitle) && titleKey(opening.textContent || "") === titleKey(articleTitle)) {
    // Only omit a matching opening heading in the display. Stored/downloaded
    // Markdown and later headings remain intact.
    opening.remove();
  }
  return fragment;
}

export function markdownDownloadName(articleId: string): string {
  const safeId = articleId.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "article";
  return `potem-${safeId}.md`;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function markdownDownload(article: {
  id: string;
  title: string;
  url: string;
}, copy: { markdown: string; capturedAt: string; source: string; revision: string }): Blob {
  const frontmatter = [
    "---",
    `title: ${yamlString(article.title)}`,
    `url: ${yamlString(article.url)}`,
    `capturedAt: ${yamlString(copy.capturedAt)}`,
    `source: ${yamlString(copy.source)}`,
    `revision: ${yamlString(copy.revision)}`,
    "---",
    "",
    "",
  ].join("\n");
  return new Blob([frontmatter, copy.markdown], { type: "text/markdown;charset=utf-8" });
}
