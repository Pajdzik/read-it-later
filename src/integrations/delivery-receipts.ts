import type { D1Database } from '@cloudflare/workers-types';

export type DeliveryReceipt = { content_hash: string; delivered_at: string };

/** Read an integration receipt scoped to the consented destination identity. */
export function readDeliveryReceipt(db: D1Database, articleId: string, integrationId: string, destinationKey: string) {
  return db.prepare(`SELECT content_hash,delivered_at FROM article_integration_deliveries
    WHERE article_id = ? AND integration_id = ? AND destination_key = ?`)
    .bind(articleId, integrationId, destinationKey).first<DeliveryReceipt>();
}

/** Persist a receipt only while its article still exists. */
export async function writeDeliveryReceipt(db: D1Database, articleId: string, integrationId: string, destinationKey: string, contentHash: string, deliveredAt: string): Promise<void> {
  await db.prepare(`INSERT INTO article_integration_deliveries
    (article_id,integration_id,destination_key,content_hash,delivered_at)
    SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM articles WHERE id = ?)
    ON CONFLICT(article_id,integration_id,destination_key) DO UPDATE SET
      content_hash=excluded.content_hash,delivered_at=excluded.delivered_at`)
    .bind(articleId, integrationId, destinationKey, contentHash, deliveredAt, articleId).run();
}
