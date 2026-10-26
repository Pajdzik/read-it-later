import { parentPort, workerData } from "node:worker_threads";
import { extractArticleMarkdown, parseArticleDocument } from "../src/articles/extraction";
import { parseArticleMetadata } from "../src/articles/metadata";

// Conversion has no network capability, even if a dependency introduces an async fallback.
globalThis.fetch = async () => { throw new Error("extraction_network_disabled"); };
try {
  const document = parseArticleDocument(workerData.html);
  // Capture metadata before Defuddle mutates the document. All parsing stays in this thread.
  const metadata = parseArticleMetadata(document);
  const markdown = await extractArticleMarkdown(document, workerData.url);
  parentPort!.postMessage({ markdown, metadata });
} catch { parentPort!.postMessage({ error: "conversion_failed" }); }
