import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { expect } from 'playwright/test';
import { iteratorStream, zipFiles, readZipDirectory, readZipEntry } from '../src/archive/zip.ts';

export async function pdfArchiveSmoke(context, base) {
  const page = await context.newPage();
  const now = '2026-10-31T00:00:00.000Z';
  const pdf = new TextEncoder().encode('%PDF-1.7\n% Private PDF browser fixture\n%%EOF');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',pdf)),b=>b.toString(16).padStart(2,'0')).join('');
  const id = '11111111-1111-4111-8111-111111111111';
  const article = { id:'pdfui001',url:'https://news.example.com/preserved.pdf',title:'Preserved PDF browser smoke',author:'Test Author',description:'Portable PDF',createdAt:now,updatedAt:now,readAt:null,
    copy:{markdown:'# Preserved PDF browser smoke\n\nPrivate reading copy.',capturedAt:now,source:'paste',revision:'pdf-browser-revision'} };
  const files = new Map([
    ['library.json',new TextEncoder().encode(JSON.stringify({version:2,exportedAt:now,articles:[article]}))],
    ['manifest.json',new TextEncoder().encode(JSON.stringify({version:1,exportedAt:now,pdfs:[{articleId:article.id,id,bytes:pdf.length,checksum:hash,capturedAt:now,sourceUrl:article.url}]}))],
    [`pdf/${id}.pdf`,pdf],
  ]);
  async function* entries() { for (const [name,bytes] of files) yield {name,size:bytes.length,body:(async function*(){yield bytes;})()}; }
  const bytes = await new Response(iteratorStream(zipFiles(entries()))).arrayBuffer();
  try {
    await page.goto(base); await page.locator('#loading').waitFor({state:'hidden'});
    await page.locator('#settings-open').click();
    page.once('dialog',dialog=>dialog.accept());
    await page.locator('#import-archive-file').setInputFiles({name:'fixture.zip',mimeType:'application/zip',buffer:Buffer.from(bytes)});
    await expect(page.locator('#settings-status')).toHaveText('Restored 1 articles; skipped 0.');
    const downloading = page.waitForEvent('download');
    await page.locator('#export-archive').click();
    const download = await downloading;
    const archive = new Blob([await readFile(await download.path())]);
    const directory = await readZipDirectory(archive);
    const manifest = JSON.parse(new TextDecoder().decode(await readZipEntry(archive,directory.get('manifest.json'))));
    assert.ok(manifest.pdfs.some(p=>p.articleId===article.id && p.checksum===hash));
    await page.goto(`${base}/read/${article.id}/preserved-pdf`);
    await expect(page.locator('#reader-body')).toContainText('Private reading copy.');
    await expect(page.locator('#reader-pdf-open')).toBeVisible();
    await expect(page.locator('#reader-pdf-download')).toHaveAttribute('href',new RegExp(`/api/articles/${article.id}/pdf\\?asset=[a-f0-9-]+&download=1`));
    const original = await page.request.get(`${base}/api/articles/${article.id}/pdf`);
    assert.deepEqual(new Uint8Array(await original.body()),pdf);
    const detail = await (await page.request.get(`${base}/api/articles/${article.id}`)).json();
    assert.equal(detail.article.readAt,null,'Opening the saved PDF must not mark it read');
    await page.setViewportSize({width:390,height:844});
    await expect(page.locator('#reader-pdf-open')).toBeVisible();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'PDF actions fit mobile');
    await page.screenshot({path:'/tmp/potem-pdf-reader-mobile.png'});
    await page.locator('.reader-back').click();
    await page.locator('#settings-open').click();
    page.once('dialog',dialog=>dialog.accept());
    await page.locator('#import-archive-file').setInputFiles({name:'fixture.zip',mimeType:'application/zip',buffer:Buffer.from(bytes)});
    await expect(page.locator('#settings-status')).toHaveText('Restored 0 articles; skipped 1.');
    console.log('PDF/archive smoke passed: file restore, ZIP download, private PDF access, reader actions, mobile layout, idempotent restore.');
  } finally { await page.close(); }
}
