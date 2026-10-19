const ARTICLE_ID = /^[a-z0-9]{8}$/;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function isArticleId(value: unknown): value is string {
  return typeof value === "string" && ARTICLE_ID.test(value);
}

/** Eight base-36 characters, using rejection sampling to avoid modulo bias. */
export function newArticleId(): string {
  let id = "";
  while (id.length < 8) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte >= 252) continue;
      id += ALPHABET[byte % ALPHABET.length];
      if (id.length === 8) break;
    }
  }
  return id;
}

export function articleSlug(title: string): string {
  return Array.from(title.normalize("NFKC").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, ""))
    .slice(0, 80).join("").replace(/-+$/g, "");
}

export function articlePath(article: { id: string; title: string }): string {
  const slug = articleSlug(article.title);
  return `/read/${encodeURIComponent(article.id)}${slug ? `/${encodeURIComponent(slug)}` : ""}`;
}

export function backupBasename(title: string): string {
  // Keep room for a numeric collision suffix and .md on 255-byte filesystems.
  let slug = "";
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const character of articleSlug(title)) {
    const size = encoder.encode(character).byteLength;
    if (bytes + size > 200) break;
    slug += character;
    bytes += size;
  }
  slug = slug.replace(/-+$/g, "") || "saved-article";
  return /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(slug) ? `${slug}-article` : slug;
}
