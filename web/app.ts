import { markdownDownload, markdownDownloadName, renderMarkdown } from "./markdown.js";

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
type ArticleCopy = { markdown: string; capturedAt: string; source: "paste" | "upload"; revision: string };
type BrowserCaptureDraft = { sourceUrl: string; title: string; markdown: string };
type GitHubBackupStatus = {
  configured: boolean; message?: string; repository?: string; branch?: string;
  path?: string; url?: string; state?: "not_saved" | "saved" | "outdated"; backedUpAt?: string;
};
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
const copyDrafts = new Map<string, { markdown: string; source: "paste" | "upload" }>();
let browserCaptureDraft: BrowserCaptureDraft | null = null;
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
    copyDrafts.clear();
    discardPrivateContent();
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
  void renderCopyEditor(article);
}

async function renderCopyEditor(article: Article) {
  const root = $("#detail-content");
  const section = el("section", undefined, "copy-editor");
  section.setAttribute("aria-label", "Markdown copy");
  section.append(el("h3", "Markdown copy"));
  section.append(el("p", "Stored as Markdown text. External image links still depend on the source site.", "muted copy-explainer"));
  const status = el("p", "Checking for a saved copy…", "muted copy-status");
  status.setAttribute("aria-live", "polite");
  const savedActions = el("div", undefined, "saved-copy-actions");
  const readCopy = el("button", "Read saved copy", "button secondary");
  readCopy.type = "button";
  readCopy.hidden = true;
  const downloadCopy = el("button", "Download Markdown", "button secondary");
  downloadCopy.type = "button";
  downloadCopy.hidden = true;
  const label = el("label", "Paste Markdown", "field-label");
  const textarea = el("textarea");
  textarea.rows = 12;
  textarea.maxLength = 262144;
  textarea.setAttribute("aria-label", "Markdown copy");
  textarea.placeholder = "Paste a browser-clipped Markdown copy here…";
  label.append(textarea);
  const fileLabel = el("label", "Load a .md or .markdown file", "field-label copy-file-label");
  const file = el("input");
  file.type = "file";
  file.accept = ".md,.markdown,text/markdown,text/plain";
  fileLabel.append(file);
  const message = el("p", undefined, "notice copy-message");
  message.hidden = true;
  message.setAttribute("role", "status");
  const save = el("button", "Save Markdown copy", "button primary");
  save.type = "button";
  const githubLabel = el("label", undefined, "github-option");
  const githubCheckbox = el("input");
  githubCheckbox.type = "checkbox";
  githubCheckbox.disabled = true;
  githubLabel.append(githubCheckbox, document.createTextNode("Also save to GitHub"));
  const githubStatus = el("p", "Checking GitHub destination…", "muted copy-status");
  githubStatus.setAttribute("aria-live", "polite");
  const githubVisibility = el("p", "GitHub copies follow the repository’s visibility. Unsaved drafts stay here until you save.", "muted copy-explainer");
  const githubRetry = el("button", "Save saved copy to GitHub", "button secondary");
  githubRetry.type = "button";
  githubRetry.hidden = true;
  let saved: ArticleCopy | null = null;
  let github: GitHubBackupStatus | null = null;
  let saving = false;
  let source: ArticleCopy["source"] = "paste";
  save.disabled = true;
  const showError = (text: string) => {
    message.textContent = text;
    message.classList.add("error");
    message.hidden = false;
  };
  const showStatus = (text: string) => {
    status.textContent = text;
  };
  const showCopyActions = () => {
    const available = Boolean(saved) && state.selected?.id === article.id && root.contains(section);
    readCopy.hidden = !available;
    downloadCopy.hidden = !available;
  };
  readCopy.addEventListener("click", () => {
    if (saved && state.selected?.id === article.id && root.contains(section))
      openReader(article, saved);
  });
  downloadCopy.addEventListener("click", () => {
    if (!saved || state.selected?.id !== article.id || !root.contains(section)) return;
    const objectUrl = URL.createObjectURL(markdownDownload(article, saved));
    const anchor = el("a");
    anchor.href = objectUrl;
    anchor.download = markdownDownloadName(article.id);
    savedActions.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  });
  const renderGitHubStatus = () => {
    githubCheckbox.disabled = saving || !github?.configured;
    githubRetry.hidden = !github?.configured || !saved;
    githubRetry.disabled = saving;
    githubStatus.replaceChildren();
    if (!github?.configured) {
      githubStatus.textContent = github?.message || "Couldn’t load GitHub settings. Reopen this article to retry.";
      return;
    }
    const label = github.state === "saved" ? `Saved to GitHub ${dateLabel(github.backedUpAt!)}. `
      : github.state === "outdated" ? "GitHub has an older saved copy or article details. " : "Not saved to GitHub yet. ";
    githubStatus.append(document.createTextNode(label));
    const destination = `${github.repository} · ${github.branch} · ${github.path}`;
    const url = github.url && safeHttpUrl(github.url);
    if (url && github.state !== "not_saved") {
      const link = el("a", destination);
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      githubStatus.append(link);
    } else githubStatus.append(document.createTextNode(destination));
  };
  const refreshGitHubStatus = async () => {
    try {
      const result = await request<{ backup: GitHubBackupStatus }>(`/api/articles/${encodeURIComponent(article.id)}/github`);
      if (state.selected?.id !== article.id || !root.contains(section)) return;
      github = result.backup;
    } catch { github = null; }
    renderGitHubStatus();
  };
  const saveToGitHub = async () => {
    if (!saved) return;
    githubStatus.textContent = "Saving to GitHub…";
    try {
      const result = await request<{ backup: GitHubBackupStatus }>(`/api/articles/${encodeURIComponent(article.id)}/github`, {
        method: "POST", body: JSON.stringify({ expectedRevision: saved.revision }),
      });
      github = result.backup;
      renderGitHubStatus();
      if (github.state === "outdated") showError("GitHub received the saved copy, but this article changed meanwhile. Reload it and save again.");
      else showNotice("Markdown copy saved to GitHub.");
    } catch (error) {
      await refreshGitHubStatus();
      showError(`Your Markdown copy is saved in Potem. Couldn’t save to GitHub. ${(error as Error).message} Use “Save saved copy to GitHub” to retry.`);
    }
  };
  githubRetry.addEventListener("click", async () => {
    saving = true;
    save.disabled = true;
    renderGitHubStatus();
    message.hidden = true;
    try { await saveToGitHub(); }
    finally { saving = false; save.disabled = false; renderGitHubStatus(); }
  });
  file.addEventListener("change", async () => {
    const selected = file.files?.[0];
    if (!selected) return;
    try {
      if (!/\.(?:md|markdown)$/i.test(selected.name)) throw new Error("Choose a .md or .markdown file.");
      if (selected.size > 262144) throw new Error("Markdown files must be at most 262144 bytes.");
      const bytes = new Uint8Array(await selected.arrayBuffer());
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const textBytes = new TextEncoder().encode(text).byteLength;
      if (textBytes > 262144) throw new Error("Markdown files must be at most 262144 UTF-8 bytes.");
      if (!text.trim()) throw new Error("This file is empty. Choose a Markdown file with content.");
      textarea.value = text;
      source = "upload";
      copyDrafts.set(article.id, { markdown: text, source });
      message.hidden = true;
      showStatus(`${selected.name} loaded · ${textBytes.toLocaleString()} UTF-8 bytes. Save when ready.`);
    } catch (error) {
      showError(`Couldn’t load this file. ${(error as Error).message} Choose another file or paste Markdown.`);
    } finally {
      file.value = "";
    }
  });
  textarea.addEventListener("input", () => {
    source = "paste";
    copyDrafts.set(article.id, { markdown: textarea.value, source });
    const bytes = new TextEncoder().encode(textarea.value).byteLength;
    showStatus(`${bytes.toLocaleString()} UTF-8 bytes · Unsaved draft`);
  });
  save.addEventListener("click", async () => {
    const markdown = textarea.value;
    const bytes = new TextEncoder().encode(markdown).byteLength;
    if (!markdown.trim()) {
      showError("Paste or load Markdown before saving.");
      return;
    }
    if (bytes > 262144) {
      showError("Markdown copies must be at most 262144 UTF-8 bytes. Shorten the draft and try again.");
      return;
    }
    if (saved && !confirm("Replace the saved Markdown copy with this draft?")) return;
    const alsoSaveToGitHub = githubCheckbox.checked;
    saving = true;
    renderGitHubStatus();
    save.disabled = true;
    textarea.disabled = true;
    file.disabled = true;
    message.hidden = true;
    try {
      const result = await request<{ copy: ArticleCopy }>(
        `/api/articles/${encodeURIComponent(article.id)}/copy`,
        { method: "PUT", body: JSON.stringify({ markdown, source, expectedRevision: saved?.revision ?? null }) },
      );
      saved = result.copy;
      showCopyActions();
      copyDrafts.delete(article.id);
      const storedBytes = new TextEncoder().encode(saved.markdown).byteLength;
      showStatus(`Saved ${dateLabel(saved.capturedAt)} · ${saved.source === "upload" ? "uploaded file" : "pasted Markdown"} · ${storedBytes.toLocaleString()} UTF-8 bytes`);
      showNotice("Markdown copy saved.");
      if (alsoSaveToGitHub) await saveToGitHub();
      else await refreshGitHubStatus();
    } catch (error) {
      showError(`Couldn’t save the Markdown copy. ${(error as Error).message} Your draft is still here; retry when ready.`);
    } finally {
      saving = false;
      renderGitHubStatus();
      save.disabled = false;
      textarea.disabled = false;
      file.disabled = false;
    }
  });
  savedActions.append(readCopy, downloadCopy);
  section.append(status, savedActions, label, fileLabel, githubLabel, githubVisibility, save, githubStatus, githubRetry, message);
  root.append(section);
  const pendingDraft = copyDrafts.get(article.id);
  if (pendingDraft) {
    textarea.value = pendingDraft.markdown;
    source = pendingDraft.source;
    showStatus(`${new TextEncoder().encode(pendingDraft.markdown).byteLength.toLocaleString()} UTF-8 bytes · Unsaved draft`);
  }
  try {
    const result = await request<{ copy: ArticleCopy | null }>(`/api/articles/${encodeURIComponent(article.id)}/copy`);
    if (state.selected?.id !== article.id || !root.contains(section)) return;
    saved = result.copy;
    showCopyActions();
    const pending = copyDrafts.get(article.id);
    if (pending) {
      textarea.value = pending.markdown;
      source = pending.source;
      showStatus(`${new TextEncoder().encode(pending.markdown).byteLength.toLocaleString()} UTF-8 bytes · Unsaved draft`);
    } else if (saved) {
      textarea.value = saved.markdown;
      source = saved.source;
      const bytes = new TextEncoder().encode(saved.markdown).byteLength;
      showStatus(`Saved ${dateLabel(saved.capturedAt)} · ${saved.source === "upload" ? "uploaded file" : "pasted Markdown"} · ${bytes.toLocaleString()} UTF-8 bytes`);
    } else {
      showStatus("No Markdown copy saved yet.");
    }
    save.disabled = false;
    await refreshGitHubStatus();
  } catch (error) {
    showStatus("Couldn’t load Markdown copy status.");
    showCopyActions();
    showError(`Couldn’t load this copy. ${(error as Error).message} Retry by closing and reopening this article.`);
    save.disabled = true;
  }
}
function openReader(article: Article, copy: ArticleCopy) {
  if (state.selected?.id !== article.id) return;
  const title = $("#reader-title");
  const author = $("#reader-author");
  const metadata = $("#reader-metadata");
  const original = $<HTMLAnchorElement>("#reader-original");
  const body = $("#reader-body");
  title.textContent = article.title;
  author.textContent = article.author ? `By ${article.author}` : "";
  author.hidden = !article.author;
  metadata.textContent = `Captured ${dateLabel(copy.capturedAt)} · ${copy.source === "upload" ? "uploaded file" : "pasted Markdown"} · ${sourceHost(article.url)}`;
  original.href = safeHttpUrl(article.url) || "#";
  body.replaceChildren(renderMarkdown(copy.markdown, article.url));
  $<HTMLDialogElement>("#reader-dialog").showModal();
}
function clearReader() {
  const dialog = document.querySelector<HTMLDialogElement>("#reader-dialog");
  if (!dialog) return;
  if (dialog.open) dialog.close();
  $("#reader-body").replaceChildren();
  $("#reader-title").textContent = "";
  $("#reader-author").textContent = "";
  $("#reader-metadata").textContent = "";
  $<HTMLAnchorElement>("#reader-original").removeAttribute("href");
}
function discardPrivateContent() {
  clearReader();
  const detailDialog = $<HTMLDialogElement>("#detail-dialog");
  if (detailDialog.open) detailDialog.close();
  $("#detail-content").replaceChildren();
  state.selected = null;
}
$("#reader-dialog").addEventListener("close", () => {
  $("#reader-body").replaceChildren();
  $("#reader-title").textContent = "";
  $("#reader-author").textContent = "";
  $("#reader-metadata").textContent = "";
  $<HTMLAnchorElement>("#reader-original").removeAttribute("href");
});
$("#reader-dialog .reader-close").addEventListener("submit", (event) => {
  event.preventDefault();
  clearReader();
});
$("#reader-dialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  clearReader();
});
function openDetail(article: Article) {
  clearReader();
  renderDetail(article);
  $<HTMLDialogElement>("#detail-dialog").showModal();
}
$("#detail-dialog").addEventListener("close", () => {
  clearReader();
  $("#detail-content").replaceChildren();
  state.selected = null;
});
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
  if (raw) try {
    const d = JSON.parse(raw);
    if (!$<HTMLInputElement>("#add-url").value) $<HTMLInputElement>("#add-url").value = d.url || "";
    if (!$<HTMLInputElement>("#add-title").value) $<HTMLInputElement>("#add-title").value = d.title || "";
    showNotice("Your unsaved link is back. Save it when you’re ready.");
    if (!$<HTMLDialogElement>("#add-dialog").open)
      $<HTMLDialogElement>("#add-dialog").showModal();
  } catch {}
  try {
    const capture = sessionStorage.getItem("later-browser-capture-draft");
    if (!capture) return;
    const draft = JSON.parse(capture) as BrowserCaptureDraft;
    if (safeHttpUrl(draft.sourceUrl) && draft.markdown && new TextEncoder().encode(draft.markdown).byteLength <= 262144) {
      browserCaptureDraft = draft;
      if ($<HTMLInputElement>("#add-url").value.trim() === draft.sourceUrl) restoreBrowserCaptureDraft();
    }
  } catch {}
}
function restoreBrowserCaptureDraft() {
  if (!browserCaptureDraft) return;
  if ($<HTMLInputElement>("#add-url").value.trim() !== browserCaptureDraft.sourceUrl) return;
  $<HTMLTextAreaElement>("#capture-markdown").value = browserCaptureDraft.markdown;
  $<HTMLInputElement>("#capture-copy-enabled").checked = true;
  $<HTMLElement>("#capture-copy").hidden = false;
  $("#add-dialog .add-heading p").textContent = "Review the link and captured Markdown before saving.";
  $("#capture-copy-status").textContent = "Review the captured Markdown. Saving a copy is enabled; uncheck it to save the link only.";
  if (!$<HTMLDialogElement>("#add-dialog").open) $<HTMLDialogElement>("#add-dialog").showModal();
}
$<HTMLInputElement>("#add-url").addEventListener("input", () => {
  stashDraft();
  if (browserCaptureDraft) {
    const matches = $<HTMLInputElement>("#add-url").value.trim() === browserCaptureDraft.sourceUrl;
    $<HTMLElement>("#capture-copy").hidden = !matches;
    if (!matches) $("#capture-copy-status").textContent = "The link changed. This captured copy will not be attached to it.";
  }
});
$<HTMLInputElement>("#add-title").addEventListener("input", stashDraft);
$<HTMLTextAreaElement>("#capture-markdown").addEventListener("input", () => {
  if (!browserCaptureDraft) return;
  browserCaptureDraft.markdown = $<HTMLTextAreaElement>("#capture-markdown").value;
  sessionStorage.setItem("later-browser-capture-draft", JSON.stringify(browserCaptureDraft));
});
$("#add-open").addEventListener("click", () => {
  $<HTMLDialogElement>("#add-dialog").showModal();
  $("#add-notice").hidden = true;
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
  const captured = browserCaptureDraft && url === browserCaptureDraft.sourceUrl
    ? browserCaptureDraft
    : null;
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
    const copyEnabled = captured && $<HTMLInputElement>("#capture-copy-enabled").checked;
    let copySaveError = "";
    if (copyEnabled) {
      const markdown = $<HTMLTextAreaElement>("#capture-markdown").value;
      const bytes = new TextEncoder().encode(markdown).byteLength;
      if (!markdown.trim() || bytes > 262144) copySaveError = "The Markdown copy is empty or exceeds the 256 KiB limit.";
      else try {
        await request<{ copy: ArticleCopy }>(`/api/articles/${encodeURIComponent(result.article.id)}/copy`, {
          method: "PUT",
          body: JSON.stringify({ markdown, source: "paste", expectedRevision: null }),
        });
      } catch (error) {
        copySaveError = (error as Error).message;
      }
    }
    const copyNotAttached = Boolean(browserCaptureDraft && !captured);
    const copySkipped = Boolean(captured && !copyEnabled);
    if (!copySaveError) {
      $<HTMLInputElement>("#add-url").value = "";
      $<HTMLInputElement>("#add-title").value = "";
      sessionStorage.removeItem("later-add-draft");
      if (browserCaptureDraft) {
        browserCaptureDraft = null;
        sessionStorage.removeItem("later-browser-capture-draft");
        $<HTMLElement>("#capture-copy").hidden = true;
        $<HTMLTextAreaElement>("#capture-markdown").value = "";
        $("#add-dialog .add-heading p").textContent = "Paste a link and we’ll keep your place.";
      }
    } else {
      stashDraft();
    }
    if (!copySaveError) $<HTMLDialogElement>("#add-dialog").close();
    state.status = "all";
    document
      .querySelectorAll<HTMLButtonElement>("[data-status]")
      .forEach((b) =>
        b.setAttribute("aria-pressed", String(b.dataset.status === "all")),
      );
    if (copySaveError) {
      const addNotice = $("#add-notice");
      addNotice.textContent = `Link saved. Markdown copy was not changed: ${copySaveError} Your draft remains here. Uncheck “Save this Markdown copy” to save the link only.`;
      addNotice.classList.add("error");
      addNotice.hidden = false;
    } else showNotice(
      copyNotAttached
          ? "Link saved. The captured Markdown was not attached because the URL changed."
          : copySkipped
            ? "Link saved. Markdown copy was left out by your choice."
      : result.duplicate
        ? result.metadataUpdated ? "Preview details updated." : "That link is already in your list."
        : "Saved for later.",
    );
    if (copySaveError) {
      await load();
      return;
    }
    await load();
  } catch (err) {
    const addNotice = $("#add-notice");
    addNotice.textContent = `Couldn’t save this link. ${(err as Error).message}`;
    addNotice.classList.add("error");
    addNotice.hidden = false;
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
  copyDrafts.clear();
  browserCaptureDraft = null;
  sessionStorage.removeItem("later-browser-capture-draft");
  sessionStorage.removeItem("later-add-draft");
  discardPrivateContent();
  try {
    await request("/auth/logout", { method: "POST" });
    copyDrafts.clear();
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
const captureChannel = params.get("capture");
if (location.pathname === "/add" && captureChannel) {
  let sourceOrigin = "";
  try { sourceOrigin = new URL(params.get("url") || "").origin; } catch {}
  history.replaceState({}, "", "/add");
  let channel: string | null = captureChannel;
  const onCapture = (event: MessageEvent) => {
    if (!channel || !sourceOrigin || event.source !== window.opener || event.origin !== sourceOrigin || event.data?.type !== "potem-capture" || event.data.channel !== channel) return;
    let sourceUrl: URL;
    try { sourceUrl = new URL(event.data.sourceUrl); } catch { return; }
    if ((sourceUrl.protocol !== "http:" && sourceUrl.protocol !== "https:") || sourceUrl.origin !== event.origin || sourceUrl.href !== $<HTMLInputElement>("#add-url").value.trim()) return;
    const markdown = typeof event.data.markdown === "string" ? event.data.markdown : "";
    const bytes = new TextEncoder().encode(markdown).byteLength;
    const invalidCopy = Boolean(markdown && (bytes > 262144 || !markdown.trim()));
    const title = typeof event.data.sourceTitle === "string" ? event.data.sourceTitle.slice(0, 500) : "";
    channel = null;
    removeEventListener("message", onCapture);
    window.opener = null;
    if (markdown && !invalidCopy) {
      browserCaptureDraft = { sourceUrl: sourceUrl.href, title, markdown };
      sessionStorage.setItem("later-browser-capture-draft", JSON.stringify(browserCaptureDraft));
      $<HTMLInputElement>("#add-title").value = title;
      stashDraft();
      restoreBrowserCaptureDraft();
    } else {
      const error = invalidCopy ? "The captured Markdown is empty or exceeds 256 KiB." : typeof event.data.error === "string" ? event.data.error.slice(0, 500) : "Article extraction failed.";
      const notice = $("#add-notice");
      notice.textContent = `The link is ready. ${error} Save the link, then use the Markdown paste fallback in article details if needed.`;
      notice.classList.add("error");
      notice.hidden = false;
    }
  };
  addEventListener("message", onCapture);
  if (window.opener && sourceOrigin) window.opener.postMessage({ type: "potem-ready", channel: captureChannel }, sourceOrigin);
}
if ("serviceWorker" in navigator)
  addEventListener("load", () =>
    navigator.serviceWorker.register("/sw.js").catch(() => {}),
  );
recoverDraft();
initialize();
