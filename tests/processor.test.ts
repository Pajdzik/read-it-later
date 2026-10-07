import { env as testEnv } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/contracts";
import { processExtractionJobs } from "../src/articles/processor";

const now = new Date(Date.now() - 10_000).toISOString();
const articleHtml = `<!doctype html><html><head><title>Extracted title</title><meta name="author" content="Jamie Example"><meta name="description" content="Useful summary"></head><body><nav>Navigation</nav><article><h1>Readable story</h1><p>Keep <strong>formatting</strong> in this article.</p></article></body></html>`;

function processorEnv(fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>, overrides: Partial<Env> = {}): Env {
  return {
    DB: testEnv.DB,
    ASSETS: testEnv.ASSETS,
    BACKGROUND_CAPTURE_ENABLED: "true",
    ARTICLE_FETCHER: { fetch, connect() { throw new Error("unused"); } } as Fetcher,
    ...overrides,
  } as Env;
}

async function addIntent(id: string, url = `https://source.example.com/${id}`): Promise<void> {
  await testEnv.DB.prepare(`INSERT INTO articles
    (id,url,normalized_url,title,author,description,created_at,updated_at,read_at,extraction_requested_at,title_origin)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, url, url, `fallback ${id}`, null, null, now, now, null, now, "fallback").run();
}

describe("scheduled extraction processor", () => {
  beforeEach(async () => {
    await testEnv.DB.prepare("DELETE FROM articles").run();
  });

  it("turns a durable intent into one private copy and enriches only fallback metadata", async () => {
    await addIntent("processor-success");
    const fetcher = vi.fn(async (_input?: RequestInfo | URL) => new Response(articleHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } }));
    await processExtractionJobs(processorEnv(fetcher), now);

    const row = await testEnv.DB.prepare(`SELECT a.title,a.author,a.description,a.read_at,j.state,j.attempts,j.lease_token,
      c.markdown,c.source,c.revision FROM articles a
      JOIN article_extraction_jobs j ON j.article_id=a.id
      JOIN article_copies c ON c.article_id=a.id WHERE a.id=?`).bind("processor-success").first<Record<string, unknown>>();
    expect(row).toMatchObject({
      title: "Extracted title", author: "Jamie Example", description: "Useful summary", read_at: null,
      state: "succeeded", attempts: 1, lease_token: null, source: "paste",
    });
    expect(row?.markdown).toContain("Readable story");
    expect(row?.markdown).toContain("**formatting**");
    expect(row?.revision).toEqual(expect.any(String));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://source.example.com/processor-success");
  });

  it("processes only one eligible job per scheduled invocation", async () => {
    await addIntent("processor-one");
    await addIntent("processor-two");
    const fetcher = vi.fn(async (_input?: RequestInfo | URL) => new Response(articleHtml, { headers: { "Content-Type": "text/html" } }));
    await processExtractionJobs(processorEnv(fetcher), now);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const completed = await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM article_copies").first<{ count: number }>();
    expect(completed?.count).toBe(1);
  });

  it("records permanent source failures without saving a copy", async () => {
    await addIntent("processor-permanent");
    const fetcher = vi.fn(async () => new Response("", { status: 404 }));
    await processExtractionJobs(processorEnv(fetcher), now);
    const job = await testEnv.DB.prepare("SELECT state,attempts,error_code FROM article_extraction_jobs WHERE article_id=?")
      .bind("processor-permanent").first<Record<string, unknown>>();
    expect(job).toMatchObject({ state: "failed", attempts: 1, error_code: "upstream_http" });
    const copy = await testEnv.DB.prepare("SELECT 1 AS found FROM article_copies WHERE article_id=?").bind("processor-permanent").first();
    expect(copy).toBeNull();
  });

  it("schedules transient source failures with capped Retry-After", async () => {
    await addIntent("processor-transient");
    const fetcher = vi.fn(async () => new Response("", { status: 503, headers: { "Retry-After": "7200" } }));
    await processExtractionJobs(processorEnv(fetcher), now);
    const job = await testEnv.DB.prepare("SELECT state,attempts,error_code,next_attempt_at,updated_at FROM article_extraction_jobs WHERE article_id=?")
      .bind("processor-transient").first<Record<string, unknown>>();
    expect(job).toMatchObject({
      state: "retry_wait", attempts: 1, error_code: "upstream_http",
      next_attempt_at: new Date(Date.parse(String(job?.updated_at)) + 3_600_000).toISOString(),
    });
  });

  it("does no reconciliation or source work while capture is paused or missing its gateway", async () => {
    await addIntent("processor-paused");
    const fetcher = vi.fn(async () => new Response(articleHtml, { headers: { "Content-Type": "text/html" } }));
    await processExtractionJobs(processorEnv(fetcher, { BACKGROUND_CAPTURE_ENABLED: "false" }), now);
    await processExtractionJobs(processorEnv(fetcher, { ARTICLE_FETCHER: undefined }), now);
    expect(fetcher).not.toHaveBeenCalled();
    const jobs = await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM article_extraction_jobs").first<{ count: number }>();
    expect(jobs?.count).toBe(0);
  });
});
