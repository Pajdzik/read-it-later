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
const copy = { markdown: "# Podcast UI Smoke\n\nA private audio test.", capturedAt: new Date().toISOString(), source: "paste", revision: "rev_123" };
let audio = { enabled: true, state: "none", episodeId: null, sourceRevision: null, characters: 1200, estimatedDurationSeconds: 390, estimatedCostUsd: 0.012, errorCode: null, suitability: article.podcastFit };
let postedAudio = [];
let tokenCreated = false;
let audioEnabled = true;
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
    else if (url.pathname === "/api/articles" && method === "GET") payload = { items: [article, codeArticle], nextCursor: null };
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
  console.log("Podcast UI smoke passed: explicit preparation, revision binding, reader behavior, and one-time feed URL.");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
