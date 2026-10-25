export const fixtureNames = ["small", "typical", "large", "clutter", "malformed", "output-limit"] as const;
export type FixtureName = typeof fixtureNames[number];

function paragraph(index: number): string {
  return `<p>Section ${index}: This public synthetic article explains how to preserve readable text. Keep <strong>important formatting</strong>, <em>emphasis</em>, and <a href="/related">related reading</a>. Each paragraph includes enough varied prose to exercise article extraction without using private library content.</p>`;
}

export function extractionFixture(name: FixtureName): string {
  const header = '<!doctype html><html><head><title>Worker extraction fixture</title><meta name="author" content="Fixture Author"></head><body>';
  const article = `<article><h1>Preserving readable articles</h1>${Array.from({ length: name === "small" ? 4 : 80 }, (_, i) => paragraph(i)).join("")}<pre><code class="language-js">const saved = true;</code></pre><table><tr><th>Case</th><th>Result</th></tr><tr><td>Worker</td><td>Readable</td></tr></table></article>`;
  if (name === "output-limit") return header + `<article><h1>Large output</h1><p>${"Preserved text. ".repeat(20_000)}</p></article></body></html>`;
  if (name === "malformed") return header + '<main><div><h1>Malformed but readable</h1>' + Array.from({ length: 80 }, (_, i) => paragraph(i).replace(/<\/p>$/, "")).join("");
  if (name === "large") {
    // Close to the 512 KiB input cap, with many DOM nodes and bounded readable output.
    const row = '<p>' + '<span class="article-word">Readable words. </span>'.repeat(15) + '</p>';
    const available = 512 * 1024 - header.length - 100;
    return header + '<article><h1>Large structured article</h1>' + row.repeat(Math.floor(available / row.length)) + '</article></body></html>';
  }
  if (name === "clutter") {
    const shell = header + article + '</body></html>';
    const item = '<a href="/navigation">Navigation clutter</a>';
    const navigation = item.repeat(Math.floor((512 * 1024 - shell.length - 32) / item.length));
    return header + '<nav>' + navigation + '</nav>' + article + '</body></html>';
  }
  return header + '<nav><a href="/home">Navigation clutter</a></nav>' + article + '</body></html>';
}
