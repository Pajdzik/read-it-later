import type { Env } from "../contracts";
import { extractArticleMarkdown } from "./extraction";
import { claimExtractionJob, completeExtractionJob, failExtractionJob, reconcileExtractionJobs } from "./jobs";
import { fetchSourcePage, isBackgroundCapturePaused, SourceFetchError } from "./source-fetch";

function log(event: string, fields: Record<string, string | number | boolean | null> = {}): void {
  console.info(JSON.stringify({ event, ...fields }));
}

/** Process at most one extraction job, sequentially, from a scheduled invocation. */
export async function processExtractionJobs(env: Env, now = new Date().toISOString()): Promise<void> {
  if (isBackgroundCapturePaused(env)) return;

  try {
    await reconcileExtractionJobs(env.DB, now);
  } catch {
    log("extraction_reconcile_failed");
    throw new Error("extraction_reconcile_failed");
  }

  let job: Awaited<ReturnType<typeof claimExtractionJob>>;
  try {
    job = await claimExtractionJob(env.DB, now);
  } catch {
    log("extraction_claim_failed");
    throw new Error("extraction_claim_failed");
  }
  if (!job) return;

  try {
    const source = await fetchSourcePage(job.url, env);
    let markdown: string;
    try {
      markdown = await extractArticleMarkdown(source.html, source.url);
    } catch {
      throw new SourceFetchError("conversion_failed", false);
    }
    let completed: boolean;
    try {
      completed = await completeExtractionJob(env.DB, job, { markdown, metadata: source.metadata }, new Date().toISOString());
    } catch {
      throw new SourceFetchError("storage_failed", true);
    }
    log(completed ? "extraction_job_completed" : "extraction_job_completion_stale", {
      articleId: job.articleId,
      attempts: job.attempts,
      ...(completed ? { outputBytes: new TextEncoder().encode(markdown).byteLength } : {}),
    });
  } catch (error) {
    const failure = error instanceof SourceFetchError
      ? { code: error.code, retryable: error.retryable, retryAfterSeconds: error.retryAfterSeconds }
      : { code: "processing_failed", retryable: false };
    try {
      await failExtractionJob(env.DB, job, failure, new Date().toISOString());
      log("extraction_job_failed", { articleId: job.articleId, attempts: job.attempts, code: failure.code });
    } catch {
      // A later scheduler tick recovers the expired lease. Never log the thrown
      // error because D1 and upstream messages may contain source details.
      log("extraction_failure_recording_failed", { articleId: job.articleId, attempts: job.attempts });
      throw new Error("extraction_failure_recording_failed");
    }
  }
}
