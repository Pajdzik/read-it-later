import { parentPort, workerData } from "node:worker_threads";
import { findFeedArticleHtml, parseFeed } from "./feed-parser";

try {
  const { xml, url, articleUrl } = workerData as { xml: string; url: string; articleUrl?: string };
  const result = articleUrl ? findFeedArticleHtml(xml, url, articleUrl) : parseFeed(xml, url);
  parentPort?.postMessage({ result });
}
catch { parentPort?.postMessage({ error: "invalid_feed" }); }
