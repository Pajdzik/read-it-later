import { isMap, parseDocument } from "yaml";

/** Recognize leading YAML metadata without mistaking Markdown rules for a header. */
export function splitMarkdownFrontMatter(markdown: string) {
  const opening = /^\uFEFF?---[ \t]*(?:\r\n?|\n)/u.exec(markdown);
  if (!opening) return { body: markdown };
  const rest = markdown.slice(opening[0].length);
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r\n?|\n|$)/mu.exec(rest);
  if (!closing) return { body: markdown };
  const document = parseDocument(rest.slice(0, closing.index), { prettyErrors: false, uniqueKeys: false });
  if (document.errors.length || !isMap(document.contents)) return { body: markdown };
  return { body: rest.slice(closing.index + closing[0].length), fields: document.contents };
}
