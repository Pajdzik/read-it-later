import type { Env, OriginalPdf } from '../contracts';
import { errorResponse, jsonResponse, PRIVATE_HEADERS } from '../http';
import { assetId, assetKey, ASSET_TTL_MS, checksum, MAX_PDF_BYTES, readBytes, stagePdf } from '../articles/pdf';
import { importArticles, validateLibrary } from '../articles/library-import';
import { parseObject, readJson, ValidationError } from '../articles/validation';
import { iteratorStream, streamChunks, zipFiles, type ZipFile } from './zip';
import { MAX_ARCHIVE_METADATA_BYTES } from './limits';

const encode = (s: string) => new TextEncoder().encode(s);
const iso = () => new Date().toISOString();
interface RecordRow { article_id: string; record: string; asset_id: string | null; pdf_info: string | null }
export interface ArchivePdf extends OriginalPdf { articleId: string }
export function validateArchivePdf(value: unknown): ArchivePdf {
  const p = parseObject(value, ['id','checksum','bytes','capturedAt','sourceUrl','articleId'], ['id','checksum','bytes','capturedAt','sourceUrl','articleId']);
  if (!assetId(p.id) || typeof p.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(p.checksum) ||
    typeof p.bytes !== 'number' || !Number.isInteger(p.bytes) || p.bytes < 5 || p.bytes > MAX_PDF_BYTES ||
    typeof p.capturedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(p.capturedAt) || !Number.isFinite(Date.parse(p.capturedAt)) ||
    typeof p.sourceUrl !== 'string' || p.sourceUrl.length > 8192 || !/^https?:\/\//.test(p.sourceUrl) ||
    new Date(p.capturedAt).toISOString() !== p.capturedAt ||
    typeof p.articleId !== 'string' || !/^[a-z0-9]{8}$/.test(p.articleId)) throw new ValidationError('Invalid PDF manifest entry');
  return { id: p.id, checksum: p.checksum, bytes: p.bytes, capturedAt: p.capturedAt, sourceUrl: p.sourceUrl, articleId: p.articleId };
}
async function* records(env: Env, session: string, pdfOnly = false): AsyncGenerator<RecordRow> {
  let cursor = '';
  while (true) {
    const { results } = await env.DB.prepare(`SELECT article_id,record,asset_id,pdf_info FROM archive_records WHERE session_id=? AND article_id>? ${pdfOnly ? 'AND asset_id IS NOT NULL' : ''} ORDER BY article_id LIMIT 25`)
      .bind(session, cursor).all<RecordRow>();
    for (const row of results) { cursor = row.article_id; yield row; }
    if (results.length < 25) break;
  }
}
async function* jsonPart(env: Env, id: string, prefix: string, manifest = false): AsyncGenerator<Uint8Array> {
  yield encode(prefix); let count = 0;
  for await (const row of records(env, id, manifest)) yield encode(`${count++ ? ',' : ''}${manifest ? row.pdf_info : row.record}`);
  yield encode(']}');
}
async function remainingImportRecords(db: D1Database, id: string): Promise<{n:number} | null> {
  return db.prepare(`SELECT (SELECT COUNT(*) FROM archive_records r WHERE r.session_id=s.id AND r.committed=0) AS n
    FROM archive_sessions s WHERE s.id=? AND s.kind='import' AND s.completed=1
      AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')`).bind(id).first<{n:number}>();
}
async function exportArchive(env: Env): Promise<Response> {
  if (!env.PDF_BUCKET) return errorResponse(503, 'archive_unavailable', 'PDF archive storage is not configured.');
  const id = crypto.randomUUID(), now = iso(), expiry = new Date(Date.now() + ASSET_TTL_MS).toISOString();
  const article = `json_object('id',a.id,'url',a.url,'title',a.title,'author',a.author,'description',a.description,'createdAt',a.created_at,'updatedAt',a.updated_at,'readAt',a.read_at)`;
  const copy = `CASE WHEN c.article_id IS NULL THEN '{}' ELSE json_object('copy',json_object('markdown',c.markdown,'capturedAt',c.captured_at,'source',c.source,'revision',c.revision)) END`;
  const pdf = `CASE WHEN p.id IS NULL THEN NULL ELSE json_object('articleId',a.id,'id',p.id,'checksum',p.checksum,'bytes',p.bytes,'capturedAt',p.captured_at,'sourceUrl',p.source_url) END`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO archive_sessions(id,kind,expires_at) VALUES(?,'export',?)").bind(id, expiry),
    env.DB.prepare(`INSERT INTO archive_records(session_id,article_id,record,asset_id,pdf_info,normalized_url)
      SELECT ?,a.id,json_patch(${article},${copy}),p.id,${pdf},a.normalized_url
      FROM articles a LEFT JOIN article_copies c ON c.article_id=a.id LEFT JOIN pdf_assets p ON p.id=a.pdf_asset_id AND p.deleting=0`).bind(id),
  ]);
  const prefix = `{"version":2,"exportedAt":${JSON.stringify(now)},"articles":[`;
  const mprefix = `{"version":1,"exportedAt":${JSON.stringify(now)},"pdfs":[`;
  const sizes = await env.DB.prepare(`SELECT COUNT(*) AS n,COALESCE(SUM(length(CAST(record AS BLOB))),0) AS bytes,
    COUNT(pdf_info) AS pn,COALESCE(SUM(length(CAST(pdf_info AS BLOB))),0) AS pbytes FROM archive_records WHERE session_id=?`).bind(id).first<{ n: number; bytes: number; pn: number; pbytes: number }>();
  const librarySize = encode(prefix).length + sizes!.bytes + Math.max(0, sizes!.n - 1) + 2;
  const manifestSize = encode(mprefix).length + sizes!.pbytes + Math.max(0, sizes!.pn - 1) + 2;
  if (librarySize > 64 * 1024 * 1024 || manifestSize > 16 * 1024 * 1024 || sizes!.n > 100_000) {
    await env.DB.prepare('DELETE FROM archive_sessions WHERE id=?').bind(id).run();
    return errorResponse(413, 'archive_too_large', 'Archive metadata exceeds the supported export limit.');
  }
  async function* files(): AsyncGenerator<ZipFile> {
    yield { name: 'library.json', size: librarySize, body: jsonPart(env, id, prefix) };
    yield { name: 'manifest.json', size: manifestSize, body: jsonPart(env, id, mprefix, true) };
    const emitted = new Set<string>();
    for await (const row of records(env, id, true)) {
      if (emitted.has(row.asset_id!)) continue;
      emitted.add(row.asset_id!);
      const pdf = JSON.parse(row.pdf_info!) as OriginalPdf;
      const object = await env.PDF_BUCKET!.get(assetKey(pdf.id));
      if (!object || object.size !== pdf.bytes) throw new Error('archive_file_unavailable');
      yield { name: assetKey(pdf.id), size: pdf.bytes, body: streamChunks(object.body) };
    }
  }
  async function* output(): AsyncGenerator<Uint8Array> {
    try { yield* zipFiles(files()); }
    finally { await env.DB.prepare('DELETE FROM archive_sessions WHERE id=?').bind(id).run(); }
  }
  return new Response(iteratorStream(output()), { headers: { ...PRIVATE_HEADERS, 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="potem-archive-${now.slice(0,10)}.zip"` } });
}
export async function handleArchive(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname, method = request.method;
  if (path === '/api/archive' && method === 'GET') return exportArchive(env);
  if (!env.PDF_BUCKET) return errorResponse(503, 'archive_unavailable', 'PDF archive storage is not configured.');
  if (path === '/api/archive/imports' && method === 'POST') {
    parseObject(await readJson(request), []);
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO archive_sessions(id,kind,expires_at) VALUES(?,'import',?)").bind(id,new Date(Date.now()+ASSET_TTL_MS).toISOString()).run();
    return jsonResponse({ id }, 201);
  }
  const route = /^\/api\/archive\/imports\/([a-f0-9-]{36})\/(records|complete|commit|files\/([a-f0-9-]{36}))$/.exec(path);
  if (!route) return errorResponse(404, 'not_found', 'Archive route not found.');
  const id = route[1], action = route[2];
  const session = await env.DB.prepare("SELECT completed FROM archive_sessions WHERE id=? AND kind='import' AND expires_at>?").bind(id,iso()).first<{ completed: number }>();
  if (!session) return errorResponse(404, 'not_found', 'Import session expired or was not found.');
  if (action === 'records' && method === 'POST' && !session.completed) {
    const input = parseObject(await readJson(request, MAX_ARCHIVE_METADATA_BYTES), ['library','pdfs'], ['library','pdfs']);
    const library = parseObject(input.library, ['version','exportedAt','articles'], ['version','exportedAt','articles']);
    const articles = validateLibrary(library);
    if (!Array.isArray(input.pdfs) || input.pdfs.length > articles.length) throw new ValidationError('Invalid PDF manifest');
    const pdfs = new Map<string, ArchivePdf>();
    for (const value of input.pdfs) { const p = validateArchivePdf(value); if (pdfs.has(p.articleId) || !articles.some(a => a.id === p.articleId)) throw new ValidationError('Invalid PDF association'); pdfs.set(p.articleId,p); }
    const statements = articles.map(a => {
      const { normalizedUrl: _normalized, ...raw } = a;
      return env.DB.prepare(`INSERT INTO archive_records(session_id,article_id,record,pdf_info,normalized_url) SELECT ?,?,?,?,?
        WHERE EXISTS(SELECT 1 FROM archive_sessions WHERE id=? AND completed=0 AND expires_at>?)`)
        .bind(id,a.id,JSON.stringify(raw),pdfs.has(a.id) ? JSON.stringify(pdfs.get(a.id)) : null,a.normalizedUrl,id,iso());
    });
    if (statements.length) await env.DB.batch(statements);
    return jsonResponse({ accepted: articles.length });
  }
  if (route[3] && method === 'PUT' && !session.completed) {
    const expectedRow = await env.DB.prepare("SELECT pdf_info FROM archive_records WHERE session_id=? AND json_extract(pdf_info,'$.id')=? LIMIT 1").bind(id,route[3]).first<{ pdf_info: string }>();
    if (!expectedRow) throw new ValidationError('Unexpected archive file');
    const expected = validateArchivePdf(JSON.parse(expectedRow.pdf_info));
    const bytes = await readBytes(request.body, MAX_PDF_BYTES);
    if (bytes.length !== expected.bytes || await checksum(bytes) !== expected.checksum) throw new ValidationError('PDF checksum or size mismatch');
    const existing = await env.DB.prepare('SELECT asset_id FROM archive_files WHERE session_id=? AND archive_id=?').bind(id,expected.id).first();
    if (!existing) {
      const pdf = await stagePdf(env,bytes,expected.sourceUrl,expected.capturedAt);
      await env.DB.prepare(`INSERT INTO archive_files(session_id,archive_id,asset_id) SELECT ?,?,?
        WHERE EXISTS(SELECT 1 FROM archive_sessions WHERE id=? AND completed=0 AND expires_at>?)`).bind(id,expected.id,pdf.id,id,iso()).run();
    }
    return jsonResponse({ ok: true });
  }
  if (action === 'complete' && method === 'POST') {
    parseObject(await readJson(request), []);
    // Seal against concurrent metadata/file requests in the same SQLite write
    // that checks completeness. Reads followed by an unconditional UPDATE can
    // admit an unuploaded PDF between validation and sealing.
    const sealed = await env.DB.prepare(`UPDATE archive_sessions SET completed=1
      WHERE id=? AND kind='import' AND completed=0 AND expires_at>?
      AND NOT EXISTS(SELECT 1 FROM archive_records r JOIN articles a ON a.id=r.article_id
        WHERE r.session_id=archive_sessions.id AND a.normalized_url!=r.normalized_url)
      AND NOT EXISTS(SELECT 1 FROM archive_records r WHERE r.session_id=archive_sessions.id AND r.pdf_info IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM archive_files f JOIN pdf_assets p ON p.id=f.asset_id
          WHERE f.session_id=r.session_id AND f.archive_id=json_extract(r.pdf_info,'$.id')
          AND p.checksum=json_extract(r.pdf_info,'$.checksum') AND p.bytes=json_extract(r.pdf_info,'$.bytes')
          AND p.captured_at=json_extract(r.pdf_info,'$.capturedAt') AND p.source_url=json_extract(r.pdf_info,'$.sourceUrl')
          AND p.deleting=0))`).bind(id,iso()).run();
    if (sealed.meta.changes) return jsonResponse({ ok: true });
    const current=await env.DB.prepare("SELECT completed FROM archive_sessions WHERE id=? AND kind='import' AND expires_at>?").bind(id,iso()).first<{completed:number}>();
    if (!current) return errorResponse(404, 'not_found', 'Import session expired or was not found.');
    if (current.completed) return jsonResponse({ ok: true });
    const conflicting = await env.DB.prepare('SELECT COUNT(*) AS n FROM archive_records r JOIN articles a ON a.id=r.article_id WHERE r.session_id=? AND a.normalized_url!=r.normalized_url').bind(id).first<{n:number}>();
    if (conflicting!.n) throw new ValidationError('An article ID already belongs to a different URL');
    throw new ValidationError('Archive files are missing or do not match the manifest');
  }
  if (action === 'commit' && method === 'POST' && session.completed) {
    parseObject(await readJson(request), []);
    // Bound bytes in SQL before returning bodies: 50 heavily escaped copies can
    // exceed D1's result-size limit even though each copy fits an import request.
    const { results } = await env.DB.prepare(`WITH candidates AS (
        SELECT article_id,length(CAST(record AS BLOB))+1 AS bytes FROM archive_records
        WHERE session_id=? AND committed=0 ORDER BY article_id LIMIT 50
      ), bounded AS (
        SELECT article_id,SUM(bytes) OVER(ORDER BY article_id) AS total_bytes FROM candidates
      ) SELECT r.article_id,r.record,f.asset_id,r.pdf_info FROM bounded b
      JOIN archive_records r ON r.session_id=? AND r.article_id=b.article_id
      LEFT JOIN archive_files f ON f.session_id=r.session_id AND f.archive_id=json_extract(r.pdf_info,'$.id')
      WHERE b.total_bytes<=? ORDER BY r.article_id`).bind(id,id,MAX_ARCHIVE_METADATA_BYTES-256).all<RecordRow>();
    const batch = results;
    if (!batch.length) {
      const remaining=await remainingImportRecords(env.DB,id);
      if (!remaining) return errorResponse(404,'not_found','Import session expired or was not found.');
      if (remaining.n) return errorResponse(413,'archive_record_too_large','An archive record exceeds the restore request limit.');
      return jsonResponse({ imported: 0, skipped: 0, done: true });
    }
    const library = { version: 2, exportedAt: iso(), articles: batch.map(r => JSON.parse(r.record)) };
    const assets = new Map(batch.filter(r => r.asset_id).map(r => [r.article_id,r.asset_id!]));
    const response = await importArticles(new Request(request.url, { method: 'POST', body: JSON.stringify(library) }),env,
      { assets, maxBytes: MAX_ARCHIVE_METADATA_BYTES, archiveSessionId: id });
    if (!response.ok) return response;
    const counts = await response.json() as { imported: number; skipped: number };
    const remaining=await remainingImportRecords(env.DB,id);
    if (!remaining) return errorResponse(404,'not_found','Import session expired or was not found.');
    return jsonResponse({ ...counts, done: remaining.n === 0 });
  }
  return errorResponse(409,'archive_state','This action is not available for the current import session.');
}
