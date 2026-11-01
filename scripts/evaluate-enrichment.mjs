import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Explicit opt-in: this command makes exactly 30 real Workers AI requests, no retries.
// It never reads the owner's library, deploys a Worker, or enables enrichment.
if (!process.argv.includes('--live')) throw new Error('Use --live to spend inference on the 30 public synthetic fixtures.');
const root = process.cwd();
let fixtures = JSON.parse(await readFile(path.join(root, 'benchmarks/enrichment-fixtures.json'), 'utf8'));
if (fixtures.length !== 30) throw new Error('Expected exactly 30 evaluation cases.');
if (process.argv.includes('--probe')) fixtures = fixtures.slice(0, 4);
const temporary = await mkdtemp(path.join(os.tmpdir(), 'potem-enrichment-eval-'));
const token = randomBytes(24).toString('hex');
const portServer = net.createServer();
await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
const port = portServer.address().port;
await new Promise(resolve => portServer.close(resolve));
const base = `http://127.0.0.1:${port}`;
const main = path.join(temporary, 'worker.mjs');
await writeFile(main, `import {buildEnrichmentPrompt,markdownLead,parseEnrichmentOutput,enrichmentModelInput,ENRICHMENT_MODEL} from ${JSON.stringify(path.join(root, 'src/articles/enrichment.ts'))};
export default {async fetch(request,env) {
 if(request.method!=='POST'||request.headers.get('Authorization')!=='Bearer '+env.EVALUATION_KEY)return new Response('Not found',{status:404});
 const sample=await request.json();
 const input={title:sample.title,title_origin:'supplied',description:markdownLead(sample.markdown),description_origin:null,tags_manual:0,markdown:sample.markdown,revision:'evaluation',baseline:'[]'};
 const prompt=buildEnrichmentPrompt(input,['databases','programming','machine learning','security','climate','astronomy','finance','psychology','cooking','history','health','mathematics','gardening','economics','accessibility']);
 const start=Date.now();
 try{const raw=await env.AI.run(ENRICHMENT_MODEL,enrichmentModelInput(prompt));
 let output,error;try{output=parseEnrichmentOutput(raw)}catch{error='invalid_output'}
 return Response.json({output,error,raw:output?undefined:raw.response,usage:raw.usage??null,latencyMs:Date.now()-start,promptBytes:new TextEncoder().encode(prompt).length});
 }catch{return Response.json({error:'provider_failed',latencyMs:Date.now()-start,promptBytes:new TextEncoder().encode(prompt).length})}
}};
`, { mode: 0o600 });
const config = path.join(temporary, 'wrangler.jsonc');
await writeFile(config, JSON.stringify({ name: 'potem-enrichment-evaluation', main, compatibility_date: '2026-08-01',
  ai: { binding: 'AI', remote: true }, vars: { EVALUATION_KEY: token }, observability: { enabled: false } }), { mode: 0o600 });
const server = spawn(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--config', config, '--ip', '127.0.0.1', '--port', String(port)],
  { cwd: root, env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore','pipe','pipe'] });
server.stdout.resume();
server.stderr.resume();
try {
  let ready = false;
  for (let i = 0; i < 180; i++) {
    if (server.exitCode !== null) throw new Error('Evaluation Worker exited before starting.');
    try { await fetch(base, { signal: AbortSignal.timeout(500) }); ready = true; break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error('Evaluation Worker did not start within 90 seconds.');
  const results = [];
  for (const sample of fixtures) {
    const response = await fetch(base, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(sample), signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Evaluation request failed (${response.status}).`);
    const result = await response.json();
    const relevant = !!result.output?.tags.some(tag => sample.expectedTopicTerms.some(term => tag.toLowerCase().includes(term)));
    results.push({ id: sample.id, language: sample.language, title: sample.title, needsGeneratedDescription: sample.needsGeneratedDescription, ...result, relevant });
    process.stdout.write(`${results.length}/${fixtures.length}: ${result.error ?? 'valid'}; ${result.latencyMs}ms\n`);
  }
  const latencies = results.map(r => r.latencyMs).sort((a,b) => a-b);
  const allUsage = results.every(r => Number.isFinite(r.usage?.prompt_tokens) && Number.isFinite(r.usage?.completion_tokens));
  const inputTokens = results.reduce((n,r) => n + (r.usage?.prompt_tokens ?? 0), 0);
  const outputTokens = results.reduce((n,r) => n + (r.usage?.completion_tokens ?? 0), 0);
  const report = { date: new Date().toISOString(), model: '@cf/meta/llama-3.2-1b-instruct',
    dataset: process.argv.includes('--probe') ? '4-case development probe' : '30 synthetic topic fixtures: 15 English, 15 Polish; no owner library data', attempts: fixtures.length,
    valid: results.filter(r => r.output).length, relevantTagSets: results.filter(r => r.relevant).length,
    latencyMedianMs: latencies[Math.floor((latencies.length - 1) / 2)], latencyP95Ms: latencies[Math.ceil(latencies.length * .95) - 1],
    inputTokens: allUsage ? inputTokens : null, outputTokens: allUsage ? outputTokens : null,
    inferenceCostBeforeAllowanceUsd: allUsage ? (inputTokens * .027 + outputTokens * .201) / 1e6 : null,
    humanGroundingReview: 'required', activation: 'disabled', results };
  await mkdir(path.join(root, '.wrangler'), { recursive: true });
  const output = path.join(root, process.argv.includes('--probe') ? '.wrangler/enrichment-probe.json' : '.wrangler/enrichment-evaluation.json');
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(`Report: ${output}\nValid ${report.valid}/${fixtures.length}; relevant ${report.relevantTagSets}/${fixtures.length}; grounding review required. Enrichment remains disabled.\n`);
} catch (error) {
  // Do not print Wrangler logs: configuration output may include the local evaluation key.
  process.stderr.write(`${error.message}\n`); process.exitCode = 1;
} finally {
  server.kill('SIGTERM');
  await new Promise(resolve => { server.once('exit', resolve); setTimeout(resolve, 5000).unref(); });
  await rm(temporary, { recursive: true, force: true });
}
