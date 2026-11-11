/** Remove verified publisher interface chrome before HTML-to-Markdown conversion. */
type Profile = { root: string; chrome: string[] };

const cloudflareLayout = 'main#main-content > article > .post-layout';
const cloudflarePost = `${cloudflareLayout} > .post-content`;

const swistakContainer = 'main > article > div[class*="post_contentContainer__"]';
const swistak: Profile = {
  root: `${swistakContainer} > div[class*="common_contentWrapper__"] > div[class*="post_wrapper__"]`,
  chrome: [],
};

const substack: Profile = {
  root: 'article.newsletter-post.post .dt-post-body > .available-content > .body.markup',
  chrome: [
    '#main [data-testid="navbar"].main-menu', '#main .publication-footer.footer-wrap',
    'article.newsletter-post.post > div > .post-footer',
    '#main .single-post-container[aria-label="Post"] > div > #discussion',
    'article.newsletter-post.post > .post-header [aria-label="Post UFI"] > .post-ufi',
    '#main .single-post-container[aria-label="Post"] > div > div > [data-component-name="SubscribeFooter"]',
  ],
};

const profiles = new Map<string, Profile>([
  ['blog.cloudflare.com', {
    root: `${cloudflarePost} > .article-content`,
    chrome: [
      'body > div > div > header > nav.h-header', 'body > div > div > footer.bg-footer',
      'body > #ai-search-dialog', 'body > #mobile-menu', `${cloudflareLayout} > .post-discuss`,
      `${cloudflareLayout} > .post-extras`, `${cloudflareLayout} > .post-email`,
      `${cloudflarePost} > header button.copy-url-btn`, `${cloudflarePost} > button.back-to-top`,
      `${cloudflarePost} > .image-lightbox`,
    ],
  }],
  ['simonwillison.net', {
    root: 'body > #wrapper > #primary',
    chrome: ['body > #smallhead', 'body > #sponsored-banner', 'body > #ft'],
  }],
  ['seldo.com', {
    root: '.subpageContainer .postPage > .postBody',
    chrome: [
      '.subpageContainer .postPage > .postTags', '.subpageContainer .postPage > .relatedSection',
      '.subpageContainer .postPage > .authorSection', 'body > nav.siteNav', 'body > footer.siteFooter',
    ],
  }],
  ['swistak.codes', swistak],
]);

function isNativeSubstack(host: string): boolean {
  return host === 'substack.com' || host.endsWith('.substack.com');
}

function hasClassPrefix(element: Element, prefix: string): boolean {
  return (element.getAttribute('class') || '').split(/\s+/).some(token => token.startsWith(prefix));
}

/** Inspect the original bounded bytes once to gate all targeted publisher selectors. */
async function inspect(html: Uint8Array<ArrayBuffer>, profile: Profile | undefined, customSubstackCandidate: boolean) {
  let articleCount = 0;
  let articleHasText = false;
  let rootCount = 0;
  let rootHasText = false;
  let hasSubstackMarker = false;
  // The generic landmarks must be siblings of the main region. Some sites use a
  // landmark on the page wrapper, which can contain the article itself.
  const rewrite = new HTMLRewriter().on('body > main > article', {
    element() { articleCount++; },
    text(text) { if (text.text.trim()) articleHasText = true; },
  });
  if (profile) {
    rewrite.on(profile.root, {
      element(element) {
        if (profile !== swistak || hasClassPrefix(element, 'post_wrapper__')) rootCount++;
      },
      text(text) { if (text.text.trim()) rootHasText = true; },
    });
  }
  if (customSubstackCandidate) {
    rewrite.on('head link[rel="preconnect"][href="https://substackcdn.com"]', { element() { hasSubstackMarker = true; } });
  }
  const response = rewrite.transform(new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
  await response.body?.pipeTo(new WritableStream());
  return {
    hasUniqueArticle: articleCount === 1 && articleHasText,
    hasUniqueProfileBody: rootCount === 1 && rootHasText,
    hasSubstackMarker,
  };
}

function remove(rewrite: HTMLRewriter, selectors: string[]): void {
  for (const selector of selectors) rewrite.on(selector, { element(element) { element.remove(); } });
}

/**
 * One inspection pass gates a single rewrite pass. The input is already limited by
 * MAX_SOURCE_HTML_BYTES; use bytes throughout and let managed conversion fall back to
 * the original source if parsing or rewriting fails.
 */
export async function cleanCapturedHtml(html: Uint8Array<ArrayBuffer>, url: URL): Promise<Uint8Array<ArrayBuffer>> {
  const host = url.hostname;
  const knownProfile = isNativeSubstack(host) ? substack : profiles.get(host);
  const customSubstackCandidate = !knownProfile && /^\/p\/[^/]+(?:\/|$)/.test(url.pathname);
  const candidate = customSubstackCandidate ? substack : knownProfile;
  const scan = await inspect(html, candidate, customSubstackCandidate);

  const rewrite = new HTMLRewriter()
    // Metadata is captured separately before this conversion request.
    .on('script[type="application/ld+json" i]', { element(element) { element.remove(); } })
    .on('meta[property^="og:"]', { element(element) { element.remove(); } })
    .on('meta[name="description"]', { element(element) { element.remove(); } })
    .on('meta[name^="twitter:"]', { element(element) { element.remove(); } })
    // Only page-direct skip controls are generic; preserve anchors in article content.
    .on('body > a[href="#main-content"]', { element(element) { element.remove(); } })
    .on('body > a.skip-link[href^="#"]', { element(element) { element.remove(); } })
    .on('body > a[data-skip-link][href^="#"]', { element(element) { element.remove(); } })
    .on('img[data-image-placeholder]', {
      element(element) { if (!element.hasAttribute('data-image-placeholder-media')) element.remove(); },
    });

  if (scan.hasUniqueArticle) remove(rewrite, ['body > [role="banner"]', 'body > [role="contentinfo"]']);
  if (candidate && scan.hasUniqueProfileBody && (!customSubstackCandidate || scan.hasSubstackMarker)) {
    remove(rewrite, candidate.chrome);
    if (candidate === swistak) {
      for (const prefix of ['post-footer_postFooterContainer__', 'post_comments__']) {
        rewrite.on(`${swistakContainer} > div[class*="${prefix}"]`, {
          element(element) { if (hasClassPrefix(element, prefix)) element.remove(); },
        });
      }
    }
  }
  return new Uint8Array(await rewrite.transform(new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })).arrayBuffer());
}
