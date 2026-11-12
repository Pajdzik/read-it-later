import assert from "node:assert/strict";
import { expect } from "playwright/test";

export async function readerPreviewSmoke(browser, base) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  const parentTitle = "Reader preview starting article";
  const unavailableUrl = "https://example.com/reader-preview/unavailable";
  const preview = {
    url: "https://example.com/reader-preview/linked",
    title: "Reader preview linked article",
    author: "Preview Author",
    description: "A linked article to read in the reader.",
    markdown: "An **important** paragraph.\n\n[Unavailable article](./unavailable)\n\n[Save from choices](./dialog-save)",
  };
  const previewRequests = [];
  const saveRequests = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url() === base + "/api/articles")
      saveRequests.push(request.postDataJSON());
  });
  await context.route(preview.url, (route) => route.fulfill({
    contentType: "text/html", body: "<title>Linked website</title>",
  }));
  // Stub the remote extraction result. Library writes still go through the local Worker and D1.
  await page.route("**/api/articles/preview", (route) => {
    const request = route.request();
    assert.equal(request.method(), "POST");
    const { url } = request.postDataJSON();
    previewRequests.push(url);
    if (url === preview.url) return route.fulfill({ json: { article: preview } });
    assert.equal(url, unavailableUrl);
    return route.fulfill({
      status: 422,
      json: { error: { code: "preview_unavailable", message: "Preview source unavailable." } },
    });
  });
  const findSaved = async () => {
    const response = await context.request.get(`${base}/api/articles?status=all&q=${encodeURIComponent(preview.title)}`);
    assert.equal(response.status(), 200);
    return (await response.json()).items.filter(({ url }) => url === preview.url);
  };
  try {
    const { csrfToken } = await (await context.request.get(base + "/api/session")).json();
    const headers = { Origin: base, "X-CSRF-Token": csrfToken };
    const created = await context.request.post(base + "/api/articles", {
      headers,
      data: { url: "https://example.com/reader-preview/index", title: parentTitle, captureMarkdown: false },
    });
    assert.equal(created.status(), 201);
    const { article: parent } = await created.json();
    const copied = await context.request.put(`${base}/api/articles/${parent.id}/copy`, {
      headers,
      data: { markdown: "Read the [Linked article](./linked).", source: "paste", expectedRevision: null },
    });
    assert.equal(copied.status(), 200);

    await page.goto(base);
    const reader = page.locator("#reader-dialog");
    const title = reader.locator("#reader-title");
    const body = reader.locator("#reader-body");
    const choice = page.locator("#reader-link-dialog");
    const readLink = choice.getByRole("button", { name: "Read in Potem" });
    await page.locator("#articles").getByRole("link", { name: parentTitle, exact: true }).click();
    await expect(title).toHaveText(parentTitle);
    await body.getByRole("link", { name: "Linked article" }).click();
    await expect(choice).toBeVisible();
    const website = choice.getByRole("link", { name: "Open website" });
    await expect(website).toHaveAttribute("href", preview.url);
    await expect(website).toHaveAttribute("target", "_blank");
    assert.deepEqual(previewRequests, [], "Opening the link choices should wait for the reader choice.");
    const popupPromise = page.waitForEvent("popup");
    await website.click();
    const popup = await popupPromise;
    await expect(popup).toHaveTitle("Linked website");
    await popup.close();
    await expect(title).toHaveText(parentTitle);
    assert.deepEqual(previewRequests, [], "Opening the website should leave the reader on the starting article.");

    await body.getByRole("link", { name: "Linked article" }).click();
    await readLink.click();
    await expect(title).toHaveText(preview.title);
    await expect(body.locator("strong")).toHaveText("important");
    assert.deepEqual(previewRequests, [preview.url]);
    assert.deepEqual(await findSaved(), [], "Reading a linked article must leave it outside the library.");
    assert.deepEqual(saveRequests, []);
    await page.goBack();
    await expect(title).toHaveText(parentTitle);
    await page.goForward();
    await expect(title).toHaveText(preview.title);

    await body.getByRole("link", { name: "Save from choices" }).tap();
    await expect(choice).toBeVisible();
    const dialogSave = choice.locator("#reader-link-save");
    const dialogSaveStatus = choice.locator("#reader-link-save-status");
    await expect(dialogSave).toHaveText("Save to library");
    assert.equal(await choice.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth + 1), true,
      "The three link actions should fit a phone viewport.");
    await dialogSave.tap();
    await expect(dialogSaveStatus).toHaveText("Saved to library");
    await expect(title).toHaveText(preview.title);
    assert.deepEqual(previewRequests, [preview.url]);
    assert.equal(saveRequests.length, 1);
    assert.deepEqual(saveRequests[0], { url: "https://example.com/reader-preview/dialog-save", captureMarkdown: true });
    const dialogSavedResponse = await context.request.get(`${base}/api/articles?status=all&q=${encodeURIComponent("dialog-save")}`);
    assert.equal(dialogSavedResponse.status(), 200);
    const dialogSavedItems = (await dialogSavedResponse.json()).items.filter(({ url }) => url === "https://example.com/reader-preview/dialog-save");
    assert.equal(dialogSavedItems.length, 1);
    await choice.getByRole("button", { name: "Cancel" }).click();
    await expect(choice).toBeHidden();
    await expect(body.getByRole("link", { name: "Save from choices" })).toBeFocused();

    await body.getByRole("link", { name: "Unavailable article" }).click();
    await readLink.click();
    await expect(reader.locator("#reader-preview-status")).toContainText("Preview source unavailable.");
    await expect(reader.locator("#reader-original")).toHaveAttribute("href", unavailableUrl);
    await expect(reader.getByRole("button", { name: "Save to library" })).toBeHidden();
    await reader.getByRole("button", { name: "Back to previous article" }).click();
    await expect(title).toHaveText(preview.title);

    await reader.getByRole("button", { name: "Save to library" }).click();
    await expect(reader.locator("#reader-preview-status")).toHaveText("Saved to library.");
    await expect(title).toHaveText(preview.title);
    assert.equal(saveRequests.length, 2);
    assert.equal(saveRequests[1].previewMarkdown, preview.markdown);
    const saved = await findSaved();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].readAt, null);
    assert.equal(saved[0].author, preview.author);
    const copy = await context.request.get(`${base}/api/articles/${saved[0].id}/copy`);
    assert.equal((await copy.json()).copy?.markdown, preview.markdown);

    await reader.getByRole("button", { name: "Back to previous article" }).click();
    await expect(title).toHaveText(parentTitle);
    await reader.getByRole("button", { name: "Close saved copy" }).click();
    await page.locator("#articles").getByRole("link", { name: preview.title, exact: true }).click();
    await expect(title).toHaveText(preview.title);
    await expect(body.locator("strong")).toHaveText("important");
    await expect(reader.getByRole("button", { name: "Save to library" })).toBeHidden();
    assert.deepEqual(errors, [], "Opening and saving reader previews should produce no runtime errors.");
    console.log("Reader preview smoke passed: link choices, browser history, failed preview fallback, and saving the Markdown copy.");
  } finally {
    await context.close();
  }
}
