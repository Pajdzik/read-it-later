import MarkdownIt from "markdown-it";
import { isMap, parseDocument } from "yaml";

const wordsPerMinute = 240;
// Recognize raw HTML as tokens so markup can be skipped without rendering it.
const parser = new MarkdownIt({ html: true });
let segmenter: Intl.Segmenter | undefined;

function markdownBody(markdown: string): string {
  const opening = /^\uFEFF?---[ \t]*(?:\r\n?|\n)/u.exec(markdown);
  if (!opening) return markdown;
  const rest = markdown.slice(opening[0].length);
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r\n?|\n|$)/mu.exec(rest);
  if (!closing) return markdown;
  const frontMatter = parseDocument(rest.slice(0, closing.index), {
    prettyErrors: false,
    uniqueKeys: false,
  });
  // A pair of horizontal rules around prose is valid Markdown.
  return frontMatter.errors.length === 0 && isMap(frontMatter.contents)
    ? rest.slice(closing.index + closing[0].length)
    : markdown;
}

export function estimateReadingTimeMinutes(markdown: string): number | null {
  try {
    segmenter ??= new Intl.Segmenter("en", { granularity: "word" });
    let words = 0;
    for (const token of parser.parse(markdownBody(markdown), {})) {
      if (token.type !== "inline" || !token.children) continue;
      const text: string[] = [];
      let autolink = false;
      for (const child of token.children) {
        switch (child.type) {
          case "text":
            if (!autolink) text.push(child.content);
            break;
          case "link_open":
            autolink = child.markup === "autolink";
            if (autolink) text.push(" ");
            break;
          case "link_close":
            autolink = false;
            break;
          case "softbreak":
          case "hardbreak":
          case "image":
          case "code_inline":
            text.push(" ");
            break;
        }
      }
      for (const part of segmenter.segment(text.join(""))) {
        if (part.isWordLike) words++;
      }
    }
    return words > 0 ? Math.ceil(words / wordsPerMinute) : null;
  } catch {
    return null;
  }
}
