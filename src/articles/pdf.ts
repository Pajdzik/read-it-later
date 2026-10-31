import type { Env, OriginalPdf } from '../contracts';
import { BodyTooLargeError, ValidationError } from './validation';
import { errorResponse, PRIVATE_HEADERS } from '../http';

export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const ASSET_TTL_MS = 24 * 60 * 60_000;
export const assetId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
export const isPdf = (bytes: Uint8Array): boolean => new TextDecoder().decode(bytes.subarray(0, 5)) === '%PDF-';
export const assetKey = (id: string): string => `pdf/${id}.pdf`;
export async function checksum(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
export async function readBytes(body: ReadableStream<Uint8Array> | null, limit: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (!body) throw new ValidationError('A file body is required');
  signal?.throwIfAborted();
  const reader = body.getReader();
  const abort=()=>{ void reader.cancel().catch(()=>undefined); };
  signal?.addEventListener('abort',abort,{once:true});
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new BodyTooLargeError('The file exceeds the size limit');
      chunks.push(value);
    }
    signal?.throwIfAborted();
  } finally { signal?.removeEventListener('abort',abort); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
export interface PdfAsset extends OriginalPdf { objectKey: string }
export async function stagePdf(env: Pick<Env, 'DB' | 'PDF_BUCKET'>, bytes: Uint8Array<ArrayBuffer>, sourceUrl: string, capturedAt = new Date().toISOString()): Promise<PdfAsset> {
  if (!env.PDF_BUCKET) throw new Error('pdf_storage_unavailable');
  if (!isPdf(bytes) || bytes.length > MAX_PDF_BYTES) throw new ValidationError('Invalid PDF file');
  const id = crypto.randomUUID();
  const pdf: PdfAsset = { id, objectKey: assetKey(id), checksum: await checksum(bytes), bytes: bytes.length, capturedAt, sourceUrl };
  // Register before writing: a crash can only leave a recoverable, unreferenced row.
  await env.DB.prepare('INSERT INTO pdf_assets(id,object_key,checksum,bytes,captured_at,source_url,cleanup_at) VALUES(?,?,?,?,?,?,?)')
    .bind(id, pdf.objectKey, pdf.checksum, pdf.bytes, capturedAt, sourceUrl, new Date(Date.now() + ASSET_TTL_MS).toISOString()).run();
  await env.PDF_BUCKET.put(pdf.objectKey, bytes, { httpMetadata: { contentType: 'application/pdf' }, sha256: pdf.checksum });
  return pdf;
}
export function pdfSummary(row: Record<string, unknown>): OriginalPdf {
  return { id: String(row.id), checksum: String(row.checksum), bytes: Number(row.bytes), capturedAt: String(row.captured_at), sourceUrl: String(row.source_url) };
}
export async function getOriginalPdf(db: D1Database, articleId: string): Promise<OriginalPdf | undefined> {
  const row = await db.prepare('SELECT p.* FROM pdf_assets p JOIN articles a ON a.pdf_asset_id=p.id WHERE a.id=? AND p.deleting=0').bind(articleId).first<Record<string, unknown>>();
  return row ? pdfSummary(row) : undefined;
}
export async function originalPdfSummaries(db: D1Database, ids: string[]): Promise<Map<string, OriginalPdf>> {
  const found = new Map<string, OriginalPdf>();
  for (let i = 0; i < ids.length; i += 80) {
    const group = ids.slice(i, i + 80);
    const { results } = await db.prepare(`SELECT p.*,a.id AS article_id FROM articles a JOIN pdf_assets p ON p.id=a.pdf_asset_id WHERE p.deleting=0 AND a.id IN (${group.map(() => '?').join(',')})`).bind(...group).all<Record<string, unknown>>();
    for (const row of results) found.set(String(row.article_id), pdfSummary(row));
  }
  return found;
}
export async function servePdf(request: Request, env: Env, id: string): Promise<Response> {
  const selected = new URL(request.url).searchParams.get('asset');
  if (selected !== null && !assetId(selected)) return errorResponse(400,'invalid_request','Invalid PDF asset ID.');
  let pdf: OriginalPdf | undefined;
  if (selected) {
    const row = await env.DB.prepare(`SELECT p.* FROM pdf_assets p WHERE p.id=? AND p.deleting=0
      AND EXISTS(SELECT 1 FROM articles a WHERE a.id=? AND (a.pdf_asset_id=p.id OR EXISTS(
        SELECT 1 FROM article_capture_recovery r WHERE r.article_id=a.id AND r.pdf_asset_id=p.id)))`)
      .bind(selected,id).first<Record<string,unknown>>();
    pdf = row ? pdfSummary(row) : undefined;
  } else pdf = await getOriginalPdf(env.DB, id);
  if (!pdf || !env.PDF_BUCKET) return errorResponse(404, 'not_found', 'Saved PDF not found.');
  const headers = new Headers({ ...PRIVATE_HEADERS, 'Content-Type': 'application/pdf', 'Accept-Ranges': 'bytes', 'Content-Disposition': `${new URL(request.url).searchParams.get('download') === '1' ? 'attachment' : 'inline'}; filename="${id}.pdf"`, 'Content-Security-Policy': "sandbox; default-src 'none'; frame-ancestors 'none'" });
  let range: { offset: number; length: number } | undefined;
  headers.set('ETag', `"${pdf.checksum}"`);
  const ifRange = request.headers.get('if-range');
  const raw = !ifRange || ifRange === headers.get('ETag') ? request.headers.get('range') : null;
  if (raw) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(raw);
    let start = Number(match?.[1] || 0), end = match?.[2] ? Number(match[2]) : pdf.bytes - 1;
    if (match && !match[1] && match[2]) { start = Math.max(0, pdf.bytes - Number(match[2])); end = pdf.bytes - 1; }
    if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= pdf.bytes || end < start) {
      headers.set('Content-Range', `bytes */${pdf.bytes}`); return new Response(null, { status: 416, headers });
    }
    end = Math.min(end, pdf.bytes - 1); range = { offset: start, length: end - start + 1 };
    headers.set('Content-Range', `bytes ${start}-${end}/${pdf.bytes}`);
  }
  const object = await env.PDF_BUCKET.get(assetKey(pdf.id), range ? { range } : undefined);
  if (!object) return errorResponse(503, 'pdf_unavailable', 'The saved PDF is temporarily unavailable.');
  headers.set('Content-Length', String(range?.length ?? pdf.bytes));
  return new Response(object.body, { status: range ? 206 : 200, headers });
}
const unreferenced = `NOT EXISTS(SELECT 1 FROM articles WHERE pdf_asset_id=pdf_assets.id)
 AND NOT EXISTS(SELECT 1 FROM article_capture_recovery WHERE pdf_asset_id=pdf_assets.id)
 AND NOT EXISTS(SELECT 1 FROM archive_records WHERE asset_id=pdf_assets.id)
 AND NOT EXISTS(SELECT 1 FROM archive_files WHERE asset_id=pdf_assets.id)`;
export async function cleanupPdfAssets(env: Env, now = new Date().toISOString()): Promise<void> {
  await env.DB.prepare('DELETE FROM archive_sessions WHERE id IN (SELECT id FROM archive_sessions WHERE expires_at<=? LIMIT 5)').bind(now).run();
  if (!env.PDF_BUCKET) return;
  // Claim in D1 before R2 deletion. Publishing only accepts non-deleting assets.
  const { results } = await env.DB.prepare(`UPDATE pdf_assets SET deleting=1 WHERE id IN
    (SELECT id FROM pdf_assets WHERE cleanup_at<=? AND ${unreferenced} LIMIT 25)
    RETURNING id,object_key`).bind(now).all<{ id: string; object_key: string }>();
  let failed = false;
  for (const row of results) {
    try {
      await env.PDF_BUCKET.delete(row.object_key);
      await env.DB.prepare(`DELETE FROM pdf_assets WHERE id=? AND deleting=1 AND ${unreferenced}`).bind(row.id).run();
    } catch {
      failed = true;
      await env.DB.prepare('UPDATE pdf_assets SET cleanup_at=? WHERE id=? AND deleting=1')
        .bind(new Date(Date.parse(now)+5*60_000).toISOString(),row.id).run();
    }
  }
  if (failed) throw new Error('pdf_cleanup_failed');
}
