import { Worker } from "node:worker_threads";
import { MAX_CAPTURE_RESPONSE_BYTES, SourceFetchError, type CapturedArticle } from "../src/articles/capture-protocol";
import { EXECUTOR_TIMEOUT_MS } from "../src/articles/capture-limits";
import { readBytes } from "../src/articles/pdf";
import { fetchSourceDocument } from "../src/articles/source-fetch";
import type { ArticleMetadata } from "../src/articles/metadata";
import { pinnedFetch } from "./pinned-fetch";

/** A separate thread gives synchronous metadata parsing a hard wall-clock and heap limit. */
export async function extractInThread(html: string, url: string, threadUrl = new URL("./extract-thread.mjs", import.meta.url), signal?: AbortSignal): Promise<ArticleMetadata> {
  signal?.throwIfAborted();
  const worker = new Worker(threadUrl, {
    workerData: { html, url }, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
    stdout: true, stderr: true,
  });
  // Third-party parser diagnostics can contain URLs or page text. Drain without logging.
  worker.stdout.resume();
  worker.stderr.resume();
  let timer: ReturnType<typeof setTimeout>;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<ArticleMetadata>((resolve, reject) => {
      const failed = () => reject(new SourceFetchError("conversion_failed", false));
      abort=()=>reject(new SourceFetchError('timeout',true));
      signal?.addEventListener('abort',abort,{once:true});
      timer = setTimeout(failed, 5_000);
      worker.once("message", message => {
        if (message?.metadata) resolve(message.metadata);
        else failed();
      });
      worker.once("error", failed);
      worker.once("exit", failed);
    });
  } finally {
    clearTimeout(timer!);
    if (abort) signal?.removeEventListener('abort',abort);
    await worker.terminate();
  }
}

export async function executeCapture(url: string, appOrigin: string, originalPdfId?: string, signal?: AbortSignal, timeoutMs = EXECUTOR_TIMEOUT_MS): Promise<CapturedArticle> {
  const controller=new AbortController();
  let response: Response | undefined, rejectAbort: (error: SourceFetchError) => void;
  const cancelled=new Promise<never>((_,reject)=>{rejectAbort=reject;});
  const abort=()=>{
    controller.abort();
    void response?.body?.cancel().catch(()=>undefined);
    rejectAbort(new SourceFetchError('timeout',true));
  };
  const timer=setTimeout(abort,timeoutMs);
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();
  const convert=async(path:string,init:RequestInit)=>{
    controller.signal.throwIfAborted();
    const pending=fetch(`http://potem.convert/${path}`,{...init,signal:controller.signal});
    void pending.then(late=>{if(controller.signal.aborted)void late.body?.cancel().catch(()=>undefined);}).catch(()=>undefined);
    response=await pending;
    const bytes=await readBytes(response.body,MAX_CAPTURE_RESPONSE_BYTES,controller.signal);
    const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as {ok?:boolean;article?:CapturedArticle;error?:{code:string;retryable:boolean}};
    if(!response.ok || !result.ok || !result.article)throw new SourceFetchError(result.error?.code || 'converter_unavailable',result.error?.retryable ?? true);
    return result.article;
  };
  const run=async()=>{
    if(originalPdfId)return convert('stored-pdf',{method:'POST',headers:{'X-Pdf-Id':originalPdfId,'X-Source-Url':encodeURIComponent(url)}});
    const source=await fetchSourceDocument(url,{
      APP_ORIGIN:appOrigin,BACKGROUND_CAPTURE_ENABLED:'true',
      ARTICLE_FETCHER:{fetch:(input,init)=>pinnedFetch(String(input),{
        ...init,signal:init.signal ? AbortSignal.any([init.signal,controller.signal]) : controller.signal,
      },appOrigin)},
    });
    const metadata=source.kind==='html' ? await extractInThread(source.html,source.url,undefined,controller.signal) : {};
    const article=await convert(source.kind,{method:'POST',
      headers:{'Content-Type':source.kind==='html' ? 'text/html' : 'application/pdf','X-Source-Url':encodeURIComponent(source.url)},
      body:source.kind==='html' ? source.html : new Uint8Array(source.bytes),
    });
    return {...article,metadata};
  };
  try { return await Promise.race([run(),cancelled]); }
  catch(error) {
    if(controller.signal.aborted)throw new SourceFetchError('timeout',true);
    if(error instanceof SourceFetchError)throw error;
    throw new SourceFetchError('converter_unavailable',true);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort',abort); }
}
