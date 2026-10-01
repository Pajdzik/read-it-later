import { describe, expect, it } from "vitest";
import { parseArticleMetadata } from "../src/articles/metadata";

describe("article metadata", () => {
  it("reads Open Graph details and a Twitter written-by card", () => {
    const metadata = parseArticleMetadata(`
      <html><head>
        <meta property="og:title" content="A useful article">
        <meta property="og:description" content="A short &amp; useful lead.">
        <meta name="twitter:label1" content="Written by">
        <meta name="twitter:data1" content="Alex Writer">
      </head></html>
    `);
    expect(metadata).toEqual({
      title: "A useful article",
      author: "Alex Writer",
      description: "A short & useful lead.",
    });
  });
});
