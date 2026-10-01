import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { deleteArticle, listArticles, saveArticle, updateArticle } from "../src/articles/repository";

async function clearArticles() {
  await env.DB.prepare("DELETE FROM articles").run();
}

describe("D1 article repository", () => {
  beforeEach(clearArticles);

  it("resolves concurrent duplicate saves to one row without changing its state", async () => {
    const [first, second] = await Promise.all([
      saveArticle(env.DB, { url: "https://example.com/a", normalizedUrl: "https://example.com/a", title: "First" }),
      saveArticle(env.DB, { url: "https://example.com/a?utm_source=x", normalizedUrl: "https://example.com/a", title: "Later" }),
    ]);
    expect([first.duplicate, second.duplicate].sort()).toEqual([false, true]);
    expect(first.article.id).toBe(second.article.id);
    expect(first.article.createdAt).toBe(second.article.createdAt);
    expect(first.article.title).toBe("First");
    const count = await env.DB.prepare("SELECT count(*) AS count FROM articles").first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("fills missing preview metadata on duplicate saves without replacing a custom title", async () => {
    const url = "https://example.com/article";
    const first = await saveArticle(env.DB, {
      url,
      normalizedUrl: url,
      title: "My title",
    });
    await updateArticle(env.DB, first.article.id, { read: true }, "2026-09-30T10:00:00.000Z");
    const refreshed = await saveArticle(env.DB, {
      url,
      normalizedUrl: url,
      title: "Page title",
      fallbackTitle: "example.com/article",
      author: "Alex Writer",
      description: "A short lead.",
    });
    expect(refreshed.duplicate).toBe(true);
    expect(refreshed.metadataUpdated).toBe(true);
    expect(refreshed.article).toMatchObject({
      id: first.article.id,
      title: "My title",
      author: "Alex Writer",
      description: "A short lead.",
      readAt: "2026-09-30T10:00:00.000Z",
    });
  });

  it("replaces a URL fallback title when a duplicate save finds page metadata", async () => {
    const url = "https://example.com/article";
    const first = await saveArticle(env.DB, {
      url,
      normalizedUrl: url,
      title: "example.com/article",
    });
    await updateArticle(env.DB, first.article.id, { read: true }, "2026-09-30T10:00:00.000Z");
    const refreshed = await saveArticle(env.DB, {
      url,
      normalizedUrl: url,
      title: "A proper page title",
      fallbackTitle: "example.com/article",
      author: "Alex Writer",
      description: "A short lead.",
    });
    expect(refreshed.metadataUpdated).toBe(true);
    expect(refreshed.article).toMatchObject({
      title: "A proper page title",
      author: "Alex Writer",
      description: "A short lead.",
      readAt: "2026-09-30T10:00:00.000Z",
    });
  });

  it("keeps the first read timestamp, clears it on unread and updates only effective changes", async () => {
    const { article } = await saveArticle(env.DB, { url: "https://example.com/", normalizedUrl: "https://example.com/" });
    const firstRead = await updateArticle(env.DB, article.id, { read: true }, "2026-09-30T10:00:00.000Z");
    const repeatedRead = await updateArticle(env.DB, article.id, { read: true }, "2026-09-30T11:00:00.000Z");
    expect(repeatedRead?.readAt).toBe("2026-09-30T10:00:00.000Z");
    expect(repeatedRead?.updatedAt).toBe(firstRead?.updatedAt);
    const unread = await updateArticle(env.DB, article.id, { read: false }, "2026-09-30T12:00:00.000Z");
    expect(unread?.readAt).toBeNull();
    expect(unread?.updatedAt).toBe("2026-09-30T12:00:00.000Z");
  });

  it("paginates tied timestamps without skips, escapes wildcard search and uses intended indexes", async () => {
    const sameTime = "2026-09-30T10:00:00.000Z";
    for (const id of ["b", "a", "c"]) {
      await env.DB.prepare("INSERT INTO articles(id,url,normalized_url,title,created_at,updated_at,read_at) VALUES(?,?,?,?,?,?,NULL)")
        .bind(id, `https://example.com/${id}`, `https://example.com/${id}`, `100% literal`, sameTime, sameTime).run();
    }
    const p1 = await listArticles(env.DB, { status: "all", limit: 2 });
    const p2 = await listArticles(env.DB, { status: "all", limit: 2, cursor: p1.nextCursor! });
    expect([...p1.items, ...p2.items].map((item) => item.id)).toEqual(["c", "b", "a"]);
    expect((await listArticles(env.DB, { status: "all", q: "%", limit: 10 })).items).toHaveLength(3);
    expect((await listArticles(env.DB, { status: "all", q: "_", limit: 10 })).items).toHaveLength(0);
    const plan = await env.DB.prepare("EXPLAIN QUERY PLAN SELECT id FROM articles WHERE read_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 51").all<{ detail: string }>();
    expect(plan.results?.some((row) => row.detail.includes("articles_read_created"))).toBe(true);
  });

  it("applies simultaneous read and title changes atomically and accepts idempotent delete", async () => {
    const { article } = await saveArticle(env.DB, { url: "https://example.com/", normalizedUrl: "https://example.com/" });
    const results = await Promise.all([
      updateArticle(env.DB, article.id, { read: true }, "2026-09-30T10:00:00.000Z"),
      updateArticle(env.DB, article.id, { title: "Changed" }, "2026-09-30T10:01:00.000Z"),
    ]);
    expect(results.some((item) => item?.readAt !== null)).toBe(true);
    expect(results.some((item) => item?.title === "Changed")).toBe(true);
    expect(await deleteArticle(env.DB, article.id)).toBe(true);
    expect(await deleteArticle(env.DB, article.id)).toBe(false);
  });
});
