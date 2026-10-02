const origin = location.origin;
const link = document.querySelector("#bookmarklet");
function capture(potemOrigin) {
  const sourceUrl = location.href;
  const sourceTitle = document.title.slice(0, 500);
  const random = new Uint8Array(16);
  crypto.getRandomValues(random);
  const channel = Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const app = window.open(`${potemOrigin}/add?url=${encodeURIComponent(sourceUrl)}&title=${encodeURIComponent(sourceTitle)}&capture=${channel}`, `potem-${channel}`);
  if (!app) {
    alert("Potem could not open. Allow popups for this page, then try again.");
    return;
  }

  let finished = false;
  let ready = false;
  let scriptState = null;
  let loadMessage = "";
  const extract = () => {
    if (!ready || scriptState === null || finished) return;
    if (!scriptState) {
      finish("", loadMessage);
      return;
    }
    try {
      if (!window.PotemDefuddle) throw new Error("The extractor did not load.");
      const result = new window.PotemDefuddle(document, { url: sourceUrl, markdown: true, useAsync: false }).parse();
      const markdown = result.content || "";
      if (!markdown.trim()) throw new Error("No article text could be extracted.");
      finish(markdown);
    } catch (error) {
      finish("", error instanceof Error ? error.message : "Article extraction failed.");
    }
  };
  const finish = (markdown, error) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    removeEventListener("message", onMessage);
    app.postMessage({ type: "potem-capture", channel, sourceUrl, sourceTitle, markdown, error }, potemOrigin);
  };
  const onMessage = (event) => {
    if (event.source !== app || event.origin !== potemOrigin || event.data?.type !== "potem-ready" || event.data.channel !== channel || finished) return;
    ready = true;
    extract();
  };
  addEventListener("message", onMessage);
  const timeout = setTimeout(() => finish("", "Potem did not respond. Keep the link and use the paste fallback for Markdown."), 20000);
  const script = document.createElement("script");
  script.src = `${potemOrigin}/defuddle.js`;
  script.onload = () => { scriptState = true; extract(); };
  script.onerror = () => {
    scriptState = false;
    loadMessage = "This page blocked the extractor. The link is ready; paste Markdown in the article details if you want a saved copy.";
    extract();
  };
  (document.head || document.documentElement).append(script);
}
link.href = `javascript:(${capture.toString()})(${JSON.stringify(origin)})`;
document.querySelector("#api-url").textContent = `${origin}/api/capture`;
