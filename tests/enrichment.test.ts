import { env as testEnv } from 'cloudflare:workers';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Env, EnrichmentMessage } from '../src/contracts';
import { completeEnrichment, enrichmentStatuses, isEnrichmentMessage, markdownLead,
  processEnrichmentMessage, recoverEnrichmentJobs, reserveEnrichmentAttempt,
  MAX_MARKDOWN_BYTES, plainMarkdown, type EnrichmentInput } from '../src/articles/enrichment';
import { buildEnrichmentMessages, enrichmentModelInput, MAX_PROMPT_BYTES, parseEnrichmentOutput,
  canGenerateDescription, relevantExistingTags, enrichmentPromptBytes } from '../benchmarks/legacy-enrichment';
import { normalizeTags } from '../src/articles/tags';
import { deleteArticle, getArticle, getArticleCopy, listArticles, saveArticle, saveArticleCopy, updateArticle,
  type SaveArticleInput } from '../src/articles/repository';
import { handleArticles } from '../src/articles/handler';
import { claimExtractionJob, completeExtractionJob } from '../src/articles/jobs';
import { consumeExtractionBatch } from '../src/articles/processor';
import { createMessageBatch } from 'cloudflare:test';

const NOW = '2026-10-31T12:00:00.000Z';
const response = () => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ tags: ['Databases', '  Query   Planning '] }), tool_calls: [] } }] });
const message = (id: string): EnrichmentMessage => ({ version: 1, kind: 'enrichment', articleId: id });
function configured(run: NonNullable<Env['AI']>['run'] = vi.fn(async () => response()), daily = '100'): Env {
  return { ...testEnv, ARTICLE_ENRICHMENT_ENABLED: 'true', ARTICLE_ENRICHMENT_DAILY_LIMIT: daily,
    AI: { run } };
}
async function add(n = '1', options: Partial<SaveArticleInput> = {}) {
  return (await saveArticle(testEnv.DB, { ...options,
    url: `https://example.com/${n}`, normalizedUrl: `https://example.com/${n}`,
    title: options.title ?? 'Understanding database indexes', titleOrigin: options.titleOrigin ?? 'supplied',
    enrichmentRequested: options.enrichmentRequested ?? true,
  })).article;
}
async function copy(id: string, markdown = '# Indexing\n\n- B-tree indexes speed up database lookups.\n- Query planning chooses an index.', revision = 'copy-one', expected: string | null = null) {
  await saveArticleCopy(testEnv.DB, id, { markdown, revision, capturedAt: NOW, source: 'paste' }, expected);
}
async function job(id: string) { return testEnv.DB.prepare('SELECT * FROM article_enrichment_jobs WHERE article_id=?').bind(id).first<Record<string, unknown>>(); }
async function usage() { return (await testEnv.DB.prepare('SELECT COALESCE(SUM(attempts),0) AS n FROM enrichment_daily_usage').first<{ n: number }>())!.n; }

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
  await testEnv.DB.prepare('DROP TRIGGER IF EXISTS reject_enrichment').run();
  await testEnv.DB.prepare('DELETE FROM articles').run();
  await testEnv.DB.prepare('DELETE FROM enrichment_daily_usage').run();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('bounded enrichment text', () => {
  it('normalizes and deduplicates tags while rejecting invalid owner and model input', () => {
    expect(normalizeTags(['  Machine   Learning ', 'machine learning', 'SQL'])).toEqual(['machine learning','sql']);
    for (const input of [null, 'sql', [''], ['x'.repeat(41)], ['<script>'], ['bad\ntext'], Array(11).fill('sql')]) expect(() => normalizeTags(input)).toThrow();
    expect(() => parseEnrichmentOutput({ response: JSON.stringify({ tags: ['sql'], description: '雪'.repeat(281) }) })).toThrow();
    expect(() => parseEnrichmentOutput({ response: '```json\n{"tags":[],"description":null}\n```' })).toThrow();
    expect(() => parseEnrichmentOutput({ response: '{"tags":[],"description":null,"unexpected":true}' })).toThrow();
  });
  it('rejects every malformed result without salvaging fields, tags or a first object', () => {
    for (const response of [
      '{"tags":["sql"],"description":null', '{"tags":["sql"]}',
      '{"tags":[],"description":null} {"tags":[],"description":null}',
      'Here is JSON: {"tags":[],"description":null}',
      JSON.stringify({ tags: ['sql', ' SQL '], description: null }),
      JSON.stringify({ tags: Array(6).fill('sql'), description: null }),
      JSON.stringify({ tags: ['bad\u2028tag'], description: null }),
      JSON.stringify({ tags: ['sql'], description: 'One sentence. Another sentence.' }),
      JSON.stringify({ tags: ['sql'], description: 'First line.\nSecond line.' }),
      JSON.stringify({ tags: ['sql'], description: 'One sentence.\u2028Another sentence.' }),
    ]) expect(() => parseEnrichmentOutput({ response })).toThrow();
    expect(() => parseEnrichmentOutput({ response: JSON.stringify({ tags: ['sql'], description: 'A factual sentence.' }) }, false)).toThrow();
  });
  it('selects at most five relevant whole-word tags without popular unrelated padding', () => {
    const input: EnrichmentInput = { title: 'Air travel and database indexes', title_origin: 'supplied', description: null,
      description_origin: null, tags_manual: 0, markdown: '- Database indexes organize keys and speed up query planning.', revision: 'r', baseline: '[]' };
    expect(relevantExistingTags(input, ['ai', 'security', 'database indexes', 'air travel', 'query planning']))
      .toEqual(['database indexes', 'air travel', 'query planning']);
    expect(relevantExistingTags(input, ['security', 'astronomy'])).toEqual([]);
    expect(relevantExistingTags(input, ['air','travel','database','indexes','query','planning'])).toHaveLength(5);
  });
  it('requires grounded prose for generation and counts examples in the complete prompt budget', () => {
    const input: EnrichmentInput = { title: 'Database indexes', title_origin: 'supplied', description: null,
      description_origin: null, tags_manual: 0, markdown: '# A very long heading about database indexes and the query planner with no article text.', revision: 'r', baseline: '[]' };
    expect(canGenerateDescription(input)).toBe(false);
    expect(buildEnrichmentMessages(input, [])[0].content).toContain('Description: null.');
    input.markdown = '- Indeksy pozwalają wyszukiwać wiersze bez przeglądania całej tabeli.';
    expect(canGenerateDescription(input)).toBe(true);
    input.description_origin = 'manual'; expect(canGenerateDescription(input)).toBe(false);
    const messages = buildEnrichmentMessages(input, []);
    expect(() => enrichmentModelInput([...messages, { role: 'assistant', content: 'x'.repeat(MAX_PROMPT_BYTES) }])).toThrow('prompt_too_large');
  });
  it('finds prose without returning frontmatter, headings, code, navigation, or cookie notices', () => {
    const prose = 'Database indexes make targeted lookups faster, while adding a cost to every write.';
    expect(markdownLead(`---\nsecret: ignored\n---\n# Title\n\n\`\`\`sql\nSELECT 1\n\`\`\`\n\n${prose}`)).toBe(prose);
    expect(markdownLead('# Heading\n\n- A bullet with enough words to look like a paragraph but which must not become a description.')).toBeNull();
    expect(markdownLead('Cookie preferences are used to personalize advertising across all of our partner websites.')).toBeNull();
  });
  it('bounds preprocessing before scanning malformed Markdown delimiters', () => {
    for (const delimiter of ['<', '[', '![', '`', '~']) {
      const text = delimiter.repeat(256 * 1024).slice(0, 256 * 1024);
      const result = plainMarkdown(text);
      expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(MAX_MARKDOWN_BYTES);
    }
    expect(plainMarkdown('**Readable** [article](https://example.com) ![image](https://example.com/image) <b>text</b>'))
      .toBe('Readable article  text');
  });
  it('keeps astral descriptions within the existing portable metadata limit', () => {
    const lead = markdownLead('📰'.repeat(250) + ' Notes on visual language and symbols.');
    expect(lead).not.toBeNull();
    expect(lead!.length).toBeLessThanOrEqual(500);
    expect([...lead!].length).toBeLessThanOrEqual(280);
    expect(new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(lead!))).toBe(lead);
    expect(() => parseEnrichmentOutput({ response: JSON.stringify({ tags: ['design'], description: '📰'.repeat(251) }) })).toThrow();
  });
  it('bounds the complete JSON-escaped prompt and keeps Unicode intact', () => {
    const input: EnrichmentInput = { title: '雪'.repeat(500), title_origin: 'supplied', description: null, description_origin: null,
      tags_manual: 0, markdown: '"\\📰'.repeat(20000), revision: 'r', baseline: '[]' };
    const prompt = buildEnrichmentMessages(input, Array(200).fill('雪'.repeat(40)));
    expect(enrichmentPromptBytes(prompt)).toBeLessThanOrEqual(MAX_PROMPT_BYTES);
    const request = enrichmentModelInput(prompt);
    expect(request.messages?.reduce((n, m) => n + new TextEncoder().encode(m.content).length, 0)).toBeLessThanOrEqual(MAX_PROMPT_BYTES);
    expect(new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(JSON.stringify(prompt)))).toBe(JSON.stringify(prompt));
    expect(prompt[0].content).toContain('untrusted data');
  });
});

describe('durable enrichment', () => {
  it('inserts intent and job atomically for new articles only, including missed notification repair', async () => {
    const old = await add('old', { enrichmentRequested: false });
    await add('old');
    expect(await job(old.id)).toBeNull();
    await testEnv.DB.prepare("CREATE TRIGGER reject_enrichment BEFORE INSERT ON article_enrichment_jobs BEGIN SELECT RAISE(ABORT,'blocked'); END").run();
    await expect(add('atomic')).rejects.toThrow();
    expect((await listArticles(testEnv.DB, { status: 'all' })).items).toHaveLength(1);
    await testEnv.DB.prepare('DROP TRIGGER reject_enrichment').run();
    const article = await add();
    await testEnv.DB.prepare('DELETE FROM article_enrichment_jobs WHERE article_id=?').bind(article.id).run();
    const sendBatch = vi.fn(async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }));
    await recoverEnrichmentJobs({ ...configured(), EXTRACTION_QUEUE: { sendBatch, send: vi.fn(), metrics: vi.fn() } as Queue });
    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(await job(article.id)).toMatchObject({ state: 'queued', attempts: 0 });
  });
  it('elects one claimant, applies normalized tags, and never regenerates successful or duplicate articles', async () => {
    const article = await add(); const run = vi.fn(async () => response()), env = configured(run);
    await Promise.all([processEnrichmentMessage(env, message(article.id)), processEnrichmentMessage(env, message(article.id))]);
    expect(run).toHaveBeenCalledTimes(1); expect(await usage()).toBe(1);
    expect(await getArticle(testEnv.DB, article.id)).toMatchObject({ tags: ['databases','query planning'], description: null });
    await add(); await updateArticle(testEnv.DB, article.id, { title: 'A corrected title' });
    await processEnrichmentMessage(env, message(article.id));
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('waits for capture, then uses a saved copy without a second fetch or external publishing', async () => {
    const article = await add('capture', { extractionRequested: true });
    const run = vi.fn(async () => response()), env = configured(run);
    const externalFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Enrichment must not publish externally'); });
    await processEnrichmentMessage(env, message(article.id)); expect(run).not.toHaveBeenCalled();
    await copy(article.id); await processEnrichmentMessage(env, message(article.id));
    expect(run).toHaveBeenCalledTimes(1);
    expect((await getArticleCopy(testEnv.DB, article.id))!.revision).toBe('copy-one');
    expect(externalFetch).not.toHaveBeenCalled();
  });
  it('waits for reviewed browser Markdown instead of racing the link save', async () => {
    const article = await add('clip', { enrichAfterCopy: true });
    const run = vi.fn(async () => response()), env = configured(run);
    await processEnrichmentMessage(env, message(article.id)); expect(run).not.toHaveBeenCalled();
    await copy(article.id); await processEnrichmentMessage(env, message(article.id));
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('finishes a maximum-size malformed copy instead of repeatedly expiring before reservation', async () => {
    const article = await add('malformed'); await copy(article.id, '<'.repeat(256 * 1024));
    const run = vi.fn(async () => response());
    await processEnrichmentMessage(configured(run), message(article.id));
    expect(run).toHaveBeenCalledTimes(1);
    expect(await usage()).toBe(1);
    expect(await job(article.id)).toMatchObject({ state: 'succeeded', attempts: 1 });
    expect((await getArticleCopy(testEnv.DB, article.id))!.markdown.length).toBe(256 * 1024);
  });
  it('skips hostname placeholders but can tag a supplied title after terminal extraction failure', async () => {
    const empty = await add('empty', { title: 'example.com/empty', titleOrigin: 'fallback' });
    const run = vi.fn(async () => response()), env = configured(run);
    await processEnrichmentMessage(env, message(empty.id));
    expect(await job(empty.id)).toMatchObject({ state: 'skipped', error_code: 'insufficient_content' });
    const article = await add('failed', { extractionRequested: true });
    expect(await testEnv.DB.prepare('SELECT article_id FROM article_extraction_jobs WHERE article_id=?').bind(article.id).first())
      .toEqual({ article_id: article.id });
    await testEnv.DB.prepare("UPDATE article_extraction_jobs SET state='failed' WHERE article_id=?").bind(article.id).run();
    await processEnrichmentMessage(env, message(article.id)); expect(run).toHaveBeenCalledTimes(1);
  });
  it('uses extracted prose before generation and preserves supplied descriptions', async () => {
    const prose = 'An index lets the query planner avoid reading every row of a large database table.';
    const article = await add(); await copy(article.id, `# Indexes\n\n${prose}`);
    const run = vi.fn(async () => response()); await processEnrichmentMessage(configured(run), message(article.id));
    expect(await getArticle(testEnv.DB, article.id)).toMatchObject({ description: prose, descriptionOrigin: 'extracted' });
    expect(run.mock.calls[0]).toBeDefined();
    const supplied = await add('supplied', { description: 'A supplied description' }); await copy(supplied.id);
    await processEnrichmentMessage(configured(), message(supplied.id));
    expect(await getArticle(testEnv.DB, supplied.id)).toMatchObject({ description: 'A supplied description', descriptionOrigin: 'manual' });
  });
  it('makes one tagging-only request and leaves generated descriptions disabled', async () => {
    const article = await add(); await copy(article.id);
    const run = vi.fn(async () => response());
    await processEnrichmentMessage(configured(run), message(article.id));
    expect(await getArticle(testEnv.DB, article.id)).toMatchObject({ descriptionOrigin: null, description: null, tags: ['databases','query planning'] });
    expect(run).toHaveBeenCalledTimes(1);
    const link = await add('link'); await processEnrichmentMessage(configured(run), message(link.id));
    expect((await getArticle(testEnv.DB, link.id))!.description).toBeNull();
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('rejects unwanted description fields without salvaging tags or making a repair call', async () => {
    const article = await add('unwanted');
    const run = vi.fn(async () => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ tags: ['databases'], description: 'Invented from the title.' }) } }] }));
    await processEnrichmentMessage(configured(run), message(article.id));
    expect(run).toHaveBeenCalledTimes(1);
    expect(await getArticle(testEnv.DB, article.id)).toMatchObject({ description: null, tags: [] });
    expect(await job(article.id)).toMatchObject({ state: 'failed', error_code: 'invalid_output', attempts: 1 });
  });
  it('skips a manual tag edit even if missing descriptions could previously trigger generation', async () => {
    const article = await add('manual-tags'); await copy(article.id);
    await updateArticle(testEnv.DB, article.id, { tags: ['owner tag'] });
    const run = vi.fn(async () => response());
    await processEnrichmentMessage(configured(run), message(article.id));
    expect(run).not.toHaveBeenCalled(); expect(await usage()).toBe(0);
    expect(await getArticle(testEnv.DB, article.id)).toMatchObject({ tags: ['owner tag'], description: null });
    expect(await job(article.id)).toMatchObject({ state: 'skipped', error_code: 'manually_edited' });
  });
  it('fingerprints the entire request and logs failed-call usage without source text', async () => {
    const article = await add('accounting');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const run = vi.fn(async (..._args: unknown[]) => ({ response: 'private source text is not JSON', usage: { prompt_tokens: 111, completion_tokens: 192 } }));
    await processEnrichmentMessage(configured(run), message(article.id));
    const [model, request] = run.mock.calls[0];
    expect(model).toBe('@cf/zai-org/glm-4.7-flash');
    expect(request).toMatchObject({ max_completion_tokens: 192, temperature: 0, stream: false, chat_template_kwargs: { enable_thinking: false } });
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${model}\n${JSON.stringify(request)}`)))]
      .map(b => b.toString(16).padStart(2, '0')).join('');
    expect(await job(article.id)).toMatchObject({ input_fingerprint: hash });
    const logged = info.mock.calls.map(([line]) => JSON.parse(String(line))).find(event => event.event === 'enrichment_output_invalid');
    expect(logged).toMatchObject({ articleId: article.id, attempt: 1, inputTokens: 111, outputTokens: 192 });
    expect(JSON.stringify(logged)).not.toContain('private source text');
    expect(await usage()).toBe(1);
  });
  it('honors manual edits and deliberate clearing while inference is in flight', async () => {
    const article = await add(); await copy(article.id);
    const run = vi.fn(async () => { await updateArticle(testEnv.DB, article.id, { tags: [], description: null }); return response(); });
    await processEnrichmentMessage(configured(run), message(article.id));
    expect(await getArticle(testEnv.DB, article.id)).toMatchObject({ tags: [], tagsManuallyEdited: true, description: null, descriptionOrigin: 'manual' });
    expect(await job(article.id)).toMatchObject({ state: 'skipped', error_code: 'input_changed' });
  });
  it('discards results after content changes or deletion', async () => {
    const article = await add(); await copy(article.id);
    await processEnrichmentMessage(configured(vi.fn(async () => { await copy(article.id, '# A new copy', 'copy-two', 'copy-one'); return response(); })), message(article.id));
    expect((await getArticle(testEnv.DB, article.id))!.tags).toEqual([]);
    expect(await job(article.id)).toMatchObject({ state: 'skipped' });
    const deleted = await add('deleted');
    await processEnrichmentMessage(configured(vi.fn(async () => { await deleteArticle(testEnv.DB, deleted.id); return response(); })), message(deleted.id));
    expect(await job(deleted.id)).toBeNull();
  });
  it('counts failed calls, caps concurrent usage, and defers without consuming retry attempts', async () => {
    const articles = await Promise.all(Array.from({ length: 6 }, (_, i) => add(String(i))));
    const run = vi.fn(async () => response()), env = configured(run, '2');
    await Promise.all(articles.map(a => processEnrichmentMessage(env, message(a.id))));
    expect(run).toHaveBeenCalledTimes(2); expect(await usage()).toBe(2);
    const rows = await testEnv.DB.prepare("SELECT state,attempts,next_attempt_at FROM article_enrichment_jobs WHERE state='deferred'").all();
    expect(rows.results).toHaveLength(4);
    expect(rows.results[0]).toMatchObject({ attempts: 0, next_attempt_at: '2026-11-01T00:00:00.000Z' });
    vi.setSystemTime(new Date('2026-11-01T00:00:01.000Z'));
    await Promise.all(articles.map(a => processEnrichmentMessage(env, message(a.id))));
    expect(run).toHaveBeenCalledTimes(4); expect(await usage()).toBe(4);
  });
  it('retries transient failures once and never repairs invalid model output', async () => {
    const article = await add(); const run = vi.fn(async () => { throw new Error('HTTP 503 unavailable'); }), env = configured(run);
    await processEnrichmentMessage(env, message(article.id)); expect(await job(article.id)).toMatchObject({ state: 'retry_wait', attempts: 1 });
    vi.setSystemTime(new Date(Date.parse(NOW) + 61_000));
    await processEnrichmentMessage(env, message(article.id)); expect(await job(article.id)).toMatchObject({ state: 'failed', attempts: 2 });
    await processEnrichmentMessage(env, message(article.id)); expect(run).toHaveBeenCalledTimes(2); expect(await usage()).toBe(2);
    const invalid = await add('invalid'), bad = vi.fn(async () => ({ response: 'not JSON' }));
    await processEnrichmentMessage(configured(bad), message(invalid.id)); await processEnrichmentMessage(configured(bad), message(invalid.id));
    expect(bad).toHaveBeenCalledTimes(1); expect(await job(invalid.id)).toMatchObject({ state: 'failed', error_code: 'invalid_output' });
  });
  it('fences expired leases, recovers once, and stops after the second spent attempt', async () => {
    const article = await add();
    await testEnv.DB.prepare("UPDATE article_enrichment_jobs SET state='running',lease_token='old',lease_expires_at=?,attempts=1 WHERE article_id=?")
      .bind('2026-10-31T11:59:00.000Z', article.id).run();
    expect(await reserveEnrichmentAttempt(configured(), article.id, 'old', NOW)).toBe(false);
    const sendBatch = vi.fn(async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } })); await recoverEnrichmentJobs({ ...configured(), EXTRACTION_QUEUE: { sendBatch, send: vi.fn(), metrics: vi.fn() } as Queue });
    expect(await job(article.id)).toMatchObject({ state: 'retry_wait', attempts: 1 });
    await testEnv.DB.prepare("UPDATE article_enrichment_jobs SET state='running',lease_token='new',lease_expires_at=?,attempts=2 WHERE article_id=?")
      .bind('2026-10-31T11:59:00.000Z', article.id).run();
    await recoverEnrichmentJobs({ ...configured(), EXTRACTION_QUEUE: { sendBatch, send: vi.fn(), metrics: vi.fn() } as Queue });
    expect(await job(article.id)).toMatchObject({ state: 'failed', attempts: 2 });
  });
  it('rolls back partial results on storage failure and rejects a stale completion token', async () => {
    const article = await add(); await copy(article.id);
    await testEnv.DB.prepare("CREATE TRIGGER reject_enrichment BEFORE INSERT ON article_tags BEGIN SELECT RAISE(ABORT,'storage failed'); END").run();
    await expect(processEnrichmentMessage(configured(), message(article.id))).rejects.toThrow();
    expect((await getArticle(testEnv.DB, article.id))!.tags).toEqual([]);
    expect(await job(article.id)).toMatchObject({ state: 'running', attempts: 1 });
    const input = await testEnv.DB.prepare(`SELECT a.title,a.title_origin,a.description,a.description_origin,a.tags_manual,c.markdown,c.revision,
      json_array(a.title,a.title_origin,a.description,a.description_origin,a.tags_manual) AS baseline
      FROM articles a LEFT JOIN article_copies c ON c.article_id=a.id WHERE a.id=?`).bind(article.id).first<EnrichmentInput>();
    expect(await completeEnrichment(testEnv.DB, article.id, 'stale-token', input!, { tags: ['bad'] })).toBe(false);
    expect((await getArticle(testEnv.DB, article.id))!.description).toBeNull();
    await testEnv.DB.prepare('DROP TRIGGER reject_enrichment').run();
  });
  it('enrichment remains independent of capture pause and honors its own switch', async () => {
    const article = await add(); const run = vi.fn(async () => response());
    await processEnrichmentMessage({ ...configured(run), ARTICLE_ENRICHMENT_ENABLED: 'false' }, message(article.id));
    expect(run).not.toHaveBeenCalled();
    await processEnrichmentMessage({ ...configured(run), BACKGROUND_CAPTURE_ENABLED: 'false' }, message(article.id));
    expect(run).toHaveBeenCalledTimes(1);
    expect((await enrichmentStatuses(configured(), [article.id])).get(article.id)).toEqual({ state: 'succeeded', paused: false });
    expect(isEnrichmentMessage({ ...message(article.id), extra: true })).toBe(false);
    const other = await add('queue');
    const batch = createMessageBatch('articles', [{ id: 'enrich', timestamp: new Date(), body: message(other.id), attempts: 1 }]);
    await consumeExtractionBatch(batch, configured(run)); expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('tag API and portable metadata', () => {
  const origin = 'http://localhost:8787';
  function route(path: string, method = 'GET', body?: unknown) {
    return handleArticles(new Request(`${origin}${path}`, { method, headers: { Origin: origin, 'X-CSRF-Token': 'dev-bypass', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), { ...configured(), DEV_AUTH_BYPASS: 'true', APP_ORIGIN: origin });
  }
  it('tag-only edits leave a queued fallback title eligible for extraction', async () => {
    const a = await add('fallback', { title: 'example.com/fallback', titleOrigin: 'fallback', extractionRequested: true });
    expect(await testEnv.DB.prepare('SELECT article_id FROM article_extraction_jobs WHERE article_id=?').bind(a.id).first())
      .toEqual({ article_id: a.id });
    expect((await route(`/api/articles/${a.id}`, 'PATCH', { tags: ['databases'] }))!.status).toBe(200);
    const claimed = await claimExtractionJob(testEnv.DB, NOW);
    expect(claimed).not.toBeNull();
    expect(await completeExtractionJob(testEnv.DB, claimed!, { markdown: '# Database article', metadata: { title: 'The actual article headline' } }, NOW)).toBe(true);
    expect(await getArticle(testEnv.DB, a.id)).toMatchObject({ title: 'The actual article headline', tags: ['databases'] });
  });
  it('filters exact tags alongside search/read state and provides authenticated counts', async () => {
    const a = await add(), b = await add('2');
    await updateArticle(testEnv.DB, a.id, { tags: ['SQL', 'databases'], read: true });
    await updateArticle(testEnv.DB, b.id, { tags: ['sql'] });
    expect((await listArticles(testEnv.DB, { status: 'read', q: 'database', tag: 'sql' })).items.map(a => a.id)).toEqual([a.id]);
    expect((await listArticles(testEnv.DB, { status: 'all', tag: 'sq' })).items).toEqual([]);
    expect(await (await route('/api/tags'))!.json()).toEqual({ tags: [{ tag: 'databases', count: 1 }, { tag: 'sql', count: 2 }] });
    expect((await route(`/api/articles/${a.id}`, 'PATCH', { tags: [], description: null }))!.status).toBe(200);
    expect((await route(`/api/articles/${a.id}`, 'PATCH', { descriptionOrigin: 'generated' }))!.status).toBe(400);
    expect((await route('/api/articles?tag=sql&tag=databases'))!.status).toBe(400);
    const unauth = await handleArticles(new Request('https://test.example/api/tags'), { ...testEnv, DEV_AUTH_BYPASS: 'false', GITHUB_CLIENT_ID: 'test', GITHUB_CLIENT_SECRET: 'test', OWNER_GITHUB_ID: '1', APP_ORIGIN: 'https://test.example' });
    expect(unauth!.status).toBe(401);
  });
  it('round trips v3 tags, protection and provenance without restoring generation intent', async () => {
    const a = await add(); await copy(a.id); await updateArticle(testEnv.DB, a.id, { tags: ['sql'], description: null });
    const exported = await (await route('/api/export'))!.json() as { version: number; articles: unknown[] };
    expect(exported.version).toBe(3); expect(JSON.stringify(exported)).not.toContain('enrichment_requested_at');
    await deleteArticle(testEnv.DB, a.id);
    expect((await route('/api/import', 'POST', exported))!.status).toBe(200);
    expect(await getArticle(testEnv.DB, a.id)).toMatchObject({ tags: ['sql'], tagsManuallyEdited: true, descriptionOrigin: 'manual', description: null });
    expect(await job(a.id)).toBeNull();
    expect(await (await route('/api/import', 'POST', exported))!.json()).toEqual({ imported: 0, skipped: 1 });
    expect((await getArticleCopy(testEnv.DB, a.id))!.markdown).toContain('B-tree');
  });
  it('round trips an enriched astral-Unicode lead through its own v3 export', async () => {
    const a = await add('astral'); await copy(a.id, '# Symbols\n\n' + '📰'.repeat(250) + ' Notes on visual language and symbols.');
    await processEnrichmentMessage(configured(), message(a.id));
    const before = await getArticle(testEnv.DB, a.id);
    expect(before!.descriptionOrigin).toBe('extracted');
    const exported = await (await route('/api/export'))!.json();
    await deleteArticle(testEnv.DB, a.id);
    expect((await route('/api/import', 'POST', exported))!.status).toBe(200);
    expect(await getArticle(testEnv.DB, a.id)).toEqual(before);
  });
});
