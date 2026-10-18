import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  claimExtractionJob,
  completeExtractionJob,
  enqueueExtractionJob,
  failExtractionJob,
  getExtractionStatus,
  getExtractionStatuses,
  reconcileExtractionJobs,
  retryExtractionJob,
} from "../src/articles/jobs";
import { deleteArticle, saveArticle, saveArticleCopy, updateArticle } from "../src/articles/repository";

const baseTime = "2026-10-06T10:00:00.000Z";
const url = "https://example.com/article";

async function clear() {
  await env.DB.prepare("DELETE FROM articles").run();
  await env.DB.prepare("DROP TRIGGER IF EXISTS fail_job_finish").run();
  await env.DB.prepare("DROP TRIGGER IF EXISTS fail_intent_update").run();
}

async function requestedArticle(title?: string) {
  return saveArticle(env.DB, {
    url,
    normalizedUrl: url,
    title,
    extractionRequested: true,
    titleOrigin: title ? "supplied" : "fallback",
  });
}

describe("D1 background extraction jobs", () => {
  beforeEach(clear);

  it("keeps a save intent durable across a crash before job materialization", async () => {
    const saved = await requestedArticle();
    expect(await getExtractionStatus(env.DB, saved.article.id)).toMatchObject({ state: "queued", attempts: 0 });
    expect(await claimExtractionJob(env.DB, baseTime)).toBeNull();

    await enqueueExtractionJob(env.DB, saved.article.id, baseTime);
    const job = await claimExtractionJob(env.DB, baseTime);
    expect(job).toMatchObject({ articleId: saved.article.id, attempts: 1, generation: 1 });
    expect(await getExtractionStatus(env.DB, saved.article.id)).toMatchObject({ state: "running", attempts: 1 });
  });

  it("rolls back duplicate metadata changes if the durable intent write fails", async () => {
    const saved = await saveArticle(env.DB, { url, normalizedUrl: url, title: "Saved title" });
    await env.DB.prepare(`CREATE TRIGGER fail_intent_update BEFORE UPDATE OF extraction_requested_at ON articles
      WHEN NEW.extraction_requested_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'forced intent failure'); END`).run();
    await expect(saveArticle(env.DB, {
      url,
      normalizedUrl: url,
      author: "Should roll back",
      extractionRequested: true,
    })).rejects.toThrow();
    expect(await env.DB.prepare("SELECT title,author,extraction_requested_at FROM articles WHERE id = ?")
      .bind(saved.article.id).first()).toEqual({ title: "Saved title", author: null, extraction_requested_at: null });
  });

  it("preserves a duplicate article's title, identity, and read state while reusing its intent", async () => {
    const first = await requestedArticle("First title");
    await updateArticle(env.DB, first.article.id, { read: true }, baseTime);
    const duplicate = await saveArticle(env.DB, {
      url: "https://example.com/article?share=again",
      normalizedUrl: url,
      title: "Later share title",
      titleOrigin: "supplied",
      extractionRequested: true,
    });
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.article).toMatchObject({
      id: first.article.id,
      title: "First title",
      readAt: baseTime,
      createdAt: first.article.createdAt,
    });
    await enqueueExtractionJob(env.DB, first.article.id, baseTime);
    const count = await env.DB.prepare("SELECT count(*) AS count FROM article_extraction_jobs WHERE article_id = ?")
      .bind(first.article.id).first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("keeps fallback title origin through link-only duplicates so extraction can enrich it later", async () => {
    const first = await requestedArticle();
    await saveArticle(env.DB, {
      url: "https://example.com/article?again=1",
      normalizedUrl: url,
      title: "Share supplied title",
      titleOrigin: "fallback",
      extractionRequested: false,
    });
    expect(await env.DB.prepare("SELECT title,title_origin FROM articles WHERE id = ?").bind(first.article.id).first())
      .toEqual({ title: url, title_origin: "fallback" });
    await enqueueExtractionJob(env.DB, first.article.id, baseTime);
    const job = await claimExtractionJob(env.DB, baseTime);
    await completeExtractionJob(env.DB, job!, { markdown: "copy", metadata: { title: "Extracted title" } }, "2026-10-06T10:00:10.000Z");
    expect(await env.DB.prepare("SELECT title,title_origin FROM articles WHERE id = ?").bind(first.article.id).first())
      .toEqual({ title: "Extracted title", title_origin: "extracted" });
  });

  it("allows exactly one winner from concurrent atomic claims", async () => {
    const saved = await requestedArticle();
    await enqueueExtractionJob(env.DB, saved.article.id, baseTime);
    const claims = await Promise.all([
      claimExtractionJob(env.DB, baseTime),
      claimExtractionJob(env.DB, baseTime),
      claimExtractionJob(env.DB, baseTime),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("uses bounded backoff and exhausts attempts recovered from expired leases", async () => {
    const saved = await requestedArticle();
    await enqueueExtractionJob(env.DB, saved.article.id, baseTime);
    let job = await claimExtractionJob(env.DB, baseTime);
    expect(job?.attempts).toBe(1);
    await reconcileExtractionJobs(env.DB, "2026-10-06T10:02:00.000Z");
    expect(await getExtractionStatus(env.DB, saved.article.id)).toMatchObject({
      state: "retry_wait", errorCode: "lease_expired", nextAttemptAt: "2026-10-06T10:03:00.000Z",
    });
    expect(await claimExtractionJob(env.DB, "2026-10-06T10:02:59.999Z")).toBeNull();

    job = await claimExtractionJob(env.DB, "2026-10-06T10:03:00.000Z");
    expect(job?.attempts).toBe(2);
    await reconcileExtractionJobs(env.DB, "2026-10-06T10:05:00.000Z");
    expect(await getExtractionStatus(env.DB, saved.article.id)).toMatchObject({
      state: "retry_wait", nextAttemptAt: "2026-10-06T10:10:00.000Z",
    });

    job = await claimExtractionJob(env.DB, "2026-10-06T10:10:00.000Z");
    expect(job?.attempts).toBe(3);
    await reconcileExtractionJobs(env.DB, "2026-10-06T10:12:00.000Z");
    expect(await getExtractionStatus(env.DB, saved.article.id)).toMatchObject({
      state: "failed", attempts: 3, errorCode: "lease_expired",
    });
    expect(await claimExtractionJob(env.DB, "2026-10-07T00:00:00.000Z")).toBeNull();
  });

  it("backs off transient failures, bounds retry-after, and fences an expired lease", async () => {
    const saved = await requestedArticle();
    await enqueueExtractionJob(env.DB, saved.article.id, baseTime);
    const oldJob = await claimExtractionJob(env.DB, baseTime);
    await failExtractionJob(env.DB, oldJob!, { code: "network_timeout", retryable: true, retryAfterSeconds: 10000 }, baseTime);
    expect(await getExtractionStatus(env.DB, saved.article.id)).toMatchObject({
      state: "retry_wait", errorCode: "network_timeout", nextAttemptAt: "2026-10-06T11:00:00.000Z",
    });
    const currentJob = await claimExtractionJob(env.DB, "2026-10-06T11:00:00.000Z");
    expect(currentJob?.leaseToken).not.toBe(oldJob?.leaseToken);
    await completeExtractionJob(env.DB, oldJob!, { markdown: "stale copy", metadata: { title: "Stale" } }, "2026-10-06T11:00:01.000Z");
    expect(await env.DB.prepare("SELECT 1 FROM article_copies WHERE article_id = ?").bind(saved.article.id).first()).toBeNull();
    await completeExtractionJob(env.DB, currentJob!, { markdown: "current copy", metadata: {} }, "2026-10-06T11:00:02.000Z");
    expect(await getExtractionStatus(env.DB, saved.article.id)).toMatchObject({ state: "ready", attempts: 2 });
  });

  it("fences old generations and enforces the explicit retry cooldown", async () => {
    const saved = await requestedArticle();
    await enqueueExtractionJob(env.DB, saved.article.id, baseTime);
    const oldJob = await claimExtractionJob(env.DB, baseTime);
    await failExtractionJob(env.DB, oldJob!, { code: "unsupported_content", retryable: false }, baseTime);
    expect(await retryExtractionJob(env.DB, saved.article.id, "2026-10-06T10:00:59.999Z")).toBe("cooldown");
    expect(await retryExtractionJob(env.DB, saved.article.id, "2026-10-06T10:01:00.000Z")).toBe("queued");
    const newJob = await claimExtractionJob(env.DB, "2026-10-06T10:01:00.000Z");
    expect(newJob?.generation).toBe(2);
    await completeExtractionJob(env.DB, oldJob!, { markdown: "old", metadata: {} }, "2026-10-06T10:01:01.000Z");
    expect(await env.DB.prepare("SELECT 1 FROM article_copies WHERE article_id = ?").bind(saved.article.id).first()).toBeNull();
    await failExtractionJob(env.DB, oldJob!, { code: "late_error", retryable: true }, "2026-10-06T10:01:02.000Z");
    expect(await getExtractionStatus(env.DB, saved.article.id)).toMatchObject({ state: "running", attempts: 1 });
  });

  it("manual copy atomically satisfies a job and wins a race with background completion", async () => {
    const saved = await requestedArticle();
    await enqueueExtractionJob(env.DB, saved.article.id, baseTime);
    const job = await claimExtractionJob(env.DB, baseTime);
    const manual = { markdown: "manual", capturedAt: "2026-10-06T10:00:30.000Z", source: "paste" as const, revision: "manual-rev" };
    expect(await saveArticleCopy(env.DB, saved.article.id, { ...manual, revision: "rejected" }, "wrong-revision")).toBe("conflict");
    expect(await getExtractionStatus(env.DB, saved.article.id)).toMatchObject({ state: "running", attempts: 1 });
    expect(await saveArticleCopy(env.DB, saved.article.id, manual, null)).toBe("saved");
    expect(await getExtractionStatus(env.DB, saved.article.id)).toMatchObject({ state: "ready", attempts: 1 });
    await completeExtractionJob(env.DB, job!, { markdown: "background", metadata: { title: "Won't win" } }, "2026-10-06T10:00:40.000Z");
    expect(await env.DB.prepare("SELECT markdown,revision FROM article_copies WHERE article_id = ?").bind(saved.article.id).first())
      .toEqual({ markdown: "manual", revision: "manual-rev" });

    expect(await saveArticleCopy(env.DB, saved.article.id, { ...manual, revision: "stale", markdown: "bad" }, "wrong-revision")).toBe("conflict");
    expect(await getExtractionStatus(env.DB, saved.article.id)).toMatchObject({ state: "ready" });
  });

  it("preserves owner title and read state while applying permitted extracted metadata", async () => {
    const saved = await requestedArticle();
    await updateArticle(env.DB, saved.article.id, { title: "Owner title", read: true }, "2026-10-06T10:00:10.000Z");
    await enqueueExtractionJob(env.DB, saved.article.id, baseTime);
    const job = await claimExtractionJob(env.DB, baseTime);
    await completeExtractionJob(env.DB, job!, {
      markdown: "# Article",
      metadata: { title: "Page title", author: "Writer", description: "Lead" },
    }, "2026-10-06T10:00:20.000Z");
    const row = await env.DB.prepare("SELECT title,title_origin,author,description,read_at FROM articles WHERE id = ?")
      .bind(saved.article.id).first<Record<string, unknown>>();
    expect(row).toMatchObject({
      title: "Owner title", title_origin: "protected", author: "Writer", description: "Lead",
      read_at: "2026-10-06T10:00:10.000Z",
    });
  });

  it("cascades deletion and rolls back copy insertion if completion cannot finish", async () => {
    const deleted = await requestedArticle();
    await enqueueExtractionJob(env.DB, deleted.article.id, baseTime);
    const deletedJob = await claimExtractionJob(env.DB, baseTime);
    await deleteArticle(env.DB, deleted.article.id);
    await completeExtractionJob(env.DB, deletedJob!, { markdown: "late", metadata: {} }, "2026-10-06T10:00:10.000Z");
    expect(await env.DB.prepare("SELECT 1 FROM article_copies WHERE article_id = ?").bind(deleted.article.id).first()).toBeNull();

    const rollback = await requestedArticle("Rollback");
    await enqueueExtractionJob(env.DB, rollback.article.id, baseTime);
    const job = await claimExtractionJob(env.DB, baseTime);
    await env.DB.prepare(`CREATE TRIGGER fail_job_finish BEFORE UPDATE OF state ON article_extraction_jobs
      WHEN NEW.state = 'succeeded' BEGIN SELECT RAISE(ABORT, 'forced rollback'); END`).run();
    await expect(completeExtractionJob(env.DB, job!, { markdown: "must rollback", metadata: {} }, "2026-10-06T10:00:10.000Z")).rejects.toThrow();
    expect(await env.DB.prepare("SELECT 1 FROM article_copies WHERE article_id = ?").bind(rollback.article.id).first()).toBeNull();
    await env.DB.prepare("DROP TRIGGER fail_job_finish").run();
  });

  it("reports compact batch statuses and keeps terminal failures on repeated requests", async () => {
    const failed = await requestedArticle();
    await enqueueExtractionJob(env.DB, failed.article.id, baseTime);
    const job = await claimExtractionJob(env.DB, baseTime);
    await failExtractionJob(env.DB, job!, { code: "http_forbidden", retryable: false }, baseTime);
    await requestedArticle();
    const statuses = await getExtractionStatuses(env.DB, [failed.article.id, "absent"], true);
    expect(statuses.get(failed.article.id)).toMatchObject({ state: "failed", attempts: 1, paused: true });
    expect(statuses.has("absent")).toBe(false);
    await enqueueExtractionJob(env.DB, failed.article.id, "2026-10-07T00:00:00.000Z");
    expect(await getExtractionStatus(env.DB, failed.article.id)).toMatchObject({ state: "failed", attempts: 1 });
  });
});
