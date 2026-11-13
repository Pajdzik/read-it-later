import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteArticle, getArticle, listArticles, saveArticle, saveArticleCopy, updateArticle } from "../src/articles/repository";
import * as identity from "../src/articles/identity";

async function clearArticles() {
  await env.DB.prepare("DELETE FROM articles").run();
}

describe("D1 article repository", () => {
  beforeEach(clearArticles);
  afterEach(() => vi.restoreAllMocks());

  it("retries primary ID collisions without returning or changing the occupied article", async () => {
    const occupied = await saveArticle(env.DB, { url: "https://example.com/occupied", normalizedUrl: "https://example.com/occupied", title: "Keep me", titleOrigin: "supplied" });
    expect(occupied.article.id).toMatch(/^[a-z0-9]{8}$/);
    const allocation = vi.spyOn(identity, "newArticleId").mockReturnValueOnce(occupied.article.id).mockReturnValueOnce("fresh001");
    const saved = await saveArticle(env.DB, { url: "https://example.com/new", normalizedUrl: "https://example.com/new", title: "New article", titleOrigin: "supplied", extractionRequested: true });
    expect(allocation).toHaveBeenCalledTimes(2);
    expect(await env.DB.prepare("SELECT article_id FROM article_extraction_jobs").all()).toMatchObject({ results: [{ article_id: "fresh001" }] });
    expect(saved).toMatchObject({ duplicate: false, article: { id: "fresh001", title: "New article" } });
    expect(await env.DB.prepare("SELECT title FROM articles WHERE id = ?").bind(occupied.article.id).first()).toEqual({ title: "Keep me" });
  });

  it("bounds collision retries and leaves the library intact after exhaustion", async () => {
    const occupied = await saveArticle(env.DB, { url: "https://example.com/occupied", normalizedUrl: "https://example.com/occupied", title: "https://example.com/occupied", titleOrigin: "fallback" });
    const allocation = vi.spyOn(identity, "newArticleId").mockReturnValue(occupied.article.id);
    await expect(saveArticle(env.DB, { url: "https://example.com/new", normalizedUrl: "https://example.com/new", title: "https://example.com/new", titleOrigin: "fallback" })).rejects.toThrow("Could not allocate");
    expect(allocation).toHaveBeenCalledTimes(5);
    expect(await env.DB.prepare("SELECT count(*) AS count FROM articles").first()).toEqual({ count: 1 });
  });

  it("resolves concurrent duplicate saves to one row without changing its state", async () => {
    const [first, second] = await Promise.all([
      saveArticle(env.DB, { url: "https://example.com/a", normalizedUrl: "https://example.com/a", title: "First", titleOrigin: "supplied" }),
      saveArticle(env.DB, { url: "https://example.com/a?utm_source=x", normalizedUrl: "https://example.com/a", title: "Later", titleOrigin: "supplied" }),
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
      title: "My title", titleOrigin: "supplied",
    });
    await updateArticle(env.DB, first.article.id, { read: true }, "2026-09-30T10:00:00.000Z");
    const refreshed = await saveArticle(env.DB, {
      url,
      normalizedUrl: url,
      title: "Page title", titleOrigin: "supplied",
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

  it("preserves a fallback title on duplicate save while filling missing metadata", async () => {
    const url = "https://example.com/article";
    const first = await saveArticle(env.DB, {
      url,
      normalizedUrl: url,
      title: "example.com/article", titleOrigin: "fallback",
    });
    await updateArticle(env.DB, first.article.id, { read: true }, "2026-09-30T10:00:00.000Z");
    const refreshed = await saveArticle(env.DB, {
      url,
      normalizedUrl: url,
      title: "A proper page title", titleOrigin: "supplied",
      author: "Alex Writer",
      description: "A short lead.",
    });
    expect(refreshed.metadataUpdated).toBe(true);
    expect(refreshed.article).toMatchObject({
      title: "example.com/article",
      author: "Alex Writer",
      description: "A short lead.",
      readAt: "2026-09-30T10:00:00.000Z",
    });
  });

  it("adds one job to concurrent duplicate capture requests and preserves every existing job state", async () => {
    for (const state of ["queued", "running", "retry_wait", "succeeded", "failed"]) {
      const url = `https://example.com/jobs/${state}`;
      const input = { url, normalizedUrl: url, title: "Saved title", titleOrigin: "supplied" as const };
      const first = await saveArticle(env.DB, input);
      await Promise.all([saveArticle(env.DB, { ...input, extractionRequested: true }), saveArticle(env.DB, { ...input, extractionRequested: true })]);
      const jobs = await env.DB.prepare("SELECT article_id FROM article_extraction_jobs WHERE article_id=?").bind(first.article.id).all();
      expect(jobs.results).toHaveLength(1);
      await env.DB.prepare(`UPDATE article_extraction_jobs SET state=?,generation=7,attempts=2,
        lease_token=?,lease_expires_at=? WHERE article_id=?`)
        .bind(state, state === "running" ? "lease" : null, state === "running" ? "2030-01-01T00:00:00.000Z" : null, first.article.id).run();
      const before = await env.DB.prepare("SELECT * FROM article_extraction_jobs WHERE article_id=?").bind(first.article.id).first();
      await saveArticle(env.DB, { ...input, title: "Later title", extractionRequested: true });
      expect(await env.DB.prepare("SELECT * FROM article_extraction_jobs WHERE article_id=?").bind(first.article.id).first()).toEqual(before);
    }
  });

  it("preserves an existing copy without creating a capture job", async () => {
    const input = { url: "https://example.com/manual", normalizedUrl: "https://example.com/manual", title: "Manual", titleOrigin: "supplied" as const };
    const saved = await saveArticle(env.DB, input);
    await saveArticleCopy(env.DB, saved.article.id, { markdown: "Owner copy", capturedAt: "2026-01-01T00:00:00.000Z", source: "paste", revision: "owner-revision" }, null);
    await saveArticle(env.DB, { ...input, extractionRequested: true });
    expect(await env.DB.prepare("SELECT * FROM article_extraction_jobs WHERE article_id=?").bind(saved.article.id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT markdown,revision FROM article_copies WHERE article_id=?").bind(saved.article.id).first()).toEqual({ markdown: "Owner copy", revision: "owner-revision" });
  });

  it("keeps the first read timestamp, clears it on unread and updates only effective changes", async () => {
    const { article } = await saveArticle(env.DB, { url: "https://example.com/", normalizedUrl: "https://example.com/", title: "https://example.com/", titleOrigin: "fallback" });
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
    for (const id of ["bbbbbbbb", "aaaaaaaa", "cccccccc"]) {
      await env.DB.prepare("INSERT INTO articles(id,url,normalized_url,title,created_at,updated_at,read_at) VALUES(?,?,?,?,?,?,NULL)")
        .bind(id, `https://example.com/${id}`, `https://example.com/${id}`, `100% literal`, sameTime, sameTime).run();
    }
    const p1 = await listArticles(env.DB, { status: "all", limit: 2 });
    const p2 = await listArticles(env.DB, { status: "all", limit: 2, cursor: p1.nextCursor! });
    expect([...p1.items, ...p2.items].map((item) => item.id)).toEqual(["cccccccc", "bbbbbbbb", "aaaaaaaa"]);
    expect((await listArticles(env.DB, { status: "all", q: "%", limit: 10 })).items).toHaveLength(3);
    expect((await listArticles(env.DB, { status: "all", q: "_", limit: 10 })).items).toHaveLength(0);
    const plan = await env.DB.prepare("EXPLAIN QUERY PLAN SELECT id FROM articles WHERE read_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 51").all<{ detail: string }>();
    expect(plan.results?.some((row) => row.detail.includes("articles_read_created"))).toBe(true);
  });

  it("updates rating and favorites independently and filters favorites across read states", async () => {
    const first = await saveArticle(env.DB, { url: "https://example.com/fav-one", normalizedUrl: "https://example.com/fav-one", title: "Find me", titleOrigin: "supplied" });
    const second = await saveArticle(env.DB, { url: "https://example.com/fav-two", normalizedUrl: "https://example.com/fav-two", title: "Find me too", titleOrigin: "supplied" });
    await updateArticle(env.DB, first.article.id, { tags: ["later"] });
    await updateArticle(env.DB, second.article.id, { tags: ["later"] });
    await updateArticle(env.DB, first.article.id, { rating: "up", favorite: true });
    await updateArticle(env.DB, first.article.id, { read: true });
    await updateArticle(env.DB, second.article.id, { rating: "down", favorite: true });
    await updateArticle(env.DB, second.article.id, { rating: null });
    const page = await listArticles(env.DB, { status: "favorites", q: "Find me", limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeTruthy();
    const next = await listArticles(env.DB, { status: "favorites", q: "Find me", limit: 1, cursor: page.nextCursor! });
    expect(next.items).toHaveLength(1);
    expect(new Set([...page.items, ...next.items].map(a => a.id))).toEqual(new Set([first.article.id, second.article.id]));
    expect((await listArticles(env.DB, { status: "favorites", tag: "missing", limit: 10 })).items).toHaveLength(0);
    expect((await listArticles(env.DB, { status: "favorites", tag: "later", limit: 10 })).items).toHaveLength(2);
    expect((await listArticles(env.DB, { status: "favorites", limit: 10 })).items).toEqual(expect.arrayContaining([expect.objectContaining({ id: second.article.id, rating: null, favorite: true })]));
    const unchanged = await updateArticle(env.DB, first.article.id, { favorite: true }, "2099-01-01T00:00:00.000Z");
    expect(unchanged?.updatedAt).not.toBe("2099-01-01T00:00:00.000Z");
    expect((await getArticle(env.DB, first.article.id))?.readAt).not.toBeNull();
  });

  it("applies simultaneous read and title changes atomically and accepts idempotent delete", async () => {
    const { article } = await saveArticle(env.DB, { url: "https://example.com/", normalizedUrl: "https://example.com/", title: "https://example.com/", titleOrigin: "fallback" });
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
