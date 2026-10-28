import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { expect } from "playwright/test";

export async function checkReadingSuggestion(browser, base) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const articles = [
    { id: "suggest1", title: "The quiet pleasure of reading something unexpected", url: "https://example.com/reading", author: "Alex Morgan" },
    { id: "suggest2", title: "Making room for curiosity", url: "https://journal.example.com/curiosity", author: null },
  ].map((article) => ({ ...article, description: "A little space for a new idea.", readAt: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", hasCopy: true }));
  let authenticated = true, failSuggestion = false, suggestionRequests = 0, releaseSuggestion;
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === "/api/session") return json(route, { authenticated, csrfToken: "smoke" });
    if (url.pathname === "/api/articles/suggestion") {
      suggestionRequests++;
      if (releaseSuggestion) await new Promise((resolve) => { releaseSuggestion = resolve; });
      if (failSuggestion) return json(route, { error: { message: "Suggestion unavailable" } }, 503);
      const unread = articles.filter((article) => !article.readAt);
      return json(route, { article: unread.find((article) => article.id !== url.searchParams.get("exclude")) || unread[0] || null, hasAlternative: unread.length > 1 });
    }
    if (url.pathname === "/api/articles") {
      const status = url.searchParams.get("status"), query = url.searchParams.get("q") || "";
      return json(route, { items: articles.filter((article) => (status === "all" || Boolean(article.readAt) === (status === "read")) && article.title.includes(query)), nextCursor: null });
    }
    const article = articles.find((item) => url.pathname === `/api/articles/${item.id}` || url.pathname === `/api/articles/${item.id}/copy`);
    if (article) {
      if (request.method() === "PATCH") {
        const { read } = request.postDataJSON();
        article.readAt = read ? "2026-10-27T00:00:00.000Z" : null;
      }
      if (request.method() === "DELETE") {
        articles.splice(articles.indexOf(article), 1);
        return route.fulfill({ status: 204 });
      }
      return json(route, url.pathname.endsWith("/copy")
        ? { copy: { markdown: `# ${article.title}\n\nA saved article to enjoy.`, capturedAt: article.createdAt, source: "paste", revision: "smoke-revision" } }
        : { article });
    }
    if (url.pathname === "/api/github") return json(route, { github: { configured: false } });
    return json(route, { error: { message: "Not found" } }, 404);
  });
  try {
    await page.goto(base);
    const card = page.locator("#last-opened"), title = card.locator("#last-opened-title");
    await expect(card).toHaveAttribute("aria-label", "Picked for you");
    await expect(title).toHaveText(articles[0].title);
    assert.equal(await page.evaluate(() => localStorage.getItem("potem-last-opened-v1")), null, "A suggestion must not start reading.");
    await card.getByRole("button", { name: "Try another" }).click();
    await expect(title).toHaveText(articles[1].title);
    const requestsBeforeBrowsing = suggestionRequests;
    await page.getByRole("button", { name: "Read", exact: true }).click();
    await expect(page.locator("#empty")).toBeVisible();
    await expect(title).toHaveText(articles[1].title);
    await page.getByRole("button", { name: "All", exact: true }).click();
    await page.locator("#search-toggle").click();
    await page.locator("#search").fill("no matches");
    await expect(page.locator("#empty")).toBeVisible();
    await expect(title).toHaveText(articles[1].title);
    assert.equal(suggestionRequests, requestsBeforeBrowsing, "List filters must not shuffle the suggestion.");
    await page.locator("#search").fill("");
    await page.locator("#search").press("Escape");
    await expect(page.locator(".article")).toHaveCount(2);
    await page.screenshot({ path: path.join(os.tmpdir(), "potem-reading-suggestion-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const bounds = await card.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390, "Suggestion must fit on a phone.");
    await page.screenshot({ path: path.join(os.tmpdir(), "potem-reading-suggestion-mobile.png") });
    await title.click();
    await expect(page.locator("#reader-title")).toHaveText(articles[1].title);
    await page.getByRole("button", { name: "Close saved copy" }).click();
    await expect(card).toHaveAttribute("aria-label", "Last opened");
    await expect(card.getByRole("button", { name: "Try another" })).toBeHidden();
    await page.reload();
    await expect(title).toHaveText(articles[1].title);
    await expect(card).toHaveAttribute("aria-label", "Last opened");
    await page.locator(`.article[data-id="${articles[1].id}"]`).getByRole("button", { name: "Mark read", exact: true }).click();
    await expect(card).toHaveAttribute("aria-label", "Picked for you");
    await expect(title).toHaveText(articles[0].title);
    await expect(card.getByRole("button", { name: "Try another" })).toBeHidden();
    // A completed last-opened article also falls back correctly after a reload.
    failSuggestion = true;
    await page.reload();
    await expect(card.getByText("Couldn’t pick an article. Try again.")).toBeVisible();
    failSuggestion = false;
    await card.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(title).toHaveText(articles[0].title);
    await page.locator(`.article[data-id="${articles[0].id}"]`).getByRole("button", { name: "Edit", exact: true }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete article", exact: true }).click();
    await expect(card).toBeHidden();
    // A stale last-opened reference must not block the suggestion fallback.
    articles[0].readAt = null;
    await page.evaluate(() => localStorage.setItem("potem-last-opened-v1", JSON.stringify({ version: 1, articleId: "missing1", openedAt: new Date().toISOString() })));
    await page.reload();
    await expect(title).toHaveText(articles[0].title);
    assert.equal(await page.evaluate(() => localStorage.getItem("potem-last-opened-v1")), null);
    // A late suggestion must not replace a newly opened article.
    await page.evaluate(() => localStorage.removeItem("potem-last-opened-v1"));
    releaseSuggestion = true;
    await page.reload();
    await expect(card.getByText("Picking something from your unread articles…")).toBeVisible();
    await page.locator(".article .article-title").click();
    await expect(page.locator("#reader-title")).toHaveText(articles[0].title);
    const lateResponse = page.waitForResponse((response) => response.url().includes("/api/articles/suggestion"));
    releaseSuggestion();
    releaseSuggestion = null;
    await (await lateResponse).finished();
    await page.getByRole("button", { name: "Close saved copy" }).click();
    await expect(card).toHaveAttribute("aria-label", "Last opened");
    authenticated = false;
    await page.reload();
    await expect(page.locator("#library-sign-in")).toBeVisible();
    await expect(card).toBeHidden();
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}
