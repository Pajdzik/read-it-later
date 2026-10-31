import { readZipDirectory, readZipEntry, type ZipEntry } from '../src/archive/zip';
import { MAX_ARCHIVE_METADATA_BYTES } from '../src/archive/limits';

interface PdfInfo { id: string; articleId: string; checksum: string; bytes: number; capturedAt: string; sourceUrl: string }
export interface CheckedArchive {
  library: { version: 2; exportedAt: string; articles: Array<Record<string, unknown>> };
  pdfs: PdfInfo[];
  entries: Map<string, ZipEntry>;
}
const byteSize = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
export async function inspectArchive(file: File, progress: (text: string) => void): Promise<CheckedArchive> {
  const entries = await readZipDirectory(file);
  const library = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readZipEntry(file, entries.get('library.json')!)));
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readZipEntry(file, entries.get('manifest.json')!)));
  if (library.version !== 2 || typeof library.exportedAt !== 'string' || !Array.isArray(library.articles) || library.articles.length > 100_000 ||
      manifest.version !== 1 || !Array.isArray(manifest.pdfs) || manifest.pdfs.length > library.articles.length) throw new Error('Invalid archive metadata');
  const ids = new Set<string>();
  for (const article of library.articles) {
    if (!article || !/^[a-z0-9]{8}$/.test(article.id) || ids.has(article.id) || byteSize(article) > 1900 * 1024) throw new Error('Invalid or oversized article in archive');
    ids.add(article.id);
  }
  const pdfs = new Map<string, PdfInfo>(), associations = new Set<string>();
  for (const pdf of manifest.pdfs) {
    if (!pdf || !/^[a-f0-9-]{36}$/.test(pdf.id) || !/^[a-f0-9]{64}$/.test(pdf.checksum) || !ids.has(pdf.articleId) || associations.has(pdf.articleId)) throw new Error('Invalid PDF manifest');
    const prior = pdfs.get(pdf.id);
    if (prior && (prior.checksum !== pdf.checksum || prior.bytes !== pdf.bytes)) throw new Error('Conflicting PDF manifest entries');
    pdfs.set(pdf.id, pdf); associations.add(pdf.articleId);
  }
  if (entries.size !== pdfs.size + 2) throw new Error('Archive contains unexpected files');
  let checked = 0;
  for (const pdf of pdfs.values()) {
    progress(`Checking PDF ${++checked} of ${pdfs.size}…`);
    const entry = entries.get(`pdf/${pdf.id}.pdf`);
    if (!entry || entry.size !== pdf.bytes) throw new Error('Archive PDF is missing or has the wrong size');
    const bytes = await readZipEntry(file, entry);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    if (hash !== pdf.checksum || new TextDecoder().decode(bytes.subarray(0,5)) !== '%PDF-') throw new Error('PDF checksum or signature mismatch');
  }
  return { library, pdfs: manifest.pdfs, entries };
}
export async function restoreArchive(file: File, archive: CheckedArchive, api: <T>(path: string, init?: RequestInit) => Promise<T>, progress: (text: string) => void): Promise<{ imported: number; skipped: number }> {
  const { id } = await api<{ id: string }>('/api/archive/imports', { method: 'POST', body: '{}' });
  const root = `/api/archive/imports/${id}`;
  const byArticle = new Map(archive.pdfs.map(p => [p.articleId,p]));
  const envelope = (articles: Array<Record<string, unknown>>) => ({
    library: { ...archive.library, articles },
    pdfs: articles.flatMap(a => byArticle.has(String(a.id)) ? [byArticle.get(String(a.id))!] : []),
  });
  const emptyBytes = byteSize(envelope([]));
  let batch: Array<Record<string, unknown>> = [], batchBytes = emptyBytes, pdfCount = 0;
  const send = async () => {
    if (!batch.length) return;
    await api(`${root}/records`, { method: 'POST', body: JSON.stringify(envelope(batch)) });
    batch = []; batchBytes = emptyBytes; pdfCount = 0;
  };
  for (const article of archive.library.articles) {
    const pdf = byArticle.get(String(article.id));
    const recordBytes = byteSize(article) + (pdf ? byteSize(pdf) : 0);
    if (emptyBytes + recordBytes > MAX_ARCHIVE_METADATA_BYTES) throw new Error('An archive record exceeds the restore request limit');
    const separatorBytes = () => (batch.length ? 1 : 0) + (pdf && pdfCount ? 1 : 0);
    if (batch.length >= 500 || batchBytes + recordBytes + separatorBytes() > MAX_ARCHIVE_METADATA_BYTES) await send();
    batchBytes += recordBytes + separatorBytes();
    batch.push(article); if (pdf) pdfCount++;
  }
  progress('Validating article metadata…'); await send();
  const unique = new Map(archive.pdfs.map(p => [p.id,p])); let uploaded = 0;
  for (const pdf of unique.values()) {
    progress(`Restoring PDF ${++uploaded} of ${unique.size}…`);
    const entry = archive.entries.get(`pdf/${pdf.id}.pdf`)!;
    await api(`${root}/files/${pdf.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: file.slice(entry.start,entry.start+entry.size) });
  }
  await api(`${root}/complete`, { method: 'POST', body: '{}' });
  let imported = 0, skipped = 0;
  while (true) {
    progress(`Restoring articles… ${imported} imported, ${skipped} skipped`);
    const result = await api<{ imported: number; skipped: number; done: boolean }>(`${root}/commit`, { method: 'POST', body: '{}' });
    imported += result.imported; skipped += result.skipped;
    if (result.done) return { imported, skipped };
  }
}
