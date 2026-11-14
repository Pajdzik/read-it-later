import { DOMParser } from "linkedom";

const MAX_ITEMS = 200;
const MAX_TEXT = 600;
const MAX_URL = 2048;
const MAX_KEY = 1024;
type XmlElement = { localName: string; textContent: string | null; children: Iterable<XmlElement>; getAttribute(name: string): string | null };

export type FeedItem = { key: string; url: string; title: string; preview: string; publishedAt: string | null };
export type FeedDocument = { title: string; items: FeedItem[] };

function comparableText(value: string): string {
  return value.replace(/\s+/g, " ").replace(/[.:!?]+$/g, "").trim().toLowerCase();
}

function plainText(raw: string, title?: string): string {
  const decoded = raw.replace(/&(?:nbsp|#160);/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
  const text = decoded.replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ")
    .replace(/<\s*br\b[^>]*\/?>/gi, "\n")
    .replace(/<\s*\/?\s*(?:p|div|li|h[1-6]|blockquote|article|section|figure|figcaption|tr|ul|ol)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:nbsp|#160);/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/g, " ");
  const blocks = text.split(/[\r\n]+/).map(block => block.replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1").replace(/([([{])\s+/g, "$1").replace(/\s+([)\]}])/g, "$1").trim())
    .filter(Boolean);
  const normalizedTitle = title ? comparableText(title) : "";
  return blocks.filter((block, index) => {
    if (/^(?:tags?|categories|topics?)\s*:/i.test(block)) return false;
    if (index === 0 && normalizedTitle) {
      const withoutLabel = block.replace(/^(?:new\s+)?(?:release|announcement|update)\s*:\s*/i, "");
      if (comparableText(block) === normalizedTitle || comparableText(withoutLabel) === normalizedTitle) return false;
    }
    return true;
  }).join("\n").slice(0, MAX_TEXT);
}

function text(node: XmlElement | null | undefined): string {
  return plainText(node?.textContent ?? "");
}

function preview(node: XmlElement | null | undefined, title: string): string {
  return plainText(node?.textContent ?? "", title);
}

function safeLink(raw: string | null | undefined, base: URL): string | null {
  if (!raw?.trim() || raw.length > MAX_URL) return null;
  try {
    const url = new URL(raw.trim(), base);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.href.length > MAX_URL) return null;
    return url.href;
  } catch { return null; }
}

function nameOf(element: XmlElement): string {
  return element.localName.split(":").at(-1)!.toLowerCase();
}

function child(el: XmlElement, name: string): XmlElement | null {
  return Array.from(el.children).find(candidate => nameOf(candidate) === name) ?? null;
}

function atomLink(entry: XmlElement, base: URL): string | null {
  for (const node of entry.children) {
    if (nameOf(node) !== "link") continue;
    const rel = node.getAttribute("rel");
    if (rel && rel !== "alternate") continue;
    const url = safeLink(node.getAttribute("href"), base);
    if (url) return url;
  }
  return null;
}

function parseDate(raw: string): string | null {
  if (!raw || raw.length > 100) return null;
  const time = Date.parse(raw);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export function parseFeed(xml: string, sourceUrl: string): FeedDocument {
  const base = new URL(sourceUrl);
  // DTDs and entity declarations are unnecessary for feeds and could enable expansion/entity attacks.
  if (/<!\s*(?:doctype|entity)\b/i.test(xml)) throw new Error("invalid_feed");
  const document = new DOMParser().parseFromString(xml, "text/xml") as unknown as { documentElement: XmlElement | null };
  const root = document.documentElement;
  if (!root || root.localName === "parsererror") throw new Error("invalid_feed");
  const rootName = nameOf(root);
  let title = "";
  let entries: XmlElement[] = [];
  let getItem: (entry: XmlElement) => FeedItem | null;
  if (rootName === "rss" || rootName === "rdf") {
    const channel = child(root, "channel");
    if (!channel) throw new Error("invalid_feed");
    title = text(child(channel, "title"));
    entries = Array.from((rootName === "rdf" ? root : channel).children).filter(node => nameOf(node) === "item").slice(0, MAX_ITEMS);
    getItem = entry => {
      const guidNode = child(entry, "guid");
      const guid = guidNode?.textContent?.trim();
      const link = safeLink(child(entry, "link")?.textContent, base)
        ?? (guidNode?.getAttribute("isPermaLink") !== "false" && guid && /^https?:\/\//i.test(guid) ? safeLink(guid, base) : null);
      if (!link) return null;
      const title = text(child(entry, "title")) || link;
      const previewText = preview(child(entry, "description"), title) || preview(child(entry, "summary"), title) || preview(child(entry, "encoded"), title);
      const date = text(child(entry, "pubdate")) || text(child(entry, "date"));
      return { key: guid && guid.length <= MAX_KEY ? guid : link, url: link, title, preview: previewText, publishedAt: parseDate(date) };
    };
  } else if (rootName === "feed") {
    title = text(child(root, "title"));
    entries = Array.from(root.children).filter(node => nameOf(node) === "entry").slice(0, MAX_ITEMS);
    getItem = entry => {
      const link = atomLink(entry, base);
      if (!link) return null;
      const title = text(child(entry, "title")) || link;
      const previewText = preview(child(entry, "summary"), title) || preview(child(entry, "content"), title);
      const id = child(entry, "id")?.textContent?.trim();
      const date = text(child(entry, "published")) || text(child(entry, "updated"));
      return { key: id && id.length <= MAX_KEY ? id : link, url: link, title, preview: previewText, publishedAt: parseDate(date) };
    };
  } else throw new Error("invalid_feed");

  const unique = new Set<string>();
  const items: FeedItem[] = [];
  for (const entry of entries) {
    const item = getItem(entry);
    if (!item || unique.has(item.key)) continue;
    unique.add(item.key);
    items.push(item);
  }
  return { title, items };
}
