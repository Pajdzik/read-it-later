import { expect, it } from 'vitest';
import { extractArticleMarkdown } from '../src/articles/extraction';

it('extracts formatting in the Worker runtime', async () => {
  const markdown = await extractArticleMarkdown('<html><head><title>Fixture</title></head><body><article><h1>Article heading</h1><p>Keep <strong>formatting</strong> in the saved text.</p></article></body></html>', 'https://source.example/article');
  expect(markdown).toContain('**formatting**');
});

it('rejects an extracted copy above the UTF-8 limit', async () => {
  const html = `<html><body><article><h1>Large article</h1><p>${'é '.repeat(100000)}</p></article></body></html>`;
  await expect(extractArticleMarkdown(html, 'https://source.example/large')).rejects.toThrow('256 KiB');
});
