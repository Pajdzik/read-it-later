import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessTaggingReport, summarizeTagging } from './tagging-evaluation.mjs';
import { TAGGING_MODELS } from '../src/articles/tagging.ts';
import { atomicJson, assessReport, digest, reserveCall, resultDigest, summarize } from './enrichment-evaluation.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); if (i < 0) return fallback; if (!args[i+1] || args[i+1].startsWith('--')) throw new Error(`Missing ${name} value`); return args[i+1]; };
const valueOptions = new Set(['--review','--judgments','--generation-report','--generation-judgments','--review-template','--output','--diagnostic','--variant','--fixtures','--model','--stage','--cases']);
for (let i=0;i<args.length;i++) {
  if (valueOptions.has(args[i])) { if (!args[i+1] || args[i+1].startsWith('--')) throw new Error(`Missing ${args[i]} value`); i++; }
  else if (!['--live','--probe','--tagging'].includes(args[i])) throw new Error(`Unknown option: ${args[i]}`);
}
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const readJson = async file => JSON.parse(await readFile(path.resolve(root, file), 'utf8'));
if (args.includes('--review')) {
  const reportPath = option('--review');
  const report = await readJson(reportPath);
  const review = await readJson(option('--judgments'));
  const evidence = [];
  if (args.includes('--generation-report')) evidence.push({ report: await readJson(option('--generation-report')), review: await readJson(option('--generation-judgments')) });
  const gate = report.schemaVersion===3 ? assessTaggingReport(report, review) : assessReport(report, review, evidence);
  if (report.schemaVersion!==3 && report.productionSourceHash !== digest(await readFile(path.join(root, 'src/articles/enrichment.ts'), 'utf8'))) {
    gate.passed = false; gate.reasons.push('source_changed_since_run');
  }
  await atomicJson(path.resolve(root, option('--output', `${reportPath}.reviewed.json`)), { report, review, gate });
  console.log(JSON.stringify(gate, null, 2));
  if (!gate.passed) process.exitCode = 1;
} else if (args.includes('--review-template')) {
  const report = await readJson(option('--review-template'));
  await atomicJson(path.resolve(root, option('--output', '.wrangler/enrichment-review.json')), {
    reportDigest: digest(report), reviewerType: 'agent', reviewer: '', reviewedAt: null,
    judgments: report.results.map(r => ({ id: r.id, resultDigest: resultDigest(r), ...(report.schemaVersion===3 ? {useful:null,topicCoverage:null} : {completeTagSetRelevant:null}),
      tags: (r.output?.tags ?? []).map(tag => ({ tag, ...(report.schemaVersion===3?{relationship:null}:{relevant:null}), english: null, evidence: '' })),
      description: { grounded: null, language: null, oneSentence: null, evidence: '' }, notes: '' })),
  });
} else {
  if (!args.includes('--live')) throw new Error('Use --live for inference, --review-template for judgments, or --review for an offline quality gate.');
  const tagging=args.includes('--tagging');
  const modelAlias=option('--model','llama');
  if(tagging&&!Object.hasOwn(TAGGING_MODELS,modelAlias))throw new Error('Unknown tagging model');
  const stage=option('--stage','development');
  if(tagging&&!['development','evaluation'].includes(stage))throw new Error('Unknown tagging stage');
  const modelId=tagging?TAGGING_MODELS[modelAlias].id:'@cf/meta/llama-3.2-1b-instruct';
  const task = tagging?'tags':option('--diagnostic', 'combined');
  const kind = tagging?(stage==='evaluation'?'tagging-evaluation':'tagging-probe'):args.includes('--diagnostic') || args.includes('--probe') ? 'diagnostic' : 'evaluation';
  const variant = option('--variant', args.includes('--probe') ? 'production' : kind === 'diagnostic' ? 'all' : 'production');
  if (!['tags','description','combined'].includes(task)) throw new Error('Unknown diagnostic task');
  if (!['minimal','vocabulary','examples','plain','plain-examples','plain-english-example','plain-all','all','production'].includes(variant)) throw new Error('Unknown variant');
  if (!tagging && variant === 'production' && task !== 'combined') throw new Error('Production requests always combine tags and description');
  if (kind === 'evaluation' && variant !== 'production') throw new Error('Final evaluation must use the production request');
  let corpus = await readJson(option('--fixtures', kind === 'evaluation'||kind==='tagging-evaluation' ? 'benchmarks/enrichment-library-fixtures.json' : tagging?'benchmarks/tagging-development-fixtures.json':'benchmarks/enrichment-fixtures.json'));
  let fixtures = Array.isArray(corpus) ? corpus : corpus.samples;
  if(tagging && (!Array.isArray(fixtures) || corpus.corpusHash!==digest(fixtures) || fixtures.some(f=>f.contentHash!==digest(f.markdown))))throw new Error('Frozen tagging corpus/hash mismatch');
  if (kind === 'diagnostic') fixtures = fixtures.filter(f => ['01-en','01-pl','04-en','04-pl'].includes(f.id));
  else if (!tagging||stage==='evaluation') { if (fixtures.length !== 30 || corpus.corpusHash !== digest(fixtures)) throw new Error('Expected frozen 30-case corpus with matching hash'); }
  if(tagging&&option('--cases')){const ids=option('--cases').split(',');fixtures=fixtures.filter(f=>ids.includes(f.id));if(fixtures.length!==ids.length)throw new Error('Unknown case');}
  if (!fixtures.length) throw new Error('No fixtures selected');
  const variants = tagging?['production']:variant === 'all' ? ['minimal','vocabulary','examples'] : variant === 'plain-all' ? ['plain','plain-examples','plain-english-example'] : [variant];
  const plannedCalls = fixtures.length * variants.length;
  const output = path.resolve(root, option('--output', tagging?`.wrangler/tagging-${modelAlias}-${stage}.json`:`.wrangler/enrichment-${kind === 'evaluation' ? 'evaluation' : task}.json`));
  // Never overwrite a previous run's evidence. Use a new output path for each run.
  await mkdir(path.dirname(output), { recursive: true });
  const outputHandle = await open(output, 'wx', 0o600);
  await outputHandle.close();
  const ledgerPath = path.join(root, tagging?'.wrangler/tagging-calls.json':'.wrangler/enrichment-calls.json');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'potem-enrichment-eval-'));
  const token = randomBytes(24).toString('hex');
  const portServer = net.createServer();
  await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const main = path.join(temporary, 'worker.mjs');
  await writeFile(main, `import {buildEnrichmentMessages,markdownLead,parseEnrichmentOutput,enrichmentModelInput,enrichmentPromptBytes,canGenerateDescription,groundedArticleText,ENRICHMENT_MODEL} from ${JSON.stringify(path.join(root, 'src/articles/enrichment.ts'))};
import {buildTaggingRequest,parseTaggingOutput,taggingUsage,taggingPromptBytes} from ${JSON.stringify(path.join(root,'src/articles/tagging.ts'))};
import {diagnosticRequest,parseDiagnosticOutput} from ${JSON.stringify(path.join(root, 'benchmarks/enrichment-diagnostics.ts'))};
export default {async fetch(request,env) {
 if(request.method!=='POST'||request.headers.get('Authorization')!=='Bearer '+env.EVALUATION_KEY)return new Response('Not found',{status:404});
 const {sample,task,variant,kind,tagging,modelAlias,modelId}=await request.json();
 const description=kind==='diagnostic'&&task==='description'?null:(sample.description??markdownLead(sample.markdown));
 const input={title:sample.title,title_origin:'supplied',description,description_origin:description?'extracted':null,tags_manual:0,markdown:sample.markdown,revision:'evaluation',baseline:'[]'};
 const article={title:input.title,description:input.description,text:groundedArticleText(input)};
 const modelInput=tagging?buildTaggingRequest(article,modelAlias,sample.existingTags??[]):variant==='production'?enrichmentModelInput(buildEnrichmentMessages(input,sample.existingTags??[])):diagnosticRequest(input,task,variant);
 const payload={input,...(tagging?{article,existingTags:sample.existingTags??[]}:{}),request:modelInput,promptBytes:tagging?taggingPromptBytes(modelInput):enrichmentPromptBytes(modelInput.messages),needsGeneratedDescription:task!=='tags'&&canGenerateDescription(input)};
 // Preparing the request never calls AI; the host reserves before /run.
 if(new URL(request.url).pathname==='/prepare')return Response.json(payload);
 const start=Date.now();
 try{const options=tagging&&modelAlias==='luna'?{gateway:{id:'default',skipCache:true,collectLog:false,retries:{maxAttempts:1}}}:undefined;
 const raw=await env.AI.run(modelId,modelInput,options);
 let output,error;try{output=tagging?parseTaggingOutput(raw,modelAlias):variant==='production'?parseEnrichmentOutput(raw,canGenerateDescription(input)):parseDiagnosticOutput(raw,task,input)}catch{error='invalid_output'}
 return Response.json({...payload,output,error,raw,usage:tagging?taggingUsage(raw):raw.usage??null,latencyMs:Date.now()-start});
 }catch(error){return Response.json({...payload,error:'provider_failed',providerStatus:Number(error?.status??error?.statusCode)||null,providerCode:typeof error?.code==='number'?error.code:null,providerErrorCodes:String(error?.message??'').match(/\\b[1-9]\\d{2,5}\\b/g)??[],providerFailureKind:/credit|balance|billing|wallet/i.test(error?.message??'')?'billing':/gateway/i.test(error?.message??'')?'gateway_setup':/auth|credential|permission|forbidden/i.test(error?.message??'')?'authorization':/model|not found/i.test(error?.message??'')?'model_access':/parameter|schema|invalid input/i.test(error?.message??'')?'request_validation':'unclassified',latencyMs:Date.now()-start,usage:null})}
}};`, { mode: 0o600 });
  const config = path.join(temporary, 'wrangler.jsonc');
  await writeFile(config, JSON.stringify({ name: 'potem-enrichment-evaluation', main, compatibility_date: '2026-08-01',
    ai: { binding: 'AI', remote: true }, vars: { EVALUATION_KEY: token }, observability: { enabled: false } }), { mode: 0o600 });
  const report = { schemaVersion: tagging?3:2, date: new Date().toISOString(), model: modelId, ...(tagging?{modelAlias}:{}), kind, task, variant:tagging?'production':variant,
    compatibilityDate: '2026-08-01', dataset: tagging||kind === 'evaluation' ? corpus.dataset : 'Four synthetic English/Polish development cases; not owner library data',
    corpusHash: digest(fixtures), productionSourceHash: digest(await readFile(path.join(root,tagging?'src/articles/tagging.ts':'src/articles/enrichment.ts'),'utf8')),
    diagnosticSourceHash: digest(await readFile(path.join(root,'benchmarks/enrichment-diagnostics.ts'),'utf8')),
    plannedCalls, activation: 'disabled', reviewStatus: 'required', results: [] };
  const server = spawn(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--config', config, '--ip', '127.0.0.1', '--port', String(port)],
    { cwd: root, env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore','pipe','pipe'] });
  server.stdout.resume(); server.stderr.resume();
  const persist = () => atomicJson(output, { ...report, ...(tagging?summarizeTagging(report.results,modelAlias):summarize(report.results)) });
  const post = async (route, body) => {
    const response = await fetch(base+route, { method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(120000) });
    if(!response.ok)throw new Error(`Evaluation HTTP ${response.status}`);
    return response.json();
  };
  try {
    let ready = false;
    for (let i=0;i<180;i++) {
      if(server.exitCode!==null)throw new Error('Evaluation Worker exited before starting; inspect local authentication/runtime without printing its secret config.');
      try { await fetch(base,{signal:AbortSignal.timeout(500)});ready=true;break; } catch {}
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    if(!ready)throw new Error('Evaluation Worker did not start within 90 seconds');
    await persist();
    for(const v of variants) for(const sample of fixtures){
      const body={sample,task,variant:v,kind,tagging,modelAlias,modelId};
      const prepared=await post('/prepare',body);
      const id=tagging?sample.id:kind==='diagnostic'?`${task}/${v}/${sample.id}`:sample.id;
      const reservation=await reserveCall(ledgerPath,{id,report:path.relative(root,output),requestDigest:digest(prepared.request)},tagging?{task:'article-tagging-comparison',maximum:null}:undefined);
      // Write an uncertain entry before dispatch so crashes cannot hide spent calls.
      const result={id,fixtureId:sample.id,language:sample.language,title:sample.title,sourceUrl:sample.sourceUrl??null,
        reservation:reservation.number,...prepared,error:'uncertain_outcome',latencyMs:null,usage:null};
      report.results.push(result);await persist();
      const started=Date.now();
      try{Object.assign(result,await post('/run',body));if(result.error==='uncertain_outcome')delete result.error;}
      catch{result.error='uncertain_outcome';result.latencyMs=Date.now()-started;}
      await persist();
      console.log(`${report.results.length}/${plannedCalls}: ${id}; ${result.error??'valid'}; ${result.latencyMs}ms`);
    }
    console.log(`Report: ${output}; semantic review required. Generation remains disabled.`);
    process.exitCode=1; // A live run alone can never satisfy the quality gate.
  }catch(error){report.failure=error.message;await persist();console.error(error.message);process.exitCode=1;}
  finally{
    server.kill('SIGTERM');
    if(server.exitCode===null)await new Promise(resolve=>{server.once('exit',resolve);setTimeout(resolve,5000).unref();});
    await rm(temporary,{recursive:true,force:true});
  }
}
