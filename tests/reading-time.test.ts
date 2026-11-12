import { describe, expect, it } from "vitest";
import { estimateReadingTimeMinutes } from "../src/articles/reading-time";

describe("reading time", () => {
  it("rounds any positive estimate up to whole minutes", () => {
    expect(estimateReadingTimeMinutes("word")).toBe(1);
    expect(estimateReadingTimeMinutes("word ".repeat(240))).toBe(1);
    expect(estimateReadingTimeMinutes("word ".repeat(241))).toBe(2);
    expect(estimateReadingTimeMinutes("word ".repeat(960))).toBe(4);
  });

  it("counts prose across formatting, line breaks and table cells", () => {
    const markdown = [
      "# Heading",
      "",
      "> A [label](https://example.test/do/not/count).",
      "",
      "- One",
      "- Two",
      "",
      "| Three | Four |",
      "| --- | --- |",
      "| Five | Six |",
      "",
      "inter*leaved*",
      "word",
      "",
      "word ".repeat(229),
    ].join("\n");
    expect(estimateReadingTimeMinutes(markdown)).toBe(1);
    expect(estimateReadingTimeMinutes(markdown + "extra")).toBe(2);
  });

  it("skips metadata, HTML markup, code and images", () => {
    const excluded = [
      "\uFEFF---",
      "title: A title and description",
      "---",
      "",
      "<script>do not count this</script>",
      "",
      "<!-- no prose here -->",
      "",
      "    indented code",
      "",
      "```text",
      "fenced code",
      "```",
      "",
      "`inline code` ![image description](https://example.test/image.jpg) <span title=\"attribute words\"></span> …",
      "",
      "<https://example.test/an-autolink>",
    ].join("\r\n");
    expect(estimateReadingTimeMinutes(excluded)).toBeNull();
    expect(estimateReadingTimeMinutes(excluded + "\r\n\r\n" + "word ".repeat(240))).toBe(1);
    expect(estimateReadingTimeMinutes("---\nOrdinary prose\n\n---")).toBe(1);
  });

  it("segments Polish and Japanese text", () => {
    expect(estimateReadingTimeMinutes("żółć ".repeat(241))).toBe(2);
    expect(estimateReadingTimeMinutes("猫が好きです。".repeat(100))).toBe(2);
  });

  it("counts the entire maximum-size copy", () => {
    expect(estimateReadingTimeMinutes("a ".repeat(128 * 1024))).toBe(547);
  });
});
