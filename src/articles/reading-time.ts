import MarkdownIt from "markdown-it";
import { splitMarkdownFrontMatter } from "./markdown-front-matter";

const wordsPerMinute = 240;
// Recognize raw HTML as tokens so markup can be skipped without rendering it.
const parser = new MarkdownIt({ html: true });
let segmenter: Intl.Segmenter | undefined;

export function estimateReadingTimeMinutes(markdown: string): number | null {
  try {
    segmenter ??= new Intl.Segmenter("en", { granularity: "word" });
    let words = 0;
    for (const token of parser.parse(splitMarkdownFrontMatter(markdown).body, {})) {
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
