type Article = {
  id: string;
  url: string;
  title: string;
  author: string | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  readAt: string | null;
};
type Session = { authenticated: boolean; csrfToken?: string };
type Page = { items: Article[]; nextCursor: string | null };
const $ = <T extends HTMLElement = HTMLElement>(selector: string): T =>
  document.querySelector<T>(selector)!;
const state = {
  session: null as Session | null,
  status: "unread",
  query: "",
  cursor: null as string | null,
  loading: false,
  theme: localStorage.getItem("later-theme") || "system",
  selected: null as Article | null,
};
const list = $("#articles"),
  notice = $("#notice"),
  empty = $("#empty"),
  loading = $("#loading");
let loadGeneration = 0;
function invalidateLoads() {
  loadGeneration++;
  setBusy(false);
  $<HTMLButtonElement>("#more").disabled = false;
}
function showNotice(message: string, bad = false) {
  notice.textContent = message;
  notice.hidden = !message;
  notice.classList.toggle("error", bad);
  if ($<HTMLDialogElement>("#settings-dialog").open)
    $("#settings-status").textContent = message;
}
function setBusy(value: boolean) {
  state.loading = value;
  loading.hidden = !value;
}
function headers(json = false) {
  const h = new Headers();
  if (json) h.set("Content-Type", "application/json");
  if (state.session?.csrfToken) h.set("X-CSRF-Token", state.session.csrfToken);
  return h;
}
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const mergedHeaders = headers(init.body !== undefined);
  new Headers(init.headers).forEach((value, key) =>
    mergedHeaders.set(key, value),
  );
  const response = await fetch(path, {
    ...init,
    headers: mergedHeaders,
    credentials: "same-origin",
    cache: "no-store",
  });
  if (response.status === 401) {
    stashDraft();
    location.assign("/auth/github");
    throw new Error("Sign in to continue.");
  }
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      message = (await response.json()).error?.message || message;
    } catch {}
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
function stashDraft() {
  const url = $<HTMLInputElement>("#add-url").value.trim();
  if (url)
    sessionStorage.setItem(
      "later-add-draft",
      JSON.stringify({
        url,
        title: $<HTMLInputElement>("#add-title").value.trim(),
      }),
    );
}
function safeHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}
function sourceHost(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Saved link";
  }
}
function dateLabel(date: string) {
  const d = new Date(date);
  return Number.isNaN(d.getTime())
    ? ""
    : new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(d);
}
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function renderArticle(article: Article) {
  const li = el("li", undefined, `article${article.readAt ? " is-read" : ""}`);
  li.dataset.id = article.id;
  const main = el("div", undefined, "article-main");
  const title = el("button", article.title, "article-title");
  title.type = "button";
  title.addEventListener("click", () => openDetail(article));
  const meta = el(
    "p",
    `${sourceHost(article.url)}${article.author ? ` · By ${article.author}` : ""} · Saved ${dateLabel(article.createdAt)}`,
    "article-meta",
  );
  const description = article.description
    ? el("p", article.description, "article-description")
    : null;
  const link = el("a", "Open original ↗", "original-link");
  link.href = safeHttpUrl(article.url) || "#";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.addEventListener("click", (e) => e.stopPropagation());
  main.append(title, meta);
  if (description) main.append(description);
  main.append(link);
  const actions = el("div", undefined, "article-actions");
  const read = el(
    "button",
    article.readAt ? "Mark unread" : "Mark read",
    "action-button",
  );
  read.type = "button";
  read.addEventListener("click", () => mutateRead(article, !article.readAt));
  const edit = el("button", "Edit", "action-button subtle");
  edit.type = "button";
  edit.addEventListener("click", () => openDetail(article));
  actions.append(read, edit);
  li.append(main, actions);
  return li;
}
function render(items: Article[], append = false) {
  if (!append) list.replaceChildren();
  for (const item of items) list.append(renderArticle(item));
  const count = list.children.length;
  $("#result-count").textContent = count ? `${count} shown` : "";
  empty.hidden = count !== 0;
  if (!count) {
    $("#empty h3").textContent = "Nothing here yet";
    $("#empty p").textContent =
      "When you save an article, it’ll be waiting here.";
  }
  $("#more").hidden = !state.cursor;
}
async function load(reset = true) {
  if (!state.session?.authenticated) return;
  const generation = ++loadGeneration;
  if (reset) {
    state.cursor = null;
    list.replaceChildren();
  }
  setBusy(true);
  $<HTMLButtonElement>("#more").disabled = true;
  try {
    const p = new URLSearchParams({ status: state.status, limit: "50" });
    if (state.query) p.set("q", state.query);
    if (state.cursor && !reset) p.set("cursor", state.cursor);
    const page = await request<Page>(`/api/articles?${p}`);
    if (generation !== loadGeneration) return;
    state.cursor = page.nextCursor;
    render(page.items, !reset);
    $("#unread-count").textContent = "Your reading list";
  } catch (e) {
    if (generation !== loadGeneration) return;
    showNotice((e as Error).message, true);
    if (!list.children.length) {
      empty.hidden = false;
      $("#empty h3").textContent = "We couldn’t load your list";
      $("#empty p").textContent = "Check your connection, then try again.";
    }
  } finally {
    if (generation === loadGeneration) {
      setBusy(false);
      $<HTMLButtonElement>("#more").disabled = false;
    }
  }
}
async function mutateRead(article: Article, read: boolean) {
  invalidateLoads();
  try {
    const result = await request<{ article: Article }>(
      `/api/articles/${encodeURIComponent(article.id)}`,
      { method: "PATCH", body: JSON.stringify({ read }) },
    );
    if (state.selected?.id === article.id) state.selected = result.article;
    await load();
    if (state.selected?.id === article.id) renderDetail(state.selected);
  } catch (e) {
    if ($<HTMLDialogElement>("#detail-dialog").open)
      showDetailError((e as Error).message);
    else
      showNotice(`Couldn’t update this article. ${(e as Error).message}`, true);
  }
}
function showDetailError(message: string) {
  let error = document.querySelector<HTMLElement>("#detail-error");
  if (!error) {
    error = el("p", undefined, "notice error");
    error.id = "detail-error";
    error.setAttribute("role", "alert");
    $("#detail-content").prepend(error);
  }
  error.textContent = message;
}
function renderDetail(article: Article) {
  state.selected = article;
  const root = $("#detail-content");
  root.replaceChildren();
  const eyebrow = el("p", sourceHost(article.url), "eyebrow");
  const form = el("form", undefined, "edit-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = input.value.trim();
    if (!title) return;
    try {
      invalidateLoads();
      const result = await request<{ article: Article }>(
        `/api/articles/${encodeURIComponent(article.id)}`,
        { method: "PATCH", body: JSON.stringify({ title }) },
      );
      state.selected = result.article;
      showNotice("Title updated.");
      await load();
      renderDetail(result.article);
    } catch (err) {
      showDetailError((err as Error).message);
    }
  });
  const label = el("label", "Title", "field-label");
  const input = el("input");
  input.value = article.title;
  input.maxLength = 500;
  label.append(input);
  const save = el("button", "Save title", "button primary");
  save.type = "submit";
  form.append(label, save);
  const url = el("a", article.url, "detail-url");
  url.href = safeHttpUrl(article.url) || "#";
  url.target = "_blank";
  url.rel = "noopener noreferrer";
  const actions = el("div", undefined, "detail-actions");
  const toggle = el(
    "button",
    article.readAt ? "Mark unread" : "Mark read",
    "button secondary",
  );
  toggle.type = "button";
  toggle.addEventListener("click", async () => {
    await mutateRead(article, !article.readAt);
  });
  const del = el("button", "Delete article", "button danger");
  del.type = "button";
  del.addEventListener("click", async () => {
    if (!confirm(`Delete “${article.title}”? This can’t be undone.`)) return;
    try {
      invalidateLoads();
      await request(`/api/articles/${encodeURIComponent(article.id)}`, {
        method: "DELETE",
      });
      $<HTMLDialogElement>("#detail-dialog").close();
      showNotice("Article deleted.");
      await load();
    } catch (err) {
      showDetailError((err as Error).message);
    }
  });
  actions.append(toggle, del);
  root.append(
    eyebrow,
    el("h2", article.title),
    ...(article.author ? [el("p", `By ${article.author}`, "muted")] : []),
    ...(article.description ? [el("p", article.description, "detail-description")] : []),
    el("p", `Saved ${dateLabel(article.createdAt)}`, "muted"),
    form,
    el("h3", "Original link"),
    url,
    actions,
  );
}
function openDetail(article: Article) {
  renderDetail(article);
  $<HTMLDialogElement>("#detail-dialog").showModal();
}
async function initialize() {
  try {
    state.session = await request<Session>("/api/session");
  } catch (error) {
    showNotice(
      `Couldn’t check your session. ${(error as Error).message}`,
      true,
    );
    loading.hidden = true;
    empty.hidden = false;
    $("#empty h3").textContent = "We couldn’t load your list";
    $("#empty p").textContent = "Check your connection, then try again.";
    let retry = document.querySelector<HTMLButtonElement>("#session-retry");
    if (!retry) {
      retry = el("button", "Try again", "button secondary");
      retry.id = "session-retry";
      retry.addEventListener("click", () => {
        retry!.remove();
        void initialize();
      });
      $("#empty").append(retry);
    }
    applyTheme();
    return;
  }
  if (!state.session.authenticated) {
    const title = $("#add-heading");
    title.textContent = "Your private reading list";
    const form = $("#add-form");
    form.hidden = true;
    $(".title-option").hidden = true;
    $("#sign-in-prompt").className = "sign-in-prompt";
    $("#sign-in-prompt").hidden = false;
    $("#sign-in-prompt a").addEventListener("click", stashDraft);
    $("#empty h3").textContent = "Your list is waiting";
    $("#empty p").textContent =
      "Sign in to see saved articles across your devices.";
  } else {
    $("#account").hidden = false;
    $("#account").textContent = "Your private library";
    $("#logout").hidden = false;
    await load();
  }
  if (!state.session.authenticated) {
    loading.hidden = true;
    empty.hidden = false;
  }
  applyTheme();
}
function recoverDraft() {
  const raw = sessionStorage.getItem("later-add-draft");
  if (!raw) return;
  try {
    const d = JSON.parse(raw);
    $<HTMLInputElement>("#add-url").value = d.url || "";
    $<HTMLInputElement>("#add-title").value = d.title || "";
    showNotice("Your unsaved link is back. Save it when you’re ready.");
    if (!$<HTMLDialogElement>("#add-dialog").open)
      $<HTMLDialogElement>("#add-dialog").showModal();
  } catch {}
}
$("#add-open").addEventListener("click", () => {
  $<HTMLDialogElement>("#add-dialog").showModal();
  if (state.session?.authenticated) $("#add-url").focus();
});
$("#add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state.session?.authenticated) {
    stashDraft();
    location.assign("/auth/github");
    return;
  }
  const url = $<HTMLInputElement>("#add-url").value.trim(),
    title = $<HTMLInputElement>("#add-title").value.trim();
  const button = $<HTMLButtonElement>("#add-form button");
  button.disabled = true;
  try {
    invalidateLoads();
    const result = await request<{ article: Article; duplicate: boolean; metadataUpdated?: boolean }>(
      "/api/articles",
      {
        method: "POST",
        body: JSON.stringify({ url, ...(title ? { title } : {}) }),
      },
    );
    $<HTMLInputElement>("#add-url").value = "";
    $<HTMLInputElement>("#add-title").value = "";
    sessionStorage.removeItem("later-add-draft");
    $<HTMLDialogElement>("#add-dialog").close();
    state.status = "all";
    document
      .querySelectorAll<HTMLButtonElement>("[data-status]")
      .forEach((b) =>
        b.setAttribute("aria-pressed", String(b.dataset.status === "all")),
      );
    showNotice(
      result.duplicate
        ? result.metadataUpdated ? "Preview details updated." : "That link is already in your list."
        : "Saved for later.",
    );
    await load();
  } catch (err) {
    showNotice(`Couldn’t save this link. ${(err as Error).message}`, true);
  } finally {
    button.disabled = false;
  }
});
document
  .querySelectorAll<HTMLButtonElement>("[data-status]")
  .forEach((button) =>
    button.addEventListener("click", () => {
      invalidateLoads();
      state.status = button.dataset.status || "unread";
      document
        .querySelectorAll("[data-status]")
        .forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
      load();
    }),
  );
let searchTimer: number;
$<HTMLInputElement>("#search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  invalidateLoads();
  state.query = (e.target as HTMLInputElement).value.trim();
  searchTimer = window.setTimeout(() => load(), 250);
});
$("#more").addEventListener("click", () => load(false));
$("#logout").addEventListener("click", async () => {
  try {
    await request("/auth/logout", { method: "POST" });
    location.assign("/");
  } catch (e) {
    showNotice((e as Error).message, true);
  }
});
function applyTheme() {
  const theme =
    state.theme === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : state.theme;
  document.documentElement.dataset.theme = theme;
  $("#theme-toggle").setAttribute(
    "aria-label",
    `Theme: ${state.theme}. Switch theme`,
  );
}
$("#theme-toggle").addEventListener("click", () => {
  state.theme =
    state.theme === "system"
      ? "dark"
      : state.theme === "dark"
        ? "light"
        : "system";
  localStorage.setItem("later-theme", state.theme);
  applyTheme();
});
$("#settings-open").addEventListener("click", openSettings);
$("#footer-settings").addEventListener("click", openSettings);
$("#settings-dialog").addEventListener("close", () => {
  const box = $("#new-token");
  box.replaceChildren();
  box.hidden = true;
});
async function openSettings() {
  $<HTMLDialogElement>("#settings-dialog").showModal();
  if (!state.session?.authenticated) {
    $("#settings-status").textContent =
      "Sign in to manage your capture tokens.";
    $("#token-form").hidden = true;
    $("#tokens").replaceChildren();
    return;
  }
  $("#settings-status").textContent = "Signed in";
  $("#token-form").hidden = false;
  try {
    const data = await request<{
      items: Array<{
        id: string;
        label: string;
        createdAt: string;
        revokedAt: string | null;
      }>;
    }>("/api/capture-tokens");
    const ul = $("#tokens");
    ul.replaceChildren();
    for (const token of data.items) {
      const li = el("li", undefined, "token-item");
      const span = el("span", undefined);
      span.append(
        el("strong", token.label),
        el(
          "small",
          `Created ${dateLabel(token.createdAt)}${token.revokedAt ? " · Revoked" : ""}`,
        ),
      );
      li.append(span);
      if (!token.revokedAt) {
        const revoke = el("button", "Revoke", "action-button danger-text");
        revoke.type = "button";
        revoke.addEventListener("click", async () => {
          if (
            !confirm(
              `Revoke “${token.label}”? Devices using it will stop saving links.`,
            )
          )
            return;
          try {
            await request(
              `/api/capture-tokens/${encodeURIComponent(token.id)}`,
              { method: "DELETE" },
            );
            openSettings();
          } catch (e) {
            $("#settings-status").textContent = (e as Error).message;
          }
        });
        li.append(revoke);
      }
      ul.append(li);
    }
  } catch (e) {
    $("#settings-status").textContent = (e as Error).message;
  }
}
$("#token-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const data = await request<{
      id: string;
      token: string;
      label: string;
      createdAt: string;
    }>("/api/capture-tokens", {
      method: "POST",
      body: JSON.stringify({
        label: $<HTMLInputElement>("#token-label").value.trim(),
      }),
    });
    const box = $("#new-token");
    box.hidden = false;
    box.replaceChildren(
      el("strong", "Copy this token now"),
      el("p", "It will only be shown once."),
    );
    const code = el("code", data.token);
    box.append(code);
    $<HTMLInputElement>("#token-label").value = "";
    openSettings();
  } catch (err) {
    $("#settings-status").textContent = (err as Error).message;
  }
});
$("#export").addEventListener("click", async () => {
  try {
    const response = await fetch("/api/export", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Export failed. Sign in and try again.");
    const blob = await response.blob(),
      a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `later-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    showNotice((e as Error).message, true);
  }
});
$<HTMLInputElement>("#import-file").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement,
    file = input.files?.[0];
  if (!file) return;
  if (file.size > 1024 * 1024) {
    showNotice("Import files must be 1 MB or smaller.", true);
    input.value = "";
    return;
  }
  try {
    const data = JSON.parse(await file.text());
    if (
      !confirm(
        `Import ${Array.isArray(data.articles) ? data.articles.length : "this"} articles? Existing links will be skipped.`,
      )
    )
      return;
    invalidateLoads();
    const result = await request<{ imported: number; skipped: number }>(
      "/api/import",
      { method: "POST", body: JSON.stringify(data) },
    );
    showNotice(
      `Imported ${result.imported} articles; skipped ${result.skipped}.`,
    );
    await load();
  } catch (err) {
    showNotice(`Import failed. ${(err as Error).message}`, true);
  } finally {
    input.value = "";
  }
});
const params = new URLSearchParams(location.search);
if (
  location.pathname === "/add" &&
  (params.has("url") || params.has("title") || params.has("text"))
) {
  const candidates =
    (params.get("text") || "").match(/https?:\/\/[^\s]+/gi) || [];
  const url =
    params.get("url") || (candidates.length === 1 ? candidates[0] : "");
  $<HTMLInputElement>("#add-url").value = url;
  $<HTMLInputElement>("#add-title").value = params.get("title") || "";
  sessionStorage.setItem(
    "later-add-draft",
    JSON.stringify({ url, title: $<HTMLInputElement>("#add-title").value }),
  );
  history.replaceState({}, "", "/add");
  if (url) showNotice("Link prefilled. Review and choose Save link.");
  else
    showNotice(
      "We couldn’t find one clear link. Paste the link you want to save.",
    );
  if (!$<HTMLDialogElement>("#add-dialog").open)
    $<HTMLDialogElement>("#add-dialog").showModal();
}
if ("serviceWorker" in navigator)
  addEventListener("load", () =>
    navigator.serviceWorker.register("/sw.js").catch(() => {}),
  );
recoverDraft();
initialize();
