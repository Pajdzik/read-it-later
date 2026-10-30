import assert from "node:assert/strict";
import { expect } from "playwright/test";

export async function readerTitleSmoke(browser, base) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const title = "How's Linear so fast? A technical breakdown";
  const capturedHeading = "How's Linear so fast?A technical breakdown";
  const cases = [
    {
      title,
      markdown: `## ${capturedHeading}\n\n![Hero image](https://example.com/hero.jpg)\n\nA few milliseconds is all it takes.\n\n## What I'll cover\n\nArticle sections.`,
      headings: ["What I'll cover"],
    },
    { title, markdown: `# **How’s Linear so fast?** A technical breakdown\n\nIntroduction.`, headings: [] },
    { title, markdown: `${title.toUpperCase()}\n===\n\nIntroduction.`, headings: [] },
    { title, markdown: "## Database in the browser\n\nIntroduction.", headings: ["Database in the browser"] },
    { title, markdown: `Introduction.\n\n## ${title}`, headings: [title] },
    { title, markdown: `> ## ${title}\n\nIntroduction.`, headings: [title] },
    { title, markdown: `${title}\n\nIntroduction.`, headings: [] },
    { title: "C++", markdown: "# C\n\nIntroduction.", headings: ["C"] },
    { title: "A: B", markdown: "# A B\n\nIntroduction.", headings: ["A B"] },
    { title, markdown: `## ${title}\n\nIntroduction.\n\n## ${title}`, headings: [title] },
  ];
  let fixture;
  let requestsWithWrites = 0;
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") requestsWithWrites++;
    const pathname = new URL(request.url()).pathname;
    const json = (body) => route.fulfill({ json: body });
    if (pathname === "/api/session") return json({ authenticated: true, csrfToken: "smoke" });
    if (pathname === "/api/articles/e0lgk5dz") return json({ article: fixture.article });
    if (pathname === "/api/articles/e0lgk5dz/copy") return json({ copy: fixture.copy });
    if (pathname === "/api/articles") return json({ items: [fixture.article], nextCursor: null });
    if (pathname === "/api/articles/suggestion") return json({ article: null, hasAlternative: false });
    if (pathname === "/api/github") return json({ github: { configured: false } });
    return route.fulfill({ status: 404, json: { error: { message: "Not found" } } });
  });
  try {
    for (const [index, sample] of cases.entries()) {
      fixture = {
        article: {
          id: "e0lgk5dz", title: sample.title, url: "https://performance.dev/how-is-linear-so-fast-a-technical-breakdown",
          author: null, description: null, hasCopy: true, readAt: null,
          createdAt: "2026-10-29T00:00:00.000Z", updatedAt: "2026-10-29T00:00:00.000Z",
        },
        copy: { markdown: sample.markdown, capturedAt: "2026-10-29T00:00:00.000Z", source: "paste", revision: `title-smoke-${index}` },
      };
      await page.goto(`${base}/read/e0lgk5dz`);
      await expect(page.locator("#reader-title")).toHaveText(sample.title);
      const body = page.locator("#reader-body");
      await expect(body).toBeVisible();
      await expect(body.getByRole("heading")).toHaveText(sample.headings);
      if (index === 0) {
        await expect(body).toContainText("A few milliseconds is all it takes.");
        await expect(body).toContainText("Image reference: Hero image");
        assert.equal(await body.locator("img").count(), 0);
        await page.screenshot({ path: "/tmp/potem-reader-title-desktop.png" });
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(page.locator("#reader-title")).toHaveText(title);
        await expect(body.getByRole("heading")).toHaveText(sample.headings);
        await page.screenshot({ path: "/tmp/potem-reader-title-mobile.png" });
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.getByRole("button", { name: "Close saved copy" }).click();
        await page.locator('.article[data-id="e0lgk5dz"]').getByRole("button", { name: "Edit", exact: true }).click();
        await expect(page.getByRole("textbox", { name: "Markdown copy" })).toHaveValue(sample.markdown);
      }
    }
    assert.equal(requestsWithWrites, 0, "Displaying a title must not rewrite saved copies or metadata.");
    assert.deepEqual(errors, [], "Reader title browser errors.");
    console.log("Reader title smoke passed: duplicate captured titles, distinct and nested headings, preserved Markdown, desktop/mobile.");
  } finally {
    await context.close();
  }
}
