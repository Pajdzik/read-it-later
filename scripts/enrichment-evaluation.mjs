import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDiagnosticOutput } from '../benchmarks/enrichment-diagnostics.ts';
import { canGenerateDescription, parseEnrichmentOutput, ENRICHMENT_MODEL, MAX_OUTPUT_TOKENS, MAX_PROMPT_BYTES, enrichmentPromptBytes } from '../src/articles/enrichment.ts';

export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const resultDigest = result => digest({ id: result.id, input: result.input, request: result.request, raw: result.raw, output: result.output ?? null, error: result.error ?? null });
export async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, file);
}
/** A durable reservation precedes dispatch, including attempts with uncertain outcomes. */
export async function reserveCall(file, metadata, policy = { task: 'article-enrichment-quality', maximum: 100 }) {
  await mkdir(path.dirname(file), { recursive: true });
  const lock = await open(`${file}.lock`, 'wx', 0o600);
  try {
    let ledger;
    try { ledger = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; ledger = { ...policy, calls: [] }; }
    if (ledger.task !== policy.task || ledger.maximum !== policy.maximum || !Array.isArray(ledger.calls)) throw new Error('Invalid call ledger');
    if (ledger.maximum !== null && ledger.calls.length >= ledger.maximum) throw new Error(`Live-call budget exhausted (${ledger.maximum})`);
    if (!ledger.calls.every((call,i) => call.number === i+1)) throw new Error('Invalid call ledger sequence');
    const reservation = { ...metadata, number: ledger.calls.length + 1, reservedAt: new Date().toISOString() };
    ledger.calls.push(reservation);
    await atomicJson(file, ledger);
    return reservation;
  } finally { await lock.close(); await unlink(`${file}.lock`); }
}
export function structuralRejectionChecks() {
  const invalid = [
    '{"tags":["sql"],"description":null',
    '{"tags":["sql"]}',
    '{"tags":[],"description":null,"extra":true}',
    '{"tags":[],"description":null}\n{"tags":[],"description":null}',
    'Result: {"tags":[],"description":null}',
    JSON.stringify({ tags: ['sql', 'SQL'], description: null }),
    JSON.stringify({ tags: Array(6).fill('sql'), description: null }),
    JSON.stringify({ tags: ['sql'], description: 'First sentence. Second sentence.' }),
    JSON.stringify({ tags: ['sql'], description: 'First line.\nSecond line.' }),
  ];
  return invalid.every(response => { try { parseEnrichmentOutput({ response }); return false; } catch { return true; } });
}
export function summarize(results) {
  const latency = results.map(r => r.latencyMs).filter(Number.isFinite).sort((a,b) => a-b);
  const accounted = results.every(r => Number.isFinite(r.usage?.prompt_tokens) && Number.isFinite(r.usage?.completion_tokens));
  const inputTokens = results.reduce((n,r) => n + (r.usage?.prompt_tokens ?? 0), 0);
  const outputTokens = results.reduce((n,r) => n + (r.usage?.completion_tokens ?? 0), 0);
  return { attempts: results.length, valid: results.filter(r => r.output && !r.error).length,
    latencyMedianMs: latency[Math.floor((latency.length - 1) / 2)] ?? null,
    latencyP95Ms: latency[Math.ceil(latency.length * .95) - 1] ?? null,
    usageComplete: accounted, inputTokens, outputTokens,
    inferenceCostBeforeAllowanceUsd: accounted ? (inputTokens * .027 + outputTokens * .201) / 1e6 : null,
    knownUsageCostUsd: (inputTokens * .027 + outputTokens * .201) / 1e6,
    pricing: { inputUsdPerMillion: .027, outputUsdPerMillion: .201, source: 'https://developers.cloudflare.com/workers-ai/models/llama-3.2-1b-instruct/' } };
}
/** Semantic judgments are explicit evidence, never inferred from keyword overlap. */
export function assessReport(report, review, diagnosticEvidence = []) {
  const reasons = [];
  const full = report.kind === 'evaluation';
  if (report.model !== ENRICHMENT_MODEL) reasons.push('unexpected_model');
  if (!Array.isArray(report.results) || !report.results.length) return { passed: false, relevantTagSets: 0, language: {}, reasons: ['empty_report'] };
  if (new Set(report.results.map(r => r.id)).size !== report.results.length) reasons.push('duplicate_result_ids');
  if (report.results.length !== report.plannedCalls) reasons.push('incomplete_run');
  if (!review || review.reportDigest !== digest(report) || review.reviewerType !== 'agent' || !review.reviewer) reasons.push('missing_or_stale_review');
  const judgments = review?.judgments ?? [];
  if (new Set(judgments.map(j => j.id)).size !== judgments.length) reasons.push('duplicate_review_ids');
  let relevantTagSets = 0;
  const language = {};
  for (const r of report.results) {
    const stats = language[r.language] ??= { total: 0, valid: 0, relevant: 0 };
    stats.total++;
    const j = judgments.find(j => j.id === r.id);
    if (!r.request || r.request.max_tokens !== MAX_OUTPUT_TOKENS || !Array.isArray(r.request.messages)
      || enrichmentPromptBytes(r.request.messages) > MAX_PROMPT_BYTES) reasons.push(`${r.id}:request_limits`);
    let valid = !!r.output && !r.error;
    try {
      const parsed = report.kind === 'diagnostic' ? parseDiagnosticOutput(r.raw, report.task, r.input) : parseEnrichmentOutput(r.raw, canGenerateDescription(r.input));
      valid = valid && digest(parsed) === digest(r.output);
    } catch { valid = false; }
    const reviewed = j && j.resultDigest === resultDigest(r) && typeof j.notes === 'string' && j.notes.trim().length > 0;
    if (!reviewed) reasons.push(`${r.id}:unreviewed`);
    if (!valid) { reasons.push(`${r.id}:invalid_output`); continue; }
    stats.valid++;
    const tagsReviewed = reviewed && typeof j.completeTagSetRelevant === 'boolean' && Array.isArray(j.tags) && j.tags.length === r.output.tags.length
      && j.tags.every((tag, i) => tag.tag === r.output.tags[i] && typeof tag.relevant === 'boolean' && tag.english === true && typeof tag.evidence === 'string' && tag.evidence.trim());
    const relevant = tagsReviewed && j.tags.every(t => t.relevant) && j.completeTagSetRelevant === true && r.output.tags.length > 0;
    if (relevant) relevantTagSets++;
    if (report.task !== 'description' && (!tagsReviewed || !relevant)) reasons.push(`${r.id}:tag_quality`);
    const needsDescription = report.task !== 'tags' && canGenerateDescription(r.input);
    if (r.needsGeneratedDescription !== needsDescription) reasons.push(`${r.id}:incorrect_generation_eligibility`);
    const d = report.task === 'tags' ? null : r.input.description ?? r.output.description;
    if (needsDescription && d === null) reasons.push(`${r.id}:missing_description`);
    if (d !== null && !(reviewed && j.description?.grounded === true && j.description?.language === r.language
      && (r.input.description || j.description?.oneSentence === true) && typeof j.description?.evidence === 'string' && j.description.evidence.trim())) reasons.push(`${r.id}:description_quality`);
    if (relevant) stats.relevant++;
  }
  if (full) {
    if (report.results.length !== 30 || report.results.filter(r => r.language === 'en').length !== 25 || report.results.filter(r => r.language === 'pl').length !== 5) reasons.push('incomplete_representative_corpus');
    if (relevantTagSets < 27) reasons.push('fewer_than_27_relevant_tag_sets');
    // Relevance may miss three times, but every tag still needs an English judgment and evidence.
    const tolerated = new Set(report.results.filter(r => {
      const j = judgments.find(j => j.id === r.id);
      return j && j.resultDigest === resultDigest(r) && typeof j.completeTagSetRelevant === 'boolean'
        && j.tags?.length === r.output?.tags.length && r.output?.tags.length > 0
        && j.tags.every((t,i) => t.tag === r.output.tags[i] && typeof t.relevant === 'boolean' && t.english === true && typeof t.evidence === 'string' && t.evidence.trim());
    }).map(r => `${r.id}:tag_quality`));
    for (let i = reasons.length - 1; i >= 0; i--) if (tolerated.has(reasons[i])) reasons.splice(i, 1);
    const generationCovered = diagnosticEvidence.some(({report: d, review: v}) =>
      d.kind === 'diagnostic' && d.task === 'combined' && d.variant === 'production' && d.productionSourceHash === report.productionSourceHash
      && d.results.filter(r => r.needsGeneratedDescription).some(r => r.language === 'en')
      && d.results.filter(r => r.needsGeneratedDescription).some(r => r.language === 'pl')
      && assessReport(d, v).passed);
    if (!generationCovered) reasons.push('combined_generation_diagnostics_required');
  }
  if (!structuralRejectionChecks()) reasons.push('structural_rejection_failed');
  return { passed: reasons.length === 0, relevantTagSets, language, reasons };
}
