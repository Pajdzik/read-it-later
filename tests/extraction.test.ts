import { expect, it } from 'vitest';
import { extractArticleMarkdown, parseArticleDocument } from '../src/articles/extraction';

it('extracts formatting in the Worker runtime', async () => {
  const markdown = await extractArticleMarkdown('<html><head><title>Fixture</title></head><body><article><h1>Article heading</h1><p>Keep <strong>formatting</strong> in the saved text.</p></article></body></html>', 'https://source.example/article');
  expect(markdown).toContain('**formatting**');
});

it('extracts from a previously parsed document', async () => {
  const document = parseArticleDocument('<html><body><article><p>Shared <strong>document</strong> input.</p></article></body></html>');
  const markdown = await extractArticleMarkdown(document, 'https://source.example/article');
  expect(markdown).toContain('Shared **document** input.');
});

it('extracts readable content from HTML larger than the former 512 KiB source limit', async () => {
  const html = `<html><head><title>Large source</title></head><body><nav>${'<span>navigation clutter</span>'.repeat(24_000)}</nav><article><h1>Git at any scale</h1><p>Readable article content survives the larger source limit.</p></article></body></html>`;
  expect(new TextEncoder().encode(html).byteLength).toBeGreaterThan(512 * 1024);
  expect(new TextEncoder().encode(html).byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
  const markdown = await extractArticleMarkdown(html, 'https://cursor.com/blog/git-at-any-scale');
  expect(markdown).toContain('Readable article content survives the larger source limit.');
  expect(markdown).not.toContain('navigation clutter');
});

it('rejects an extracted copy above the UTF-8 limit', async () => {
  const html = `<html><body><article><h1>Large article</h1><p>${'é '.repeat(100000)}</p></article></body></html>`;
  await expect(extractArticleMarkdown(html, 'https://source.example/large')).rejects.toThrow('256 KiB');
});
