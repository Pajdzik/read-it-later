import { isArticleId } from './identity';
import { normalizeTags } from './validation';

/** Shared structural checks for current JSON v3 portable article records.
 * URL normalization and API/offline limits remain at their call sites.
 */
export type PortableCopy = { markdown: string; capturedAt: string; source: 'paste' | 'upload'; revision: string };
export type PortableArticle = {
  id: string; url: string; title: string; author?: string | null; description?: string | null;
  tags?: string[]; descriptionOrigin?: 'manual' | 'extracted' | 'generated' | null; tagsManuallyEdited?: boolean;
  createdAt: string; updatedAt: string; readAt: string | null; copy?: PortableCopy;
};
export const isPortableShortId = isArticleId;
export function isPortableTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
/** Throws stable field codes; consumers translate these to their own error/report format. */
export function validatePortableArticle(value: unknown): asserts value is PortableArticle {
  if (!object(value)) throw new Error('article');
  const item = value;
  const allowed = ['id','url','title','author','description','tags','descriptionOrigin','tagsManuallyEdited','createdAt','updatedAt','readAt','copy'];
  if (Object.keys(item).some(key => !allowed.includes(key))) throw new Error('article');
  if (['id','url','title','createdAt','updatedAt','readAt'].some(key => !Object.hasOwn(item, key))) throw new Error('article');
  if (!isArticleId(item.id)) throw new Error('id');
  if (typeof item.url !== 'string' || !item.url || new TextEncoder().encode(item.url).byteLength > 8192) throw new Error('url');
  if (typeof item.title !== 'string' || !item.title.trim() || item.title.trim().length > 500) throw new Error('title');
  if (!isPortableTimestamp(item.createdAt) || !isPortableTimestamp(item.updatedAt) || !(item.readAt === null || isPortableTimestamp(item.readAt))) throw new Error('timestamp');
  if (!(item.author === undefined || item.author === null || (typeof item.author === 'string' && !!item.author.trim() && item.author.length <= 200))) throw new Error('author');
  if (!(item.description === undefined || item.description === null || (typeof item.description === 'string' && !!item.description.trim() && item.description.length <= 500))) throw new Error('description');
  if (item.tags !== undefined) {
    try { normalizeTags(item.tags); } catch { throw new Error('tags'); }
  }
  const description = typeof item.description === 'string' ? item.description : null;
  const descriptionOrigin = item.descriptionOrigin;
  if (descriptionOrigin !== undefined && ![null, 'manual', 'extracted', 'generated'].includes(descriptionOrigin as string | null)) throw new Error('descriptionOrigin');
  if (descriptionOrigin !== undefined && ((description && descriptionOrigin === null) || (!description && descriptionOrigin && descriptionOrigin !== 'manual') ||
    (descriptionOrigin === 'generated' && description && [...description].length > 280))) throw new Error('descriptionOrigin');
  if (item.tagsManuallyEdited !== undefined && typeof item.tagsManuallyEdited !== 'boolean') throw new Error('tagsManuallyEdited');
  if (item.copy !== undefined) {
    if (!object(item.copy)) throw new Error('copy');
    const copy = item.copy;
    if (Object.keys(copy).some(key => !['markdown','capturedAt','source','revision'].includes(key)) ||
      ['markdown','capturedAt','source','revision'].some(key => !Object.hasOwn(copy, key))) throw new Error('copy');
    if (typeof copy.markdown !== 'string' || !copy.markdown.trim() || !isPortableTimestamp(copy.capturedAt) ||
      (copy.source !== 'paste' && copy.source !== 'upload') || typeof copy.revision !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(copy.revision)) throw new Error('copy');
    const bytes = new TextEncoder().encode(copy.markdown);
    if (bytes.byteLength > 262144 || new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== copy.markdown) throw new Error('copy');
  }
}
