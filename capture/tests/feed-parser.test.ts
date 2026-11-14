import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFeed } from "../feed-parser";

test("RSS 2 parses readable text, relative links and distinct GUIDs", () => {
  const result = parseFeed(`<?xml version="1.0"?><rss version="2.0"><channel><title>News &amp; Notes</title>
    <item><guid>urn:story:1</guid><title>First</title><link>/one</link><description><![CDATA[<p>Hello <b>reader</b><script>bad()</script></p>]]></description><pubDate>Tue, 01 Jan 2030 00:00:00 GMT</pubDate></item>
    <item><guid>urn:story:1</guid><title>Duplicate</title><link>/two</link></item>
    <item><title>Not a webpage</title><link>mailto:editor@example.com</link></item></channel></rss>`, "https://news.example/feed.xml");
  assert.equal(result.title, "News & Notes");
  assert.deepEqual(result.items, [{ key: "urn:story:1", url: "https://news.example/one", title: "First", preview: "Hello reader", publishedAt: "2030-01-01T00:00:00.000Z" }]);
});

test("Atom prefers alternate links, strips HTML markup and supports empty feeds", () => {
  const result = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><entry><id>id-1</id><title>Story</title>
    <link rel="self" href="/feed"/><link href="/story"/><summary type="html">&lt;p&gt;Plain &amp;amp; clear&lt;/p&gt;</summary>
    <published>2031-04-03T00:00:00Z</published></entry></feed>`, "https://news.example/atom");
  assert.deepEqual(result.items, [{ key: "id-1", url: "https://news.example/story", title: "Story", preview: "Plain & clear", publishedAt: "2031-04-03T00:00:00.000Z" }]);
  assert.deepEqual(parseFeed(`<rss><channel><title>Nothing</title></channel></rss>`, "https://news.example/feed"), { title: "Nothing", items: [] });
});

test("feed parser refuses DTD and entity declarations", () => {
  assert.throws(() => parseFeed(`<!DOCTYPE rss [<!ENTITY title "Example">]><rss><channel><title>&title;</title></channel></rss>`, "https://news.example/feed"));
});

test("namespaced RSS metadata provides a readable fallback preview", () => {
  const result = parseFeed(`<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:content="http://purl.org/rss/1.0/modules/content/">
    <channel><title>RSS 1.0</title></channel><item><title>Story</title><link>/story</link><content:encoded><![CDATA[<p>Preview text.</p>]]></content:encoded></item>
    </rdf:RDF>`, "https://news.example/feed");
  assert.equal(result.title, "RSS 1.0");
  assert.equal(result.items[0].preview, "Preview text.");
});

test("feed excerpts preserve paragraphs and omit repeated headings and tag metadata", () => {
  const result = parseFeed(`<rss><channel><title>Example</title><item><guid>release-1</guid><title>Plugin 1.0</title><link>/plugin-1</link>
    <description><![CDATA[<p><strong>Release:</strong> <a href="/plugin-1">Plugin 1.0</a></p><p>A useful first paragraph.</p><p>More detail about PG&amp;E.</p><p><strong>Tags:</strong> maps, plugins</p>]]></description>
    </item></channel></rss>`, "https://news.example/feed");
  assert.equal(result.items[0].preview, "A useful first paragraph.\nMore detail about PG&E.");
});
