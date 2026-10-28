import assert from "node:assert/strict";
import { expect } from "playwright/test";

export async function readerCompletionSmoke(context, base, sourceBase) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(base);
    await page.locator("#loading").waitFor({ state: "hidden" });
    const fixtures = await page.evaluate(async (source) => {
      const session = await (await fetch("/api/session")).json();
      const headers = { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken };
      const items = [];
      for (const suffix of ["first", "second"]) {
        const { article } = await (await fetch("/api/articles", {
          method: "POST", headers,
          body: JSON.stringify({ url: `${source}/completion-${suffix}`, title: `Completion smoke ${suffix}`, captureMarkdown: false }),
        })).json();
        const saved = await fetch(`/api/articles/${article.id}/copy`, {
          method: "PUT", headers,
          body: JSON.stringify({ markdown: Array.from({ length: 20 }, (_, i) => `Paragraph ${i + 1}. ${"Saved article text. ".repeat(20)}`).join("\n\n"), source: "paste", expectedRevision: null }),
        });
        if (!saved.ok) throw new Error("Couldn’t save the completion fixture.");
        items.push(article);
      }
      return items;
    }, sourceBase);
    const [first, second] = fixtures;
    await page.reload();
    await page.locator("#search-toggle").click();
    await page.locator("#search").fill("Completion smoke");
    const row = (id) => page.locator(`.article[data-id="${id}"]`);
    await expect(page.locator(".article")).toHaveCount(2);
    await row(first.id).getByRole("button", { name: "Edit", exact: true }).click();
    const detail = page.locator("#detail-dialog");
    const draft = "# Unsaved completion draft";
    await detail.getByRole("button", { name: "Read saved copy" }).waitFor();
    await detail.getByRole("textbox", { name: "Markdown copy" }).fill(draft);
    await detail.getByRole("button", { name: "Read saved copy" }).click();
    const reader = page.locator("#reader-dialog");
    const toggle = page.locator("#reader-read-toggle");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveText("Mark as read");
    await reader.evaluate((dialog) => { dialog.scrollTop = dialog.scrollHeight; });
    const footer = page.locator("#reader-completion");
    const metrics = await footer.evaluate((element) => ({
      top: element.getBoundingClientRect().top,
      left: element.getBoundingClientRect().left,
      bodyBottom: document.querySelector("#reader-body").getBoundingClientRect().bottom,
      bodyLeft: document.querySelector("#reader-body").getBoundingClientRect().left,
      height: element.querySelector("button").getBoundingClientRect().height,
    }));
    assert.ok(metrics.top >= metrics.bodyBottom + 23 && Math.abs(metrics.left - metrics.bodyLeft) < 1 && metrics.height >= 44,
      `Completion footer layout: ${JSON.stringify(metrics)}`);
    await page.screenshot({ path: "/tmp/potem-reader-completion-desktop.png" });
    let patchCount = 0;
    let fail = true;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await page.route(`**/api/articles/${first.id}`, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      patchCount++;
      if (fail) return route.fulfill({ status: 503, json: { error: { message: "Temporary save failure" } } });
      await gate;
      await route.continue();
    });
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#reader-read-error")).toContainText("Temporary save failure");
    await expect(toggle).toBeEnabled();
    assert.ok(await reader.evaluate((dialog) => dialog.open && dialog.scrollTop > 0), "Failure must preserve the reader and its scroll position.");
    assert.equal(await page.evaluate(async (id) => (await (await fetch(`/api/articles/${id}`)).json()).article.readAt, first.id), null);
    fail = false;
    await toggle.click();
    await expect(toggle).toHaveText("Saving…");
    await expect(toggle).toBeDisabled();
    await toggle.evaluate((button) => { button.click(); button.click(); });
    await expect.poll(() => patchCount, { message: "Only the failure and one retry should be submitted." }).toBe(2);
    release();
    await expect(page.locator("#notice")).toHaveText("Marked as read.");
    await expect(page.locator("#last-opened")).toHaveAttribute("aria-label", "Picked for you");
    assert.equal(new URL(page.url()).pathname, "/");
    await expect(reader).not.toBeVisible();
    await expect(detail).not.toBeVisible();
    await expect(footer).toBeHidden();
    await expect(row(first.id)).toHaveCount(0);
    await expect(page.locator("#search")).toHaveValue("Completion smoke");
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.status), "unread");
    await page.unroute(`**/api/articles/${first.id}`);

    await page.locator('[data-status="read"]').click();
    await row(first.id).getByRole("button", { name: "Edit", exact: true }).click();
    await expect(detail.getByRole("textbox", { name: "Markdown copy" })).toHaveValue(draft);
    await page.locator("#detail-dialog .dialog-close button").click();
    await row(first.id).locator(".article-title").click();
    await expect(toggle).toHaveText("Mark as unread");
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await reader.evaluate((dialog) => { dialog.scrollTop = dialog.scrollHeight; });
    await page.screenshot({ path: "/tmp/potem-reader-completion-desktop-dark.png" });
    await toggle.click();
    await expect(page.locator("#notice")).toHaveText("Marked as unread.");
    await expect(page.locator("#last-opened")).toHaveAttribute("aria-label", "Last opened");
    await expect(row(first.id)).toHaveCount(0);
    await page.reload();
    assert.equal(await page.evaluate(async (id) => (await (await fetch(`/api/articles/${id}`)).json()).article.readAt, first.id), null, "Marking unread must persist across reloads.");

    // A direct landing returns inside the app even when refreshing the list fails.
    await page.goto(`${base}/read/${first.id}`);
    await expect(toggle).toHaveText("Mark as read");
    await page.route("**/api/articles?*", (route) => route.fulfill({ status: 503, json: { error: { message: "List unavailable" } } }));
    await toggle.click();
    await expect(page.locator("#notice")).toContainText("Marked as read. Couldn’t refresh your library.");
    assert.equal(new URL(page.url()).pathname, "/");
    assert.ok(await page.evaluate(async (id) => (await (await fetch(`/api/articles/${id}`)).json()).article.readAt, first.id));
    await page.unroute("**/api/articles?*");
    await page.locator("#notice").getByRole("button", { name: "Retry" }).click();
    await expect(page.locator("#notice")).toHaveText("Marked as read.");

    // Completing a save for an old reader must not close a newer article.
    await page.goto(`${base}/read/${first.id}`);
    await expect(toggle).toHaveText("Mark as unread");
    let releaseLate;
    let observeLate;
    const lateGate = new Promise((resolve) => { releaseLate = resolve; });
    const lateStarted = new Promise((resolve) => { observeLate = resolve; });
    await page.route(`**/api/articles/${first.id}`, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      const response = await route.fetch();
      observeLate();
      await lateGate;
      await route.fulfill({ response });
    });
    await toggle.click();
    await lateStarted;
    await reader.getByRole("button", { name: "Close saved copy" }).click();
    await page.locator('[data-status="all"]').click();
    await row(second.id).locator(".article-title").click();
    await expect(reader.locator("#reader-title")).toHaveText(second.title);
    const lateResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith(first.id));
    releaseLate();
    await (await lateResponse).finished();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(reader.locator("#reader-title")).toHaveText(second.title);
    await expect(toggle).toHaveText("Mark as read");
    await expect(page.locator("#reader-read-error")).toBeHidden();
    await reader.getByRole("button", { name: "Close saved copy" }).click();

    // Preserve loaded-page depth and search when completion refreshes the library.
    await page.route("**/api/articles?*", async (route) => {
      const url = new URL(route.request().url());
      const pageNumber = url.searchParams.has("cursor");
      url.searchParams.delete("cursor");
      const response = await route.fetch({ url: url.href });
      const data = await response.json();
      const entry = data.items.find((item) => item.id === second.id);
      data.items = pageNumber ? [entry]
        : Array.from({ length: 50 }, (_, i) => ({ ...entry, id: `finish${String(i).padStart(2, "0")}`, title: `Completion row ${i}` }));
      data.nextCursor = pageNumber ? null : "completion-next-page";
      await route.fulfill({ json: data });
    });
    await page.locator('[data-status="all"]').click();
    await expect(page.locator(".article")).toHaveCount(50);
    await page.locator("#more").click();
    await expect(page.locator(".article")).toHaveCount(51);
    await row(second.id).locator(".article-title").evaluate((link) => {
      link.addEventListener("click", () => { window.__completionLibraryScroll = window.scrollY; }, { capture: true, once: true });
    });
    await row(second.id).locator(".article-title").click();
    await expect(toggle).toHaveText("Mark as read");
    const libraryScroll = await page.evaluate(() => window.__completionLibraryScroll);
    assert.ok(libraryScroll > 0, "The final-page fixture should preserve a scrolled library.");
    await toggle.click();
    await expect(page.locator("#notice")).toHaveText("Marked as read.");
    await expect(page.locator(".article")).toHaveCount(51);
    assert.equal(await row(second.id).locator(".article-title").evaluate((link) => document.activeElement === link), true);
    const restoredScroll = await page.evaluate(() => window.scrollY);
    assert.ok(Math.abs(restoredScroll - libraryScroll) <= 1, `Completion should preserve the scrolled library position: ${libraryScroll} → ${restoredScroll}.`);
    assert.ok(await row(second.id).evaluate((element) => element.classList.contains("is-read")));
    assert.deepEqual(errors, [], "Completion flow should not produce browser runtime errors.");
  } finally {
    await page.close();
  }
}
