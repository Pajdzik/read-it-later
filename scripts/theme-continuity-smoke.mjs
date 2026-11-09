import assert from "node:assert/strict";
import { expect } from "playwright/test";

export async function themeContinuitySmoke(browser, base) {
  const context = await browser.newContext({ colorScheme: "dark" });
  const page = await context.newPage();
  let releaseSession;
  const sessionGate = new Promise((resolve) => { releaseSession = resolve; });
  await page.addInitScript(() => localStorage.setItem("later-theme", "dark"));
  await page.route("**/api/session", async (route) => {
    await sessionGate;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ authenticated: false }) });
  });
  const navigation = page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  assert.equal(await page.locator('meta[name="theme-color"]').getAttribute("content"), "#102d24");
  releaseSession();
  await navigation;
  await expect(page.locator("#library-sign-in")).toBeVisible();

  await page.locator("#theme-toggle").evaluate((select) => {
    select.value = "light";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  assert.equal(await page.locator('meta[name="theme-color"]').getAttribute("content"), "#f7f1e6");
  assert.equal(await page.evaluate(() => localStorage.getItem("later-theme")), "light");
  await context.close();

  const blockedContext = await browser.newContext({ colorScheme: "dark" });
  const blockedPage = await blockedContext.newPage();
  await blockedPage.addInitScript(() => Object.defineProperty(window, "localStorage", { get() { throw new Error("storage disabled"); } }));
  await blockedPage.goto(base, { waitUntil: "domcontentloaded" });
  await expect(blockedPage.locator("html")).toHaveAttribute("data-theme", "dark");
  await blockedPage.locator("#theme-toggle").evaluate((select) => {
    select.value = "dark";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await blockedPage.emulateMedia({ colorScheme: "light" });
  await expect(blockedPage.locator("html")).toHaveAttribute("data-theme", "dark");
  await blockedContext.close();

  const captureContext = await browser.newContext({ colorScheme: "dark" });
  const capture = await captureContext.newPage();
  await capture.addInitScript(() => { if (!localStorage.getItem("later-theme")) localStorage.setItem("later-theme", "sepia"); });
  await capture.goto(`${base}/capture.html`, { waitUntil: "domcontentloaded" });
  await expect(capture.locator("html")).toHaveAttribute("data-theme", "dark");
  assert.equal(await capture.locator('meta[name="theme-color"]').getAttribute("content"), "#102d24");
  await capture.emulateMedia({ colorScheme: "light" });
  await expect(capture.locator("html")).toHaveAttribute("data-theme", "light");
  assert.equal(await capture.locator('meta[name="theme-color"]').getAttribute("content"), "#f7f1e6");
  await capture.evaluate(() => localStorage.setItem("later-theme", "dark"));
  await capture.reload({ waitUntil: "domcontentloaded" });
  await expect(capture.locator("html")).toHaveAttribute("data-theme", "dark");
  assert.equal(await capture.locator('meta[name="theme-color"]').getAttribute("content"), "#102d24");
  await captureContext.close();
}
