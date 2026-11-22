import { MAX_FEED_DOCUMENT_ITEMS } from './source';

export const FEED_HISTORY = 500;
export const MAX_RETENTION_DAYS = 36500;
// Keep every item that could have been pruned since the last successful refresh.
const PRUNED_HISTORY = FEED_HISTORY + MAX_FEED_DOCUMENT_ITEMS;

export type FeedRetention = { retentionDays: number | null; retentionCount: number | null };

function expiryCutoff(now: string, days: string): string {
  return `strftime('%Y-%m-%dT%H:%M:%fZ', ${now}, '-' || ${days} || ' days')`;
}

function retainedItems(cutoff: string, count: string): string {
  return `SELECT id FROM feed_items WHERE feed_id = ?1 AND COALESCE(published_at > (${cutoff}), 1)
    ORDER BY published_at DESC, id DESC LIMIT COALESCE((${count}), ${FEED_HISTORY})`;
}

const TOTAL_ITEMS = '(SELECT COUNT(*) FROM feed_items WHERE feed_id = ?1)';
const REMOVAL_COUNT = `${TOTAL_ITEMS} - (SELECT COUNT(*) FROM (${retainedItems(expiryCutoff('?2', '?3'), '?4')}))`;

export function previewRetention(db: D1Database, feedId: string, now: string, limits: FeedRetention) {
  return db.prepare(`SELECT ${TOTAL_ITEMS} AS total, ${REMOVAL_COUNT} AS removed FROM feeds WHERE id = ?1`)
    .bind(feedId, now, limits.retentionDays, limits.retentionCount).first<{ total: number; removed: number }>();
}

export function updateRetention(db: D1Database, feedId: string, now: string, limits: FeedRetention, maxRemovals: number) {
  return db.prepare(`UPDATE feeds SET retention_days = ?3, retention_count = ?4
    WHERE id = ?1 AND ${REMOVAL_COUNT} <= ?5`)
    .bind(feedId, now, limits.retentionDays, limits.retentionCount, maxRemovals);
}

export function pruneFeedItems(db: D1Database, feedId: string, now: string, guardUpdate = false) {
  const cutoff = `SELECT ${expiryCutoff('?2', 'retention_days')} FROM feeds WHERE id = ?1`;
  const count = 'SELECT retention_count FROM feeds WHERE id = ?1';
  // For a settings change, the preceding update only succeeds if the confirmation still covers the removals.
  return db.prepare(`DELETE FROM feed_items WHERE feed_id = ?1 ${guardUpdate ? 'AND changes() = 1' : ''}
    AND id NOT IN (${retainedItems(cutoff, count)}) ${guardUpdate ? 'RETURNING id' : ''}`).bind(feedId, now);
}

export function trimPrunedHistory(db: D1Database, feedId: string) {
  return db.prepare(`DELETE FROM feed_item_history WHERE changes() > 0 AND feed_id = ?1 AND entry_key IN (
    SELECT entry_key FROM feed_item_history WHERE feed_id = ?1
    ORDER BY refresh_sequence DESC, entry_key DESC LIMIT -1 OFFSET ?2
  )`).bind(feedId, PRUNED_HISTORY);
}

export async function expireFeedItems(db: D1Database, now: string): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM feed_items WHERE id IN (
      SELECT i.id FROM feeds f JOIN feed_items i ON i.feed_id = f.id
      WHERE f.retention_days IS NOT NULL AND i.published_at <= ${expiryCutoff('?1', 'f.retention_days')}
    )`).bind(now),
    db.prepare(`DELETE FROM feed_item_history WHERE changes() > 0 AND (feed_id, entry_key) IN (
      SELECT feed_id, entry_key FROM (
        SELECT feed_id, entry_key, ROW_NUMBER() OVER (
          PARTITION BY feed_id ORDER BY refresh_sequence DESC, entry_key DESC
        ) AS position FROM feed_item_history
      ) WHERE position > ?1
    )`).bind(PRUNED_HISTORY),
  ]);
}
