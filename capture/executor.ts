import { Worker } from "node:worker_threads";
import { SourceFetchError, type CapturedArticle } from "../src/articles/capture-protocol";
import { fetchSourcePage } from "../src/articles/source-fetch";
import { pinnedFetch } from "./pinned-fetch";

/** A separate thread gives synchronous DOM conversion a hard wall-clock and heap limit. */
export async function extractInThread(html: string, url: string, threadUrl = new URL("./extract-thread.mjs", import.meta.url)): Promise<CapturedArticle> {
  const worker = new Worker(threadUrl, {
    workerData: { html, url }, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
    stdout: true, stderr: true,
  });
  // Third-party parser diagnostics can contain URLs or page text. Drain without logging.
  worker.stdout.resume();
  worker.stderr.resume();
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await new Promise<CapturedArticle>((resolve, reject) => {
      const failed = () => reject(new SourceFetchError("conversion_failed", false));
      timer = setTimeout(failed, 5_000);
      worker.once("message", message => {
        if (message && typeof message.markdown === "string" && message.metadata) resolve({ markdown: message.markdown, metadata: message.metadata });
        else failed();
      });
      worker.once("error", failed);
      worker.once("exit", failed);
    });
  } finally {
    clearTimeout(timer!);
    await worker.terminate();
  }
}

export async function executeCapture(url: string, appOrigin: string): Promise<CapturedArticle> {
  const source = await fetchSourcePage(url, {
    APP_ORIGIN: appOrigin, BACKGROUND_CAPTURE_ENABLED: "true",
    ARTICLE_FETCHER: { fetch: (input, init) => pinnedFetch(String(input), init, appOrigin) },
  });
  return extractInThread(source.html, source.url);
}
