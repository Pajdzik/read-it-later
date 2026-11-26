import assert from "node:assert/strict";
import { expect } from "playwright/test";

export async function shareCaptureSmoke(browser, base, sourceBase) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const marker = "synthetic-private-marker-93a1";
  const requestedUrls = [];
  context.on("request", request => requestedUrls.push(request.url()));

  await page.goto(`${base}/capture`);
  await page.evaluate(({ title, url }) => {
    const form = document.createElement("form");
    form.method = "POST";
    form.action = "/add";
    for (const [name, value] of Object.entries({ title, text: "A shared article", url })) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = value;
      form.append(input);
    }
    document.body.append(form);
    form.submit();
  }, { title: marker, url: `https://source.example/article?private=${marker}#${marker}` });
  await expect(page.locator("#add-dialog")).toBeVisible();
  await expect(page.locator("#add-url")).toHaveValue(`https://source.example/article?private=${marker}#${marker}`);
  await expect(page.locator("#add-title")).toHaveValue(marker);
  assert(requestedUrls.every(url => !url.includes(marker)), "share fields must stay out of navigation and subresource URLs");
  await page.keyboard.press("Escape");
  await expect(page.locator("#add-dialog")).not.toBeVisible();
  await page.locator("#settings-open").click();
  await page.locator("#logout").waitFor();
  await page.locator("#logout").click();
  await expect(page).toHaveURL(`${base}/`);
  assert.equal(await page.evaluate(() => sessionStorage.getItem("later-add-draft")), null,
    "sign-out clears a dismissed share handoff draft");
  await page.reload();
  assert.equal(await page.locator("#add-dialog").evaluate(dialog => dialog.open), false,
    "a dismissed POST share must not reopen after sign-out and reload");

  requestedUrls.length = 0;
  await page.goto(`${base}/capture`);
  const bookmarklet = await page.locator("#bookmarklet").getAttribute("href");
  assert(bookmarklet?.startsWith("javascript:"), "capture guide should expose its bookmarklet");
  const source = await context.newPage();
  await source.goto(`${sourceBase}/article`);
  await source.evaluate(marker => {
    document.title = marker;
    history.replaceState({}, "", `/article#${marker}`);
  }, marker);
  const popupPromise = source.waitForEvent("popup");
  await source.evaluate(href => (0, eval)(href.slice("javascript:".length)), bookmarklet);
  const popup = await popupPromise;
  await expect(popup.locator("#add-dialog")).toBeVisible({ timeout: 10000 });
  assert(!popup.url().includes(marker), "bookmarklet metadata must not appear in the Potem navigation URL");
  assert(requestedUrls.every(url => !url.includes(marker)), "bookmarklet metadata must stay out of request URLs");
  await popup.keyboard.press("Escape");
  await expect(popup.locator("#add-dialog")).not.toBeVisible();

  const conflictUrl = "https://source.example/private-article";
  const ownerHeaders = { Origin: base, "X-CSRF-Token": "dev-bypass" };
  const seeded = await context.request.post(`${base}/api/articles`, {
    headers: ownerHeaders,
    data: { url: conflictUrl, title: "Saved article before review" },
  });
  assert.equal(seeded.status(), 201, "fixture article should be saved before duplicate review");
  const savedArticle = (await seeded.json()).article;
  const seededCopy = await context.request.put(`${base}/api/articles/${encodeURIComponent(savedArticle.id)}/copy`, {
    headers: ownerHeaders,
    data: { markdown: `# Existing saved copy ${marker}`, source: "paste", expectedRevision: null },
  });
  assert.equal(seededCopy.status(), 200, "fixture copy should be saved before duplicate review");
  await popup.evaluate(({ marker, conflictUrl }) => {
    sessionStorage.setItem("later-extension-capture", JSON.stringify({
      requestId: "a".repeat(48), sourceUrl: conflictUrl, title: marker,
      markdown: `# Replacement clip ${marker}`, mode: "review",
    }));
  }, { marker, conflictUrl });
  await popup.reload();
  await expect(popup.locator("#add-dialog")).toBeVisible();
  await popup.locator("#extension-save-private").click();
  await expect(popup.locator("#capture-existing-preview")).toBeVisible();
  await expect(popup.locator("#capture-existing-preview")).toContainText(`Existing saved copy ${marker}`);
  await popup.keyboard.press("Escape");
  await expect(popup.locator("#add-dialog")).not.toBeVisible();
  assert(await popup.evaluate(() => Boolean(sessionStorage.getItem("later-extension-capture"))), "dismissal keeps the handoff until the owner signs out");
  await popup.locator("#settings-open").click();
  await popup.locator("#logout").click();
  await expect(popup).toHaveURL(`${base}/`);
  await popup.reload();
  assert.equal(await popup.evaluate(() => sessionStorage.getItem("later-extension-capture")), null);
  assert.equal(await popup.evaluate(() => sessionStorage.getItem("later-browser-capture-draft")), null);
  assert.equal(await popup.locator("#add-dialog").evaluate(dialog => dialog.open), false);
  await context.close();
}
