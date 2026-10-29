import type { ExtractionJob, ExtractionMetadata } from './jobs';

/** SQL representation shared by request, completion, and undo guards. */
export const metadataSnapshot = (alias: string): string =>
  `json_array(${alias}.title,${alias}.title_origin,${alias}.author,${alias}.description)`;

export type RecaptureResult = 'queued' | 'active' | 'missing' | 'revision_conflict' | 'capture_active' | 'cooldown';

/** A single write records both explicit intent and the exact version it may replace. */
export async function requestRecapture(
  db: D1Database, id: string, expectedRevision: string | null, refreshMetadata = false,
  now = new Date().toISOString(),
): Promise<RecaptureResult> {
  const cutoff = new Date(Date.parse(now) - 60_000).toISOString();
  const queued = await db.prepare(`INSERT INTO article_extraction_jobs
      (article_id,generation,state,attempts,next_attempt_at,created_at,updated_at,
       kind,expected_revision,refresh_metadata,baseline_metadata)
    SELECT a.id,1,'queued',0,?,?,?,'recapture',?,?,${metadataSnapshot('a')}
    FROM articles a WHERE a.id = ?
      AND (SELECT revision FROM article_copies WHERE article_id = a.id) IS ?
    ON CONFLICT(article_id) DO UPDATE SET
      generation = article_extraction_jobs.generation + 1, state = 'queued', attempts = 0,
      next_attempt_at = excluded.next_attempt_at, updated_at = excluded.updated_at,
      lease_token = NULL, lease_expires_at = NULL, error_code = NULL, finished_at = NULL,
      kind = 'recapture', expected_revision = excluded.expected_revision,
      refresh_metadata = excluded.refresh_metadata, baseline_metadata = excluded.baseline_metadata
    WHERE article_extraction_jobs.state IN ('succeeded','failed') AND article_extraction_jobs.updated_at <= ?
    RETURNING generation`)
    .bind(now, now, now, expectedRevision, refreshMetadata ? 1 : 0, id, expectedRevision, cutoff).first();
  if (queued) return 'queued';
  const current = await db.prepare(`SELECT c.revision,j.state,j.kind,j.expected_revision,j.refresh_metadata
    FROM articles a LEFT JOIN article_copies c ON c.article_id=a.id
    LEFT JOIN article_extraction_jobs j ON j.article_id=a.id WHERE a.id=?`)
    .bind(id).first<Record<string, unknown>>();
  if (!current) return 'missing';
  if ((current.revision ?? null) !== expectedRevision) return 'revision_conflict';
  if (['queued', 'running', 'retry_wait'].includes(String(current.state))) {
    return current.kind === 'recapture' && (current.expected_revision ?? null) === expectedRevision &&
      Number(current.refresh_metadata) === Number(refreshMetadata) ? 'active' : 'capture_active';
  }
  return 'cooldown';
}

export async function undoRecapture(
  db: D1Database, id: string, expectedRevision: string, now = new Date().toISOString(),
): Promise<'saved' | 'missing' | 'conflict'> {
  const revision = crypto.randomUUID();
  const restoreCopy = db.prepare(`UPDATE article_copies SET
      markdown = (SELECT markdown FROM article_capture_recovery WHERE article_id = ?),
      captured_at = (SELECT captured_at FROM article_capture_recovery WHERE article_id = ?),
      source = (SELECT source FROM article_capture_recovery WHERE article_id = ?), revision = ?
    WHERE article_id = ? AND revision = ? AND EXISTS (
      SELECT 1 FROM article_capture_recovery r JOIN articles a ON a.id=r.article_id
      WHERE r.article_id = ? AND r.resulting_revision = article_copies.revision
        AND (r.previous_metadata IS NULL OR r.resulting_metadata = ${metadataSnapshot('a')}))`)
    .bind(id, id, id, revision, id, expectedRevision, id);
  const restoreMetadata = db.prepare(`UPDATE articles SET
      title = json_extract((SELECT previous_metadata FROM article_capture_recovery WHERE article_id=?), '$[0]'),
      title_origin = json_extract((SELECT previous_metadata FROM article_capture_recovery WHERE article_id=?), '$[1]'),
      author = json_extract((SELECT previous_metadata FROM article_capture_recovery WHERE article_id=?), '$[2]'),
      description = json_extract((SELECT previous_metadata FROM article_capture_recovery WHERE article_id=?), '$[3]'),
      updated_at = ?
    WHERE id = ? AND EXISTS (SELECT 1 FROM article_copies WHERE article_id=? AND revision=?)
      AND EXISTS (SELECT 1 FROM article_capture_recovery WHERE article_id=? AND previous_metadata IS NOT NULL)`)
    .bind(id, id, id, id, now, id, id, revision, id);
  const supersede = db.prepare(`UPDATE article_extraction_jobs SET
      state='failed',error_code='copy_changed',lease_token=NULL,lease_expires_at=NULL,finished_at=?,updated_at=?
    WHERE article_id=? AND state IN ('queued','running','retry_wait')
      AND EXISTS (SELECT 1 FROM article_copies WHERE article_id=? AND revision=?)`)
    .bind(now, now, id, id, revision);
  const consume = db.prepare(`DELETE FROM article_capture_recovery WHERE article_id=?
    AND EXISTS (SELECT 1 FROM article_copies WHERE article_id=? AND revision=?)`).bind(id, id, revision);
  const results = await db.batch([restoreCopy, restoreMetadata, supersede, consume]);
  if (results[0].meta.changes > 0) return 'saved';
  return await db.prepare('SELECT id FROM articles WHERE id=?').bind(id).first() ? 'conflict' : 'missing';
}

/** All guards and writes run in one transaction; a no-op guard never publishes partial content. */
export async function completeRecapture(
  db: D1Database, job: ExtractionJob, result: { markdown: string; metadata: ExtractionMetadata }, now: string,
): Promise<boolean> {
  const revision = crypto.randomUUID();
  const fence = `j.article_id=? AND j.generation=? AND j.state='running'
    AND j.lease_token=? AND j.lease_expires_at>?`;
  const fenceValues = [job.articleId, job.generation, job.leaseToken, now];
  const matches = `(SELECT revision FROM article_copies WHERE article_id=j.article_id) IS j.expected_revision
    AND (j.refresh_metadata=0 OR j.baseline_metadata=${metadataSnapshot('a')})`;
  const eligible = `EXISTS (SELECT 1 FROM article_extraction_jobs j JOIN articles a ON a.id=j.article_id
    WHERE ${fence} AND ${matches})`;
  const written = `EXISTS (SELECT 1 FROM article_copies WHERE article_id=? AND revision=?)`;
  const conflict = db.prepare(`UPDATE article_extraction_jobs AS j SET
      state='failed',error_code=CASE WHEN (SELECT revision FROM article_copies WHERE article_id=j.article_id)
        IS NOT j.expected_revision THEN 'copy_changed' ELSE 'metadata_changed' END,
      lease_token=NULL,lease_expires_at=NULL,finished_at=?,updated_at=?
    WHERE ${fence} AND EXISTS (SELECT 1 FROM articles a WHERE a.id=j.article_id AND NOT (${matches}))`)
    .bind(now, now, ...fenceValues);
  const clearSnapshot = db.prepare(`DELETE FROM article_capture_recovery WHERE article_id=? AND ${eligible}`)
    .bind(job.articleId, ...fenceValues);
  const snapshot = db.prepare(`INSERT INTO article_capture_recovery
      (article_id,markdown,captured_at,source,previous_metadata,resulting_revision)
    SELECT c.article_id,c.markdown,c.captured_at,c.source,
      CASE WHEN j.refresh_metadata=1 THEN ${metadataSnapshot('a')} ELSE NULL END,?
    FROM article_copies c JOIN articles a ON a.id=c.article_id
      JOIN article_extraction_jobs j ON j.article_id=a.id
    WHERE ${fence} AND ${matches}`).bind(revision, ...fenceValues);
  const copy = db.prepare(`INSERT INTO article_copies(article_id,markdown,captured_at,source,revision)
    SELECT ?,?,?,'paste',? WHERE ${eligible}
    ON CONFLICT(article_id) DO UPDATE SET markdown=excluded.markdown,captured_at=excluded.captured_at,
      source=excluded.source,revision=excluded.revision`)
    .bind(job.articleId, result.markdown, now, revision, ...fenceValues);
  const title = result.metadata.title?.trim() || null;
  const author = result.metadata.author?.trim() || null;
  const description = result.metadata.description?.trim() || null;
  const metadata = db.prepare(`UPDATE articles SET title=COALESCE(?,title),
      title_origin=CASE WHEN ? IS NOT NULL THEN 'extracted' ELSE title_origin END,
      author=COALESCE(?,author),description=COALESCE(?,description),updated_at=?
    WHERE id=? AND ${written}
      AND EXISTS (SELECT 1 FROM article_extraction_jobs WHERE article_id=? AND refresh_metadata=1)`)
    .bind(title, title, author, description, now, job.articleId, job.articleId, revision, job.articleId);
  const finalSnapshot = db.prepare(`UPDATE article_capture_recovery SET resulting_metadata=
      (SELECT ${metadataSnapshot('a')} FROM articles a WHERE a.id=?)
    WHERE article_id=? AND resulting_revision=? AND ${written}`)
    .bind(job.articleId, job.articleId, revision, job.articleId, revision);
  const finish = db.prepare(`UPDATE article_extraction_jobs AS j SET state='succeeded',error_code=NULL,
      lease_token=NULL,lease_expires_at=NULL,finished_at=?,updated_at=? WHERE ${fence} AND ${written}`)
    .bind(now, now, ...fenceValues, job.articleId, revision);
  const results = await db.batch([conflict, clearSnapshot, snapshot, copy, metadata, finalSnapshot, finish]);
  return results[6].meta.changes > 0;
}
