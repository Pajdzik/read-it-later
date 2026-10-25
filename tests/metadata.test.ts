import { describe, expect, it } from "vitest";
import { parseArticleMetadata } from "../src/articles/metadata";
import { parseArticleDocument } from "../src/articles/extraction";

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

  it("reads metadata and the lead paragraph from a shared parsed document", () => {
    const document = parseArticleDocument(`<html><head><title>Fallback title</title><meta property="og:description" content="A &amp;amp; B"></head><body><article><p>Ignored because metadata exists.</p></article></body></html>`);
    expect(parseArticleMetadata(document)).toEqual({ title: "Fallback title", description: "A &amp; B" });

    const fallback = parseArticleDocument(`<html><body><main><p>First &amp; foremost.</p><p>Second paragraph.</p></main></body></html>`);
    expect(parseArticleMetadata(fallback).description).toBe("First & foremost.");
  });

  it("keeps string and document inputs aligned for entities and ignores commented-out tags", () => {
    const html = `<!-- <meta property="og:title" content="Fake title"> -->
      <html><head><title>Title &amp; details</title>
        <meta property="og:title" content="Real &amp;amp; useful">
        <meta property="og:description" content="Encoded &amp;amp; text">
        <meta name="author" content="A &amp;amp; B">
      </head><body><article><p>Lead &amp;amp; paragraph.</p></article></body></html>`;
    const stringResult = parseArticleMetadata(html);
    const documentResult = parseArticleMetadata(parseArticleDocument(html));
    expect(stringResult).toEqual(documentResult);
    expect(stringResult).toEqual({
      title: "Real &amp; useful",
      author: "A &amp; B",
      description: "Encoded &amp; text",
    });
  });
});
