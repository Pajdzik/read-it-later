import type { Article } from '../contracts';
import { ValidationError } from './validation';

export function normalizeTags(value: unknown, maximum = 10): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new ValidationError(`tags must be an array of at most ${maximum} tags`);
  const tags = value.map(tag => {
    if (typeof tag !== 'string' || /[\p{Cc}\p{Cs}<>]/u.test(tag)) throw new ValidationError('tags must contain plain text');
    const normalized = tag.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
    if (!normalized || [...normalized].length > 40) throw new ValidationError('each tag must contain 1–40 characters');
    return normalized;
  });
  return [...new Set(tags)].sort();
}

/** A fixed number of queries for the whole page, rather than one per article. */
export async function hydrateTags(db: D1Database, articles: Article[]): Promise<Article[]> {
  if (!articles.length) return articles;
  const rows = await db.prepare(`SELECT article_id,tag FROM article_tags WHERE article_id IN (${articles.map(() => '?').join(',')}) ORDER BY tag`)
    .bind(...articles.map(a => a.id)).all<{ article_id: string; tag: string }>();
  const tags = new Map<string, string[]>();
  for (const row of rows.results) {
    const list = tags.get(row.article_id) ?? [];
    list.push(row.tag); tags.set(row.article_id, list);
  }
  return articles.map(a => ({ ...a, tags: tags.get(a.id) ?? [] }));
}

export async function listTags(db: D1Database): Promise<Array<{ tag: string; count: number }>> {
  const rows = await db.prepare('SELECT tag,COUNT(*) AS count FROM article_tags GROUP BY tag ORDER BY tag').all<{ tag: string; count: number }>();
  return rows.results;
}
