import type { Env } from '../src/contracts';
import { CONVERSION_TIMEOUT_MS, MAX_SOURCE_HTML_BYTES } from '../src/articles/capture-limits';
import { MAX_MARKDOWN_BYTES, SourceFetchError, type CapturedArticle } from '../src/articles/capture-protocol';
import { assetId, assetKey, MAX_PDF_BYTES, pdfSummary, readBytes, stagePdf } from '../src/articles/pdf';

export interface ManagedEnv extends Pick<Env, 'DB' | 'PDF_BUCKET' | 'MANAGED_CONVERSION_ENABLED'> { AI?: { toMarkdown(file: MarkdownDocument, options?: ConversionRequestOptions): Promise<ConversionResponse> } }

function hasPdfText(markdown: string): boolean {
  // The converter returns this outline even for blank/image-only PDFs. Only
  // disregard its known generated outline, not arbitrary headings in a paper.
  const lines=markdown.trim().split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  if (lines[0] !== '# document.pdf' || lines[1] !== '## Contents') return lines.length > 0;
  return lines.slice(2).some(line=>!/^### Page \d+$/.test(line));
}

/** Only reachable through the Container's virtual outbound hostname, never the public fetch handler. */
export async function managedConversion(request: Request, env: ManagedEnv): Promise<Response> {
  const send = (article: CapturedArticle) => Response.json({ version: 1, ok: true, article });
  const url = new URL(request.url);
  if (request.method !== 'POST' || !['/html', '/pdf', '/stored-pdf'].includes(url.pathname)) return new Response(null, { status: 404 });
  if (env.MANAGED_CONVERSION_ENABLED !== 'true' || !env.AI) return Response.json({ version: 1, ok: false, error: { code: 'capture_paused', retryable: false } });
  let originalPdf: CapturedArticle['originalPdf'];
  try {
    const pdf = url.pathname !== '/html';
    const sourceUrl = decodeURIComponent(request.headers.get('X-Source-Url') || '');
    if (!/^https?:$/.test(new URL(sourceUrl).protocol)) throw new SourceFetchError('invalid_url', false);
    let bytes: Uint8Array<ArrayBuffer>;
    if (url.pathname === '/stored-pdf') {
      const id = request.headers.get('X-Pdf-Id');
      if (!assetId(id) || !env.PDF_BUCKET) throw new SourceFetchError('invalid_pdf', false);
      try {
        const row = await env.DB.prepare('SELECT * FROM pdf_assets WHERE id=? AND deleting=0').bind(id).first<Record<string, unknown>>();
        if (!row) throw new SourceFetchError('invalid_pdf', false);
        originalPdf = pdfSummary(row);
        const object = await env.PDF_BUCKET.get(assetKey(id));
        if (!object) throw new SourceFetchError('pdf_storage_unavailable', true);
        bytes = await readBytes(object.body, MAX_PDF_BYTES);
      } catch (error) {
        if (error instanceof SourceFetchError) throw error;
        throw new SourceFetchError('pdf_storage_unavailable', true);
      }
    } else {
      bytes = await readBytes(request.body, pdf ? MAX_PDF_BYTES : MAX_SOURCE_HTML_BYTES);
      if (pdf) {
        try { const { objectKey: _key, ...summary } = await stagePdf(env, bytes, sourceUrl); originalPdf = summary; }
        catch { throw new SourceFetchError('pdf_storage_unavailable', true); }
      }
    }
    let timer: ReturnType<typeof setTimeout>;
    let markdown: string;
    try {
      const result = await Promise.race([
        env.AI.toMarkdown({ name: pdf ? 'document.pdf' : 'article.html', blob: new Blob([bytes], { type: pdf ? 'application/pdf' : 'text/html' }) }, {
          conversionOptions: pdf ? { pdf: { metadata: false, images: { convert: false } } } : { html: { hostname: sourceUrl, images: { convert: false, convertOGImage: false } } },
        }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SourceFetchError('conversion_timeout', true)), CONVERSION_TIMEOUT_MS); }),
      ]);
      if (result.format === 'error' || typeof result.data !== 'string') throw new SourceFetchError('conversion_failed', false);
      markdown = result.data;
    } catch (error) {
      if (error instanceof SourceFetchError) throw error;
      throw new SourceFetchError('converter_unavailable', true);
    } finally { clearTimeout(timer!); }
    if (pdf ? !hasPdfText(markdown) : !markdown.trim()) throw new SourceFetchError(pdf ? 'pdf_no_text' : 'conversion_failed', false);
    if (new TextEncoder().encode(markdown).length > MAX_MARKDOWN_BYTES) throw new SourceFetchError('markdown_too_large', false);
    return send({ markdown, metadata: {}, ...(originalPdf ? { originalPdf } : {}) });
  } catch (error) {
    const failure = error instanceof SourceFetchError ? { code: error.code, retryable: error.retryable } : { code: 'conversion_failed', retryable: false };
    if (originalPdf) return send({ markdown: '', metadata: {}, originalPdf, conversionError: failure });
    return Response.json({ version: 1, ok: false, error: failure });
  }
}
