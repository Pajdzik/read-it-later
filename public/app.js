const state = {
  article: null,
  articles: [],
  category: "all",
  filter: "all",
  query: "",
  selectedId: null,
  sort: "latest",
};

const elements = {
  articleContent: document.querySelector("#articleContent"),
  articleCount: document.querySelector("#articleCount"),
  articleList: document.querySelector("#articleList"),
  backButton: document.querySelector("#backButton"),
  categorySelect: document.querySelector("#categorySelect"),
  reader: document.querySelector("#reader"),
  readerCategory: document.querySelector("#readerCategory"),
  readerEmpty: document.querySelector("#readerEmpty"),
  readerMeta: document.querySelector("#readerMeta"),
  readerTitle: document.querySelector("#readerTitle"),
  readButton: document.querySelector("#readButton"),
  searchInput: document.querySelector("#searchInput"),
  sortSelect: document.querySelector("#sortSelect"),
  sourceLink: document.querySelector("#sourceLink"),
  themeButton: document.querySelector("#themeButton"),
  unreadCount: document.querySelector("#unreadCount"),
};

const savedPrefs = JSON.parse(localStorage.getItem("readLaterPrefs") || "{}");
for (const key of ["category", "filter", "sort", "theme"]) {
  if (typeof savedPrefs[key] === "string") state[key] = savedPrefs[key];
}
if (!["system", "dark", "light"].includes(state.theme)) state.theme = "system";

elements.sortSelect.value = state.sort;
document.querySelectorAll(".segmentButton").forEach((button) => {
  button.classList.toggle("isActive", button.dataset.filter === state.filter);
});

function persistPrefs() {
  localStorage.setItem(
    "readLaterPrefs",
    JSON.stringify({
      category: state.category,
      filter: state.filter,
      sort: state.sort,
      theme: state.theme,
    }),
  );
}

function systemTheme() {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function activeTheme() {
  return state.theme === "dark" || state.theme === "light" ? state.theme : systemTheme();
}

function applyTheme() {
  const theme = activeTheme();
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themeMode = state.theme;
  const nextMode = nextThemeMode();
  const modeLabel = state.theme === "system" ? `System (${theme})` : state.theme;
  elements.themeButton.setAttribute("aria-label", `Theme: ${modeLabel}. Switch to ${nextMode} mode`);
  elements.themeButton.title = `Theme: ${modeLabel}`;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#151817" : "#f6f4ee");
}

function nextThemeMode() {
  const modes = ["system", "dark", "light"];
  return modes[(modes.indexOf(state.theme) + 1) % modes.length];
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeInlineText(value) {
  return String(value ?? "")
    .replace(/<\/?(u|b|i|em|strong|span)>/gi, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function hostFromUrl(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function plural(count, label) {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

function normalizeText(value) {
  return String(value || "").toLocaleLowerCase();
}

function filteredArticles() {
  const query = normalizeText(state.query);
  const articles = state.articles.filter((article) => {
    if (state.filter === "read" && !article.read) return false;
    if (state.filter === "unread" && article.read) return false;
    if (state.category !== "all" && article.category !== state.category) return false;
    if (!query) return true;

    return [article.title, article.excerpt, article.category, article.source, hostFromUrl(article.source)]
      .map(normalizeText)
      .some((value) => value.includes(query));
  });

  const byLatest = (a, b) => b.addedTimestamp - a.addedTimestamp || a.title.localeCompare(b.title);
  const sorters = {
    category: (a, b) => a.category.localeCompare(b.category) || byLatest(a, b),
    latest: byLatest,
    published: (a, b) => b.publishedTimestamp - a.publishedTimestamp || byLatest(a, b),
    reading: (a, b) => a.readingMinutes - b.readingMinutes || byLatest(a, b),
    title: (a, b) => a.title.localeCompare(b.title),
    unread: (a, b) => Number(a.read) - Number(b.read) || byLatest(a, b),
  };

  return articles.toSorted(sorters[state.sort] || byLatest);
}

function renderStats() {
  const unread = state.articles.filter((article) => !article.read).length;
  elements.articleCount.textContent = plural(state.articles.length, "article");
  elements.unreadCount.textContent = `${unread} unread`;
}

function renderCategories() {
  const categories = [...new Set(state.articles.map((article) => article.category))].sort();
  if (state.category !== "all" && !categories.includes(state.category)) {
    state.category = "all";
  }

  elements.categorySelect.innerHTML = [
    '<option value="all">All categories</option>',
    ...categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`),
  ].join("");
  elements.categorySelect.value = state.category;
}

function iconCheck() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>';
}

function iconCircle() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7" /></svg>';
}

function renderList() {
  const articles = filteredArticles();

  if (!articles.length) {
    elements.articleList.innerHTML = '<li class="emptyList">No articles match this view.</li>';
    return;
  }

  elements.articleList.innerHTML = articles
    .map((article) => {
      const isSelected = article.id === state.selectedId;
      const sourceHost = hostFromUrl(article.source);
      const date = article.added || article.published;

      return `
        <li class="articleItem ${article.read ? "isRead" : ""} ${isSelected ? "isSelected" : ""}">
          <button class="readToggle" type="button" data-read-toggle="${escapeHtml(article.id)}" aria-label="${article.read ? "Mark unread" : "Mark read"}" title="${article.read ? "Mark unread" : "Mark read"}">
            ${article.read ? iconCheck() : iconCircle()}
          </button>
          <button class="articleCard" type="button" data-open-article="${escapeHtml(article.id)}" aria-current="${isSelected ? "true" : "false"}">
            <span class="cardKicker">${escapeHtml(article.category)}${date ? ` / ${escapeHtml(formatDate(date))}` : ""}</span>
            <strong>${escapeHtml(article.title)}</strong>
            <span class="excerpt">${escapeHtml(article.excerpt || "No preview available.")}</span>
            <span class="cardMeta">
              <span>${escapeHtml(plural(article.readingMinutes, "min"))}</span>
              ${sourceHost ? `<span>${escapeHtml(sourceHost)}</span>` : ""}
            </span>
          </button>
        </li>
      `;
    })
    .join("");
}

function showReader(show) {
  elements.reader.hidden = !show;
  elements.readerEmpty.hidden = show;
  document.body.classList.toggle("readerOpen", show);
}

function setReaderLoading() {
  showReader(true);
  elements.readerTitle.textContent = "Loading...";
  elements.readerCategory.textContent = "";
  elements.readerMeta.textContent = "";
  elements.articleContent.innerHTML = "";
  elements.readButton.disabled = true;
}

async function loadArticle(id) {
  if (!id) return;
  state.selectedId = id;
  state.article = null;
  setReaderLoading();
  renderList();

  const response = await fetch(`/api/articles/${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error(`Could not load article: ${response.status}`);
  const { article } = await response.json();

  state.article = article;
  const index = state.articles.findIndex((candidate) => candidate.id === article.id);
  if (index !== -1) state.articles[index] = { ...state.articles[index], ...article };

  renderReader();
  renderList();
  history.replaceState(null, "", `?article=${encodeURIComponent(id)}`);
}

function sourceIsUrl(value) {
  return /^https?:\/\//i.test(value || "");
}

function renderReader() {
  const article = state.article;
  if (!article) {
    showReader(false);
    return;
  }

  showReader(true);
  elements.readerTitle.textContent = article.title;
  elements.readerCategory.textContent = article.category;

  const meta = [
    article.added ? `Added ${formatDate(article.added)}` : "",
    article.published ? `Published ${formatDate(article.published)}` : "",
    plural(article.readingMinutes, "min"),
    article.wordCount ? `${article.wordCount.toLocaleString()} words` : "",
  ].filter(Boolean);
  elements.readerMeta.textContent = meta.join(" / ");

  elements.sourceLink.hidden = !sourceIsUrl(article.source);
  elements.sourceLink.href = sourceIsUrl(article.source) ? article.source : "#";

  elements.readButton.disabled = false;
  elements.readButton.dataset.read = String(!article.read);
  elements.readButton.classList.toggle("isUnreadAction", !article.read);
  elements.readButton.querySelector("span").textContent = article.read ? "Mark unread" : "Mark read";
  elements.articleContent.innerHTML = renderMarkdown(article.content, article.id);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function setArticleRead(id, read) {
  const response = await fetch(`/api/articles/${encodeURIComponent(id)}/read`, {
    body: JSON.stringify({ read }),
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  });
  if (!response.ok) throw new Error(`Could not update read state: ${response.status}`);

  const { state: readState } = await response.json();
  state.articles = state.articles.map((article) =>
    article.id === id ? { ...article, read: readState.read, readAt: readState.readAt } : article,
  );
  if (state.article?.id === id) {
    state.article = { ...state.article, read: readState.read, readAt: readState.readAt };
    renderReader();
  }
  renderStats();
  renderList();
}

function assetUrl(src, articleId) {
  const trimmed = src.trim().replace(/^<|>$/g, "");
  if (/^(https?:|data:|blob:|mailto:|#|\/)/i.test(trimmed)) return trimmed;
  let assetPath = trimmed;
  try {
    assetPath = decodeURIComponent(trimmed);
  } catch {
    assetPath = trimmed;
  }
  return `/api/articles/${encodeURIComponent(articleId)}/asset?path=${encodeURIComponent(assetPath)}`;
}

function safeHref(href, articleId) {
  const trimmed = href.trim().replace(/^<|>$/g, "");
  if (/^(https?:|mailto:|obsidian:|#)/i.test(trimmed)) return trimmed;
  if (/\.(png|jpe?g|gif|webp|avif|svg|pdf)$/i.test(trimmed)) return assetUrl(trimmed, articleId);
  return "#";
}

function stashHtml(stash, html) {
  const index = stash.push(html) - 1;
  return `\u0000${index}\u0000`;
}

function renderInline(raw, articleId) {
  const stash = [];
  let text = normalizeInlineText(raw);

  text = text.replace(/`([^`]+)`/g, (_, code) => stashHtml(stash, `<code>${escapeHtml(code)}</code>`));
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, src) =>
    stashHtml(
      stash,
      `<img src="${escapeHtml(assetUrl(src, articleId))}" alt="${escapeHtml(alt)}" loading="lazy" />`,
    ),
  );
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, href) =>
    stashHtml(
      stash,
      `<a href="${escapeHtml(safeHref(href, articleId))}" target="_blank" rel="noreferrer">${renderInline(label, articleId)}</a>`,
    ),
  );
  text = text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, page, label) =>
    stashHtml(stash, escapeHtml(label || page)),
  );

  text = escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^\*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");

  return text.replace(/\u0000(\d+)\u0000/g, (_, index) => stash[Number(index)] || "");
}

function tableAlignment(separatorCell) {
  const cell = separatorCell.trim();
  if (cell.startsWith(":") && cell.endsWith(":")) return ' style="text-align:center"';
  if (cell.endsWith(":")) return ' style="text-align:right"';
  return "";
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function renderTable(lines, articleId) {
  const headers = splitTableRow(lines[0]);
  const alignments = splitTableRow(lines[1]);
  const bodyRows = lines.slice(2).map(splitTableRow);

  return `
    <div class="tableWrap">
      <table>
        <thead>
          <tr>${headers
            .map((header, index) => `<th${tableAlignment(alignments[index] || "")}>${renderInline(header, articleId)}</th>`)
            .join("")}</tr>
        </thead>
        <tbody>
          ${bodyRows
            .map(
              (row) =>
                `<tr>${row
                  .map((cell, index) => `<td${tableAlignment(alignments[index] || "")}>${renderInline(cell, articleId)}</td>`)
                  .join("")}</tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderListBlock(lines, articleId, ordered) {
  const tag = ordered ? "ol" : "ul";
  const items = lines.map((line) => {
    const content = ordered ? line.replace(/^\s*\d+\.\s+/, "") : line.replace(/^\s*[-*+]\s+/, "");
    return `<li>${renderInline(content, articleId)}</li>`;
  });
  return `<${tag}>${items.join("")}</${tag}>`;
}

function renderMarkdown(markdown, articleId) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${renderInline(paragraph.join(" "), articleId)}</p>`);
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      continue;
    }

    if (trimmed.startsWith("```")) {
      flushParagraph();
      const language = trimmed.slice(3).trim();
      const codeLines = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      html.push(
        `<pre><code${language ? ` data-language="${escapeHtml(language)}"` : ""}>${escapeHtml(codeLines.join("\n"))}</code></pre>`,
      );
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      const level = Math.min(6, heading[1].length + 1);
      html.push(`<h${level}>${renderInline(heading[2], articleId)}</h${level}>`);
      continue;
    }

    if (/^---+$/.test(trimmed)) {
      flushParagraph();
      html.push("<hr />");
      continue;
    }

    if (trimmed.startsWith(">")) {
      flushParagraph();
      const quoteLines = [];
      while (index < lines.length && lines[index].trim().startsWith(">")) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      index -= 1;
      html.push(`<blockquote>${renderMarkdown(quoteLines.join("\n"), articleId)}</blockquote>`);
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      flushParagraph();
      const listLines = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        listLines.push(lines[index]);
        index += 1;
      }
      index -= 1;
      html.push(renderListBlock(listLines, articleId, false));
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      flushParagraph();
      const listLines = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        listLines.push(lines[index]);
        index += 1;
      }
      index -= 1;
      html.push(renderListBlock(listLines, articleId, true));
      continue;
    }

    if (line.includes("|") && lines[index + 1] && isTableSeparator(lines[index + 1])) {
      flushParagraph();
      const tableLines = [line, lines[index + 1]];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        tableLines.push(lines[index]);
        index += 1;
      }
      index -= 1;
      html.push(renderTable(tableLines, articleId));
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  return html.join("\n");
}

async function loadArticles() {
  elements.articleList.innerHTML = '<li class="emptyList">Loading articles...</li>';
  const response = await fetch("/api/articles");
  if (!response.ok) throw new Error(`Could not load articles: ${response.status}`);
  const { articles } = await response.json();
  state.articles = articles;

  renderStats();
  renderCategories();
  renderList();

  const requested = new URLSearchParams(location.search).get("article");
  const first = filteredArticles()[0];
  await loadArticle(requested || first?.id);
}

elements.articleList.addEventListener("click", async (event) => {
  const readToggle = event.target.closest("[data-read-toggle]");
  if (readToggle) {
    const id = readToggle.dataset.readToggle;
    const article = state.articles.find((candidate) => candidate.id === id);
    if (article) await setArticleRead(id, !article.read);
    return;
  }

  const opener = event.target.closest("[data-open-article]");
  if (opener) {
    await loadArticle(opener.dataset.openArticle);
  }
});

elements.readButton.addEventListener("click", async () => {
  if (!state.article) return;
  await setArticleRead(state.article.id, elements.readButton.dataset.read === "true");
});

elements.searchInput.addEventListener("input", () => {
  state.query = elements.searchInput.value;
  renderList();
});

elements.sortSelect.addEventListener("change", () => {
  state.sort = elements.sortSelect.value;
  persistPrefs();
  renderList();
});

elements.categorySelect.addEventListener("change", () => {
  state.category = elements.categorySelect.value;
  persistPrefs();
  renderList();
});

document.querySelectorAll(".segmentButton").forEach((button) => {
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    document.querySelectorAll(".segmentButton").forEach((candidate) => {
      candidate.classList.toggle("isActive", candidate === button);
    });
    persistPrefs();
    renderList();
  });
});

elements.themeButton.addEventListener("click", () => {
  state.theme = nextThemeMode();
  persistPrefs();
  applyTheme();
});

window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (state.theme === "system") applyTheme();
});

elements.backButton.addEventListener("click", () => {
  document.body.classList.remove("readerOpen");
});

applyTheme();
loadArticles().catch((error) => {
  console.error(error);
  elements.articleList.innerHTML = `<li class="emptyList">Could not load articles. ${escapeHtml(error.message)}</li>`;
  showReader(false);
});
