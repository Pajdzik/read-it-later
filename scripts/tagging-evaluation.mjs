import { buildTaggingRequest, parseTaggingOutput, TAGGING_MODELS, TAGGING_OUTPUT_TOKENS, TAGGING_PROMPT_BYTES, taggingPromptBytes } from '../benchmarks/tagging-models.ts';
import { groundedArticleText } from '../src/articles/enrichment.ts';
import { digest, resultDigest, summarize } from './enrichment-evaluation.mjs';
import { readFileSync } from 'node:fs';

const representativeCorpus = JSON.parse(readFileSync(new URL('../benchmarks/enrichment-library-fixtures.json', import.meta.url), 'utf8'));

export function summarizeTagging(results, model) {
  const base=summarize(results), pricing=TAGGING_MODELS[model];
  const cachedTokens=results.reduce((n,r)=>n+(r.usage?.cached_tokens??0),0);
  const estimated=((base.inputTokens-cachedTokens)*pricing.inputUsdPerMillion+cachedTokens*pricing.cachedInputUsdPerMillion+base.outputTokens*pricing.outputUsdPerMillion)/1e6;
  return {...base,cachedTokens,pricing,inferenceCostBeforeAllowanceUsd:base.usageComplete?estimated:null,knownUsageCostUsd:estimated};
}
export function taggingRejectionChecks() {
  const invalid=['{"tags":["sql"]','{"tags":[],"description":null}','{"tags":[]}\n{"tags":[]}','```json\n{"tags":[]}\n```',
    JSON.stringify({tags:['sql','SQL']}),JSON.stringify({tags:Array(6).fill('sql')}),JSON.stringify({tags:['bad\ntext']})];
  return invalid.every(response=>Object.keys(TAGGING_MODELS).every(model=>{
    const raw=model==='glm'?{choices:[{finish_reason:'stop',message:{role:'assistant',content:response}}]}
      :model==='luna'?{status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:response}]}]}
      :{response};
    try{parseTaggingOutput(raw,model);return false;}catch{return true;}
  }));
}
/** Review usefulness, not literal word overlap. Related concepts and synonyms are valid. */
export function assessTaggingReport(report, review) {
  const reasons=[],failures=[],language={};let usefulTagSets=0,valid=0;
  if(report.schemaVersion!==3||report.task!=='tags'||!Object.hasOwn(TAGGING_MODELS,report.modelAlias)||report.model!==TAGGING_MODELS[report.modelAlias]?.id)reasons.push('unexpected_model_or_contract');
  if(!Array.isArray(report.results)||!report.results.length)return {passed:false,usefulTagSets:0,valid:0,language,reasons:['empty_report'],failures};
  if(report.results.length!==report.plannedCalls||new Set(report.results.map(r=>r.id)).size!==report.results.length)reasons.push('incomplete_or_duplicate_results');
  if(!review||review.reportDigest!==digest(report)||!['agent','human'].includes(review.reviewerType)||!review.reviewer?.trim())reasons.push('missing_or_stale_review');
  const judgments=Array.isArray(review?.judgments)?review.judgments:[];
  if(judgments.length!==report.results.length||new Set(judgments.map(j=>j.id)).size!==judgments.length)reasons.push('incomplete_or_duplicate_review');
  for(const r of report.results){
    const stats=language[r.language]??={total:0,valid:0,useful:0};stats.total++;
    const j=judgments.find(j=>j.id===r.id),reviewed=j?.resultDigest===resultDigest(r)&&typeof j?.notes==='string'&&j.notes.trim();
    if(!reviewed)reasons.push(`${r.id}:unreviewed`);
    try{
      const article={title:r.input.title,description:r.input.description,text:groundedArticleText(r.input)};
      if(digest(article)!==digest(r.article))reasons.push(`${r.id}:stale_preprocessing`);
      const expected=buildTaggingRequest(article,report.modelAlias,r.existingTags??[]);
      if(digest(expected)!==digest(r.request)||taggingPromptBytes(r.request)>TAGGING_PROMPT_BYTES
        ||(r.request.max_tokens??r.request.max_completion_tokens??r.request.max_output_tokens)!==TAGGING_OUTPUT_TOKENS)reasons.push(`${r.id}:request_mismatch_or_limits`);
    }catch{reasons.push(`${r.id}:invalid_request`);}
    let parsed;
    try{parsed=parseTaggingOutput(r.raw,report.modelAlias);}catch{}
    if(r.output&&(!parsed||digest(parsed)!==digest(r.output)))reasons.push(`${r.id}:invalid_output_accepted`);
    if(!parsed||!r.output||r.error||digest(parsed)!==digest(r.output)){
      failures.push({id:r.id,reason:r.error??'invalid_output'});
      if(reviewed&&j.structuralJudgment!=='rejected')reasons.push(`${r.id}:rejection_review_required`);
      continue;
    }
    valid++;stats.valid++;
    const reviewedTags=reviewed&&Array.isArray(j.tags)&&j.tags.length===r.output.tags.length&&j.tags.every((t,i)=>t.tag===r.output.tags[i]
      &&typeof t.english==='boolean'&&['central','related','too_broad','misleading'].includes(t.relationship)&&typeof t.evidence==='string'&&t.evidence.trim());
    if(!reviewedTags||typeof j?.useful!=='boolean'||!['good','partial','poor'].includes(j?.topicCoverage))reasons.push(`${r.id}:incomplete_semantic_review`);
    if(reviewedTags&&j.tags.some(t=>!t.english))reasons.push(`${r.id}:non_english_tag`);
    const useful=reviewedTags&&j.useful&&j.topicCoverage!=='poor'&&j.tags.some(t=>t.relationship==='central')
      &&j.tags.every(t=>t.english&&['central','related'].includes(t.relationship));
    if(useful){usefulTagSets++;stats.useful++;}else failures.push({id:r.id,reason:'not_useful_complete_set'});
  }
  if(report.kind==='tagging-evaluation'){
    if(report.corpusHash!==digest(representativeCorpus.samples)||report.results.some(r=>{
      const sample=representativeCorpus.samples.find(s=>s.id===r.id);
      return !sample||r.language!==sample.language||r.sourceUrl!==sample.sourceUrl||r.input.title!==sample.title||r.input.markdown!==sample.markdown;
    }))reasons.push('representative_corpus_mismatch');
    if(report.results.length!==30||report.results.filter(r=>r.language==='en').length!==25||report.results.filter(r=>r.language==='pl').length!==5)reasons.push('incomplete_representative_corpus');
    if(usefulTagSets<27)reasons.push('fewer_than_27_useful_tag_sets');
  }else if(usefulTagSets!==report.results.length)reasons.push('probe_not_fully_useful');
  if(!taggingRejectionChecks())reasons.push('structural_rejection_failed');
  return {passed:reasons.length===0,usefulTagSets,valid,language,reasons,failures};
}
