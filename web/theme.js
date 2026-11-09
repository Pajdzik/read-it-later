(() => {
  const storageKey = "later-theme";
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
  const readPreference = () => {
    try {
      const stored = window.localStorage.getItem(storageKey);
      return stored === "light" || stored === "dark" ? stored : "system";
    } catch {
      return "system";
    }
  };
  let preference = readPreference();
  const apply = (nextPreference = preference) => {
    preference = nextPreference === "light" || nextPreference === "dark" ? nextPreference : "system";
    const theme = preference === "dark" || (preference === "system" && systemTheme.matches) ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    const color = theme === "dark" ? "#102d24" : "#f7f1e6";
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.content = color;
    return theme;
  };

  apply();
  systemTheme.addEventListener("change", () => {
    if (preference === "system") apply("system");
  });
  window.potemTheme = { apply };
})();
