import { parentPort, workerData } from "node:worker_threads";
import { extractArticleMarkdown } from "../src/articles/extraction";
import { parseArticleMetadata } from "../src/articles/metadata";

// Conversion has no network capability, even if a dependency introduces an async fallback.
globalThis.fetch = async () => { throw new Error("extraction_network_disabled"); };
try {
  const markdown = await extractArticleMarkdown(workerData.html, workerData.url);
  const metadata = parseArticleMetadata(workerData.html);
  parentPort!.postMessage({ markdown, metadata });
} catch { parentPort!.postMessage({ error: "conversion_failed" }); }
