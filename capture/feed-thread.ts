import { parentPort, workerData } from "node:worker_threads";
import { parseFeed } from "./feed-parser";

try { parentPort?.postMessage({ feed: parseFeed(workerData.xml as string, workerData.url as string) }); }
catch { parentPort?.postMessage({ error: "invalid_feed" }); }
