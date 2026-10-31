import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker';
import type { Env, Article, OriginalPdf } from '../src/contracts';
import { managedConversion, type ManagedEnv } from '../capture/managed';
import { deliverPendingExtractions, extractionQueueStub } from './extraction-queue-fixture';
import { cleanupPdfAssets, getOriginalPdf, stagePdf, assetKey, checksum } from '../src/articles/pdf';
import { fetchSourceDocument } from '../src/articles/source-fetch';
import { completeExtractionJob, claimExtractionJob, enqueueExtractionJob } from '../src/articles/jobs';
import { saveArticleCopy } from '../src/articles/repository';
import { requestRecapture, undoRecapture } from '../src/articles/recovery';
import { inspectArchive, restoreArchive } from '../web/archive';
import { iteratorStream, zipFiles, readZipDirectory, readZipEntry } from '../src/archive/zip';
import { CONVERSION_TIMEOUT_MS } from '../src/articles/capture-limits';
import { unzipSync } from 'fflate';

const origin = 'http://localhost:8787';
const configured: Env = { ...env, EXTRACTION_QUEUE: extractionQueueStub().binding, APP_ORIGIN: origin, DEV_AUTH_BYPASS: 'true', BACKGROUND_CAPTURE_ENABLED: 'true', MANAGED_CONVERSION_ENABLED: 'true' };
const pdfBytes = new TextEncoder().encode('%PDF-1.7\n1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj\n2 0 obj <</Type /Pages /Kids [] /Count 0>> endobj\ntrailer <</Root 1 0 R>>\n%%EOF');
const ago = () => new Date(Date.now()-120_000).toISOString();
function ai(data: string | null = '# Converted\n\nReadable document.') {
  const convert = vi.fn(async (_document: MarkdownDocument, _options?: ConversionRequestOptions): Promise<ConversionResponse> => data === null
    ? { format: 'error', error: 'private parser diagnostic', id: 'test', name: 'test', mimeType: 'application/pdf' }
    : { format: 'markdown', data, tokens: 10, id: 'test', name: 'test', mimeType: 'application/pdf' });
  return { ...configured, AI: { toMarkdown: convert }, convert };
}
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await route(path, init);
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data as T;
}
function route(path: string, init: RequestInit = {}, target = configured): Promise<Response> {
  return worker.fetch(new Request(origin+path, { ...init, headers: { Origin: origin, 'X-CSRF-Token': 'dev-bypass', ...Object.fromEntries(new Headers(init.headers)) } }),target);
}
function observeDatabase(match: (sql: string) => boolean, hooks: {
  beforeRun?: () => Promise<void>;
  beforeFirst?: () => Promise<void>;
  beforeBatch?: () => Promise<void>;
  afterAll?: (result: D1Result<unknown>) => void;
}): D1Database {
  const statement = (target: D1PreparedStatement): D1PreparedStatement => new Proxy(target, {
    get(target, key) {
      if (key === 'bind') return (...values: unknown[]) => statement(target.bind(...values));
      if (key === 'run') return async () => { await hooks.beforeRun?.(); return target.run(); };
      if (key === 'first') return async (column?: string) => { await hooks.beforeFirst?.(); return column === undefined ? target.first() : target.first(column); };
      if (key === 'all') return async <T>() => { const result=await target.all<T>(); hooks.afterAll?.(result); return result; };
      const value=Reflect.get(target,key,target); return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return new Proxy(env.DB, { get(target,key) {
    if (key === 'prepare') return (sql: string) => match(sql) ? statement(target.prepare(sql)) : target.prepare(sql);
    if (key === 'batch') return async <T>(statements: D1PreparedStatement[]) => { await hooks.beforeBatch?.(); return target.batch<T>(statements); };
    const value=Reflect.get(target,key,target); return typeof value === 'function' ? value.bind(target) : value;
  } });
}
async function add(id = 'pdf00001', url = 'https://news.example.com/document'): Promise<void> {
  await env.DB.prepare(`INSERT INTO articles(id,url,normalized_url,title,created_at,updated_at,read_at,extraction_requested_at,title_origin) VALUES(?,?,?,'Saved title',?,?,NULL,?,'supplied')`)
    .bind(id,url,url,ago(),ago(),ago()).run();
  await enqueueExtractionJob(env.DB,id,ago());
}
function converterService(binding: ManagedEnv) {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    return managedConversion(new Request(`http://potem.convert/${body.originalPdfId ? 'stored-pdf' : 'pdf'}`, {
      method: 'POST', headers: { 'X-Source-Url': encodeURIComponent(body.url), ...(body.originalPdfId ? { 'X-Pdf-Id': body.originalPdfId } : {}) },
      body: body.originalPdfId ? undefined : pdfBytes,
    }),binding);
  });
}
async function capture(binding = ai()) {
  const fetch = converterService(binding);
  await deliverPendingExtractions({ ...configured, ARTICLE_EXTRACTOR: { fetch, connect() { throw new Error('unused'); } } as Fetcher });
  return fetch;
}
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM archive_sessions').run();
  await env.DB.prepare('DELETE FROM articles').run();
  await env.DB.prepare('DELETE FROM pdf_assets').run();
  for (const object of (await env.PDF_BUCKET.list()).objects) await env.PDF_BUCKET.delete(object.key);
});

describe('managed conversion', () => {
  it('uses bounded fetched HTML and the final URL without requesting image inference', async () => {
    const binding = ai('## Article\n\nKeep **formatting**, [links](https://news.example.com/next), `code`, and tables.');
    const response = await managedConversion(new Request('http://potem.convert/html', { method: 'POST', headers: { 'X-Source-Url': encodeURIComponent('https://news.example.com/redirected/page') }, body: '<html><article>Article</article></html>' }),binding);
    expect(await response.json()).toMatchObject({ ok: true, article: { markdown: expect.stringContaining('**formatting**') } });
    const args = binding.convert.mock.calls;
    expect(args[0][0].name).toBe('article.html');
    expect(args[0][1]).toEqual({ conversionOptions: { html: { hostname: 'https://news.example.com/redirected/page', images: { convert: false, convertOGImage: false } } } });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM pdf_assets').first()).toEqual({ n: 0 });
  });
  it('preserves the exact PDF and commits its reference alongside Markdown', async () => {
    await add(); await capture();
    const article = (await api<{ article: Article }>('/api/articles/pdf00001')).article;
    expect(article.originalPdf?.checksum).toBe(await checksum(pdfBytes));
    expect(article.title).toBe('Saved title'); expect(article.readAt).toBeNull();
    const object = await env.PDF_BUCKET.get(assetKey(article.originalPdf!.id));
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(pdfBytes);
    const copy = await env.DB.prepare('SELECT markdown FROM article_copies WHERE article_id=?').bind(article.id).first<{markdown:string}>();
    expect(copy!.markdown).toContain('Readable document');
  });
  it('retains scans without text and retries from their saved bytes', async () => {
    await add(); await capture(ai('# document.pdf\n## Contents\n### Page 1\n\n\n'));
    const original = await getOriginalPdf(env.DB,'pdf00001'); expect(original).toBeDefined();
    expect(await env.DB.prepare('SELECT error_code,state FROM article_extraction_jobs').first()).toEqual({ error_code: 'pdf_no_text', state: 'failed' });
    await env.DB.prepare('UPDATE article_extraction_jobs SET updated_at=?').bind(ago()).run();
    await api('/api/articles/pdf00001/extraction/retry',{ method: 'POST',body:'{}' });
    const service = await capture(ai('Recovered text'));
    expect(JSON.parse(String(service.mock.calls[0][1]?.body)).originalPdfId).toBe(original!.id);
    expect((await getOriginalPdf(env.DB,'pdf00001'))!.id).toBe(original!.id);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM pdf_assets').first()).toEqual({n:1});
  });
  it('keeps genuine PDF headings while recognizing empty multi-page outlines', async () => {
    const request=()=>new Request('http://potem.convert/pdf',{method:'POST',headers:{'X-Source-Url':encodeURIComponent('https://news.example.com/paper')},body:pdfBytes});
    const empty=await (await managedConversion(request(),ai('# document.pdf\r\n## Contents\r\n### Page 1\r\n\r\n### Page 2\r\n'))).json() as {article:{conversionError?:{code:string}}};
    expect(empty.article.conversionError?.code).toBe('pdf_no_text');
    const heading='# document.pdf\n## Contents\n### Page 1\n# Actual paper title\n';
    expect(await (await managedConversion(request(),ai(heading))).json()).toMatchObject({ok:true,article:{markdown:heading}});
  });
  it('preserves originals on corrupt/encrypted conversion errors and output overflow without leaking diagnostics', async () => {
    for (const binding of [ai(null),ai('x'.repeat(256*1024+1))]) {
      const response = await managedConversion(new Request('http://potem.convert/pdf',{method:'POST',headers:{'X-Source-Url':encodeURIComponent('https://news.example.com/paper')},body:pdfBytes}),binding);
      const text = await response.text(); expect(text).not.toContain('private parser diagnostic');
      const result = JSON.parse(text); expect(result.article.originalPdf).toBeDefined(); expect(result.article.conversionError).toBeDefined(); expect(result.article.markdown).toBe('');
    }
  });
  it('retries transient storage failures while looking up or attaching original PDFs', async () => {
    for (const operation of ['lookup','attach']) {
      const id=operation==='lookup' ? 'store001' : 'store002';
      await add(id,`https://news.example.com/${id}`);
      const fail=async()=>{throw new Error('Temporary D1 failure');};
      const db=observeDatabase(sql=>operation==='lookup'
        ? sql.startsWith('SELECT p.* FROM pdf_assets p JOIN articles')
        : sql.startsWith('UPDATE articles SET pdf_asset_id=? WHERE id=? AND pdf_asset_id IS NULL'),
        operation==='lookup' ? {beforeFirst:fail} : {beforeRun:fail});
      const fetch=converterService(ai('# document.pdf\n## Contents\n### Page 1\n'));
      await deliverPendingExtractions({...configured,DB:db,ARTICLE_EXTRACTOR:{fetch,connect(){throw new Error('unused');}} as Fetcher});
      expect(await env.DB.prepare('SELECT state,error_code FROM article_extraction_jobs WHERE article_id=?').bind(id).first())
        .toEqual({state:'retry_wait',error_code:'storage_failed'});
    }
  });
  it('keeps stored-PDF lookup, download and stream failures retryable', async () => {
    const stored=await stagePdf(configured,pdfBytes,'https://news.example.com/paper');
    for (const failure of ['lookup','download','stream']) {
      const binding=ai();
      if(failure==='lookup')binding.DB=observeDatabase(sql=>sql.startsWith('SELECT * FROM pdf_assets'),{
        async beforeFirst(){throw new Error('Temporary D1 failure');},
      });
      else binding.PDF_BUCKET=new Proxy(env.PDF_BUCKET,{get(target,key){
        if(key==='get')return async(key:string)=>{
          if(failure==='download')throw new Error('Temporary R2 failure');
          const object=await target.get(key);
          if(!object)return null;
          await object.body.cancel();
          return new Proxy(object,{get(target,key){
            if(key==='body')return new ReadableStream({start(controller){controller.error(new Error('Interrupted R2 stream'));}});
            const value=Reflect.get(target,key,target);return typeof value==='function' ? value.bind(target) : value;
          }});
        };
        const value=Reflect.get(target,key,target);return typeof value==='function' ? value.bind(target) : value;
      }});
      const response=await managedConversion(new Request('http://potem.convert/stored-pdf',{method:'POST',headers:{
        'X-Pdf-Id':stored.id,'X-Source-Url':encodeURIComponent(stored.sourceUrl),
      }}),binding);
      const result=await response.json() as {error?:{code:string;retryable:boolean};article?:{conversionError?:{code:string;retryable:boolean}}};
      expect(result.error ?? result.article?.conversionError).toEqual({code:'pdf_storage_unavailable',retryable:true});
      expect(binding.convert).not.toHaveBeenCalled();
    }
  });
  it('bounds converter time and pauses without invoking AI', async () => {
    const binding = ai();
    const request = () => new Request('http://potem.convert/html',{method:'POST',headers:{'X-Source-Url':'https%3A%2F%2Fnews.example.com%2F'},body:'<html>Article</html>'});
    expect(await (await managedConversion(request(),{...binding,MANAGED_CONVERSION_ENABLED:'false'})).json()).toMatchObject({ok:false,error:{code:'capture_paused'}});
    expect(binding.convert).not.toHaveBeenCalled();
    vi.useFakeTimers();
    try {
      binding.convert.mockImplementation(() => new Promise(() => undefined));
      const pending = managedConversion(request(),binding);
      await vi.advanceTimersByTimeAsync(CONVERSION_TIMEOUT_MS+1);
      expect(await (await pending).json()).toMatchObject({ok:false,error:{code:'conversion_timeout',retryable:true}});
    } finally { vi.useRealTimers(); }
  });
});

describe('PDF source fetching and access', () => {
  it('recognizes extensionless PDFs, validates signatures, and retains separate HTML/PDF bounds', async () => {
    const source = (body: BodyInit, type: string, length?: string) => ({ BACKGROUND_CAPTURE_ENABLED:'true',ARTICLE_FETCHER:{fetch:async()=>new Response(body,{headers:{'Content-Type':type,...(length?{'Content-Length':length}:{})}})} });
    expect(await fetchSourceDocument('https://news.example.com/download',source(pdfBytes,'application/pdf'))).toMatchObject({kind:'pdf',bytes:pdfBytes});
    expect(await fetchSourceDocument('https://news.example.com/download',source(pdfBytes,'application/octet-stream'))).toMatchObject({kind:'pdf'});
    await expect(fetchSourceDocument('https://news.example.com/download',source('not pdf','application/pdf'))).rejects.toMatchObject({code:'invalid_pdf'});
    await expect(fetchSourceDocument('https://news.example.com/download',source(pdfBytes,'application/pdf',String(20*1024*1024+1)))).rejects.toMatchObject({code:'source_too_large'});
    await expect(fetchSourceDocument('https://news.example.com/download',source('<html>text</html>','text/html',String(2*1024*1024+1)))).rejects.toMatchObject({code:'source_too_large'});
    await expect(fetchSourceDocument('http://127.0.0.1/paper',source(pdfBytes,'application/pdf'))).rejects.toMatchObject({code:'unsafe_destination'});
    let cancelled=false;
    const chunk=new Uint8Array(1024*1024);
    const body=new ReadableStream<Uint8Array>({pull(controller){controller.enqueue(chunk);},cancel(){cancelled=true;}});
    await expect(fetchSourceDocument('https://news.example.com/download',source(body,'application/pdf'))).rejects.toMatchObject({code:'source_too_large'});
    expect(cancelled).toBe(true);
  });
  it('requires owner access, supports ranges/downloads, and leaves read state unchanged', async () => {
    await add(); await capture();
    const full = await route('/api/articles/pdf00001/pdf'); expect(full.status).toBe(200); expect(full.headers.get('Cache-Control')).toContain('no-store');
    expect(full.headers.get('Content-Security-Policy')).toContain('sandbox;'); expect(new Uint8Array(await full.arrayBuffer())).toEqual(pdfBytes);
    const partial = await route('/api/articles/pdf00001/pdf',{headers:{Range:'bytes=0-4'}}); expect(partial.status).toBe(206); expect(new TextDecoder().decode(await partial.arrayBuffer())).toBe('%PDF-');
    expect((await route('/api/articles/pdf00001/pdf',{headers:{Range:'bytes=99999-'}})).status).toBe(416);
    expect((await route('/api/articles/pdf00001/pdf?download=1')).headers.get('Content-Disposition')).toContain('attachment');
    const privateEnv = {...configured,APP_ORIGIN:'https://service.example',DEV_AUTH_BYPASS:undefined,OWNER_GITHUB_ID:'123',GITHUB_CLIENT_ID:'test-client',GITHUB_CLIENT_SECRET:'test-secret'};
    const anonymous = await worker.fetch(new Request('https://service.example/api/articles/pdf00001/pdf',{headers:{Authorization:'Bearer save-only'}}),privateEnv);
    expect(anonymous.status).toBe(401);
    expect(await env.DB.prepare('SELECT read_at FROM articles').first()).toEqual({read_at:null});
  });
});

describe('PDF lifecycle', () => {
  it('preserves the first original when recapturing a link-only scan without a saved copy', async () => {
    await add();
    await env.DB.prepare('DELETE FROM article_extraction_jobs').run();
    await env.DB.prepare('UPDATE articles SET extraction_requested_at=NULL').run();
    expect(await requestRecapture(env.DB,'pdf00001',null)).toBe('queued');
    await capture(ai('# document.pdf\n## Contents\n### Page 1\n'));
    const original=await getOriginalPdf(env.DB,'pdf00001');
    expect(original?.checksum).toBe(await checksum(pdfBytes));
    expect(await env.DB.prepare('SELECT state,error_code,kind FROM article_extraction_jobs').first())
      .toEqual({state:'failed',error_code:'pdf_no_text',kind:'recapture'});
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM article_copies').first()).toEqual({n:0});
    await env.DB.prepare('UPDATE article_extraction_jobs SET updated_at=?').bind(ago()).run();
    expect(await requestRecapture(env.DB,'pdf00001',null)).toBe('queued');
    await capture(ai(''));
    expect((await getOriginalPdf(env.DB,'pdf00001'))?.id).toBe(original!.id);
  });
  it('recaptures and undoes the original and copy together, retaining old files until undo expires', async () => {
    await add(); await capture();
    const old = await getOriginalPdf(env.DB,'pdf00001');
    const current = await env.DB.prepare('SELECT revision FROM article_copies').first<{revision:string}>();
    await env.DB.prepare('UPDATE article_extraction_jobs SET updated_at=?').bind(ago()).run();
    expect(await requestRecapture(env.DB,'pdf00001',current!.revision)).toBe('queued');
    await capture(ai('New revision'));
    const replacement = await getOriginalPdf(env.DB,'pdf00001'); expect(replacement!.id).not.toBe(old!.id);
    expect((await route(`/api/articles/pdf00001/pdf?asset=${old!.id}`)).status).toBe(200);
    const copy = await env.DB.prepare('SELECT revision,markdown FROM article_copies').first<{revision:string;markdown:string}>(); expect(copy!.markdown).toBe('New revision');
    expect(await undoRecapture(env.DB,'pdf00001',copy!.revision)).toBe('saved');
    expect((await getOriginalPdf(env.DB,'pdf00001'))!.id).toBe(old!.id);
    expect((await env.DB.prepare('SELECT markdown FROM article_copies').first<{markdown:string}>())!.markdown).toContain('Readable document');
  });
  it('rejects stale job publication and cleans only unreferenced files with durable retries', async () => {
    await add(); const job = await claimExtractionJob(env.DB); expect(job).not.toBeNull();
    const staged = await stagePdf(configured,pdfBytes,'https://news.example.com/paper');
    await env.DB.prepare('UPDATE article_extraction_jobs SET generation=generation+1').run();
    expect(await completeExtractionJob(env.DB,job!,{markdown:'Stale',metadata:{},originalPdf:staged})).toBe(false);
    expect(await getOriginalPdf(env.DB,'pdf00001')).toBeUndefined();
    await env.DB.prepare('UPDATE pdf_assets SET cleanup_at=?').bind(ago()).run();
    const deleteObject = vi.fn(async()=>{throw new Error('temporary');});
    await expect(cleanupPdfAssets({...configured,PDF_BUCKET:{delete:deleteObject} as unknown as R2Bucket})).rejects.toThrow();
    expect(await env.DB.prepare('SELECT deleting FROM pdf_assets WHERE id=?').bind(staged.id).first()).toEqual({deleting:1});
    await expect(env.DB.prepare('UPDATE articles SET pdf_asset_id=? WHERE id=?').bind(staged.id,'pdf00001').run()).rejects.toThrow();
    await env.DB.prepare('UPDATE pdf_assets SET cleanup_at=?').bind(ago()).run();
    await cleanupPdfAssets(configured); expect(await env.PDF_BUCKET.get(staged.objectKey)).toBeNull();
  });
  it('rolls back a copy when its PDF can no longer be published', async () => {
    await add(); const job=await claimExtractionJob(env.DB);
    const staged=await stagePdf(configured,pdfBytes,'https://news.example.com/paper');
    await env.DB.prepare('UPDATE pdf_assets SET deleting=1 WHERE id=?').bind(staged.id).run();
    await expect(completeExtractionJob(env.DB,job!,{markdown:'Cannot publish',metadata:{title:'Changed'},originalPdf:staged})).rejects.toThrow();
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM article_copies').first()).toEqual({n:0});
    expect(await env.DB.prepare('SELECT title,pdf_asset_id FROM articles').first()).toEqual({title:'Saved title',pdf_asset_id:null});
  });
  it('preserves the current pair after failed recapture or a manual edit during capture', async () => {
    await add(); await capture();
    const original=await getOriginalPdf(env.DB,'pdf00001');
    const copy=await env.DB.prepare('SELECT * FROM article_copies').first<{revision:string;markdown:string}>();
    await env.DB.prepare('UPDATE article_extraction_jobs SET updated_at=?').bind(ago()).run();
    await requestRecapture(env.DB,'pdf00001',copy!.revision);
    await capture(ai(null));
    expect((await getOriginalPdf(env.DB,'pdf00001'))!.id).toBe(original!.id);
    expect(await env.DB.prepare('SELECT markdown FROM article_copies').first()).toEqual({markdown:copy!.markdown});
    await env.DB.prepare('UPDATE article_extraction_jobs SET updated_at=?').bind(ago()).run();
    await requestRecapture(env.DB,'pdf00001',copy!.revision);
    const job=await claimExtractionJob(env.DB);
    await saveArticleCopy(env.DB,'pdf00001',{markdown:'Owner draft',capturedAt:new Date().toISOString(),source:'paste',revision:'owner-revision'},copy!.revision);
    const staged=await stagePdf(configured,pdfBytes,'https://news.example.com/new');
    expect(await completeExtractionJob(env.DB,job!,{markdown:'Late conversion',metadata:{},originalPdf:staged})).toBe(false);
    expect((await getOriginalPdf(env.DB,'pdf00001'))!.id).toBe(original!.id);
    expect(await env.DB.prepare('SELECT markdown FROM article_copies').first()).toEqual({markdown:'Owner draft'});
  });
  it('pins originals during an export even if the article is deleted', async () => {
    await add(); await capture();
    const original=await getOriginalPdf(env.DB,'pdf00001');
    const download=await route('/api/archive');
    await env.DB.prepare('DELETE FROM articles').run();
    await env.DB.prepare('UPDATE pdf_assets SET cleanup_at=?').bind(ago()).run();
    await cleanupPdfAssets(configured);
    expect(await env.PDF_BUCKET.head(assetKey(original!.id))).not.toBeNull();
    const file=new File([await download.arrayBuffer()],'archive.zip');
    expect((await inspectArchive(file,()=>undefined)).pdfs[0].checksum).toBe(original!.checksum);
    await cleanupPdfAssets(configured);
    expect(await env.PDF_BUCKET.head(assetKey(original!.id))).toBeNull();
  });
});

describe('complete portable archives', () => {
  it('restores checksummed PDFs and complete article/copy/read state, then skips repeated imports', async () => {
    await add(); await capture();
    await env.DB.prepare('UPDATE articles SET read_at=?').bind(ago()).run();
    const originalArticle = (await api<{article:Article}>('/api/articles/pdf00001')).article;
    const oldCopy = await api('/api/articles/pdf00001/copy');
    const response = await route('/api/archive'); expect(response.status).toBe(200);
    const file = new File([await response.arrayBuffer()],'archive.zip');
    const portable = unzipSync(new Uint8Array(await file.arrayBuffer()));
    expect(JSON.parse(new TextDecoder().decode(portable['library.json'])).articles[0].id).toBe('pdf00001');
    expect(portable[`pdf/${originalArticle.originalPdf!.id}.pdf`]).toEqual(pdfBytes);
    const archive = await inspectArchive(file,()=>undefined);
    await env.DB.prepare('DELETE FROM articles').run(); await env.DB.prepare('DELETE FROM pdf_assets').run();
    for (const object of (await env.PDF_BUCKET.list()).objects) await env.PDF_BUCKET.delete(object.key);
    expect(await restoreArchive(file,archive,api,()=>undefined)).toEqual({imported:1,skipped:0});
    const restored = (await api<{article:Article}>('/api/articles/pdf00001')).article;
    expect({...restored,originalPdf:undefined,extraction:undefined,hasCopy:undefined}).toMatchObject({id:originalArticle.id,url:originalArticle.url,title:originalArticle.title,readAt:originalArticle.readAt});
    expect(restored.originalPdf!.checksum).toBe(originalArticle.originalPdf!.checksum);
    expect(await api('/api/articles/pdf00001/copy')).toEqual(oldCopy);
    expect(await restoreArchive(file,archive,api,()=>undefined)).toEqual({imported:0,skipped:1});
    expect((await getOriginalPdf(env.DB,'pdf00001'))!.id).toBe(restored.originalPdf!.id);
  });
  it('rejects unexpected paths and checksum corruption before import', async () => {
    async function* badFiles() { for (const name of ['library.json','manifest.json','../bad']) yield { name,size:2,body:(async function*(){yield new TextEncoder().encode('{}');})() }; }
    const bad = new File([await new Response(iteratorStream(zipFiles(badFiles()))).arrayBuffer()],'bad.zip');
    await expect(readZipDirectory(bad)).rejects.toThrow();
    await add(); await capture();
    const file = new File([await (await route('/api/archive')).arrayBuffer()],'valid.zip');
    const directory = await readZipDirectory(file); const entry = [...directory.values()].find(e=>e.name.endsWith('.pdf'))!;
    const changed = new Uint8Array(await file.arrayBuffer()); changed[entry.start+8] ^= 1;
    await expect(inspectArchive(new File([changed],'corrupt.zip'),()=>undefined)).rejects.toThrow('checksum');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM archive_sessions').first()).toEqual({n:0});
  });
  it('requires all expected files before committing and expires staged imports', async () => {
    await add(); await capture();
    const file = new File([await (await route('/api/archive')).arrayBuffer()],'valid.zip'), archive=await inspectArchive(file,()=>undefined);
    const { id } = await api<{id:string}>('/api/archive/imports',{method:'POST',body:'{}'});
    await api(`/api/archive/imports/${id}/records`,{method:'POST',body:JSON.stringify({library:archive.library,pdfs:archive.pdfs})});
    expect((await route(`/api/archive/imports/${id}/complete`,{method:'POST',body:'{}'})).status).toBe(400);
    expect((await route(`/api/archive/imports/${id}/commit`,{method:'POST',body:'{}'})).status).toBe(409);
    await env.DB.prepare('UPDATE archive_sessions SET expires_at=?').bind(ago()).run(); await cleanupPdfAssets(configured);
    expect((await route(`/api/archive/imports/${id}/complete`,{method:'POST',body:'{}'})).status).toBe(404);
  });
  it('preserves existing URLs and their copies when an archive has a different article ID', async () => {
    await add(); await capture();
    const file=new File([await (await route('/api/archive')).arrayBuffer()],'archive.zip');
    const archive=await inspectArchive(file,()=>undefined);
    archive.library.articles[0].id='pdf00002'; archive.pdfs[0].articleId='pdf00002';
    const before=await getOriginalPdf(env.DB,'pdf00001');
    expect(await restoreArchive(file,archive,api,()=>undefined)).toEqual({imported:0,skipped:1});
    expect(await getOriginalPdf(env.DB,'pdf00001')).toEqual(before);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM articles').first()).toEqual({n:1});
  });
  it('rejects malformed metadata and cross-origin import requests before library changes', async () => {
    const {id}=await api<{id:string}>('/api/archive/imports',{method:'POST',body:'{}'});
    const invalid=await route(`/api/archive/imports/${id}/records`,{method:'POST',body:JSON.stringify({library:{version:2,exportedAt:new Date().toISOString(),articles:[{id:'bad'}]},pdfs:[]})});
    expect(invalid.status).toBe(400);
    expect((await route('/api/archive/imports',{method:'POST',body:'{}',headers:{Origin:'https://other.example'}})).status).toBe(403);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM articles').first()).toEqual({n:0});
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM archive_records').first()).toEqual({n:0});
  });
  it('round-trips an empty archive', async () => {
    const file=new File([await (await route('/api/archive')).arrayBuffer()],'empty.zip');
    const archive=await inspectArchive(file,()=>undefined);
    expect(archive.library.articles).toEqual([]);
    expect(await restoreArchive(file,archive,api,()=>undefined)).toEqual({imported:0,skipped:0});
  });
  it('restores a maximum-size Markdown copy even when JSON escaping exceeds the ordinary import bound', async () => {
    await add();
    const markdown='\u0001'.repeat(256*1024);
    await saveArticleCopy(env.DB,'pdf00001',{markdown,source:'paste',capturedAt:new Date().toISOString(),revision:'escaped-copy'},null);
    const file=new File([await (await route('/api/archive')).arrayBuffer()],'escaped.zip');
    const archive=await inspectArchive(file,()=>undefined);
    await env.DB.prepare('DELETE FROM articles').run();
    expect(await restoreArchive(file,archive,api,()=>undefined)).toEqual({imported:1,skipped:0});
    expect((await env.DB.prepare('SELECT markdown FROM article_copies').first<{markdown:string}>())!.markdown).toBe(markdown);
  });
  it('includes long PDF manifest entries in metadata upload batch limits', async () => {
    const now=new Date().toISOString(), pdfId=crypto.randomUUID();
    const sourceUrl=`https://news.example.com/${'s'.repeat(7000)}`;
    const articles=Array.from({length:160},(_,i)=>({id:i.toString(36).padStart(8,'0'),url:`https://news.example.com/${i}/${'a'.repeat(7000)}`,title:`Article ${i}`,author:null,description:null,createdAt:now,updatedAt:now,readAt:null}));
    const pdfs=articles.map(a=>({id:pdfId,articleId:a.id,checksum:'',bytes:pdfBytes.length,capturedAt:now,sourceUrl}));
    const hash=await checksum(pdfBytes); for(const p of pdfs)p.checksum=hash;
    const requests: number[]=[];
    const checkedApi=async <T>(path:string,init?:RequestInit):Promise<T>=>{
      if(path.endsWith('/records')) requests.push(new TextEncoder().encode(String(init?.body)).length);
      return api<T>(path,init);
    };
    const result=await restoreArchive(new File([pdfBytes],'fixture.pdf'),{
      library:{version:2,exportedAt:now,articles},pdfs,
      entries:new Map([[assetKey(pdfId),{name:assetKey(pdfId),size:pdfBytes.length,start:0,crc:0}]]),
    },checkedApi,()=>undefined);
    expect(result).toEqual({imported:160,skipped:0});
    expect(requests.length).toBeGreaterThan(1);
    expect(Math.max(...requests)).toBeLessThanOrEqual(2*1024*1024);
  });
  it('fetches bounded record bodies before the D1 result crosses a request budget', async () => {
    const {id}=await api<{id:string}>('/api/archive/imports',{method:'POST',body:'{}'}), now=new Date().toISOString();
    for (let i=0;i<2;i++) {
      const article={id:`large00${i}`,url:`https://news.example.com/large/${i}`,title:'Large escaped article',createdAt:now,updatedAt:now,readAt:null,
        copy:{markdown:'\u0001'.repeat(256*1024),source:'paste',capturedAt:now,revision:`large-${i}`}};
      await api(`/api/archive/imports/${id}/records`,{method:'POST',body:JSON.stringify({library:{version:2,exportedAt:now,articles:[article]},pdfs:[]})});
    }
    await api(`/api/archive/imports/${id}/complete`,{method:'POST',body:'{}'});
    const sizes: number[]=[];
    const db=observeDatabase(sql=>sql.includes('r.record') && sql.includes('committed=0'),{afterAll(result){
      const bytes=new TextEncoder().encode(JSON.stringify(result)).length; sizes.push(bytes);
      if(bytes>2*1024*1024) throw new Error('Simulated D1 query result limit exceeded');
    }});
    const response=await route(`/api/archive/imports/${id}/commit`,{method:'POST',body:'{}'},{...configured,DB:db});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({imported:1,skipped:0,done:false});
    expect(sizes).toHaveLength(1);
    expect(sizes[0]).toBeLessThan(2*1024*1024);
  });
  it('does not finalize when a new record arrives before the completion write', async () => {
    const {id}=await api<{id:string}>('/api/archive/imports',{method:'POST',body:'{}'}), now=new Date().toISOString();
    let injected=false;
    const db=observeDatabase(sql=>sql.startsWith('UPDATE archive_sessions SET completed=1'),{async beforeRun(){
      if(injected)return; injected=true;
      const article={id:'late0001',url:'https://news.example.com/late',title:'Late PDF',createdAt:now,updatedAt:now,readAt:null};
      const pdf={id:crypto.randomUUID(),articleId:article.id,checksum:await checksum(pdfBytes),bytes:pdfBytes.length,capturedAt:now,sourceUrl:article.url};
      await api(`/api/archive/imports/${id}/records`,{method:'POST',body:JSON.stringify({library:{version:2,exportedAt:now,articles:[article]},pdfs:[pdf]})});
    }});
    const response=await route(`/api/archive/imports/${id}/complete`,{method:'POST',body:'{}'},{...configured,DB:db});
    expect(injected).toBe(true); expect(response.status).toBe(400);
    expect(await env.DB.prepare('SELECT completed FROM archive_sessions WHERE id=?').bind(id).first()).toEqual({completed:0});
    expect((await route(`/api/archive/imports/${id}/commit`,{method:'POST',body:'{}'})).status).toBe(409);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM articles').first()).toEqual({n:0});
  });
  it('does not resurrect deleted articles from a stale concurrent commit', async () => {
    const {id}=await api<{id:string}>('/api/archive/imports',{method:'POST',body:'{}'}), now=new Date().toISOString();
    const article={id:'fence001',url:'https://news.example.com/fence',title:'Fenced article',createdAt:now,updatedAt:now,readAt:null};
    await api(`/api/archive/imports/${id}/records`,{method:'POST',body:JSON.stringify({library:{version:2,exportedAt:now,articles:[article]},pdfs:[]})});
    await api(`/api/archive/imports/${id}/complete`,{method:'POST',body:'{}'});
    let injected=false;
    const db=observeDatabase(()=>false,{async beforeBatch(){
      if(injected)return; injected=true;
      expect(await api(`/api/archive/imports/${id}/commit`,{method:'POST',body:'{}'})).toEqual({imported:1,skipped:0,done:true});
      expect((await route(`/api/articles/${article.id}`,{method:'DELETE'})).status).toBe(204);
    }});
    const response=await route(`/api/archive/imports/${id}/commit`,{method:'POST',body:'{}'},{...configured,DB:db});
    expect(injected).toBe(true); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({imported:0,skipped:0,done:true});
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM articles').first()).toEqual({n:0});
  });
  it('does not publish a cached commit after its archive session is removed', async () => {
    const {id}=await api<{id:string}>('/api/archive/imports',{method:'POST',body:'{}'}), now=new Date().toISOString();
    const article={id:'fence002',url:'https://news.example.com/expired',title:'Expired article',createdAt:now,updatedAt:now,readAt:null};
    await api(`/api/archive/imports/${id}/records`,{method:'POST',body:JSON.stringify({library:{version:2,exportedAt:now,articles:[article]},pdfs:[]})});
    await api(`/api/archive/imports/${id}/complete`,{method:'POST',body:'{}'});
    const db=observeDatabase(()=>false,{async beforeBatch(){await env.DB.prepare('DELETE FROM archive_sessions WHERE id=?').bind(id).run();}});
    expect((await route(`/api/archive/imports/${id}/commit`,{method:'POST',body:'{}'},{...configured,DB:db})).status).toBe(404);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM articles').first()).toEqual({n:0});
  });
});
