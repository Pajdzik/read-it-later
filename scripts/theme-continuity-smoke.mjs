import assert from "node:assert/strict";
import { expect } from "playwright/test";

const colors = {
  green: { light: ["#f7f1e6", "#124138"], dark: ["#0d1a10", "#eee2cf"] },
  brown: { light: ["#f5ebdd", "#513023"], dark: ["#1c1511", "#eed9c4"] },
};
const rgb = (hex) => `rgb(${hex.slice(1).match(/../g).map((part) => parseInt(part, 16)).join(", ")})`;

async function expectTheme(page, palette, mode) {
  const [paper, topbar] = colors[palette][mode];
  await expect(page.locator("html")).toHaveAttribute("data-palette", palette);
  await expect(page.locator("html")).toHaveAttribute("data-theme", mode);
  await expect(page.locator("html")).toHaveCSS("color-scheme", mode);
  await expect(page.locator("body")).toHaveCSS("background-color", rgb(paper));
  await expect(page.locator(".topbar")).toHaveCSS("background-color", rgb(topbar));
  await expect(page.locator(".topbar")).toHaveCSS("border-bottom-color", rgb("#934324"));
  await expect(page.locator(".brand")).toHaveCSS("color", rgb(paper));
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", topbar);
}

function savedTheme(page) {
  return page.evaluate(() => ({
    palette: localStorage.getItem("later-palette"),
    appearance: localStorage.getItem("later-appearance"),
    legacy: localStorage.getItem("later-theme"),
  }));
}

async function checkMigration(browser, base) {
  const cases = [
    { legacy: "system", palette: "green", appearance: "system", mode: "dark", path: "/" },
    { legacy: "light", palette: "green", appearance: "light", mode: "light", path: "/" },
    { legacy: "dark", palette: "green", appearance: "dark", mode: "dark", path: "/capture.html" },
    { legacy: "brown", palette: "brown", appearance: "dark", mode: "dark", path: "/capture.html" },
    { legacy: "brown", stored: { "later-palette": "green", "later-appearance": "sepia" }, palette: "green", appearance: "dark", mode: "dark", path: "/" },
    { legacy: "brown", stored: { "later-appearance": "light" }, palette: "brown", appearance: "light", mode: "light", path: "/capture.html" },
  ];
  for (const { legacy, stored, palette, appearance, mode, path } of cases) {
    const context = await browser.newContext({ colorScheme: appearance === "dark" ? "light" : "dark", serviceWorkers: "block" });
    const page = await context.newPage();
    await page.addInitScript((values) => {
      for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
    }, { "later-theme": legacy, ...stored });
    let release;
    const moduleGate = new Promise((resolve) => { release = resolve; });
    await page.route(/\/(app\.[\w]+|capture)\.js$/, async (route) => {
      await moduleGate;
      await route.continue();
    });
    try {
      // The head script must theme both pages while their application modules are blocked.
      await page.goto(`${base}${path}`, { waitUntil: "commit" });
      await expectTheme(page, palette, mode);
      assert.deepEqual(await savedTheme(page), { palette, appearance, legacy: null });
    } finally {
      release();
      await context.close();
    }
  }
}

export async function themeContinuitySmoke(browser, base) {
  await checkMigration(browser, base);

  const context = await browser.newContext({ colorScheme: "light" });
  try {
    const page = await context.newPage();
    const capture = await context.newPage();
    await page.route("**/api/session", (route) => route.fulfill({ json: { authenticated: false } }));
    await capture.goto(`${base}/capture.html`);
    await capture.evaluate(() => {
      localStorage.setItem("later-theme", "sepia");
      localStorage.setItem("later-palette", "sepia");
      localStorage.setItem("later-appearance", "sepia");
    });
    await page.goto(base);
    await expect(page.locator("#library-sign-in")).toBeVisible();
    await page.getByRole("button", { name: "Settings" }).click();
    const paletteSelect = page.getByLabel("Palette");
    const appearanceSelect = page.getByLabel("Appearance");
    await expect(paletteSelect).toBeFocused();
    await expect(paletteSelect).toHaveValue("green");
    await expect(appearanceSelect).toHaveValue("system");

    for (const [palette, previousAppearance] of [["green", "system"], ["brown", "dark"]]) {
      await paletteSelect.selectOption(palette);
      await expect(appearanceSelect).toHaveValue(previousAppearance);
      await appearanceSelect.selectOption("system");
      for (const mode of ["dark", "light"]) {
        await page.emulateMedia({ colorScheme: mode });
        await capture.emulateMedia({ colorScheme: mode });
        await expectTheme(page, palette, mode);
        await expectTheme(capture, palette, mode);
        await expect(appearanceSelect).toHaveValue("system");
        await expect(paletteSelect).toHaveValue(palette);
      }
      for (const mode of ["light", "dark"]) {
        await appearanceSelect.selectOption(mode);
        const opposite = mode === "light" ? "dark" : "light";
        await page.emulateMedia({ colorScheme: opposite });
        await capture.emulateMedia({ colorScheme: opposite });
        await expectTheme(page, palette, mode);
        await expectTheme(capture, palette, mode);
        await expect(paletteSelect).toHaveValue(palette);
        assert.equal((await savedTheme(page)).appearance, mode);
      }
    }
    await page.reload();
    await capture.reload();
    await expectTheme(page, "brown", "dark");
    await expectTheme(capture, "brown", "dark");
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(paletteSelect).toHaveValue("brown");
    await expect(appearanceSelect).toHaveValue("dark");
    await capture.evaluate(() => localStorage.setItem("later-palette", "green"));
    await expect(paletteSelect).toHaveValue("green");
    await expect(appearanceSelect).toHaveValue("dark");
    await expectTheme(page, "green", "dark");
  } finally {
    await context.close();
  }

  const blockedContext = await browser.newContext({ colorScheme: "dark" });
  try {
    const page = await blockedContext.newPage();
    await page.addInitScript(() => Object.defineProperty(window, "localStorage", { get() { throw new Error("storage disabled"); } }));
    await page.goto(base);
    await expectTheme(page, "green", "dark");
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Palette").selectOption("brown");
    await page.getByLabel("Appearance").selectOption("dark");
    await page.emulateMedia({ colorScheme: "light" });
    await expectTheme(page, "brown", "dark");
  } finally {
    await blockedContext.close();
  }
}
