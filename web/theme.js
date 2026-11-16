(() => {
  const paletteKey = "later-palette";
  const appearanceKey = "later-appearance";
  const legacyKey = "later-theme";
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
  const validPalette = (value) => value === "green" || value === "brown";
  const validAppearance = (value) => value === "system" || value === "light" || value === "dark";
  const validLegacy = (value) => value === "system" || value === "light" || value === "dark" || value === "brown";
  const legacyValues = {
    system: { palette: "green", appearance: "system" },
    light: { palette: "green", appearance: "light" },
    dark: { palette: "green", appearance: "dark" },
    brown: { palette: "brown", appearance: "dark" },
  };
  const topbarColors = {
    green: { light: "#124138", dark: "#eee2cf" },
    brown: { light: "#513023", dark: "#eed9c4" },
  };
  const readAll = () => {
    try {
      return {
        ok: true,
        palette: window.localStorage.getItem(paletteKey),
        appearance: window.localStorage.getItem(appearanceKey),
        legacy: window.localStorage.getItem(legacyKey),
      };
    } catch { return { ok: false }; }
  };
  let palette = "green";
  let appearance = "system";
  const listeners = new Set();

  function resolveStored(values) {
    if (!values.ok) return;
    const fallback = validLegacy(values.legacy) ? legacyValues[values.legacy] : null;
    const paletteNeedsMigration = !validPalette(values.palette);
    const appearanceNeedsMigration = !validAppearance(values.appearance);
    palette = validPalette(values.palette) ? values.palette : fallback?.palette ?? "green";
    appearance = validAppearance(values.appearance) ? values.appearance : fallback?.appearance ?? "system";

    if (fallback) {
      try {
        if (paletteNeedsMigration) window.localStorage.setItem(paletteKey, palette);
        if (appearanceNeedsMigration) window.localStorage.setItem(appearanceKey, appearance);
        window.localStorage.removeItem(legacyKey);
      } catch { /* Keep resolved preferences in memory if migration cannot be saved. */ }
    }
  }
  resolveStored(readAll());

  function apply() {
    const theme = appearance === "dark" || (appearance === "system" && systemTheme.matches) ? "dark" : "light";
    document.documentElement.dataset.palette = palette;
    document.documentElement.dataset.theme = theme;
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.content = topbarColors[palette][theme];
    return { palette, appearance, theme };
  }
  function notify() {
    const value = apply();
    listeners.forEach((listener) => listener(value));
  }
  function set(next) {
    if (next && validPalette(next.palette) && next.palette !== palette) {
      palette = next.palette;
      try { window.localStorage.setItem(paletteKey, palette); } catch { /* Keep the preference in memory. */ }
    }
    if (next && validAppearance(next.appearance) && next.appearance !== appearance) {
      appearance = next.appearance;
      try { window.localStorage.setItem(appearanceKey, appearance); } catch { /* Keep the preference in memory. */ }
    }
    notify();
  }

  apply();
  systemTheme.addEventListener("change", () => { if (appearance === "system") notify(); });
  window.addEventListener("storage", (event) => {
    if (event.key === null || [paletteKey, appearanceKey, legacyKey].includes(event.key)) {
      resolveStored(readAll());
      notify();
    }
  });
  window.potemTheme = {
    get: () => ({ palette, appearance }),
    set,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
})();
