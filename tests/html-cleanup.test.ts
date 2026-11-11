import { env as bindings } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { managedConversion, type ManagedEnv } from '../capture/managed';

function converter() {
  const toMarkdown = vi.fn(async (_document: MarkdownDocument, _options?: ConversionRequestOptions): Promise<ConversionResponse> => ({
    format: 'markdown', data: '# Converted article', tokens: 3, id: 'fixture', name: 'article.html', mimeType: 'text/html',
  }));
  return { toMarkdown };
}

async function convertedInput(url: string, html: string) {
  const AI = converter();
  const managed: ManagedEnv = { ...bindings, MANAGED_CONVERSION_ENABLED: 'true', AI };
  const response = await managedConversion(new Request('http://potem.convert/html', {
    method: 'POST', headers: { 'X-Source-Url': encodeURIComponent(url) }, body: html,
  }), managed);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, article: { markdown: '# Converted article' } });
  expect(AI.toMarkdown).toHaveBeenCalledTimes(1);
  return await AI.toMarkdown.mock.calls[0][0].blob.text();
}

describe('managed HTML cleanup', () => {
  it('cleans known global chrome and JSON-LD while preserving unknown article content', async () => {
    const input = await convertedInput('https://unknown.example/post', `<!doctype html><html><head>
      <meta property="og:title" content="metadata"><meta name="description" content="metadata">
      <script type="Application/LD+JSON">{"@type":"NewsArticle","headline":"metadata"}</script>
      </head><body><a href="#main-content">Skip to content</a><header role="banner">GLOBAL HEADER</header><main><article>
      <header><h1>Authored discussion</h1></header><p>Keep the contents and closing paragraph.</p>
      <h2>Table of contents</h2><ol><li><a href="#section">Discussion</a></li></ol>
      <p><a href="#main-content">An authored internal anchor.</a></p><footer>Article footer.</footer>
      <img data-image-placeholder src="/placeholder.gif"><img data-image-placeholder data-image-placeholder-media src="/diagram.png">
      <p>JSON-like example: {"@type":"NewsArticle"}</p></article></main>
      <footer role="contentinfo">GLOBAL FOOTER</footer></body></html>`);
    for (const removed of ['property="og:title"', 'name="description"', 'Application/LD+JSON', 'Skip to content', 'GLOBAL HEADER', 'GLOBAL FOOTER', '/placeholder.gif']) expect(input).not.toContain(removed);
    for (const kept of ['Authored discussion', 'closing paragraph.', 'Table of contents', 'href="#section"', 'An authored internal anchor.', 'Article footer.', 'JSON-like example:', 'href="#main-content"', '/diagram.png']) expect(input).toContain(kept);
  });

  it('preserves an article inside a landmark used as the page wrapper', async () => {
    const input = await convertedInput('https://unknown.example/wrapped-post', `<html><body>
      <div role="banner"><main><article><h1>Wrapped article</h1><p>Article content.</p></article></main></div>
      </body></html>`);
    expect(input).toContain('Wrapped article');
    expect(input).toContain('Article content.');
  });

  it('uses the Cloudflare article root and removes adjacent interface chrome only', async () => {
    const input = await convertedInput('https://blog.cloudflare.com/example', `<!doctype html><html><body><div><div>
      <header><nav class="h-header">GLOBAL NAV</nav></header></div><main id="main-content"><article><div class="post-layout">
      <div class="post-content"><header><h1>Cloudflare article</h1><p class="byline">By Ada Author</p></header>
      <div class="article-content"><p>Opening paragraph.</p><p>Closing paragraph.</p>
      <h2>Contents</h2><ol><li><a href="#section">Chart section</a></li></ol><table><tr><td>Traffic</td><td>42</td></tr></table>
      <figure><figcaption>Chart caption</figcaption><img src="/chart.png" alt="Chart"></figure>
      </div><a href="#main-content">Article internal link</a></div>
      <aside class="post-extras">RELATED TAGS</aside><div class="post-email">EMAIL SIGNUP</div>
      <section class="post-discuss">DISCUSSION</section></div></article></main>
      <div><footer class="bg-footer">GLOBAL FOOTER</footer></div></div></body></html>`);
    for (const kept of ['Cloudflare article', 'By Ada Author', 'Opening paragraph.', 'Closing paragraph.', 'href="#section"', 'Traffic', 'Chart caption', 'chart.png', 'Article internal link']) expect(input).toContain(kept);
    for (const removed of ['GLOBAL NAV', 'GLOBAL FOOTER', 'RELATED TAGS', 'EMAIL SIGNUP', 'DISCUSSION']) expect(input).not.toContain(removed);
  });

  it('leaves Cloudflare widget chrome when its editorial root is duplicated', async () => {
    const input = await convertedInput('https://blog.cloudflare.com/ambiguous', `<main id="main-content"><article><div class="post-layout">
      <div class="post-content"><div class="article-content"><p>First root.</p></div></div>
      <div class="post-content"><div class="article-content"><p>Second root.</p></div></div>
      <section class="post-extras">Keep ambiguous widget.</section></div></article></main>`);
    expect(input).toContain('First root.');
    expect(input).toContain('Second root.');
    expect(input).toContain('Keep ambiguous widget.');
  });

  it('keeps Simon Willison post content while removing body-level page furniture', async () => {
    const input = await convertedInput('https://simonwillison.net/2026/example/', `<html><body>
      <div id="smallhead">SMALL HEADER</div><div id="sponsored-banner">SPONSOR</div>
      <div id="wrapper"><div id="primary"><article><header><h1>Simon post</h1></header><p>Post body.</p>
      <p class="byline">By Simon Willison</p><table><tr><td>Result</td></tr></table><footer>Article footer.</footer></article></div></div>
      <footer id="ft">SITE FOOTER</footer></body></html>`);
    for (const kept of ['Simon post', 'Post body.', 'By Simon Willison', 'Result', 'Article footer.']) expect(input).toContain(kept);
    for (const removed of ['SMALL HEADER', 'SPONSOR', 'SITE FOOTER']) expect(input).not.toContain(removed);
  });

  it('keeps Seldo post content while removing exact adjacent recommendations', async () => {
    const input = await convertedInput('https://seldo.com/posts/example', `<div class="subpageContainer"><div class="postPage">
      <div class="postBody"><header><h1>Seldo post</h1></header><p>Byline by Alex</p><p>Substantive discussion.</p><footer>Article footer.</footer></div>
      <div class="postTags">TAGS</div><section class="relatedSection">RELATED POSTS</section>
      <section class="authorSection">AUTHOR BIO</section></div></div>`);
    for (const kept of ['Seldo post', 'Byline by Alex', 'Substantive discussion.', 'Article footer.']) expect(input).toContain(kept);
    for (const removed of ['TAGS', 'RELATED POSTS', 'AUTHOR BIO']) expect(input).not.toContain(removed);
    const uncertain = await convertedInput('https://seldo.com/posts/other', `<div class="subpageContainer"><div class="postPage">
      <div class="postBody"><p>Keep discussion.</p><aside class="postTagsRelated">An uncertain similarly named section.</aside></div>
      <section class="possiblyRelated">Keep uncertain section.</section></div></div>`);
    expect(uncertain).toContain('An uncertain similarly named section.');
    expect(uncertain).toContain('Keep uncertain section.');
  });

  it('guards native and custom Substack cleanup and preserves byline, teaser, and paywall', async () => {
    const content = `<div id="main"><div class="single-post-container" aria-label="Post">
      <nav data-testid="navbar" class="main-menu">NAVBAR</nav><div><article class="newsletter-post post"><header class="post-header">
      <p class="byline">By Substack writer</p><div aria-label="Post UFI"><div class="post-ufi">REACTIONS</div></div></header>
      <div><div class="dt-post-body"><div class="available-content"><div class="body markup"><h1>Substack story</h1>
      <p>Free teaser.</p><footer class="post-footer">Keep prose footer.</footer></div></div></div>
      <div data-testid="paywall" data-component-name="Paywall">PAID CONTINUATION</div>
      <footer class="post-footer">POST CONTROLS</footer></div></article>
      <section id="discussion">COMMENTS</section><div><footer data-component-name="SubscribeFooter">SUBSCRIBE FOOTER</footer></div></div>
      <footer class="publication-footer footer-wrap">PUBLICATION FOOTER</footer></div></div>`;
    const native = await convertedInput('https://writer.substack.com/p/story', content);
    for (const kept of ['By Substack writer', 'Substack story', 'Free teaser.', 'Keep prose footer.', 'PAID CONTINUATION']) expect(native).toContain(kept);
    for (const removed of ['NAVBAR', 'REACTIONS', 'POST CONTROLS', 'COMMENTS', 'SUBSCRIBE FOOTER', 'PUBLICATION FOOTER']) expect(native).not.toContain(removed);

    const custom = await convertedInput('https://writer.example/p/story', `<html><head><link rel="preconnect" href="https://substackcdn.com"></head><body>${content}</body></html>`);
    for (const kept of ['Substack story', 'By Substack writer', 'PAID CONTINUATION', 'Keep prose footer.']) expect(custom).toContain(kept);
    expect(custom).not.toContain('POST CONTROLS');

    const unguarded = await convertedInput('https://notsubstack.com/p/story', content);
    expect(unguarded).toContain('NAVBAR');
    expect(unguarded).toContain('POST CONTROLS');
    const ambiguous = await convertedInput('https://writer.example/p/story', `<html><head><link rel="preconnect" href="https://substackcdn.com"></head><body>
      <article class="newsletter-post post"><div><div class="dt-post-body"><div class="available-content"><div class="body markup"><p>Keep this lookalike section.</p></div></div></div>
      <footer class="post-footer-note">Keep ambiguous footer.</footer></div></article></body></html>`);
    expect(ambiguous).toContain('Keep this lookalike section.');
    expect(ambiguous).toContain('Keep ambiguous footer.');
  });

  it('guards swistak.codes content and strips only recognized direct footer and comments', async () => {
    const input = await convertedInput('https://swistak.codes/post/example/', `<main><article><div class="utility post_contentContainer__abc">
      <div class="common_contentWrapper__def post_coverCaption__jkl">Cover caption.</div>
      <div class="common_contentWrapper__def"><div class="post_wrapper__ghi"><h1>Swistak story</h1><p>Technical discussion.</p>
      <table><tr><td>Key</td><td>Value</td></tr></table></div></div>
      <div class="post-footer_postFooterContainer__abc">SHARE FOOTER</div><div class="post_comments__xyz">COMMENTS</div>
      <div class="utility post-footer_postFooterContainer__abc">FOLLOW FOOTER</div>
      <div class="not-post_comments__xyz">UNCERTAIN RELATED</div></div></article></main>`);
    for (const kept of ['Swistak story', 'Cover caption.', 'Technical discussion.', 'Key', 'Value', 'UNCERTAIN RELATED']) expect(input).toContain(kept);
    for (const removed of ['SHARE FOOTER', 'FOLLOW FOOTER', 'COMMENTS']) expect(input).not.toContain(removed);
    const uncertain = await convertedInput('https://swistak.codes/other/', `<main><article><div class="utility post_contentContainer__abc">
      <div class="common_contentWrapper__def"><div class="post_wrapper__ghi"><p>Discussion should remain.</p></div>
      <div class="post-footer-ish">Keep uncertain footer.</div></div></div></article></main>`);
    expect(uncertain).toContain('Discussion should remain.');
    expect(uncertain).toContain('Keep uncertain footer.');
  });
});
