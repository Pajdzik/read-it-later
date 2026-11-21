import { chromium } from "playwright";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const webRoot = path.resolve("dist/web");
const server = createServer(async (request, response) => {
  const requested = new URL(request.url, "http://localhost").pathname;
  const relative = requested === "/" ? "index.html" : requested.slice(1);
  const file = path.join(webRoot, relative);
  try {
    const resolved = await stat(file);
    if (!resolved.isFile() || !file.startsWith(webRoot)) throw new Error("not found");
    const mime = file.endsWith(".html") ? "text/html" : file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "application/octet-stream";
    response.writeHead(200, { "Content-Type": mime });
    response.end(await readFile(file));
  } catch {
    response.writeHead(404); response.end("Not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
async function openSettingsDisclosure(page, selector) {
  const disclosure = page.locator(selector);
  if (!(await disclosure.evaluate((el) => el.open))) await disclosure.locator("summary").click();
}
const article = { id: "abc12345", url: "https://example.com/story", title: "Podcast UI Smoke", author: "Reader", description: "An English article.", tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), readAt: null, hasCopy: true, podcastFit: { tier: "good", reason: "Mostly prose with no code blocks.", spokenWords: 250, codeBlocks: 0, codeSharePercent: 0 }, extraction: { state: "ready", attempts: 1, errorCode: null, nextAttemptAt: null, paused: false } };
const codeArticle = { ...article, id: "bad23456", title: "Code-heavy article", podcastFit: { tier: "poor", reason: "Code makes up about 72% of the copy, and is skipped in narration.", spokenWords: 80, codeBlocks: 5, codeSharePercent: 72 } };
const feedSources = [
  { id: "field", url: "https://field.example/rss.xml", title: "Field Notes", lastFetchedAt: article.createdAt, lastError: null },
  { id: "journal", url: "https://journal.example/atom.xml", title: `Small Web Journal ${"Journal".repeat(20)}`, lastFetchedAt: article.createdAt, lastError: "Feed unavailable" },
];
const feedItems = [
  { id: "walk", feedId: "field", url: "https://field.example/walking", title: "Walking the same route", preview: "What changes when the streets stay the same.", publishedAt: article.createdAt, seen: false, saved: false },
  { id: "site", feedId: "journal", url: "https://journal.example/site", title: "A small personal site", preview: "Notes on keeping a website.", publishedAt: article.createdAt, seen: false, saved: false },
];
const savedArticles = [article, codeArticle];
const copy = { markdown: "# Podcast UI Smoke\n\nA private audio test.", capturedAt: new Date().toISOString(), source: "paste", revision: "rev_123" };
let audio = { enabled: true, state: "none", episodeId: null, sourceRevision: null, characters: 1200, estimatedDurationSeconds: 390, estimatedCostUsd: 0.012, errorCode: null, suitability: article.podcastFit };
let postedAudio = [];
let tokenCreated = false;
let audioEnabled = true;
let failFeedRemoval = true;
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const apiCalls = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request(); const url = new URL(request.url()); const method = request.method();
    apiCalls.push({ path: url.pathname, method, body: request.postDataJSON() });
    let payload = {};
    if (url.pathname === "/api/session") payload = { authenticated: true, csrfToken: "smoke", audioEnabled: true };
    else if (url.pathname === "/api/capture-tokens") payload = { items: [] };
    else if (url.pathname === "/api/articles" && method === "GET") payload = { items: savedArticles, nextCursor: null };
    else if (url.pathname === "/api/articles" && method === "POST") {
      const item = feedItems.find((candidate) => candidate.url === request.postDataJSON().url);
      assert.ok(item, "The feed Save action must use the selected article URL.");
      item.saved = true;
      const saved = { ...article, id: "walk1234", url: item.url, title: item.title, hasCopy: false, podcastFit: null };
      savedArticles.unshift(saved);
      payload = { article: saved, duplicate: false };
    }
    else if (url.pathname === "/api/feeds" && method === "GET") payload = { feeds: feedSources };
    else if (url.pathname === "/api/feeds" && method === "POST") {
      const added = { id: "new-feed", url: request.postDataJSON().url, title: "New journal", lastFetchedAt: article.createdAt, lastError: null };
      feedSources.push(added);
      payload = { feed: added };
    }
    else if (url.pathname.startsWith("/api/feeds/") && method === "DELETE") {
      if (failFeedRemoval) {
        failFeedRemoval = false;
        await route.fulfill({ status: 503, json: { error: { message: "Try again shortly." } } });
        return;
      }
      const index = feedSources.findIndex((source) => source.id === url.pathname.split("/").at(-1));
      assert.ok(index >= 0);
      feedSources.splice(index, 1);
      payload = { ok: true };
    }
    else if (url.pathname === "/api/feeds/items") {
      const source = url.searchParams.get("feedId");
      const status = url.searchParams.get("status");
      payload = { items: feedItems.filter((item) => (!source || item.feedId === source) && (status === "all" || !item.seen)), nextCursor: null };
    }
    else if (url.pathname.startsWith("/api/feeds/items/") && method === "PATCH") {
      const item = feedItems.find((candidate) => candidate.id === url.pathname.split("/").at(-1));
      assert.ok(item);
      item.seen = request.postDataJSON().seen;
      payload = { ok: true };
    }
    else if (url.pathname === `/api/articles/${article.id}` && method === "GET") payload = { article };
    else if (url.pathname === `/api/articles/${article.id}/copy` && method === "GET") payload = { copy };
    else if (url.pathname === `/api/articles/${article.id}/audio` && method === "GET") payload = { audio };
    else if (url.pathname === `/api/articles/${article.id}/audio` && method === "POST") {
      postedAudio.push(request.postDataJSON()); audio = { ...audio, state: "queued", episodeId: "episode-1", sourceRevision: copy.revision, suitability: article.podcastFit };
      payload = { audio };
    } else if (url.pathname === "/api/podcast/settings") payload = { enabled: audioEnabled, token: tokenCreated ? { createdAt: new Date().toISOString() } : null, readyEpisodes: 1, usage: { month: "2026-11", usedCharacters: 1200, reservedCharacters: 0, freeCharacters: 5000, budgetUsd: 5, estimatedCostUsd: 0.01 } };
    else if (url.pathname === "/api/podcast/token" && method === "POST") { tokenCreated = true; payload = { feedUrl: "https://potem.test/api/podcast/feed.xml?token=pod_" + "x".repeat(43), createdAt: new Date().toISOString() }; }
    await route.fulfill({ status: method === "POST" && url.pathname === `/api/articles/${article.id}/audio` ? 202 : 200, contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.goto(base);
  await page.getByRole("link", { name: article.title, exact: true }).waitFor();
  await page.getByRole("button", { name: "Podcast picks" }).click();
  const row = page.locator(`.article[data-id="${article.id}"]`);
  await row.waitFor();
  assert.equal(await page.locator(`.article[data-id="${codeArticle.id}"]`).count(), 0, "Podcast picks should exclude code-heavy articles.");
  const fitIcon = row.locator(".podcast-fit-icon-button");
  assert.equal((await fitIcon.textContent()).trim(), "", "The library fit indicator should be icon-only.");
  const moreButton = row.getByRole("button", { name: "More actions" });
  await moreButton.click();
  assert.equal(apiCalls.filter((call) => call.path.endsWith("/audio")).length, 0, "Opening More must not request audio or start generation.");
  await moreButton.click();
  await fitIcon.click();
  await page.locator("#podcast-dialog").waitFor({ state: "visible" });
  const podcastEstimate = page.locator("#podcast-estimate");
  await podcastEstimate.getByText(/About 7 min/).waitFor();
  assert.equal((await podcastEstimate.textContent()).includes("before free allowance"), false, "The estimate should show cost without allowance copy.");
  assert.match(await podcastEstimate.textContent(), /\$0\.012/, "The estimate should include the cost.");
  const modalFitIcon = page.locator("#podcast-fit-icon");
  assert.equal((await modalFitIcon.textContent()).trim(), "", "The modal fit indicator should be icon-only.");
  assert.equal(await modalFitIcon.getAttribute("aria-label"), "Good fit. Mostly prose with no code blocks.");
  assert.equal(await modalFitIcon.evaluate((el) => getComputedStyle(el.parentElement).display), "flex", "The fit icon should share the article title row.");
  await page.screenshot({ path: "/tmp/potem-podcast-more.png" });
  assert.equal(postedAudio.length, 0, "Showing the estimate must not prepare audio.");
  await page.locator("#podcast-dialog").getByRole("button", { name: "Prepare audio" }).click();
  await page.waitForFunction(() => document.querySelector("#podcast-status")?.textContent?.includes("Audio queued"));
  assert.equal(postedAudio.length, 1);
  assert.equal(postedAudio[0].expectedRevision, copy.revision, "Audio must use the saved copy revision.");

  await page.locator("#podcast-dialog").getByRole("button", { name: "Close podcast options" }).click();
  audio = { enabled: true, state: "none", episodeId: null, sourceRevision: null, characters: 1200, estimatedDurationSeconds: 390, estimatedCostUsd: 0.012, errorCode: null, suitability: article.podcastFit };
  await row.locator(".article-title").click();
  await page.locator("#reader-dialog").waitFor({ state: "visible" });
  const readerPodcastControl = page.locator("#reader-audio");
  const readerPodcastButton = readerPodcastControl.getByRole("button", { name: "Podcast options" });
  await readerPodcastButton.waitFor();
  assert.equal(await readerPodcastControl.evaluate((el) => el.parentElement?.classList.contains("reader-meta-row")), true, "The podcast launcher should sit beside the reader date metadata.");
  assert.equal(await readerPodcastControl.evaluate((el) => getComputedStyle(el.parentElement).display), "flex", "Reader metadata and podcast options should share a flex row.");
  assert.equal(await readerPodcastControl.locator(".audio-panel-inner").count(), 0, "The detail view should use a compact podcast launcher, not the old fit panel.");
  assert.equal(await readerPodcastControl.evaluate((el) => getComputedStyle(el).paddingTop), "0px", "The detail podcast launcher should not have panel padding.");
  await page.screenshot({ path: "/tmp/potem-podcast-reader.png" });
  assert.equal(postedAudio.length, 1, "Opening the reader must not generate audio.");
  assert.match(await readerPodcastButton.textContent(), /Podcast options/, "Reader podcast options should pair the icon with a text label.");
  await readerPodcastButton.click();
  await page.locator("#podcast-dialog").waitFor({ state: "visible" });
  await page.locator("#podcast-dialog").getByRole("button", { name: "Prepare audio" }).click();
  await page.waitForFunction(() => document.querySelector("#podcast-status")?.textContent?.includes("Audio queued"));
  assert.equal(postedAudio.length, 2, "Reader preparation starts only after an explicit button press.");

  await page.locator("#podcast-dialog").getByRole("button", { name: "Close podcast options" }).click();
  await page.locator("#reader-dialog").getByRole("button", { name: "Close saved copy" }).click();
  await page.getByRole("button", { name: "Unread", exact: true }).click();
  const widths = [320, 390, 620, 768, 1200];
  const libraryActionPositions = new Map();
  for (const width of widths) {
    await page.setViewportSize({ width, height: 844 });
    const [rowBounds, readBounds, moreBounds] = await Promise.all([
      row.boundingBox(), row.locator(".read-action").boundingBox(), moreButton.boundingBox(),
    ]);
    assert.ok(rowBounds && readBounds && moreBounds);
    libraryActionPositions.set(width, {
      top: readBounds.y - rowBounds.y,
      right: rowBounds.x + rowBounds.width - moreBounds.x - moreBounds.width,
    });
  }
  assert.equal(apiCalls.some((call) => call.path.startsWith("/api/feeds")), false, "Feeds should load when opened.");
  await page.getByRole("button", { name: "Feeds", exact: true }).click();
  const feedsView = page.locator("#feeds-view");
  const walk = feedsView.getByRole("link", { name: feedItems[0].title, exact: true });
  const site = feedsView.getByRole("link", { name: feedItems[1].title, exact: true });
  await walk.waitFor();
  await site.waitFor();
  assert.equal(await walk.getAttribute("href"), feedItems[0].url);
  assert.equal(await page.getByRole("button", { name: "Podcast picks" }).isVisible(), false, "Podcast picks belongs to the reading list.");
  await feedsView.locator("#feed-source").selectOption("field");
  await site.waitFor({ state: "hidden" });
  const walkRow = feedsView.locator('.feed-item[data-id="walk"]');
  const addToPotem = walkRow.getByRole("button", { name: "Add to Potem", exact: true });
  const skip = walkRow.getByRole("button", { name: "Skip", exact: true });
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    await page.locator(`html[data-theme="${colorScheme}"]`).waitFor();
    for (const width of widths) {
      await page.setViewportSize({ width, height: 844 });
      for (const title of [feedItems[0].title, "A longer feed title that wraps over several lines beside its actions", "Unbroken".repeat(30)]) {
        await walkRow.locator(".article-title").evaluate((element, text) => { element.textContent = text; }, title);
        const [rowBounds, titleBounds, addBounds, skipBounds] = await Promise.all([
          walkRow.boundingBox(), walkRow.locator(".article-title").boundingBox(), addToPotem.boundingBox(), skip.boundingBox(),
        ]);
        assert.ok(rowBounds && titleBounds && addBounds && skipBounds);
        for (const bounds of [addBounds, skipBounds]) {
          assert.equal(bounds.width, 44, "Feed actions must be 44px wide.");
          assert.equal(bounds.height, 44, "Feed actions must be 44px tall.");
          assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, "Feed actions must fit inside the viewport.");
        }
        assert.equal(addBounds.y, skipBounds.y, "Feed actions must share a row.");
        assert.equal(addBounds.y, titleBounds.y, "Feed actions must align with the top of the title.");
        assert.ok(titleBounds.x + titleBounds.width <= addBounds.x - 8, "Feed titles must wrap before the actions.");
        assert.ok(skipBounds.x - (addBounds.x + addBounds.width) >= 8, "Add to Potem must sit to the left of Skip with at least 8px between them.");
        assert.deepEqual({
          top: addBounds.y - rowBounds.y,
          right: rowBounds.x + rowBounds.width - skipBounds.x - skipBounds.width,
        }, libraryActionPositions.get(width), "Feed actions must match the reading list's top and right insets.");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "Feed titles and actions must fit the viewport.");
      }
    }
  }
  await walkRow.locator(".article-title").evaluate((element, title) => { element.textContent = title; }, feedItems[0].title);
  await page.screenshot({ path: "/tmp/potem-feed-actions-desktop.png" });
  for (const button of [addToPotem, skip]) {
    assert.equal(await button.evaluate(el => getComputedStyle(el).borderRadius), "50%", "Feed actions must be circular.");
    assert.equal(await button.textContent(), "", "Feed actions must be icon-only.");
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/tmp/potem-feed-actions-mobile.png" });
  await addToPotem.click();
  const added = walkRow.getByRole("button", { name: "Added to Potem", exact: true });
  await added.waitFor();
  assert.equal(await added.isDisabled(), true);
  assert.equal(apiCalls.find((call) => call.path === "/api/articles" && call.method === "POST").body.captureMarkdown, true);
  await skip.click();
  await walk.waitFor({ state: "hidden" });
  await feedsView.getByRole("button", { name: `Undo skipping ${feedItems[0].title}` }).click();
  await walk.waitFor();
  assert.equal(feedItems[0].seen, false, "Undo should restore the item on the server.");
  await skip.click();
  await walk.waitFor({ state: "hidden" });
  await feedsView.getByRole("button", { name: "All", exact: true }).click();
  await walkRow.getByRole("button", { name: "Mark as unread", exact: true }).click();
  await skip.waitFor();
  assert.equal(feedItems[0].seen, false, "Mark as unread should restore the item on the server.");
  await feedsView.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("button", { name: "Add feed" }).click();
  await feedsView.getByRole("textbox", { name: "RSS or Atom feed URL" }).fill("https://journal.example/new.xml");
  await feedsView.locator("#feed-add-form").getByRole("button", { name: "Add feed" }).click();
  await feedsView.getByText("Feed added.", { exact: true }).waitFor();
  const manage = feedsView.getByRole("button", { name: "Manage feeds" });
  const manageDialog = page.getByRole("dialog", { name: "Manage feeds" });
  const closeManage = manageDialog.getByRole("button", { name: "Close", exact: true });
  await manage.focus();
  await page.keyboard.press("Enter");
  await closeManage.waitFor();
  assert.equal(await closeManage.evaluate((el) => el === document.activeElement), true);
  assert.equal(await manageDialog.evaluate((el) => el.matches(":modal")), true);
  await page.keyboard.press("Tab");
  const removeField = manageDialog.getByRole("button", { name: "Remove Field Notes" });
  await page.locator("#reading-tab").evaluate((el) => el.focus());
  assert.equal(await removeField.evaluate((el) => el === document.activeElement), true, "Background controls must be inert while managing feeds.");
  await page.keyboard.press("Escape");
  await manageDialog.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.id === "feed-manage-open");

  await manage.click();
  const subscriptions = manageDialog.getByRole("list", { name: "Subscribed feeds" });
  await subscriptions.getByText("Couldn’t refresh", { exact: true }).waitFor();
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    await page.locator(`html[data-theme="${colorScheme}"]`).waitFor();
    for (const width of widths) {
      await page.setViewportSize({ width, height: 844 });
      const bounds = await manageDialog.boundingBox();
      assert.ok(bounds && bounds.x > 0 && bounds.x + bounds.width < width);
      assert.equal(await subscriptions.evaluate((el) => el.scrollWidth <= el.clientWidth), true, "Feed titles must wrap within the dialog.");
    }
  }
  await page.setViewportSize({ width: 320, height: 230 });
  assert.equal(await subscriptions.evaluate((el) => el.scrollHeight > el.clientHeight), true, "Long subscription lists must scroll within the dialog.");
  await subscriptions.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await closeManage.click();
  await manageDialog.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.id === "feed-manage-open");

  await page.setViewportSize({ width: 390, height: 844 });
  await feedsView.locator("#feed-source").selectOption("new-feed");
  await manage.click();
  const remove = manageDialog.getByRole("button", { name: "Remove New journal" });
  await remove.click();
  const removalError = manageDialog.getByRole("alert").getByText("Couldn’t remove feed. Try again shortly.");
  await removalError.waitFor();
  await remove.click();
  await remove.waitFor({ state: "hidden" });
  await removalError.waitFor({ state: "hidden" });
  assert.equal(await feedsView.locator("#feed-source").inputValue(), "", "Removing the selected feed should reset the filter.");
  await removeField.press("Enter");
  await removeField.waitFor({ state: "hidden" });
  const removeJournal = manageDialog.getByRole("button", { name: /^Remove Small Web Journal/ });
  assert.equal(await removeJournal.evaluate((el) => el === document.activeElement), true, "Focus should move to a remaining subscription.");
  await page.keyboard.press("Enter");
  await manageDialog.getByText("No subscribed feeds.", { exact: true }).waitFor();
  assert.equal(await closeManage.evaluate((el) => el === document.activeElement), true);
  await closeManage.click();
  await manageDialog.waitFor({ state: "hidden" });
  await manage.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.id === "add-open");
  await page.getByRole("button", { name: "Reading list", exact: true }).click();
  await page.getByRole("link", { name: feedItems[0].title, exact: true }).waitFor();
  await page.getByRole("button", { name: "Podcast picks" }).click();
  await fitIcon.click();
  await page.locator("#podcast-dialog").getByRole("button", { name: "Close podcast options" }).click();
  await page.locator("#settings-open").click();
  await openSettingsDisclosure(page, "#settings-private-podcast");
  await page.locator("#podcast-settings").getByRole("button", { name: "Create private feed" }).click();
  await page.locator("#podcast-settings").getByText(/token=pod_/).waitFor();
  await page.locator(".feed-url").evaluate((el) => el.scrollIntoView({ block: "center" }));
  assert.equal(await page.locator(".feed-url").evaluate((el) => el.scrollWidth <= el.clientWidth), true, "The private feed URL should wrap inside the Settings panel.");
  await page.screenshot({ path: "/tmp/potem-podcast-settings.png" });
  assert.equal(apiCalls.some((call) => call.path === "/api/podcast/token" && call.method === "POST"), true);
  audioEnabled = false;
  await page.locator("#settings-dialog").locator(".dialog-close button").click();
  await page.locator("#settings-open").click();
  await openSettingsDisclosure(page, "#settings-private-podcast");
  await page.locator("#podcast-settings").getByText(/New audio generation is paused/).waitFor();
  await page.locator("#podcast-settings").getByRole("button", { name: "Revoke feed" }).waitFor();
  console.log("Podcast and Feeds UI smoke passed: podcast options, responsive feed actions, subscription management, feed navigation and saving, read status, and private feed setup.");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
