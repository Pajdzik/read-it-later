import { parentPort, workerData } from "node:worker_threads";
import { parseHTML } from "linkedom";
import { parseArticleMetadata } from "../src/articles/metadata";

// Conversion has no network capability, even if a dependency introduces an async fallback.
globalThis.fetch = async () => { throw new Error("extraction_network_disabled"); };
try {
  const document = parseHTML(workerData.html).document;
  parentPort!.postMessage({ metadata: parseArticleMetadata(document) });
} catch { parentPort!.postMessage({ error: "conversion_failed" }); }
