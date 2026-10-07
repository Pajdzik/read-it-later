import type { ArticleCopy, ExtractionStatus } from "../contracts";

export interface ExtractionJob {
  articleId: string;
  url: string;
  generation: number;
  leaseToken: string;
  attempts: number;
  leaseExpiresAt: string;
}

export interface ExtractionMetadata {
  title?: string;
  author?: string;
  description?: string;
}

export interface ExtractionFailure {
  code: string;
  retryable: boolean;
  retryAfterSeconds?: number;
}

const MAX_RECONCILE = 50;
const MAX_ATTEMPTS = 3;
const LEASE_MS = 2 * 60_000;

function isoAfter(now: string, seconds: number): string {
  return new Date(Date.parse(now) + seconds * 1000).toISOString();
}

function safeCode(code: string): string {
  return /^[a-z][a-z0-9_]{0,47}$/.test(code) ? code : "extraction_failed";
}

function mapStatus(row: Record<string, unknown>, paused: boolean): ExtractionStatus {
  const hasCopy = row.copy_id != null;
  const intent = row.extraction_requested_at != null;
  const jobState = row.job_state == null ? null : String(row.job_state);
  const state: ExtractionStatus["state"] = hasCopy ? "ready"
    : jobState === "queued" || jobState === "retry_wait" || jobState === "running" ? jobState
      : jobState === "failed" ? "failed"
        : jobState === "succeeded" ? "failed"
          : intent ? "queued" : "none";
  return {
    state,
    attempts: Number(row.attempts ?? 0),
    errorCode: row.error_code == null
      ? (jobState === "succeeded" && !hasCopy ? "copy_unavailable" : null)
      : String(row.error_code),
    nextAttemptAt: row.next_attempt_at == null ? null : String(row.next_attempt_at),
    paused,
  };
}

const STATUS_SELECT = `SELECT a.id, a.extraction_requested_at, c.article_id AS copy_id,
    j.state AS job_state, j.attempts, j.error_code, j.next_attempt_at
  FROM articles a LEFT JOIN article_copies c ON c.article_id = a.id
  LEFT JOIN article_extraction_jobs j ON j.article_id = a.id`;

export async function getExtractionStatus(
  db: D1Database,
  id: string,
  paused = false,
): Promise<ExtractionStatus | null> {
  const row = await db.prepare(`${STATUS_SELECT} WHERE a.id = ?`).bind(id).first<Record<string, unknown>>();
  return row ? mapStatus(row, paused) : null;
}

export async function getExtractionStatuses(
  db: D1Database,
  ids: string[],
  paused = false,
): Promise<Map<string, ExtractionStatus>> {
  const result = new Map<string, ExtractionStatus>();
  if (ids.length === 0) return result;
  // D1/SQLite has a bounded parameter count. Keep each read comfortably below it.
  for (let offset = 0; offset < ids.length; offset += 80) {
    const chunk = ids.slice(offset, offset + 80);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db.prepare(`${STATUS_SELECT} WHERE a.id IN (${placeholders})`).bind(...chunk)
      .all<Record<string, unknown>>();
    for (const row of rows.results ?? []) result.set(String(row.id), mapStatus(row, paused));
  }
  return result;
}

/** Materialize one durable article intent. Safe to retry after a save/worker crash. */
export async function enqueueExtractionJob(db: D1Database, id: string, now = new Date().toISOString()): Promise<void> {
  await db.prepare(`INSERT INTO article_extraction_jobs
      (article_id,generation,state,attempts,next_attempt_at,created_at,updated_at)
    SELECT a.id,1,'queued',0,?,?,? FROM articles a
    WHERE a.id = ? AND a.extraction_requested_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM article_copies c WHERE c.article_id = a.id)
    ON CONFLICT(article_id) DO NOTHING`)
    .bind(now, now, now, id).run();
}

/** Reconcile missed intents and consume expired leases in bounded batches. */
export async function reconcileExtractionJobs(db: D1Database, now = new Date().toISOString()): Promise<void> {
  const recover = db.prepare(`UPDATE article_extraction_jobs SET
      state = CASE WHEN attempts >= ? THEN 'failed' ELSE 'retry_wait' END,
      next_attempt_at = CASE attempts
        WHEN 1 THEN strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+1 minute')
        ELSE strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+5 minutes') END,
      lease_token = NULL, lease_expires_at = NULL,
      error_code = CASE WHEN attempts >= ? THEN 'lease_expired' ELSE 'lease_expired' END,
      finished_at = CASE WHEN attempts >= ? THEN ? ELSE NULL END,
      updated_at = ?
    WHERE article_id IN (SELECT article_id FROM article_extraction_jobs
      WHERE state = 'running' AND lease_expires_at <= ? ORDER BY lease_expires_at,article_id LIMIT ?)`)
    .bind(MAX_ATTEMPTS, now, now, MAX_ATTEMPTS, MAX_ATTEMPTS, now, now, now, MAX_RECONCILE);
  const materialize = db.prepare(`INSERT INTO article_extraction_jobs
      (article_id,generation,state,attempts,next_attempt_at,created_at,updated_at)
    SELECT a.id,1,'queued',0,?,?,? FROM articles a
    WHERE a.extraction_requested_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM article_copies c WHERE c.article_id = a.id)
      AND NOT EXISTS (SELECT 1 FROM article_extraction_jobs j WHERE j.article_id = a.id)
    ORDER BY a.extraction_requested_at,a.id LIMIT ?`)
    .bind(now, now, now, MAX_RECONCILE);
  await db.batch([recover, materialize]);
}

/** One conditional UPDATE elects a single claimant and installs its lease. */
export async function claimExtractionJob(db: D1Database, now = new Date().toISOString()): Promise<ExtractionJob | null> {
  const token = crypto.randomUUID();
  const leaseExpiresAt = isoAfter(now, LEASE_MS / 1000);
  const row = await db.prepare(`UPDATE article_extraction_jobs SET state = 'running',
      attempts = attempts + 1, lease_token = ?, lease_expires_at = ?, updated_at = ?, finished_at = NULL
    WHERE article_id = (
      SELECT j.article_id FROM article_extraction_jobs j
      JOIN articles a ON a.id = j.article_id
      WHERE j.state IN ('queued','retry_wait') AND j.next_attempt_at <= ? AND j.attempts < ?
        AND NOT EXISTS (SELECT 1 FROM article_copies c WHERE c.article_id = j.article_id)
      ORDER BY j.next_attempt_at,j.article_id LIMIT 1
    ) AND state IN ('queued','retry_wait') AND next_attempt_at <= ? AND attempts < ?
      AND NOT EXISTS (SELECT 1 FROM article_copies c WHERE c.article_id = article_extraction_jobs.article_id)
    RETURNING article_id,generation,attempts,lease_expires_at,
      (SELECT url FROM articles WHERE id = article_extraction_jobs.article_id) AS url`)
    .bind(token, leaseExpiresAt, now, now, MAX_ATTEMPTS, now, MAX_ATTEMPTS)
    .first<Record<string, unknown>>();
  if (!row) return null;
  return {
    articleId: String(row.article_id),
    url: String(row.url),
    generation: Number(row.generation),
    leaseToken: token,
    attempts: Number(row.attempts),
    leaseExpiresAt: String(row.lease_expires_at),
  };
}

/** Commit the copy, allowed metadata, and terminal job state under one lease fence. */
export async function completeExtractionJob(
  db: D1Database,
  job: ExtractionJob,
  result: { markdown: string; metadata: ExtractionMetadata },
  now = new Date().toISOString(),
): Promise<boolean> {
  const copy: ArticleCopy = {
    markdown: result.markdown,
    capturedAt: now,
    source: "paste",
    revision: crypto.randomUUID(),
  };
  const fence = `EXISTS (SELECT 1 FROM article_extraction_jobs j
      WHERE j.article_id = ? AND j.generation = ? AND j.state = 'running'
        AND j.lease_token = ? AND j.lease_expires_at > ?)`;
  const insertCopy = db.prepare(`INSERT INTO article_copies(article_id,markdown,captured_at,source,revision)
      SELECT ?,?,?,?,? WHERE ${fence} AND EXISTS (SELECT 1 FROM articles WHERE id = ?)
        AND NOT EXISTS (SELECT 1 FROM article_copies WHERE article_id = ?)
      ON CONFLICT(article_id) DO NOTHING`)
    .bind(job.articleId, copy.markdown, copy.capturedAt, copy.source, copy.revision,
      job.articleId, job.generation, job.leaseToken, now, job.articleId, job.articleId);
  const title = result.metadata.title?.trim() || null;
  const author = result.metadata.author?.trim() || null;
  const description = result.metadata.description?.trim() || null;
  const metadataUpdate = db.prepare(`UPDATE articles SET
      title = CASE WHEN title_origin = 'fallback' AND ? IS NOT NULL THEN ? ELSE title END,
      title_origin = CASE WHEN title_origin = 'fallback' AND ? IS NOT NULL THEN 'extracted' ELSE title_origin END,
      author = COALESCE(author, ?), description = COALESCE(description, ?),
      updated_at = CASE WHEN
        (title_origin = 'fallback' AND ? IS NOT NULL AND title != ?) OR
        (author IS NULL AND ? IS NOT NULL) OR (description IS NULL AND ? IS NOT NULL)
        THEN ? ELSE updated_at END
    WHERE id = ? AND ${fence} AND EXISTS (SELECT 1 FROM article_copies WHERE article_id = ? AND revision = ?)`)
    .bind(title, title, title, author, description, title, title, author, description, now, job.articleId,
      job.articleId, job.generation, job.leaseToken, now, job.articleId, copy.revision);
  const finish = db.prepare(`UPDATE article_extraction_jobs SET state = 'succeeded',
      lease_token = NULL, lease_expires_at = NULL, error_code = NULL, finished_at = ?, updated_at = ?
    WHERE article_id = ? AND generation = ? AND state = 'running' AND lease_token = ?
      AND lease_expires_at > ? AND EXISTS (SELECT 1 FROM articles WHERE id = ?)
      AND EXISTS (SELECT 1 FROM article_copies WHERE article_id = ?)`)
    .bind(now, now, job.articleId, job.generation, job.leaseToken, now, job.articleId, job.articleId);
  const results = await db.batch([insertCopy, metadataUpdate, finish]);
  return (results[2]?.meta.changes ?? 0) > 0;
}

/** Record only a bounded stable failure code; stale workers cannot alter a retry. */
export async function failExtractionJob(
  db: D1Database,
  job: ExtractionJob,
  failure: ExtractionFailure,
  now = new Date().toISOString(),
): Promise<void> {
  const code = safeCode(failure.code);
  const retryable = failure.retryable && job.attempts < MAX_ATTEMPTS;
  const standardDelay = job.attempts <= 1 ? 60 : 300;
  const retryAfter = Number.isFinite(failure.retryAfterSeconds)
    ? Math.max(0, Math.min(3600, failure.retryAfterSeconds!)) : 0;
  const nextAttemptAt = isoAfter(now, Math.max(standardDelay, retryAfter));
  await db.prepare(`UPDATE article_extraction_jobs SET
      state = ?, next_attempt_at = ?, lease_token = NULL, lease_expires_at = NULL,
      error_code = ?, finished_at = ?, updated_at = ?
    WHERE article_id = ? AND generation = ? AND state = 'running' AND lease_token = ?
      AND lease_expires_at > ? AND attempts = ? AND EXISTS (SELECT 1 FROM articles WHERE id = ?)
      AND NOT EXISTS (SELECT 1 FROM article_copies WHERE article_id = ?)`)
    .bind(retryable ? "retry_wait" : "failed", nextAttemptAt, code,
      retryable ? null : now, now, job.articleId, job.generation, job.leaseToken, now,
      job.attempts, job.articleId, job.articleId).run();
}

export type RetryExtractionResult = "missing" | "cooldown" | "ready" | "active" | "queued";

/** Owner retry: only a failed, copy-less generation can be reset. */
export async function retryExtractionJob(
  db: D1Database,
  id: string,
  now = new Date().toISOString(),
): Promise<RetryExtractionResult> {
  const article = await db.prepare(`SELECT a.id, a.extraction_requested_at,
      EXISTS (SELECT 1 FROM article_copies c WHERE c.article_id = a.id) AS has_copy
    FROM articles a WHERE a.id = ?`).bind(id).first<Record<string, unknown>>();
  if (!article) return "missing";
  if (Number(article.has_copy) > 0) return "ready";
  const row = await db.prepare("SELECT state,updated_at FROM article_extraction_jobs WHERE article_id = ?")
    .bind(id).first<Record<string, unknown>>();
  if (!row) {
    if (article.extraction_requested_at == null) return "missing";
    await enqueueExtractionJob(db, id, now);
    return "queued";
  }
  if (["queued", "running", "retry_wait"].includes(String(row.state))) return "active";
  if (row.state !== "failed") return "missing";
  if (Date.parse(now) - Date.parse(String(row.updated_at)) < 60_000) return "cooldown";
  const reset = await db.prepare(`UPDATE article_extraction_jobs SET generation = generation + 1,
      state = 'queued', attempts = 0, next_attempt_at = ?, lease_token = NULL,
      lease_expires_at = NULL, error_code = NULL, finished_at = NULL, updated_at = ?
    WHERE article_id = ? AND state = 'failed' AND updated_at = ?
      AND NOT EXISTS (SELECT 1 FROM article_copies WHERE article_id = ?)`)
    .bind(now, now, id, row.updated_at, id).run();
  return (reset.meta.changes ?? 0) > 0 ? "queued" : "active";
}
