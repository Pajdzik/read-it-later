import { Worker, type ResourceLimits } from "node:worker_threads";
import { captureErrorCodes, MAX_CAPTURE_RESPONSE_BYTES, SourceFetchError, type CapturedArticle } from "../src/articles/capture-protocol";
import { EXECUTOR_TIMEOUT_MS } from "../src/articles/capture-limits";
import { readBytes } from "../src/articles/pdf";
import { fetchSourceDocument } from "../src/articles/source-fetch";
import { pinnedFetch } from "./pinned-fetch";
import { fetchFeedXml } from "./feed-fetch";
import type { FeedDocument } from "./feed-parser";
import type { InspectedSource, TextSource } from "./extract-thread";

/** Separate threads bound synchronous parsing by wall time and heap. */
async function runParseThread<Result>(workerData: object, threadUrl: URL, resourceLimits: ResourceLimits, errorCode: string, signal?: AbortSignal): Promise<Result> {
  signal?.throwIfAborted();
  const worker = new Worker(threadUrl, {
    workerData, resourceLimits,
    stdout: true, stderr: true,
  });
  // Third-party parser diagnostics can contain URLs or page text. Drain without logging.
  worker.stdout.resume();
  worker.stderr.resume();
  let timer: ReturnType<typeof setTimeout>;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<Result>((resolve, reject) => {
      const failed = () => reject(new SourceFetchError(errorCode, false));
      abort = () => reject(new SourceFetchError("timeout", true));
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(failed, 5_000);
      worker.once("message", message => {
        if (message?.result !== undefined) resolve(message.result as Result);
        else failed();
      });
      worker.once("error", failed);
      worker.once("exit", failed);
    });
  } finally {
    clearTimeout(timer!);
    if (abort) signal?.removeEventListener("abort", abort);
    await worker.terminate();
  }
}

export function extractInThread(source: TextSource, threadUrl = new URL("./extract-thread.mjs", import.meta.url), signal?: AbortSignal): Promise<InspectedSource> {
  return runParseThread(source, threadUrl, { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 }, "conversion_failed", signal);
}

const feedThreadUrl = new URL("./feed-thread.mjs", import.meta.url);
const feedThreadLimits = { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 };

type CaptureOptions = { originalPdfId?: string; signal?: AbortSignal; timeoutMs?: number; preview?: boolean };

export async function executeCapture(url: string, appOrigin: string, options: CaptureOptions = {}): Promise<CapturedArticle> {
  const { originalPdfId, signal, timeoutMs = EXECUTOR_TIMEOUT_MS, preview } = options;
  const started = Date.now();
  let stage = 'source_fetch';
  let sourceFormat: 'html' | 'markdown' | 'pdf' | 'rss' | undefined;
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
    if (originalPdfId && !preview) {
      sourceFormat = 'pdf';
      stage = 'stored_pdf_conversion';
      return convert('stored-pdf',{method:'POST',headers:{'X-Pdf-Id':originalPdfId,'X-Source-Url':encodeURIComponent(url)}});
    }
    const source=await fetchSourceDocument(url,{
      appOrigin, signal: controller.signal,
      fetchHop:(input,init)=>pinnedFetch(input,init,appOrigin),
    });
    sourceFormat = source.kind;
    const sourceHeaders = { 'X-Source-Url': encodeURIComponent(source.url) };
    const previewSource = preview ? { sourceUrl: source.url } : {};
    if (source.kind === 'pdf') {
      stage = 'conversion';
      const article = await convert(preview ? 'preview-pdf' : 'pdf', {
        method: 'POST', headers: { ...sourceHeaders, 'Content-Type': 'application/pdf' }, body: new Uint8Array(source.bytes),
      });
      return { ...article, ...previewSource };
    }

    stage = 'source_parse';
    const inspected = await extractInThread(source, undefined, controller.signal);
    if (inspected.kind === 'markdown') {
      if (!inspected.markdown.trim()) throw new SourceFetchError('empty_source', false);
      return { markdown: inspected.markdown, metadata: inspected.metadata, ...previewSource };
    }
    if (source.kind !== 'html') throw new SourceFetchError('conversion_failed', false);
    let html = source.html;
    if (inspected.shell) {
      if (!inspected.shell.feedUrl) throw new SourceFetchError('conversion_failed', false);
      sourceFormat = 'rss';
      stage = 'feed_fetch';
      const feed = await fetchFeedXml(inspected.shell.feedUrl, appOrigin, controller.signal, new URL(source.url).origin);
      stage = 'feed_parse';
      const fullArticle = await runParseThread<string | null>(
        { ...feed, articleUrl: source.url }, feedThreadUrl, feedThreadLimits, 'conversion_failed', controller.signal,
      );
      if (!fullArticle) throw new SourceFetchError('conversion_failed', false);
      html = fullArticle;
    }
    stage = 'conversion';
    const article = await convert('html', {
      method: 'POST', headers: { ...sourceHeaders, 'Content-Type': 'text/html' }, body: html,
    });
    return { ...article, metadata: inspected.metadata, ...previewSource };
  };
  const logContext = () => ({ stage, sourceFormat, preview: !!preview, elapsedMs: Date.now() - started });
  try {
    const article = await Promise.race([run(), cancelled]);
    if (!article.conversionError) {
      console.info(JSON.stringify({ event: 'capture_executor_completed', ...logContext() }));
      return article;
    }
    logFailure(article.conversionError);
    return article;
  } catch (error) {
    const failure = controller.signal.aborted ? new SourceFetchError('timeout', true)
      : error instanceof SourceFetchError ? error : new SourceFetchError('converter_unavailable', true);
    logFailure(failure);
    throw failure;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort',abort); }

  function logFailure(failure: { code: string; retryable: boolean }) {
    const code = captureErrorCodes.find(known => known === failure.code) ?? 'invalid_capture_response';
    console.warn(JSON.stringify({ event: 'capture_executor_failed', ...logContext(), code, retryable: failure.retryable }));
  }
}

export async function executeFeed(url: string, appOrigin: string, signal?: AbortSignal): Promise<FeedDocument> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(), EXECUTOR_TIMEOUT_MS);
  try {
    const source = await fetchFeedXml(url, appOrigin, controller.signal);
    controller.signal.throwIfAborted();
    return await runParseThread<FeedDocument>(source, feedThreadUrl, feedThreadLimits, 'invalid_feed', controller.signal);
  } catch (error) {
    if (error instanceof SourceFetchError) throw error;
    if (controller.signal.aborted) throw new SourceFetchError("timeout", true);
    throw new SourceFetchError("invalid_feed", false);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
