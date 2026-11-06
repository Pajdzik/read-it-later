import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { atomicJson, assessReport, digest, reserveCall, resultDigest, structuralRejectionChecks, summarize } from './enrichment-evaluation.mjs';
import { buildEnrichmentMessages, enrichmentModelInput } from '../benchmarks/legacy-enrichment.ts';
import { groundedArticleText } from '../src/articles/enrichment.ts';

function result(id = 'one', language = 'en') {
  const input = { title: 'Database indexes', title_origin: 'supplied', description: null, description_origin: null,
    tags_manual: 0, markdown: '- Database indexes locate matching rows without scanning the entire table.', revision: 'test', baseline: '[]' };
  const output = { tags: ['databases'], description: language === 'pl' ? 'Indeksy przyspieszają wyszukiwanie danych.' : 'Indexes speed up data lookups.' };
  return { id, language, input, request: enrichmentModelInput(buildEnrichmentMessages(input, [])), output, raw: { response: JSON.stringify(output) }, needsGeneratedDescription: true, latencyMs: 50, usage: { prompt_tokens: 100, completion_tokens: 20 } };
}
function review(report) {
  return { reportDigest: digest(report), reviewerType: 'agent', reviewer: 'test reviewer', judgments: report.results.map(r => ({
    id: r.id, resultDigest: resultDigest(r), completeTagSetRelevant: true, notes: 'Reviewed all output fields against the supplied text.',
    tags: r.output.tags.map(tag => ({ tag, relevant: true, english: true, evidence: 'The source describes database indexing.' })),
    description: { grounded: true, language: r.language, oneSentence: true, evidence: 'Matching rows are found without scanning the table.' },
  })) };
}
function diagnostic() { return { model: '@cf/meta/llama-3.2-1b-instruct', kind: 'diagnostic', task: 'combined', variant: 'production', plannedCalls: 2, productionSourceHash: 'source', results: [result('en','en'),result('pl','pl')] }; }
function full() { return { model: '@cf/meta/llama-3.2-1b-instruct', kind: 'evaluation', task: 'combined', variant: 'production', productionSourceHash: 'source', plannedCalls: 30, results: Array.from({length:30},(_,i)=>result(String(i),i<25?'en':'pl')) }; }

test('explicit review is mandatory and bound to the entire report and exact outputs', () => {
  const r = diagnostic(), v = review(r);
  assert.equal(assessReport(r,v).passed,true);
  assert.equal(assessReport(r,null).passed,false);
  r.results[0].output.tags = ['air travel'];
  assert.equal(assessReport(r,v).passed,false);
  const changed = review(r); changed.judgments[0].resultDigest='old';
  assert.equal(assessReport(r,changed).passed,false);
});
test('a keyword or one good tag cannot make the whole set relevant', () => {
  const r=diagnostic();
  r.results[0].output.tags=['air travel','databases'];r.results[0].raw.response=JSON.stringify(r.results[0].output);
  const v=review(r);v.judgments[0].tags[0].relevant=false;v.judgments[0].completeTagSetRelevant=false;
  assert.equal(assessReport(r,v).passed,false);
  assert.equal(assessReport(r,v).relevantTagSets,1);
});
test('English, language, grounding, sentence and missing-description failures block the gate', () => {
  for(const mutate of [v=>v.judgments[0].tags[0].english=false,v=>v.judgments[0].description.language='pl',v=>v.judgments[0].description.grounded=false,v=>v.judgments[0].description.oneSentence=false,v=>v.judgments[0].description.evidence='']) {
    const r=diagnostic(),v=review(r);mutate(v);assert.equal(assessReport(r,v).passed,false);
  }
  const r=diagnostic();r.results[0].output.description=null;r.results[0].raw.response=JSON.stringify(r.results[0].output);
  assert.equal(assessReport(r,review(r)).passed,false);
  r.results[0].needsGeneratedDescription=false;
  assert.equal(assessReport(r,review(r)).passed,false);
});
test('full gate requires 27/30 relevant sets and reviewed production generation diagnostics in both languages', () => {
  const r=full(),d=diagnostic(),e=[{report:d,review:review(d)}];
  assert.equal(assessReport(r,review(r)).passed,false);
  const v=review(r);for(const j of v.judgments.slice(0,3)){j.completeTagSetRelevant=false;j.tags[0].relevant=false;}
  assert.equal(assessReport(r,v,e).passed,true);
  v.judgments[3].completeTagSetRelevant=false;v.judgments[3].tags[0].relevant=false;
  assert.equal(assessReport(r,v,e).passed,false);
  d.productionSourceHash='stale';assert.equal(assessReport(r,review(r),e).passed,false);
});
test('structurally invalid raw output cannot pass even with a forged parsed output and positive judgments', () => {
  assert.equal(structuralRejectionChecks(),true);
  const r=diagnostic();r.results[0].raw.response+='\n{"extra":true}';
  assert.equal(assessReport(r,review(r)).passed,false);
});
test('failed calls remain in usage, latency and inference cost, unknown usage stays unknown', () => {
  const r=result();r.error='invalid_output';delete r.output;
  const summary=summarize([r]);assert.equal(summary.attempts,1);assert.equal(summary.valid,0);assert.equal(summary.inputTokens,100);assert.ok(summary.inferenceCostBeforeAllowanceUsd>0);
  assert.equal(summarize([{...r,usage:null}]).inferenceCostBeforeAllowanceUsd,null);
});
test('call reservations persist, cap at 100, and fail closed under a concurrent lock', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'enrichment-ledger-test-')),file=path.join(dir,'calls.json');
  try {
    await atomicJson(file,{task:'article-enrichment-quality',maximum:100,calls:Array.from({length:99},(_,i)=>({number:i+1}))});
    assert.equal((await reserveCall(file,{id:'last'})).number,100);
    await assert.rejects(reserveCall(file,{id:'overflow'}),/exhausted/);
    assert.equal(JSON.parse(await readFile(file,'utf8')).calls.length,100);
    const lock=await open(`${file}.lock`,'wx');
    try { await assert.rejects(reserveCall(file,{id:'locked'}),{code:'EEXIST'}); } finally { await lock.close(); }
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('CLI exits nonzero for failed or incomplete offline quality review', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'enrichment-cli-test-'));
  try {
    const r=diagnostic(),v=review(r);v.judgments[0].tags[0].english=false;
    await atomicJson(path.join(dir,'report.json'),r);await atomicJson(path.join(dir,'review.json'),v);
    const child=spawnSync(process.execPath,['--import','tsx','scripts/evaluate-enrichment.mjs','--review',path.join(dir,'report.json'),'--judgments',path.join(dir,'review.json'),'--output',path.join(dir,'gate.json')],{encoding:'utf8'});
    assert.equal(child.status,1,child.stderr);
    const gate=JSON.parse(await readFile(path.join(dir,'gate.json'),'utf8')).gate;
    assert.equal(gate.passed,false);
    assert.ok(gate.reasons.includes('source_changed_since_run'));
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('checked-in live evidence binds every judgment, all reservations, usage and the frozen corpus', async () => {
  const directory='docs/benchmarks/article-enrichment-quality';
  const summary=JSON.parse(await readFile(`${directory}/summary.json`,'utf8'));
  const ledger=JSON.parse(await readFile(`${directory}/calls.json`,'utf8'));
  const results=[];
  for(const experiment of summary.experiments){
    const report=JSON.parse(await readFile(`${directory}/${experiment.report}`,'utf8'));
    const judgments=JSON.parse(await readFile(`${directory}/${experiment.review}`,'utf8'));
    const gate=JSON.parse(await readFile(`${directory}/${experiment.gate}`,'utf8'));
    assert.equal(judgments.reportDigest,digest(report));
    assert.deepEqual(assessReport(report,judgments),gate);
    assert.equal(gate.passed,false);
    for(const r of report.results){
      assert.equal(judgments.judgments.find(j=>j.id===r.id).resultDigest,resultDigest(r));
      assert.equal(ledger.calls[r.reservation-1].requestDigest,digest(r.request));
    }
    results.push(...report.results);
  }
  assert.equal(results.length,60);
  assert.equal(new Set(results.map(r=>r.reservation)).size,60);
  assert.equal(ledger.calls.length,results.length);
  const accounting=summarize(results);
  for(const key of ['attempts','valid','inputTokens','outputTokens','latencyMedianMs','latencyP95Ms','inferenceCostBeforeAllowanceUsd'])assert.equal(summary[key],accounting[key]);
  assert.equal(summary.activation,'disabled');
  assert.equal(summary.actualLibraryEvaluation.status,'not_run');
  const corpus=JSON.parse(await readFile('benchmarks/enrichment-library-fixtures.json','utf8'));
  assert.equal(corpus.corpusHash,digest(corpus.samples));
  assert.equal(corpus.samples.filter(s=>s.language==='en').length,25);
  assert.equal(corpus.samples.filter(s=>s.language==='pl').length,5);
  assert.equal(new Set(corpus.samples.map(s=>s.contentHash)).size,30);
  for(const s of corpus.samples)assert.equal(s.contentHash,digest(s.markdown));
});

test('tagging-only review allows related topics and synonyms without a generated description gate', async () => {
  const {assessTaggingReport}=await import('./tagging-evaluation.mjs');
  const {TAGGING_MODELS,buildTaggingRequest}=await import('../benchmarks/tagging-models.ts');
  const article={title:'Passkeys',description:null,text:'Passkeys use public/private keys and bind credentials to a relying party to prevent phishing.'};
  const output={tags:['authentication','passwords','phishing']};
  const r={id:'case',language:'en',article,input:{title:article.title,description:article.description,markdown:article.text},existingTags:[],request:buildTaggingRequest(article,'glm'),raw:{choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(output),tool_calls:[]}}]},output};
  const report={schemaVersion:3,model:TAGGING_MODELS.glm.id,modelAlias:'glm',task:'tags',kind:'tagging-probe',plannedCalls:1,results:[r]};
  const judgments={reportDigest:digest(report),reviewerType:'agent',reviewer:'reviewer',judgments:[{id:r.id,resultDigest:resultDigest(r),useful:true,topicCoverage:'good',notes:'Useful topics cover passkey authentication and phishing.',tags:output.tags.map(tag=>({tag,english:true,relationship:tag==='passwords'?'related':'central',evidence:'The source discusses credentials, authentication and phishing prevention.'}))}]};
  assert.equal(assessTaggingReport(report,judgments).passed,true);
  judgments.judgments[0].tags[1].relationship='misleading';
  assert.equal(assessTaggingReport(report,judgments).passed,false);
  judgments.judgments[0].tags[1].relationship='related';judgments.judgments[0].tags[1].english=false;
  assert.equal(assessTaggingReport(report,judgments).passed,false);
  r.request.max_completion_tokens=193;
  assert.ok(assessTaggingReport(report,judgments).reasons.some(x=>x.includes('request_mismatch')));
});

test('expanded experiment reservations exceed 100 without changing legacy limits or resetting a ledger', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'tagging-ledger-test-')),file=path.join(dir,'calls.json');
  try{
    await atomicJson(file,{task:'article-tagging-comparison',maximum:null,calls:Array.from({length:100},(_,i)=>({number:i+1}))});
    assert.equal((await reserveCall(file,{id:'expanded'},{task:'article-tagging-comparison',maximum:null})).number,101);
    assert.equal(JSON.parse(await readFile(file,'utf8')).calls.length,101);
    await assert.rejects(reserveCall(file,{id:'wrong-policy'}),/Invalid call ledger/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('tagging release gate counts 27 useful complete sets and rejects invalid accepted output', async () => {
  const {assessTaggingReport}=await import('./tagging-evaluation.mjs');
  const {TAGGING_MODELS,buildTaggingRequest}=await import('../benchmarks/tagging-models.ts');
  const corpus=JSON.parse(await readFile('benchmarks/enrichment-library-fixtures.json','utf8'));
  // Mechanical gate controls use mocked judgments, not model-quality evidence.
  const results=corpus.samples.map(sample=>{
    const input={title:sample.title,description:sample.description??null,markdown:sample.markdown};
    const article={title:input.title,description:input.description,text:groundedArticleText(input)};
    return {id:sample.id,language:sample.language,sourceUrl:sample.sourceUrl,article,input,existingTags:[],request:buildTaggingRequest(article,'glm'),raw:{choices:[{finish_reason:'stop',message:{role:'assistant',content:'{"tags":["databases"]}',tool_calls:[]}}]},output:{tags:['databases']}};
  });
  const report={schemaVersion:3,model:TAGGING_MODELS.glm.id,modelAlias:'glm',task:'tags',kind:'tagging-evaluation',corpusHash:corpus.corpusHash,plannedCalls:30,results};
  function judgments(){return{reportDigest:digest(report),reviewerType:'agent',reviewer:'reviewer',judgments:results.map(r=>({id:r.id,resultDigest:resultDigest(r),useful:true,topicCoverage:'good',notes:'Reviewed the set.',tags:[{tag:'databases',english:true,relationship:'central',evidence:'The source describes database indexes.'}]}))};}
  let v=judgments();for(const j of v.judgments.slice(0,3)){j.useful=false;j.topicCoverage='poor';}
  assert.equal(assessTaggingReport(report,v).passed,true);
  results[0].input.markdown='A substitute article';
  assert.ok(assessTaggingReport(report,judgments()).reasons.includes('representative_corpus_mismatch'));
  results[0].input.markdown=corpus.samples[0].markdown;
  v.judgments[3].useful=false;assert.equal(assessTaggingReport(report,v).passed,false);
  results[0].raw.choices[0].message.content='{"tags":["databases"],"extra":true}';
  v=judgments();assert.ok(assessTaggingReport(report,v).reasons.some(r=>r.includes('invalid_output_accepted')));
});

test('tagging evidence is fully reviewed, accounted and uses disjoint frozen corpora', async () => {
  const {assessTaggingReport,summarizeTagging}=await import('./tagging-evaluation.mjs');
  const directory='docs/benchmarks/article-tagging-models',summary=JSON.parse(await readFile(`${directory}/summary.json`,'utf8'));
  const ledger=JSON.parse(await readFile(`${directory}/calls.json`,'utf8')),results=[];
  for(const stage of summary.stages){
    const report=JSON.parse(await readFile(`${directory}/${stage.report}`,'utf8'));
    const review=JSON.parse(await readFile(`${directory}/${stage.review}`,'utf8'));
    const gate=JSON.parse(await readFile(`${directory}/${stage.gate}`,'utf8'));
    assert.deepEqual(assessTaggingReport(report,review),gate);
    for(const r of report.results){
      assert.equal(review.judgments.find(j=>j.id===r.id).resultDigest,resultDigest(r));
      assert.equal(ledger.calls[r.reservation-1].requestDigest,digest(r.request));
    }
    assert.equal(stage.inputTokens,summarizeTagging(report.results,report.modelAlias).inputTokens);
    results.push(...report.results);
  }
  assert.equal(results.length,ledger.calls.length);assert.equal(new Set(results.map(r=>r.reservation)).size,results.length);
  assert.equal(ledger.maximum,null);assert.equal(summary.activation,'disabled');
  const development=JSON.parse(await readFile('benchmarks/tagging-development-fixtures.json','utf8'));
  const evaluation=JSON.parse(await readFile('benchmarks/enrichment-library-fixtures.json','utf8'));
  assert.equal(development.corpusHash,digest(development.samples));
  assert.equal(evaluation.corpusHash,digest(evaluation.samples));
  const evaluationHashes=new Set(evaluation.samples.map(s=>s.contentHash));
  for(const s of development.samples){assert.equal(s.contentHash,digest(s.markdown));assert.equal(evaluationHashes.has(s.contentHash),false);}
});

test('benchmark-only model adapters keep request limits and reject incomplete or multiple Luna messages', async () => {
  const {buildTaggingRequest,parseTaggingOutput,taggingUsage,taggingPromptBytes,TAGGING_MODELS}=await import('../benchmarks/tagging-models.ts');
  for(const model of Object.keys(TAGGING_MODELS)){
    const request=buildTaggingRequest({title:'📰'.repeat(1000),description:null,text:'\\"📰'.repeat(20000)},model);
    assert.ok(taggingPromptBytes(request)<=8192);
    assert.equal(request.max_tokens??request.max_completion_tokens??request.max_output_tokens,192);
  }
  const raw={status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'{"tags":["databases"]}'}]}]};
  assert.deepEqual(parseTaggingOutput(raw,'luna'),{tags:['databases']});
  assert.throws(()=>parseTaggingOutput({...raw,status:'incomplete'},'luna'));
  assert.throws(()=>parseTaggingOutput({...raw,output:[...raw.output,...raw.output]},'luna'));
  assert.deepEqual(parseTaggingOutput({response:'{"tags":["databases"]}'},'llama'),{tags:['databases']});
  assert.deepEqual(taggingUsage({usage:{input_tokens:100,output_tokens:192}}),{prompt_tokens:100,completion_tokens:192,cached_tokens:0});
});

test('Gemma evidence preserves the frozen comparison, per-tag review and every additional reservation', async () => {
  const {assessTaggingReport,summarizeTagging}=await import('./tagging-evaluation.mjs');
  const directory='docs/benchmarks/article-tagging-gemma';
  const summary=JSON.parse(await readFile(`${directory}/summary.json`,'utf8'));
  const ledger=JSON.parse(await readFile(`${directory}/calls.json`,'utf8'));
  const originalLedger=JSON.parse(await readFile('docs/benchmarks/article-tagging-models/calls.json','utf8'));
  assert.deepEqual(ledger.calls.slice(0,45),originalLedger.calls);
  const results=[];
  for(const stage of summary.stages){
    const report=JSON.parse(await readFile(`${directory}/${stage.report}`,'utf8'));
    const review=JSON.parse(await readFile(`${directory}/${stage.review}`,'utf8'));
    const gate=JSON.parse(await readFile(`${directory}/${stage.gate}`,'utf8'));
    assert.deepEqual(assessTaggingReport(report,review),gate);
    assert.equal(gate.passed,true);
    for(const r of report.results){
      assert.equal(review.judgments.find(j=>j.id===r.id).resultDigest,resultDigest(r));
      assert.equal(ledger.calls[r.reservation-1].requestDigest,digest(r.request));
    }
    results.push(...report.results);
  }
  assert.equal(results.length,36);assert.equal(ledger.calls.length,81);
  assert.equal(new Set(results.map(r=>r.reservation)).size,36);
  assert.deepEqual([...results.map(r=>r.reservation)].sort((a,b)=>a-b),Array.from({length:36},(_,i)=>46+i));
  const accounting=summarizeTagging(results,'gemma');
  for(const key of ['attempts','valid','inputTokens','outputTokens','cachedTokens','inferenceCostBeforeAllowanceUsd'])assert.equal(summary[key],accounting[key]);
  const evaluation=JSON.parse(await readFile(`${directory}/evaluation.json`,'utf8'));
  const glm=JSON.parse(await readFile('docs/benchmarks/article-tagging-models/glm-evaluation.json','utf8'));
  for(const r of evaluation.results)assert.deepEqual(r.request,glm.results.find(g=>g.id===r.id).request);
  assert.equal(summary.representativeGate.usefulTagSets,28);
  assert.equal(summary.activation,'disabled');
  assert.equal(summary.productionModel,'@cf/zai-org/glm-4.7-flash');
  assert.equal(summary.reviewRubricHash,digest(await readFile('docs/benchmarks/article-tagging-models/review-rubric.md','utf8')));
});
