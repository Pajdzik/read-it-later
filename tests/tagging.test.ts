import { describe, expect, it } from 'vitest';
import { buildTaggingRequest, parseTaggingOutput, taggingUsage, taggingPromptBytes, TAGGING_OUTPUT_TOKENS, TAGGING_PROMPT_BYTES } from '../src/articles/tagging';

const article = { title: 'Database indexes', description: null, text: 'B-tree database indexes allow matching rows to be located without scanning the whole table.' };
function glm(content = '{"tags":["Databases","indexes"]}', extra = {}) {
  return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content, tool_calls: [], function_call: null, refusal: null } }], ...extra };
}
describe('tagging model contracts', () => {
  it('bounds complete GLM requests including the schema and preserves Unicode', () => {
    const request = buildTaggingRequest({ title: '📰'.repeat(1000), description: null, text: '\\\"📰'.repeat(20000) });
    expect(taggingPromptBytes(request)).toBeLessThanOrEqual(TAGGING_PROMPT_BYTES);
    const serialized = JSON.stringify(request);
    expect(new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(serialized))).toBe(serialized);
    expect(request.max_completion_tokens).toBe(TAGGING_OUTPUT_TOKENS);
    expect(request).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
  });
  it('accepts documented empty provider metadata without changing the tags JSON', () => {
    expect(parseTaggingOutput(glm())).toEqual({ tags: ['databases','indexes'] });
  });
  it('suggests only evidence-matched whole-word tags and never fills empty vocabulary slots', () => {
    const request = buildTaggingRequest(article, ['air travel','ai','database indexes','gardening','database']);
    expect(request.messages?.[1].content).toContain('Suggested existing tags: database indexes, database');
    expect(request.messages?.[1].content).not.toContain('air travel');
    expect(buildTaggingRequest(article, ['gardening']).messages?.[1].content).not.toContain('Suggested existing tags');
    const many = buildTaggingRequest({ title: 'one two three four five six', description: null, text: '' }, ['one','two','three','four','five','six']);
    expect(many.messages?.[1].content).toContain('Suggested existing tags: one, two, three, four, five');
    expect(many.messages?.[1].content).not.toContain(', six');
  });
  it('rejects nonterminal, refused, multiple-message or tool results even if text contains valid JSON', () => {
    const truncated = glm(); truncated.choices[0].finish_reason = 'length';
    const tool = glm(); Object.assign(tool.choices[0].message, { tool_calls: [{ type: 'function' }] });
    const refused = glm(); Object.assign(refused.choices[0].message, { refusal: 'Refused' });
    for (const value of [truncated,tool,refused,{ choices: [...glm().choices,...glm().choices] }]) expect(() => parseTaggingOutput(value)).toThrow();
    expect(() => parseTaggingOutput({ response: '{"tags":[]}' })).toThrow();
  });
  it('rejects the whole model result for extra fields, duplicates, excess tags or arbitrary text', () => {
    for (const text of ['{"tags":[],"description":null}', '{"tags":[]} {"tags":[]}', '```json\n{"tags":[]}\n```',
      JSON.stringify({ tags: ['sql','SQL'] }),JSON.stringify({ tags: Array(6).fill('sql') }),JSON.stringify({ tags: ['bad\ntext'] })]) {
      expect(() => parseTaggingOutput(glm(text))).toThrow();
    }
  });
  it('accounts for GLM usage including cached input and rejected output', () => {
    expect(taggingUsage({ usage: { prompt_tokens: 100, completion_tokens: 192, prompt_tokens_details: { cached_tokens: 20 } } }))
      .toEqual({ prompt_tokens: 100, completion_tokens: 192, cached_tokens: 20 });
    expect(taggingUsage({ usage: { prompt_tokens: 100, completion_tokens: 192 } })).toEqual({ prompt_tokens: 100, completion_tokens: 192, cached_tokens: 0 });
    expect(taggingUsage({})).toBeNull();
  });
});
