import Defuddle from 'defuddle/full';

declare global { interface Window { __potemExtract?: () => unknown } }

function plainText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return text || undefined;
}

window.__potemExtract = () => {
  const sourceUrl = location.href;
  if (!/^https?:$/.test(location.protocol) || /\.pdf(?:$|[?#])/i.test(sourceUrl)) return { error: 'unsupported', sourceUrl, title: document.title };
  if (new TextEncoder().encode(sourceUrl).byteLength > 8192) return { error: 'unsupported', sourceUrl: sourceUrl.slice(0, 8192), title: document.title };
  try {
    const detached = document.implementation.createHTMLDocument('');
    detached.replaceChild(document.documentElement.cloneNode(true), detached.documentElement);
    const result = new Defuddle(detached, { url: sourceUrl, markdown: true, useAsync: false }).parse();
    if (location.href !== sourceUrl) return { error: 'navigation', sourceUrl, title: document.title };
    const markdown = typeof result.content === 'string' ? result.content : '';
    if (!markdown.trim()) return { error: 'empty', sourceUrl, title: plainText(result.title, 500) || document.title };
    if (new TextEncoder().encode(markdown).byteLength > 262144) return { error: 'oversized', sourceUrl, title: plainText(result.title, 500) || document.title };
    return {
      sourceUrl,
      title: plainText(result.title, 500) || plainText(document.title, 500) || sourceUrl.slice(0, 500),
      author: plainText(result.author, 200), description: plainText(result.description, 500), markdown,
    };
  } catch { return { error: 'failed', sourceUrl, title: document.title }; }
};
