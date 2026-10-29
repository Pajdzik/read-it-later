import { markdownDownload, markdownDownloadName, renderMarkdown } from "./markdown.js";
import type { IntegrationConfiguration, IntegrationStatus, IntegrationConsent } from "../src/integrations/contracts.js";
import { articlePath, isArticleId } from "../src/articles/identity.js";

declare const __BUILD_INFO__: { commitSha: string; builtAt: string } | null;

const buildInfo = typeof __BUILD_INFO__ === "undefined" ? null : __BUILD_INFO__;
const buildInfoButton = document.querySelector<HTMLButtonElement>("#build-info-open");
const buildInfoDialog = document.querySelector<HTMLDialogElement>("#build-info-dialog");
if (buildInfoButton && buildInfoDialog) {
  const validBuild = buildInfo && buildInfo.commitSha && buildInfo.builtAt && !Number.isNaN(Date.parse(buildInfo.builtAt));
  if (validBuild) {
    const builtAt = new Date(buildInfo.builtAt);
    const shortDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(builtAt);
    const fullDate = new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "long" }).format(builtAt);
    buildInfoButton.textContent = `Build ${shortDate} · ${buildInfo.commitSha.slice(0, 7)}`;
    document.querySelector("#build-info-commit")!.textContent = buildInfo.commitSha;
    document.querySelector("#build-info-time")!.textContent = fullDate;
    const details = `Commit: ${buildInfo.commitSha}\nBuilt: ${fullDate}`;
    document.querySelector("#build-info-copy")!.addEventListener("click", async () => {
      const status = document.querySelector<HTMLElement>("#build-info-copy-status")!;
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
        await navigator.clipboard.writeText(details);
        status.textContent = "Build details copied.";
      } catch {
        status.textContent = "Couldn’t copy build details. Select and copy them manually.";
      }
    });
  } else {
    buildInfoButton.textContent = "Local build";
    document.querySelector("#build-info-metadata")!.setAttribute("hidden", "");
    document.querySelector("#build-info-local")!.removeAttribute("hidden");
    document.querySelector("#build-info-copy")!.setAttribute("hidden", "");
  }
  buildInfoButton.addEventListener("click", () => buildInfoDialog.showModal());
}

type Article = {
  id: string;
  url: string;
  title: string;
  author: string | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  readAt: string | null;
  hasCopy?: boolean;
  extraction?: ExtractionStatus;
};
type ExtractionState = "none" | "queued" | "running" | "retry_wait" | "ready" | "failed";
type ExtractionStatus = {
  state: ExtractionState; attempts: number; errorCode: string | null; nextAttemptAt: string | null; paused: boolean;
  undoAvailable?: boolean;
  recovery?: { generation: number; state: 'queued' | 'running' | 'retry_wait' | 'succeeded' | 'failed'; attempts: number; errorCode: string | null; nextAttemptAt: string | null };
};
type Session = { authenticated: boolean; csrfToken?: string };
type Page = { items: Article[]; nextCursor: string | null };
type ArticleCopy = { markdown: string; capturedAt: string; source: "paste" | "upload"; revision: string };
type BrowserCaptureDraft = {
  sourceUrl: string; title: string; markdown: string; author?: string; description?: string;
  requestId?: string; mode?: 'review' | 'simple'; destination?: IntegrationConsent; extractionError?: string;
  capturedAt?: string; savedArticleId?: string; savedCopyRevision?: string;
  publishRequested?: boolean;
  stage?: 'draft' | 'link-saved' | 'metadata-saving' | 'metadata-saved' | 'copy-saving' | 'copy-saved' | 'publishing' | 'complete';
  conflict?: { article: Article; copy: ArticleCopy | null }; replacementConfirmed?: boolean;
};
function matchesIntegrationDestination(configuration: IntegrationConfiguration | null | undefined, expected: IntegrationConsent | undefined): boolean {
  return Boolean(expected && configuration?.configured && configuration.id === expected.id && configuration.destinationKey === expected.destinationKey);
}
function integrationConsent(configuration: IntegrationConfiguration): IntegrationConsent {
  return { id: configuration.id, destinationKey: configuration.destinationKey };
}
async function sendToIntegration(id: string, revision: string, destination: IntegrationConsent) {
  return request<{ integration: IntegrationStatus; unchanged: boolean }>(`/api/articles/${encodeURIComponent(id)}/integrations/${encodeURIComponent(destination.id)}`, {
    method: 'POST', body: JSON.stringify({ expectedRevision: revision, expectedDestinationKey: destination.destinationKey }),
  });
}
const $ = <T extends HTMLElement = HTMLElement>(selector: string): T =>
  document.querySelector<T>(selector)!;
const READING_POSITION_PREFIX = "later-reading-position:";
const MAX_READER_SCROLL = 10_000_000;
type ReadingPosition = { revision: string; block: number; fraction: number; scrollTop: number };
let readerPositionContext: { id: string; revision: string } | null = null;
let readerPositionTimer = 0;
let restoringReaderPosition = false;
let readerPositionRestorePending = false;
let readerPositionRestoreGeneration = 0;
function readReadingPosition(context: { id: string; revision: string }): ReadingPosition | null {
  try {
    const raw = localStorage.getItem(`${READING_POSITION_PREFIX}${encodeURIComponent(context.id)}`);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<ReadingPosition>;
    if (value.revision !== context.revision) {
      localStorage.removeItem(`${READING_POSITION_PREFIX}${encodeURIComponent(context.id)}`);
      return null;
    }
    if (!Number.isInteger(value.block) || value.block! < -1 || value.block! > 100_000 ||
        typeof value.fraction !== "number" || !Number.isFinite(value.fraction) || value.fraction < -100 || value.fraction > 100 ||
        typeof value.scrollTop !== "number" || !Number.isFinite(value.scrollTop) || value.scrollTop < 0 || value.scrollTop > MAX_READER_SCROLL) return null;
    return value as ReadingPosition;
  } catch { return null; }
}
function saveReadingPosition() {
  window.clearTimeout(readerPositionTimer);
  readerPositionTimer = 0;
  const dialog = $<HTMLDialogElement>("#reader-dialog");
  const context = readerPositionContext;
  if (!context || restoringReaderPosition || readerPositionRestorePending || $("#reader-pending").hidden === false) return;
  const scrollTop = Math.min(MAX_READER_SCROLL, Math.max(0, dialog.scrollTop));
  const body = $("#reader-body");
  const toolbar = $(".reader-toolbar");
  const anchorY = toolbar.getBoundingClientRect().bottom;
  const children = Array.from(body.children) as HTMLElement[];
  let block = -1;
  let fraction = 0;
  const visible = children.findIndex((child) => child.getBoundingClientRect().bottom > anchorY);
  if (visible >= 0) {
    block = visible;
    const bounds = children[visible].getBoundingClientRect();
    fraction = bounds.height > 0 ? Math.max(-100, Math.min(100, (anchorY - bounds.top) / bounds.height)) : 0;
  }
  try {
    localStorage.setItem(`${READING_POSITION_PREFIX}${encodeURIComponent(context.id)}`, JSON.stringify({ revision: context.revision, block, fraction, scrollTop }));
  } catch { /* Reading remains available when browser storage is disabled or full. */ }
}
function scheduleReadingPositionSave() {
  if (!readerPositionContext || restoringReaderPosition) return;
  window.clearTimeout(readerPositionTimer);
  readerPositionTimer = window.setTimeout(saveReadingPosition, 300);
}
function restoreReadingPosition(context: { id: string; revision: string }) {
  const generation = ++readerPositionRestoreGeneration;
  readerPositionRestorePending = false;
  restoringReaderPosition = false;
  const position = readReadingPosition(context);
  if (!position) return;
  const dialog = $<HTMLDialogElement>("#reader-dialog");
  restoringReaderPosition = true;
  readerPositionRestorePending = true;
  requestAnimationFrame(() => {
    if (generation !== readerPositionRestoreGeneration) return;
    if (!dialog.open || readerPositionContext !== context) {
      readerPositionRestorePending = false;
      restoringReaderPosition = false;
      return;
    }
    if (position.scrollTop === 0) {
      dialog.scrollTop = position.scrollTop;
    } else {
      const body = $("#reader-body");
      const block = position.block >= 0 ? body.children.item(position.block) as HTMLElement | null : null;
      if (block) {
        const toolbar = $(".reader-toolbar");
        const bounds = block.getBoundingClientRect();
        dialog.scrollTop = Math.max(0, Math.min(MAX_READER_SCROLL,
          dialog.scrollTop + bounds.top + position.fraction * bounds.height - toolbar.getBoundingClientRect().bottom));
      } else dialog.scrollTop = position.scrollTop;
    }
    requestAnimationFrame(() => {
      if (readerPositionContext === context && generation === readerPositionRestoreGeneration) {
        readerPositionRestorePending = false;
        restoringReaderPosition = false;
      }
    });
  });
}
function showDialog(dialog: HTMLDialogElement, target: HTMLElement | null = null) {
  dialog.showModal();
  target?.focus({ preventScroll: true });
}
function parseReaderPath(pathname: string): ReaderRoute {
  if (pathname !== "/read" && pathname !== "/read/" && !pathname.startsWith("/read/")) return null;
  if (pathname === "/read" || pathname === "/read/") return { invalid: true };
  const parts = pathname.slice(6).replace(/\/$/, "").split("/");
  try {
    const id = decodeURIComponent(parts[0] || "");
    const slug = parts[1] === undefined ? undefined : decodeURIComponent(parts[1]);
    if (parts.length > 2 || !isArticleId(id) || (slug !== undefined && (!slug || slug.includes("/") || slug.includes("\\")))) return { invalid: true };
    return { id, ...(slug === undefined ? {} : { slug }) };
  } catch { return { invalid: true }; }
}
function listHistoryState(): ReaderHistoryState { return { potem: { version: 1, kind: "list" } }; }
function readerHistoryState(id: string, fromList: boolean): ReaderHistoryState { return { potem: { version: 1, kind: "reader", articleId: id, fromList } }; }
function setListTitle() { document.title = "potem — your reading list"; }
function setArticleTitle(article: Article) { document.title = `${article.title} · Potem`; }
function rememberListView(opener?: HTMLElement) {
  const active = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const article = active?.closest<HTMLElement>(".article");
  listSnapshot = { scrollY: window.scrollY, cursor: state.cursor, pageCount: Math.max(1, Math.ceil(list.children.length / 50)), focus: active, focusArticleId: article?.dataset.id || null, focusKind: active?.classList.contains("article-lead") ? "lead" : article ? "title" : "other", status: state.status, query: state.query, rowCount: list.children.length };
}
async function restoreListView() {
  const completion = pendingReadCompletion;
  pendingReadCompletion = null;
  if (!listSnapshot && !completion) return;
  const snapshot = listSnapshot;
  if (snapshot) {
    state.status = snapshot.status;
    state.query = snapshot.query;
    $<HTMLInputElement>("#search").value = snapshot.query;
    document.querySelectorAll<HTMLButtonElement>("[data-status]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.status === snapshot.status)));
  }
  let refreshed = true;
  if (completion || (snapshot && list.children.length !== snapshot.rowCount)) {
    refreshed = await load() === true;
    for (let page = 1; refreshed && page < (snapshot?.pageCount || 1) && state.cursor; page++) {
      if (parseReaderPath(location.pathname)) return;
      refreshed = await load(false) === true;
    }
  }
  if (parseReaderPath(location.pathname)) return;
  const fallback = snapshot?.focusArticleId
    ? list.querySelector<HTMLElement>(`.article[data-id="${CSS.escape(snapshot.focusArticleId)}"] .${snapshot.focusKind === "lead" ? "article-lead" : "article-title"}`)
    : null;
  const target = !completion && snapshot?.focus?.isConnected ? snapshot.focus : fallback || (!completion && document.querySelector<HTMLElement>("#last-opened-title")) || document.querySelector<HTMLElement>("[data-status][aria-pressed='true']") || document.querySelector<HTMLElement>("#search");
  if (completion) {
    showNotice(refreshed ? completion : `${completion} Couldn’t refresh your library.`, !refreshed);
    if (!refreshed) {
      const retry = el("button", "Retry", "text-button");
      retry.type = "button";
      retry.addEventListener("click", () => {
        pendingReadCompletion = completion;
        void restoreListView();
      });
      notice.append(document.createTextNode(" "), retry);
    }
  }
  // Announce the result before restoring scroll so the notice cannot shift
  // the saved library position through browser scroll anchoring.
  window.scrollTo(0, snapshot?.scrollY || 0);
  target?.focus({ preventScroll: true });
}
function readLastOpenedId(): string | null {
  try {
    const raw = localStorage.getItem(lastOpenedStorageKey);
    if (!raw) return null;
    const item = JSON.parse(raw);
    if (item?.version === 1 && isArticleId(item.articleId) && typeof item.openedAt === "string" && Number.isFinite(Date.parse(item.openedAt))) return item.articleId;
    localStorage.removeItem(lastOpenedStorageKey);
  } catch { try { localStorage.removeItem(lastOpenedStorageKey); } catch {} }
  return null;
}
function renderLastOpened() {
  const row = document.querySelector<HTMLElement>("#last-opened");
  const link = document.querySelector<HTMLAnchorElement>("#last-opened-title");
  const status = document.querySelector<HTMLElement>("#last-opened-status");
  if (!row || !link || !status) return;
  const scrollX = window.scrollX, scrollY = window.scrollY;
  const inProgress = lastOpenedArticle && !lastOpenedArticle.readAt ? lastOpenedArticle : null;
  const article = inProgress || (!lastOpenedError ? suggestedArticle : null);
  const error = lastOpenedError || suggestionError;
  const label = inProgress || lastOpenedError ? "Last opened" : "Picked for you";
  row.hidden = !state.session?.authenticated || (!article && !error && !suggestionLoading);
  row.setAttribute("aria-label", label);
  row.setAttribute("aria-busy", String(suggestionLoading));
  $("#last-opened-label").textContent = label;
  link.hidden = !article;
  status.hidden = !error && (!suggestionLoading || Boolean(article));
  status.textContent = error || (suggestionLoading ? "Picking something from your unread articles…" : "");
  const retry = document.querySelector<HTMLButtonElement>("#last-opened-retry");
  if (retry) retry.hidden = !error || suggestionLoading;
  const shuffle = $<HTMLButtonElement>("#suggestion-shuffle");
  shuffle.hidden = Boolean(inProgress || lastOpenedError || !suggestedArticle || !suggestionHasAlternative);
  shuffle.disabled = suggestionLoading;
  const source = $("#last-opened-source");
  source.hidden = !article || Boolean(inProgress);
  source.textContent = article && !inProgress ? `${sourceHost(article.url)}${article.author ? ` · ${article.author}` : ""}` : "";
  if (article) {
    link.textContent = article.title; link.href = articlePath(article); link.dataset.articleId = article.id;
    if (!link.dataset.navigationBound) {
      link.dataset.navigationBound = "true";
      link.addEventListener("click", (event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); void navigateToArticle(link.dataset.articleId || "", link);
      });
    }
  } else {
    link.textContent = ""; link.removeAttribute("href"); delete link.dataset.articleId;
  }
  // Updating the shortcut above the list must not move its background view.
  window.scrollTo(scrollX, scrollY);
}
async function loadSuggestion(shuffle = false) {
  if (!state.session?.authenticated || !lastOpenedReady || lastOpenedError ||
      (lastOpenedArticle && !lastOpenedArticle.readAt) || suggestionLoading || ((suggestionLoaded || suggestionError) && !shuffle)) return;
  const generation = ++suggestionFetchGeneration;
  suggestionLoading = true;
  suggestionError = "";
  renderLastOpened();
  try {
    const query = shuffle && suggestedArticle ? `?exclude=${encodeURIComponent(suggestedArticle.id)}` : "";
    const result = await request<{ article: Article | null; hasAlternative: boolean }>(`/api/articles/suggestion${query}`);
    if (generation !== suggestionFetchGeneration) return;
    suggestedArticle = result.article;
    suggestionHasAlternative = result.hasAlternative;
    suggestionLoaded = true;
  } catch {
    if (generation !== suggestionFetchGeneration) return;
    suggestionError = "Couldn’t pick an article. Try again.";
  } finally {
    if (generation === suggestionFetchGeneration) {
      suggestionLoading = false;
      renderLastOpened();
    }
  }
}
function resetSuggestion() {
  suggestionFetchGeneration++;
  suggestedArticle = null;
  suggestionLoaded = false;
  suggestionLoading = false;
  suggestionError = "";
  suggestionHasAlternative = false;
}
async function loadLastOpened() {
  const generation = ++lastOpenedFetchGeneration;
  const id = readLastOpenedId();
  if (!state.session?.authenticated || !id) {
    lastOpenedArticle = null; lastOpenedError = ""; lastOpenedReady = true;
    renderLastOpened(); void loadSuggestion(); return;
  }
  try {
    const { article } = await request<{ article: Article }>(`/api/articles/${encodeURIComponent(id)}`);
    if (generation !== lastOpenedFetchGeneration || readLastOpenedId() !== id) return;
    lastOpenedArticle = article; lastOpenedError = ""; lastOpenedReady = true;
    renderLastOpened(); void loadSuggestion();
  } catch (error) {
    if (generation !== lastOpenedFetchGeneration) return;
    if ((error as Error & { status?: number }).status === 404) {
      try { localStorage.removeItem(lastOpenedStorageKey); } catch {}
      lastOpenedArticle = null; lastOpenedError = "";
    } else { lastOpenedArticle = null; lastOpenedError = "Couldn’t load the last opened article."; }
    lastOpenedReady = true;
    renderLastOpened(); void loadSuggestion();
  }
}
function saveLastOpened(article: Article) {
  lastOpenedFetchGeneration++;
  resetSuggestion();
  try { localStorage.setItem(lastOpenedStorageKey, JSON.stringify({ version: 1, articleId: article.id, openedAt: new Date().toISOString() })); } catch {}
  lastOpenedArticle = article; lastOpenedError = ""; lastOpenedReady = true;
  renderLastOpened(); void loadSuggestion();
}
function clearLastOpened(id?: string) {
  if (!id || suggestionLoading || suggestedArticle?.id === id) resetSuggestion();
  if (id && readLastOpenedId() !== id) return;
  lastOpenedFetchGeneration++;
  try { localStorage.removeItem(lastOpenedStorageKey); } catch {}
  lastOpenedArticle = null; lastOpenedError = ""; lastOpenedReady = true; renderLastOpened();
}
function rememberReaderForAuthentication() {
  const route = parseReaderPath(location.pathname);
  if (!route || !("id" in route)) return;
  try { sessionStorage.setItem(pendingReaderStorageKey, JSON.stringify({ version: 1, articleId: route.id, createdAt: Date.now() })); } catch {}
}
function resumePendingReader() {
  if (!state.session?.authenticated) return;
  try {
    const pending = JSON.parse(sessionStorage.getItem(pendingReaderStorageKey) || "null");
    if (pending?.version !== 1 || !isArticleId(pending.articleId) || !Number.isFinite(pending.createdAt) || Date.now() < pending.createdAt || Date.now() - pending.createdAt >= 30 * 60 * 1000) {
      sessionStorage.removeItem(pendingReaderStorageKey); return;
    }
    const route = parseReaderPath(location.pathname);
    if (route && (!("id" in route) || route.id !== pending.articleId || readerArticleId === pending.articleId)) {
      sessionStorage.removeItem(pendingReaderStorageKey); return;
    }
    if (browserCaptureDraft || sessionStorage.getItem("later-extension-connect-request")) return;
    if (sessionStorage.getItem("later-add-draft")) return;
    sessionStorage.removeItem(pendingReaderStorageKey);
    history.replaceState(readerHistoryState(pending.articleId, false), "", `/read/${pending.articleId}`);
    void openArticleById(pending.articleId);
  } catch { try { sessionStorage.removeItem(pendingReaderStorageKey); } catch {} }
}
const searchControl = $<HTMLElement>("#search-control");
const searchToggle = $<HTMLButtonElement>("#search-toggle");
const searchField = $<HTMLElement>("#search-field");
const searchInput = $<HTMLInputElement>("#search");
const statusTabs = $<HTMLElement>("#status-tabs");
function updateSearchState() {
  const hasQuery = Boolean(searchInput.value.trim());
  searchControl.classList.toggle("has-query", hasQuery);
  searchToggle.setAttribute("aria-label", hasQuery ? "Search (active)" : "Search");
  searchToggle.title = hasQuery ? "Search (active)" : "Search";
}
function setSearchOpen(open: boolean, focus = false) {
  searchControl.classList.toggle("is-open", open);
  searchControl.closest(".topbar")?.classList.toggle("search-open", open);
  searchToggle.setAttribute("aria-expanded", String(open));
  searchField.setAttribute("aria-hidden", String(!open));
  searchInput.disabled = !open;
  searchInput.tabIndex = open ? 0 : -1;
  updateSearchState();
  if (open && focus) requestAnimationFrame(() => searchInput.focus({ preventScroll: true }));
}
const state = {
  session: null as Session | null,
  status: "unread",
  query: "",
  cursor: null as string | null,
  loading: false,
  theme: (() => { try { return localStorage.getItem("later-theme") || "system"; } catch { return "system"; } })(),
  selected: null as Article | null,
};
const copyDrafts = new Map<string, { markdown: string; source: "paste" | "upload" }>();
let browserCaptureDraft: BrowserCaptureDraft | null = null;
let captureIntegrationConfiguration: IntegrationConfiguration | null = null;
let captureIntegrations: IntegrationConfiguration[] = [];
let captureIntegrationConfigurationPromise: Promise<void> | null = null;
let readerLoadGeneration = 0;
const readerCloseEvents: Array<{ generation: number; opener: HTMLElement | null }> = [];
let readerReturnFocus: HTMLElement | null = null;
const lastOpenedStorageKey = "potem-last-opened-v1";
const pendingReaderStorageKey = "potem-pending-reader-v1";
type ReaderRoute = { id: string; slug?: string } | { invalid: true } | null;
type ReaderHistoryState = { potem?: { version: 1; kind: "list" | "reader"; articleId?: string; fromList?: boolean } };
let readerArticleId: string | null = null;
let lastOpenedFetchGeneration = 0;
let lastOpenedArticle: Article | null = null;
let lastOpenedError = "";
let lastOpenedReady = false;
let suggestedArticle: Article | null = null;
let suggestionFetchGeneration = 0;
let suggestionLoading = false;
let suggestionLoaded = false;
let suggestionHasAlternative = false;
let suggestionError = "";
let readerFromList = false;
let readerReturnPending = false;
let pendingReadCompletion: string | null = null;
let readerReadRequest: object | null = null;
let listSnapshot: { scrollY: number; cursor: string | null; pageCount: number; focus: HTMLElement | null; focusArticleId: string | null; focusKind: "title" | "lead" | "other"; status: string; query: string; rowCount: number } | null = null;
let extractionPollTimer = 0;
let extractionPollStartedAt = 0;
let extractionPollGeneration = 0;
const extensionUrl = new URL(location.href);
const extensionHandoffId = extensionUrl.searchParams.get('extension');
let extensionDraftReceived = false;
let extensionAutosaveStarted = false;
const connectRequestId = new URL(location.href).pathname === '/extension-connect'
  ? new URL(location.href).searchParams.get('request') : null;
if (connectRequestId) sessionStorage.setItem('later-extension-connect-request', connectRequestId);
function extensionPost(type: string, requestId: string, extra: Record<string, unknown> = {}) {
  window.postMessage({ namespace: 'potem-extension', version: 1, type, requestId, ...extra }, location.origin);
}
window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as Record<string, unknown> | null;
  if (event.source !== window || event.origin !== location.origin || !message || message.namespace !== 'potem-extension' || message.version !== 1) return;
  if (message.type !== 'deliver-capture' || typeof message.requestId !== 'string' || message.requestId !== extensionHandoffId || !message.capture || typeof message.capture !== 'object') return;
  const capture = message.capture as Record<string, unknown>;
  const rawSourceUrl = typeof capture.sourceUrl === 'string' ? capture.sourceUrl : '';
  const sourceUrl = safeHttpUrl(rawSourceUrl);
  const markdown = typeof capture.markdown === 'string' ? capture.markdown : '';
  if (capture.version !== 1 || capture.requestId !== message.requestId || (!sourceUrl && capture.extractionError !== 'unsupported') ||
      new TextEncoder().encode(rawSourceUrl).byteLength > 8192 || new TextEncoder().encode(markdown).byteLength > 262144 ||
      typeof capture.title !== 'string' || capture.title.length > 500 || !['review', 'simple'].includes(String(capture.mode))) return;
  const draft: BrowserCaptureDraft = {
    requestId: message.requestId, sourceUrl: sourceUrl || rawSourceUrl, title: capture.title, markdown,
    mode: capture.mode as 'review' | 'simple', capturedAt: typeof capture.capturedAt === 'string' ? capture.capturedAt : undefined,
    ...(typeof capture.author === 'string' ? { author: capture.author.slice(0, 200) } : {}),
    ...(typeof capture.description === 'string' ? { description: capture.description.slice(0, 500) } : {}),
    ...(capture.destination && typeof capture.destination === 'object' ? { destination: capture.destination as IntegrationConsent } : {}),
    ...(typeof capture.extractionError === 'string' ? { extractionError: capture.extractionError } : {}),
  };
  try {
    sessionStorage.setItem('later-extension-capture', JSON.stringify(draft));
    sessionStorage.setItem('later-extension-request', message.requestId);
    browserCaptureDraft = draft;
    extensionDraftReceived = true;
    $<HTMLInputElement>('#add-url').value = sourceUrl || '';
    $<HTMLInputElement>('#add-title').value = draft.title;
    $<HTMLInputElement>('#capture-author').value = draft.author || '';
    $<HTMLTextAreaElement>('#capture-description').value = draft.description || '';
    restoreBrowserCaptureDraft();
    if (!$<HTMLDialogElement>('#add-dialog').open) $<HTMLDialogElement>('#add-dialog').showModal();
    extensionPost('ack-capture', message.requestId);
    void finishExtensionSetup();
  } catch { /* Quota failures are surfaced by the 20-second extension handoff deadline. */ }
});
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
function showExtensionResult(article: Article, sourceUrl: string, integrationUrl?: string) {
  notice.replaceChildren(document.createTextNode('Saved. '));
  const link = (href: string, label: string) => {
    const anchor = document.createElement('a'); anchor.href = href; anchor.textContent = label;
    if (/^https?:/.test(href)) { anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; }
    return anchor;
  };
  notice.append(link(articlePath(article), 'Read in Potem'), document.createTextNode(' · '));
  if (integrationUrl) notice.append(link(integrationUrl, 'Open destination'), document.createTextNode(' · '));
  notice.append(link(sourceUrl, 'Open original'));
  notice.hidden = false; notice.classList.remove('error');
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
    rememberReaderForAuthentication();
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
    const error = new Error(message) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
function stashDraft() {
  const url = $<HTMLInputElement>("#add-url").value.trim();
  if (browserCaptureDraft?.requestId && url === browserCaptureDraft.sourceUrl) {
    browserCaptureDraft.title = $<HTMLInputElement>("#add-title").value.trim();
    sessionStorage.setItem('later-extension-capture', JSON.stringify(browserCaptureDraft));
  }
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
function extractionLabel(extraction?: ExtractionStatus) {
  if (extraction?.recovery) {
    const recovery = extraction.recovery;
    if (recovery.state === 'failed') return `Recapture failed. ${extractionFailureMessage(recovery.errorCode)}`;
    if (recovery.state === 'succeeded') return 'Recapture completed';
    if (extraction.paused) return 'Recapture queued · Capture paused';
    return recovery.state === 'queued' ? 'Recapture queued' : recovery.state === 'retry_wait' ? 'Recapture retrying' : 'Recapturing article';
  }
  if (!extraction || extraction.state === "none") return "";
  if (extraction.state === "ready") return "Markdown ready";
  if (extraction.state === "failed") return "Capture failed";
  if (extraction.paused) return "Capture paused";
  return extraction.state === "retry_wait" ? "Capture retrying" : "Capturing Markdown";
}
function renderArticleMeta(article: Article) {
  const meta = el("p", undefined, "article-meta");
  meta.append(el("span", sourceHost(article.url), "article-meta-domain"));
  if (article.author) {
    meta.append(document.createTextNode(" · "));
    meta.append(el("span", `By ${article.author}`));
  }
  meta.append(document.createTextNode(" · "));
  meta.append(el("span", `Saved ${dateLabel(article.createdAt)}`, "article-meta-date"));
  if (article.extraction?.paused) meta.append(document.createTextNode(" · Capture paused"));
  return meta;
}
function updateExtractionBadge(badge: HTMLElement, extraction?: ExtractionStatus) {
  badge.classList.toggle("extraction-badge-pending", extractionIsPending(extraction));
  const failed = extraction?.recovery?.state === 'failed' || extraction?.state === "failed";
  const ready = extraction?.state === "ready" && !failed && !extractionIsPending(extraction);
  const label = extraction?.paused && !extraction?.recovery ? "" : extractionLabel(extraction);
  badge.classList.toggle("extraction-badge-ready", ready);
  badge.classList.toggle("extraction-badge-failed", failed);
  badge.hidden = !label;
  if (extractionIsPending(extraction)) {
    badge.setAttribute("role", "img");
    badge.setAttribute("aria-label", label);
    badge.title = label;
    badge.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3 2" /></svg>';
    return;
  }
  if (ready) {
    badge.setAttribute("role", "img");
    badge.setAttribute("aria-label", "Markdown ready");
    badge.title = "Markdown ready";
    badge.innerHTML = iconMarkup("mark-read");
    return;
  }
  if (failed) {
    badge.setAttribute("role", "img");
    badge.setAttribute("aria-label", label);
    badge.title = label;
    badge.innerHTML = iconMarkup("capture-failed");
    return;
  }
  badge.removeAttribute("role");
  badge.removeAttribute("aria-label");
  badge.removeAttribute("title");
  badge.textContent = label;
}
function extractionIsPending(extraction?: ExtractionStatus) {
  return Boolean(extraction && ["queued", "running", "retry_wait"].includes(extraction.recovery?.state ?? extraction.state));
}
function extractionFailureMessage(code: string | null | undefined) {
  switch (code) {
    case 'copy_changed': return 'The saved copy changed. Your latest copy was kept.';
    case 'metadata_changed': return 'Article details changed during capture. Your saved content was kept.';
    case "source_http":
    case "source_unavailable": return "The source site could not be reached.";
    case "upstream_http": return "The source site refused the request or is unavailable.";
    case "network_error": return "A network error interrupted capture.";
    case "timeout": return "The source site took too long to respond.";
    case "unsupported_content":
    case "unsupported_content_type": return "This link does not serve a supported article page.";
    case "source_too_large":
    case "response_too_large": return "The source page is larger than the capture limit.";
    case "unsafe_destination":
    case "unsafe_redirect":
    case "redirect_downgrade":
    case "redirect_loop":
    case "too_many_redirects":
    case "unvalidated_redirect": return "The source link could not be fetched safely.";
    case "unsupported_encoding":
    case "invalid_encoding": return "The source page uses an unsupported text encoding.";
    case "conversion_failed": return "The source page could not be converted to Markdown.";
    case "storage_failed":
    case "copy_unavailable": return "The Markdown copy could not be saved.";
    default: return "Markdown capture failed.";
  }
}
function stopExtractionPolling() {
  window.clearTimeout(extractionPollTimer);
  extractionPollTimer = 0;
  extractionPollGeneration++;
}
function scheduleExtractionPoll(article: Article) {
  stopExtractionPolling();
  if (!state.session?.authenticated || document.visibilityState === "hidden" || !extractionIsPending(article.extraction)) return;
  if (!$<HTMLDialogElement>("#detail-dialog").open && !$<HTMLDialogElement>("#reader-dialog").open) return;
  const generation = extractionPollGeneration;
  const delay = Date.now() - extractionPollStartedAt < 60_000 ? 5_000 : 30_000;
  extractionPollTimer = window.setTimeout(async () => {
    try {
      const result = await request<{ extraction: ExtractionStatus }>(`/api/articles/${encodeURIComponent(article.id)}/extraction`);
      if (generation !== extractionPollGeneration || state.selected?.id !== article.id) return;
      let updated = { ...state.selected, extraction: result.extraction } as Article;
      if (!extractionIsPending(result.extraction)) {
        const detail = await request<{ article: Article }>(`/api/articles/${encodeURIComponent(article.id)}`);
        if (generation !== extractionPollGeneration || state.selected?.id !== article.id) return;
        updated = { ...detail.article, extraction: result.extraction };
      }
      state.selected = updated;
      const detailStatus = document.querySelector('#detail-extraction-status');
      if (detailStatus) detailStatus.textContent = extractionLabel(result.extraction);
      const row = list.querySelector<HTMLElement>(`[data-id="${CSS.escape(article.id)}"]`);
      if (row && !extractionIsPending(result.extraction)) {
        row.replaceWith(renderArticle(updated));
        if (lastOpenedArticle?.id === updated.id) lastOpenedArticle = updated;
        if (suggestedArticle?.id === updated.id) suggestedArticle = updated;
        renderLastOpened();
      } else if (row) {
        const meta = row.querySelector<HTMLElement>(".article-meta");
        if (meta) meta.replaceWith(renderArticleMeta({ ...article, extraction: result.extraction }));
        const badge = row.querySelector<HTMLElement>(".extraction-badge");
        if (badge) updateExtractionBadge(badge, result.extraction);
      }
      if (!extractionIsPending(result.extraction) && result.extraction.state === "ready") {
        if ($<HTMLDialogElement>("#reader-dialog").open) {
          if (!$("#reader-body").hidden && result.extraction.recovery) {
            if (result.extraction.recovery.state === 'succeeded') $("#reader-new-copy").hidden = false;
            else showNotice(extractionLabel(result.extraction), true);
          } else {
            const copy = await request<{ copy: ArticleCopy | null }>(`/api/articles/${encodeURIComponent(article.id)}/copy`);
            if (copy.copy && generation === extractionPollGeneration && state.selected?.id === article.id && $<HTMLDialogElement>("#reader-dialog").open && !$<HTMLDialogElement>("#detail-dialog").open) openReader(updated, copy.copy);
          }
        } else if ($<HTMLDialogElement>("#detail-dialog").open) refreshDetailAfterExtraction(updated);
        stopExtractionPolling();
        return;
      }
      if (result.extraction.state === "failed") {
        if ($<HTMLDialogElement>("#detail-dialog").open) refreshDetailAfterExtraction(updated);
        else renderPendingReader(updated);
        stopExtractionPolling();
        return;
      }
      const status = $("#reader-pending-status");
      if ($<HTMLDialogElement>("#reader-dialog").open && !status.hidden) status.textContent = extractionLabel(result.extraction);
      if ($<HTMLDialogElement>("#detail-dialog").open) {
        const detailStatus = $("#detail-extraction-status");
        if (detailStatus) detailStatus.textContent = extractionLabel(result.extraction);
      }
      scheduleExtractionPoll(updated);
    } catch {
      if (generation === extractionPollGeneration) scheduleExtractionPoll(article);
    }
  }, delay);
}
function startExtractionPolling(article: Article) {
  stopExtractionPolling();
  extractionPollStartedAt = Date.now();
  scheduleExtractionPoll(article);
}
function refreshDetailAfterExtraction(article: Article) {
  const root = $("#detail-content");
  if (root.querySelector<HTMLElement>('.copy-editor')?.dataset.saving === 'true') return;
  const input = root.querySelector<HTMLInputElement>(".edit-form input");
  const titleDraft = input && input.value !== input.defaultValue ? input.value : undefined;
  renderDetail(article);
  const titleInput = root.querySelector<HTMLInputElement>(".edit-form input");
  if (titleDraft !== undefined && titleInput) {
    titleInput.value = titleDraft;
    titleInput.dispatchEvent(new Event('input'));
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    stopExtractionPolling();
    return;
  }
  if (state.selected && extractionIsPending(state.selected.extraction)) scheduleExtractionPoll(state.selected);
});
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
type IconName = "capture-failed" | "edit" | "external" | "mark-read" | "mark-unread";
function iconMarkup(name: IconName): string {
  switch (name) {
    case "capture-failed":
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v6m0 4h.01" /></svg>';
    case "edit":
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 16.5-.8 3.3 3.3-.8L18.7 6.8a2.3 2.3 0 0 0-3.3-3.3L4 16.5Z" /><path d="m13.9 5.1 5 5" /></svg>';
    case "external":
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6m-1-5-9 9" /><path d="M11 5H7a4 4 0 0 0-4 4v8a4 4 0 0 0 4 4h8a4 4 0 0 0 4-4v-4" /></svg>';
    case "mark-unread":
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7" /></svg>';
    case "mark-read":
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4.5 4.5L19 7" /></svg>';
  }
}
function iconButton(label: string, icon: IconName, className = "") {
  const button = el("button", undefined, `action-button icon-action${className ? ` ${className}` : ""}`);
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.innerHTML = iconMarkup(icon);
  return button;
}
function iconLink(label: string, icon: IconName, className = "") {
  const link = el("a", undefined, `action-button icon-action${className ? ` ${className}` : ""}`);
  link.setAttribute("aria-label", label);
  link.title = label;
  link.innerHTML = iconMarkup(icon);
  return link;
}
function renderArticle(article: Article) {
  const li = el("li", undefined, `article${article.readAt ? " is-read" : ""}`);
  li.dataset.id = article.id;
  const main = el("div", undefined, "article-main");
  const title = el("a", article.title, "article-title");
  title.href = articlePath(article);
  title.dataset.articleId = article.id;
  title.addEventListener("click", (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); void navigateToArticle(article.id, title);
  });
  const metaRow = el("div", undefined, "article-meta-row");
  const meta = renderArticleMeta(article);
  const extractionBadge = el("span", undefined, "extraction-badge");
  updateExtractionBadge(extractionBadge, article.extraction);
  const description = article.description
    ? el("a", article.description, "article-description article-lead")
    : null;
  if (description) {
    description.href = articlePath(article);
    description.dataset.articleId = article.id;
    description.setAttribute("aria-label", `Read saved copy of ${article.title}`);
    description.addEventListener("click", (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); void navigateToArticle(article.id, description);
    });
  }
  const link = iconLink("Open original", "external", "subtle original-link");
  link.href = safeHttpUrl(article.url) || "#";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.addEventListener("click", (e) => e.stopPropagation());
  if (description) main.append(description);
  const actions = el("div", undefined, "article-actions");
  const read = iconButton(
    article.readAt ? "Mark unread" : "Mark read",
    article.readAt ? "mark-unread" : "mark-read",
    "read-action",
  );
  read.addEventListener("click", () => mutateRead(article, !article.readAt));
  metaRow.append(meta, extractionBadge);
  const edit = iconButton("Edit", "edit", "subtle edit-action");
  edit.addEventListener("click", () => openDetail(article));
  actions.append(read, edit, link);
  main.append(title, metaRow);
  if (description) title.after(description);
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
    if (reset && !suggestedArticle && !suggestionError) suggestionLoaded = false;
    void loadSuggestion();
    return true;
  } catch (e) {
    if (generation !== loadGeneration) return;
    showNotice((e as Error).message, true);
    if (!list.children.length) {
      empty.hidden = false;
      $("#empty h3").textContent = "We couldn’t load your list";
      $("#empty p").textContent = "Check your connection, then try again.";
    }
    return false;
  } finally {
    if (generation === loadGeneration) {
      setBusy(false);
      $<HTMLButtonElement>("#more").disabled = false;
    }
  }
}
async function saveReadState(article: Article, read: boolean): Promise<Article> {
  invalidateLoads();
  const result = await request<{ article: Article }>(
    `/api/articles/${encodeURIComponent(article.id)}`,
    { method: "PATCH", body: JSON.stringify({ read }) },
  );
  return result.article;
}
function applyReadState(article: Article) {
  if (state.selected?.id === article.id) state.selected = article;
  if (lastOpenedArticle?.id === article.id || readLastOpenedId() === article.id) {
    lastOpenedFetchGeneration++;
    lastOpenedArticle = article;
    lastOpenedReady = true;
    lastOpenedError = "";
  }
  if (suggestionLoading || (suggestedArticle?.id === article.id && article.readAt)) resetSuggestion();
  renderLastOpened();
  void loadSuggestion();
}
async function mutateRead(article: Article, read: boolean) {
  try {
    const updated = await saveReadState(article, read);
    applyReadState(updated);
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
      if (lastOpenedArticle?.id === result.article.id || readLastOpenedId() === result.article.id) {
        lastOpenedArticle = result.article;
        renderLastOpened();
      }
      if (suggestedArticle?.id === result.article.id) {
        suggestedArticle = result.article;
        renderLastOpened();
      }
      if (readerArticleId === result.article.id) {
        setArticleTitle(result.article);
        history.replaceState(readerHistoryState(result.article.id, readerFromList), "", articlePath(result.article));
      }
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
  input.defaultValue = article.title;
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
      clearLastOpened(article.id);
      $<HTMLDialogElement>("#detail-dialog").close();
      showNotice("Article deleted.");
      await load();
    } catch (err) {
      showDetailError((err as Error).message);
    }
  });
  actions.append(toggle, del);
  const extractionPanel = el("section", undefined, "extraction-panel");
  extractionPanel.setAttribute("aria-live", "polite");
  const extractionStatus = el("p", extractionLabel(article.extraction), "extraction-detail-status");
  extractionStatus.id = "detail-extraction-status";
  const retryCapture = el("button", "Retry capture", "button secondary");
  retryCapture.type = "button";
  retryCapture.hidden = article.extraction?.state !== "failed";
  retryCapture.addEventListener("click", async () => {
    retryCapture.disabled = true;
    extractionStatus.textContent = "Queueing a new capture attempt…";
    try {
      const result = await request<{ extraction: ExtractionStatus }>(`/api/articles/${encodeURIComponent(article.id)}/extraction/retry`, { method: "POST", body: JSON.stringify({}) });
      if (state.selected?.id !== article.id || !extractionPanel.isConnected || !$<HTMLDialogElement>("#detail-dialog").open) return;
      const updated = { ...article, extraction: result.extraction };
      state.selected = updated;
      refreshDetailAfterExtraction(updated);
      startExtractionPolling(updated);
    } catch (error) {
      if (state.selected?.id !== article.id || !extractionPanel.isConnected || !$<HTMLDialogElement>("#detail-dialog").open) return;
      extractionStatus.textContent = `Couldn’t retry capture. ${(error as Error).message}`;
      retryCapture.disabled = false;
    }
  });
  if (article.extraction) {
    if (article.extraction.state === "failed") extractionStatus.textContent = `${extractionFailureMessage(article.extraction.errorCode)} Paste or upload a browser copy below, or retry.`;
    extractionPanel.append(extractionStatus, retryCapture);
  }
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
    extractionPanel,
  );
  void renderCopyEditor(article);
  if (extractionIsPending(article.extraction)) startExtractionPolling(article);
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
  const integrationLabel = el("label", undefined, "integration-option");
  const integrationCheckbox = el("input");
  integrationCheckbox.type = "checkbox";
  integrationCheckbox.disabled = true;
  integrationLabel.append(integrationCheckbox, document.createTextNode("Also send to an integration"));
  const integrationSelect = el("select");
  integrationSelect.className = 'integration-select';
  integrationSelect.setAttribute("aria-label", "Integration destination");
  const integrationStatus = el("p", "Checking integrations…", "muted copy-status");
  integrationStatus.setAttribute("aria-live", "polite");
  const integrationDescription = el("p", undefined, "muted copy-explainer");
  const integrationRetry = el("button", "Send saved copy", "button secondary");
  integrationRetry.type = "button";
  integrationRetry.hidden = true;
  let saved: ArticleCopy | null = null;
  let integrations: IntegrationStatus[] = [];
  const selectedIntegration = () => integrations.find(item => item.id === integrationSelect.value);
  let saving = false;
  let source: ArticleCopy["source"] = "paste";
  let loaded = false;
  const recovery = el('div', undefined, 'capture-recovery');
  recovery.append(el('p', 'Fetch the original again and replace the saved Markdown when capture succeeds.', 'muted copy-explainer'));
  const refreshLabel = el('label', undefined, 'capture-refresh-option');
  const refreshMetadata = el('input');
  refreshMetadata.type = 'checkbox';
  refreshLabel.append(refreshMetadata, document.createTextNode('Also refresh title, author, and description'));
  const recapture = el('button', 'Recapture article', 'button secondary');
  recapture.type = 'button';
  const undo = el('button', 'Undo last recapture', 'button secondary');
  undo.type = 'button';
  const discard = el('button', 'Discard unsaved changes', 'button secondary');
  discard.type = 'button';
  const recoveryHint = el('p', undefined, 'muted copy-status');
  recoveryHint.setAttribute('aria-live', 'polite');
  const titleInput = root.querySelector<HTMLInputElement>('.edit-form input');
  const isDirty = () => Boolean(copyDrafts.has(article.id) || (titleInput && titleInput.value !== titleInput.defaultValue));
  const updateRecoveryControls = () => {
    const dirty = isDirty();
    recapture.disabled = !loaded || saving || dirty || extractionIsPending(state.selected?.extraction);
    undo.hidden = !state.selected?.extraction?.undoAvailable;
    undo.disabled = !loaded || saving || dirty;
    discard.hidden = !dirty;
    discard.disabled = !loaded || saving;
    refreshMetadata.disabled = saving;
    recoveryHint.textContent = dirty ? 'Save or discard your unsaved changes before recapturing or undoing.' : '';
  };
  titleInput?.addEventListener('input', updateRecoveryControls);
  discard.addEventListener('click', () => {
    copyDrafts.delete(article.id);
    textarea.value = saved?.markdown ?? '';
    source = saved?.source ?? 'paste';
    if (titleInput) titleInput.value = titleInput.defaultValue;
    showStatus(saved ? `Saved ${dateLabel(saved.capturedAt)}` : 'No Markdown copy saved yet.');
    updateRecoveryControls();
  });
  const recover = async (action: 'recapture' | 'undo') => {
    if (!loaded || saving || isDirty()) return;
    saving = true;
    updateRecoveryControls();
    message.hidden = true;
    try {
      const result = await request<{ extraction: ExtractionStatus }>(`/api/articles/${encodeURIComponent(article.id)}/extraction/${action}`, {
        method: 'POST', body: JSON.stringify({ expectedRevision: saved?.revision ?? null,
          ...(action === 'recapture' ? { refreshMetadata: refreshMetadata.checked } : {}) }),
      });
      if (state.selected?.id !== article.id || !root.contains(section) || !$<HTMLDialogElement>('#detail-dialog').open) return;
      const detail = await request<{ article: Article }>(`/api/articles/${encodeURIComponent(article.id)}`);
      if (state.selected?.id !== article.id || !root.contains(section) || !$<HTMLDialogElement>('#detail-dialog').open) return;
      const updated = { ...detail.article, extraction: result.extraction };
      state.selected = updated;
      refreshDetailAfterExtraction(updated);
      if (extractionIsPending(result.extraction)) startExtractionPolling(updated);
      showNotice(action === 'undo' ? 'Previous copy restored.' : extractionLabel(result.extraction));
      void load();
    } catch (error) {
      if (root.contains(section)) showError(`Couldn’t ${action === 'undo' ? 'undo recapture' : 'queue recapture'}. ${(error as Error).message}`);
    } finally { saving = false; updateRecoveryControls(); }
  };
  recapture.addEventListener('click', () => { void recover('recapture'); });
  undo.addEventListener('click', () => { void recover('undo'); });
  const recoveryActions = el('div', undefined, 'saved-copy-actions');
  recoveryActions.append(recapture, undo, discard);
  recovery.append(refreshLabel, recoveryActions, recoveryHint);
  updateRecoveryControls();
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
      void navigateToArticle(article.id, readCopy);
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
  const renderIntegrationStatus = () => {
    const integration = selectedIntegration();
    integrationLabel.hidden = !integrations.length;
    integrationSelect.hidden = !integrations.length;
    integrationCheckbox.disabled = saving || !integration?.configured;
    integrationSelect.disabled = saving || !integrations.length;
    integrationRetry.hidden = !integration?.configured || !saved;
    integrationRetry.disabled = saving;
    integrationRetry.textContent = integration ? `Send saved copy to ${integration.name}` : 'Send saved copy';
    integrationDescription.textContent = integration?.description || '';
    integrationStatus.replaceChildren();
    if (!integration) {
      integrationStatus.textContent = "No integrations configured. Copies are saved privately in Potem.";
      return;
    }
    if (!integration.configured) {
      integrationStatus.textContent = integration.message || 'This integration is not configured.';
      return;
    }
    const label = integration.state === "saved" ? `Sent to ${integration.name} ${dateLabel(integration.deliveredAt!)}. `
      : integration.state === "outdated" ? `${integration.name} has an older copy or article details. ` : `Not sent to ${integration.name} yet. `;
    integrationStatus.append(document.createTextNode(label + integration.destination));
    const url = integration.url && safeHttpUrl(integration.url);
    if (url && integration.state !== "not_saved") {
      const link = el("a", " Open destination");
      link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer";
      integrationStatus.append(link);
    }
  };
  integrationSelect.addEventListener('change', () => { integrationCheckbox.checked = false; renderIntegrationStatus(); });
  const refreshIntegrationStatus = async () => {
    try {
      const result = await request<{ integrations: IntegrationStatus[] }>(`/api/articles/${encodeURIComponent(article.id)}/integrations`);
      if (state.selected?.id !== article.id || !root.contains(section)) return;
      const selected = integrationSelect.value;
      const previousKey = selectedIntegration()?.destinationKey;
      integrations = result.integrations;
      integrationSelect.replaceChildren(...integrations.map(item => {
        const option = el('option', item.name); option.value = item.id; return option;
      }));
      if (integrations.some(item => item.id === selected)) integrationSelect.value = selected;
      if (previousKey !== selectedIntegration()?.destinationKey) integrationCheckbox.checked = false;
      renderIntegrationStatus();
    } catch (error) {
      integrationCheckbox.disabled = true;
      integrationStatus.textContent = `Couldn’t load integrations. ${(error as Error).message}`;
    }
  };
  const sendSavedCopy = async (destination: IntegrationConsent) => {
    if (!saved) return;
    integrationStatus.textContent = "Sending saved copy…";
    try {
      const result = await sendToIntegration(article.id, saved.revision, destination);
      integrations = integrations.map(item => item.id === result.integration.id ? result.integration : item);
      renderIntegrationStatus();
      if (result.integration.state === "outdated") showError("The saved copy was sent, but this article changed meanwhile. Reload it and send again.");
      else showNotice(`Markdown copy sent to ${result.integration.name}.`);
    } catch (error) {
      await refreshIntegrationStatus();
      showError(`Your Markdown copy is saved in Potem. Couldn’t send it. ${(error as Error).message} Use “Send saved copy” to retry.`);
    }
  };
  integrationRetry.addEventListener("click", async () => {
    const integration = selectedIntegration();
    if (!integration) return;
    saving = true; save.disabled = true; renderIntegrationStatus(); message.hidden = true;
    try { await sendSavedCopy(integrationConsent(integration)); }
    finally { saving = false; save.disabled = false; renderIntegrationStatus(); }
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
      updateRecoveryControls();
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
    if (textarea.value === (saved?.markdown ?? '')) copyDrafts.delete(article.id);
    else copyDrafts.set(article.id, { markdown: textarea.value, source });
    updateRecoveryControls();
    const bytes = new TextEncoder().encode(textarea.value).byteLength;
    showStatus(`${bytes.toLocaleString()} UTF-8 bytes · Unsaved draft`);
  });
  save.addEventListener("click", async () => {
    if (saving) return;
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
    const destination = integrationCheckbox.checked && selectedIntegration() ? integrationConsent(selectedIntegration()!) : null;
    saving = true;
    section.dataset.saving = 'true';
    updateRecoveryControls();
    renderIntegrationStatus();
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
      try {
        const extraction = await request<{ extraction: ExtractionStatus }>(`/api/articles/${encodeURIComponent(article.id)}/extraction`);
        if (state.selected?.id === article.id && root.contains(section)) state.selected.extraction = extraction.extraction;
      } catch { /* A status refresh failure does not change the successful copy save. */ }
      const storedBytes = new TextEncoder().encode(saved.markdown).byteLength;
      showStatus(`Saved ${dateLabel(saved.capturedAt)} · ${saved.source === "upload" ? "uploaded file" : "captured or pasted Markdown"} · ${storedBytes.toLocaleString()} UTF-8 bytes`);
      showNotice("Markdown copy saved.");
      if (destination) await sendSavedCopy(destination);
      else await refreshIntegrationStatus();
    } catch (error) {
      showError(`Couldn’t save the Markdown copy. ${(error as Error).message} Your draft is still here; retry when ready.`);
    } finally {
      saving = false;
      section.dataset.saving = 'false';
      updateRecoveryControls();
      renderIntegrationStatus();
      save.disabled = false;
      textarea.disabled = false;
      file.disabled = false;
    }
  });
  savedActions.append(readCopy, downloadCopy);
  section.append(status, savedActions, recovery, label, fileLabel, integrationLabel, integrationSelect, integrationDescription, save, integrationStatus, integrationRetry, message);
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
    loaded = true;
    updateRecoveryControls();
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
      showStatus(`Saved ${dateLabel(saved.capturedAt)} · ${saved.source === "upload" ? "uploaded file" : "captured or pasted Markdown"} · ${bytes.toLocaleString()} UTF-8 bytes`);
    } else {
      showStatus(extractionIsPending(article.extraction)
        ? `${extractionLabel(article.extraction)} · You can paste or upload a copy while capture runs.`
        : article.extraction?.state === "failed"
          ? "No Markdown copy saved. Paste or upload a browser copy, or retry capture above."
          : "No Markdown copy saved yet.");
    }
    save.disabled = false;
    await refreshIntegrationStatus();
  } catch (error) {
    showStatus("Couldn’t load Markdown copy status.");
    showCopyActions();
    showError(`Couldn’t load this copy. ${(error as Error).message} Retry by closing and reopening this article.`);
    save.disabled = true;
  }
}
function rememberReaderOpener(opener?: HTMLElement) {
  if ($<HTMLDialogElement>("#reader-dialog").open) return;
  const activeElement = document.activeElement;
  const candidate = opener ?? (activeElement instanceof HTMLElement ? activeElement : null);
  readerReturnFocus = candidate?.isConnected ? candidate : null;
}
function ensureReaderOpener(opener?: HTMLElement) {
  if ($<HTMLDialogElement>("#reader-dialog").open) return;
  if (opener || !readerReturnFocus) rememberReaderOpener(opener);
}
function resetReaderCompletion(article?: Article) {
  readerReadRequest = null;
  $("#reader-completion").hidden = !article;
  $("#reader-read-error").hidden = true;
  $("#reader-read-error").textContent = "";
  const button = $<HTMLButtonElement>("#reader-read-toggle");
  button.disabled = false;
  button.removeAttribute("aria-busy");
  $("#reader-read-label").textContent = article?.readAt ? "Mark as unread" : "Mark as read";
  button.querySelector("svg")!.outerHTML = iconMarkup(article?.readAt ? "mark-unread" : "mark-read");
}
$("#reader-read-toggle").addEventListener("click", async () => {
  const article = state.selected;
  const dialog = $<HTMLDialogElement>("#reader-dialog");
  if (!article || readerArticleId !== article.id || !dialog.open || $("#reader-completion").hidden || readerReadRequest) return;
  const generation = readerLoadGeneration;
  const operation = {};
  readerReadRequest = operation;
  const isCurrent = () => generation === readerLoadGeneration && readerReadRequest === operation && readerArticleId === article.id && dialog.open;
  const button = $<HTMLButtonElement>("#reader-read-toggle");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  $("#reader-read-label").textContent = "Saving…";
  $("#reader-read-error").hidden = true;
  try {
    const updated = await saveReadState(article, !article.readAt);
    if (!isCurrent()) return;
    applyReadState(updated);
    pendingReadCompletion = updated.readAt ? "Marked as read." : "Marked as unread.";
    if (listSnapshot && !listSnapshot.focusArticleId) {
      listSnapshot = { ...listSnapshot, focus: null, focusArticleId: article.id, focusKind: "title" };
    }
    // Both layers must close before restoring the refreshed library's focus.
    const detail = $<HTMLDialogElement>("#detail-dialog");
    if (detail.open) detail.close();
    navigateReaderAway();
    clearReader();
  } catch (error) {
    if (!isCurrent()) return;
    resetReaderCompletion(article);
    const feedback = $("#reader-read-error");
    feedback.textContent = `Couldn’t update this article. ${(error as Error).message} Try again.`;
    feedback.hidden = false;
  }
});
function openReader(article: Article, copy: ArticleCopy, opener?: HTMLElement) {
  if (state.selected?.id !== article.id) return;
  if (readerPositionContext && (readerPositionContext.id !== article.id || readerPositionContext.revision !== copy.revision)) saveReadingPosition();
  const title = $("#reader-title");
  const author = $("#reader-author");
  const metadata = $("#reader-metadata");
  const original = $<HTMLAnchorElement>("#reader-original");
  const body = $("#reader-body");
  const about = $<HTMLDetailsElement>("#reader-about");
  title.textContent = article.title;
  readerArticleId = article.id;
  setArticleTitle(article);
  const canonicalPath = articlePath(article);
  if (location.pathname !== canonicalPath) history.replaceState(readerHistoryState(article.id, readerFromList), "", canonicalPath);
  author.textContent = article.author ? `By ${article.author}` : "";
  author.hidden = !article.author;
  metadata.textContent = `Captured ${dateLabel(copy.capturedAt)} · ${copy.source === "upload" ? "uploaded file" : "captured or pasted Markdown"} · ${sourceHost(article.url)}`;
  about.open = false;
  $("#reader-pending").hidden = true;
  $("#reader-new-copy").hidden = true;
  $("#reader-image-note").hidden = false;
  body.hidden = false;
  original.href = safeHttpUrl(article.url) || "#";
  body.replaceChildren(renderMarkdown(copy.markdown, article.url));
  resetReaderCompletion(article);
  saveLastOpened(article);
  const positionContext = { id: article.id, revision: copy.revision };
  const readerIsSameCopy = readerPositionContext?.id === positionContext.id && readerPositionContext.revision === positionContext.revision;
  readerPositionContext = positionContext;
  const dialog = $<HTMLDialogElement>("#reader-dialog");
  if (!dialog.open) {
    ensureReaderOpener(opener);
    showDialog(dialog, title);
  }
  if (!readerIsSameCopy) dialog.scrollTop = 0;
  title.focus({ preventScroll: true });
  restoreReadingPosition(positionContext);
  stopExtractionPolling();
  if (extractionIsPending(article.extraction)) startExtractionPolling(article);
}
$("#reader-new-copy").addEventListener('click', () => {
  if (state.selected) void openSavedCopy(state.selected);
});
function renderPendingReader(article: Article) {
  $("#reader-new-copy").hidden = true;
  resetReaderCompletion();
  saveReadingPosition();
  readerPositionContext = null;
  state.selected = article;
  const title = $("#reader-title");
  title.textContent = article.title;
  readerArticleId = article.id;
  setArticleTitle(article);
  const canonicalPath = articlePath(article);
  if (location.pathname !== canonicalPath) history.replaceState(readerHistoryState(article.id, readerFromList), "", canonicalPath);
  $<HTMLDetailsElement>("#reader-about").open = false;
  const author = $("#reader-author");
  author.textContent = article.author ? `By ${article.author}` : "";
  author.hidden = !article.author;
  $("#reader-metadata").textContent = `${sourceHost(article.url)} · ${extractionLabel(article.extraction)}`;
  const original = $<HTMLAnchorElement>("#reader-original");
  original.href = safeHttpUrl(article.url) || "#";
  $("#reader-pending-status").textContent = article.extraction?.state === "failed"
    ? `${extractionFailureMessage(article.extraction.errorCode)} You can paste or upload a browser copy in article details.`
    : article.extraction?.paused ? "Capture is paused. Your link is saved; you can add Markdown manually in article details."
      : "Markdown is being prepared in the background. You can close this view; the link is already saved.";
  $("#reader-pending").hidden = false;
  const retry = $<HTMLButtonElement>("#reader-retry");
  retry.hidden = article.extraction?.state !== "failed";
  retry.disabled = false;
  $("#reader-image-note").hidden = true;
  $("#reader-body").hidden = true;
  const dialog = $<HTMLDialogElement>("#reader-dialog");
  if (!dialog.open) {
    ensureReaderOpener();
    showDialog(dialog, title);
  }
  dialog.scrollTop = 0;
  title.focus({ preventScroll: true });
  startExtractionPolling(article);
}
$("#reader-manual-copy").addEventListener("click", () => {
  const article = state.selected;
  if (!article) return;
  clearReader();
  openDetail(article);
});
$("#reader-retry").addEventListener("click", async () => {
  const article = state.selected;
  const generation = readerLoadGeneration;
  const button = $<HTMLButtonElement>("#reader-retry");
  if (!article) return;
  button.disabled = true;
  $("#reader-pending-status").textContent = "Queueing a new capture attempt…";
  try {
    const result = await request<{ extraction: ExtractionStatus }>(`/api/articles/${encodeURIComponent(article.id)}/extraction/retry`, { method: "POST", body: JSON.stringify({}) });
    if (generation !== readerLoadGeneration || state.selected?.id !== article.id || !$<HTMLDialogElement>("#reader-dialog").open) return;
    const updated = { ...article, extraction: result.extraction };
    renderPendingReader(updated);
  } catch (error) {
    if (generation !== readerLoadGeneration || state.selected?.id !== article.id || !$<HTMLDialogElement>("#reader-dialog").open) return;
    $("#reader-pending-status").textContent = `Couldn’t retry capture. ${(error as Error).message}`;
    button.disabled = false;
  }
});
function clearReader() {
  $("#reader-new-copy").hidden = true;
  resetReaderCompletion();
  saveReadingPosition();
  readerPositionContext = null;
  readerLoadGeneration++;
  stopExtractionPolling();
  if (notice.textContent === "Loading Markdown copy…") showNotice("");
  const dialog = document.querySelector<HTMLDialogElement>("#reader-dialog");
  if (!dialog) return;
  if (dialog.open) {
    readerCloseEvents.push({ generation: readerLoadGeneration, opener: readerReturnFocus });
    dialog.close();
  } else readerReturnFocus = null;
  readerArticleId = null;
  dialog.scrollTop = 0;
  $("#reader-body").replaceChildren();
  $("#reader-title").textContent = "";
  $("#reader-author").textContent = "";
  $("#reader-metadata").textContent = "";
  $("#reader-pending").hidden = true;
  $<HTMLDetailsElement>("#reader-about").open = false;
  $("#reader-pending-status").textContent = "";
  $("#reader-body").hidden = false;
  $("#reader-image-note").hidden = false;
  $<HTMLAnchorElement>("#reader-original").removeAttribute("href");
}
function restoreReaderFocus(opener = readerReturnFocus) {
  readerReturnFocus = null;
  if (!opener?.isConnected) return;
  const detailDialog = $<HTMLDialogElement>("#detail-dialog");
  if (detailDialog.open && !detailDialog.contains(opener)) return;
  opener.focus({ preventScroll: true });
}
function discardPrivateContent() {
  pendingReadCompletion = null;
  lastOpenedFetchGeneration++;
  lastOpenedArticle = null;
  lastOpenedError = "";
  lastOpenedReady = false;
  resetSuggestion();
  renderLastOpened();
  clearReader();
  const detailDialog = $<HTMLDialogElement>("#detail-dialog");
  if (detailDialog.open) detailDialog.close();
  $("#detail-content").replaceChildren();
  state.selected = null;
}
$("#reader-dialog").addEventListener("close", () => {
  const dialog = $<HTMLDialogElement>("#reader-dialog");
  // Closing queues an event. Ignore its cleanup if another navigation has
  // started, including while that navigation is still fetching its copy.
  const closed = readerCloseEvents.shift();
  if (dialog.open) return;
  if (closed && closed.generation !== readerLoadGeneration) {
    if (!parseReaderPath(location.pathname)) restoreReaderFocus(closed.opener);
    return;
  }
  saveReadingPosition();
  readerPositionContext = null;
  dialog.scrollTop = 0;
  resetReaderCompletion();
  $("#reader-body").replaceChildren();
  $("#reader-title").textContent = "";
  $("#reader-author").textContent = "";
  $("#reader-metadata").textContent = "";
  $("#reader-pending").hidden = true;
  $("#reader-pending-status").textContent = "";
  $<HTMLDetailsElement>("#reader-about").open = false;
  $("#reader-body").hidden = false;
  $("#reader-image-note").hidden = false;
  $<HTMLAnchorElement>("#reader-original").removeAttribute("href");
  if (!$<HTMLDialogElement>("#detail-dialog").open) {
    stopExtractionPolling();
    state.selected = null;
  }
  restoreReaderFocus(closed?.opener);
});
$("#reader-dialog .reader-close").addEventListener("submit", (event) => {
  event.preventDefault();
  navigateReaderAway();
  clearReader();
});
$("#reader-dialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  navigateReaderAway();
  clearReader();
});
document.addEventListener("pointerdown", (event) => {
  const dialog = $<HTMLDialogElement>("#reader-dialog");
  if (!dialog.open) return;

  const bounds = dialog.getBoundingClientRect();
  const clickedOutside = event.clientX < bounds.left || event.clientX > bounds.right ||
    event.clientY < bounds.top || event.clientY > bounds.bottom;
  if (clickedOutside) {
    navigateReaderAway();
    clearReader();
  }
}, true);
$("#reader-dialog").addEventListener("scroll", scheduleReadingPositionSave, { passive: true });
window.addEventListener("pagehide", saveReadingPosition);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveReadingPosition(); });
function openDetail(article: Article) {
  clearReader();
  renderDetail(article);
  showDialog($<HTMLDialogElement>("#detail-dialog"), $<HTMLInputElement>("#detail-content input"));
  if (extractionIsPending(article.extraction)) startExtractionPolling(article);
}
async function openArticleById(id: string) {
  if (!state.session?.authenticated || !isArticleId(id)) return;
  const generation = ++readerLoadGeneration;
  try {
    const { article } = await request<{ article: Article }>(`/api/articles/${encodeURIComponent(id)}`);
    if (generation !== readerLoadGeneration) return;
    state.selected = article;
    setArticleTitle(article);
    history.replaceState(readerHistoryState(id, readerFromList), "", articlePath(article));
    await openSavedCopy(article);
  } catch (error) {
    if (generation !== readerLoadGeneration) return;
    const status = (error as Error & { status?: number }).status;
    if (status === 404) { clearLastOpened(id); void loadSuggestion(); }
    showNotice(status === 404 ? "This article is no longer in your library." : `Couldn’t open the saved article. ${(error as Error).message}`, true);
    if (status === 404) {
      const back = el("a", "Back to list"); back.href = "/";
      back.addEventListener("click", (event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); history.replaceState(listHistoryState(), "", "/"); readerFromList = false; setListTitle(); clearReader(); showNotice(""); restoreListView();
      });
      notice.append(document.createTextNode(" "), back);
    } else {
      const retry = el("button", "Retry", "text-button"); retry.type = "button";
      retry.addEventListener("click", () => { showNotice(""); void openArticleById(id); });
      notice.append(document.createTextNode(" "), retry);
    }
  }
}
async function navigateToArticle(id: string, opener?: HTMLElement) {
  if (!isArticleId(id) || readerReturnPending) return;
  if (!state.session?.authenticated) {
    try { sessionStorage.setItem(pendingReaderStorageKey, JSON.stringify({ version: 1, articleId: id, createdAt: Date.now() })); } catch {}
    location.assign("/auth/github");
    return;
  }
  const current = parseReaderPath(location.pathname);
  if (current && "id" in current && current.id === id) {
    // The editor can reopen the current article without another history entry.
    // Its reader button still owns focus when that reader closes.
    rememberReaderOpener(opener);
    if (listSnapshot && opener) listSnapshot.focus = opener;
    await openArticleById(id);
    return;
  }
  rememberListView(opener);
  readerFromList = true;
  rememberReaderOpener(opener);
  history.pushState(readerHistoryState(id, true), "", `/read/${id}`);
  await openArticleById(id);
}
function navigateReaderAway() {
  if (readerReturnPending || !readerArticleId && !parseReaderPath(location.pathname)) return;
  const current = history.state as ReaderHistoryState | null;
  const fromList = current?.potem?.kind === "reader" ? Boolean(current.potem.fromList) : readerFromList;
  if (fromList) { readerReturnPending = true; history.back(); }
  else { history.replaceState(listHistoryState(), "", "/"); readerFromList = false; setListTitle(); restoreListView(); }
}
window.addEventListener("popstate", () => {
  readerReturnPending = false;
  const route = parseReaderPath(location.pathname);
  if (route) {
    if (!("id" in route)) { clearReader(); setListTitle(); showNotice("This article link is invalid. Go back to your list and try again.", true); return; }
    const entry = history.state as ReaderHistoryState | null;
    readerFromList = Boolean(entry?.potem?.kind === "reader" && entry.potem.fromList);
    if (state.session?.authenticated) void openArticleById(route.id);
    return;
  }
  readerFromList = false;
  setListTitle();
  clearReader();
  restoreListView();
});
const lastOpenedRetry = document.querySelector<HTMLButtonElement>("#last-opened-retry");
lastOpenedRetry?.addEventListener("click", () => {
  if (lastOpenedError) void loadLastOpened();
  else void loadSuggestion(true);
});
$("#suggestion-shuffle").addEventListener("click", () => void loadSuggestion(true));
const reconcileGitHubButton = document.querySelector<HTMLButtonElement>("#github-reconcile");
reconcileGitHubButton?.addEventListener("click", async () => {
  if (!state.session?.authenticated || !reconcileGitHubButton) return;
  reconcileGitHubButton.disabled = true;
  const status = $("#settings-status");
  status.textContent = "Finding existing GitHub backups…";
  try {
    const result = await request<{ scanned: number; mapped: number; conflicts: unknown[] }>("/api/github/reconcile", { method: "POST", body: JSON.stringify({}) });
    status.textContent = `Scanned ${result.scanned} backup${result.scanned === 1 ? "" : "s"}; mapped ${result.mapped}; ${result.conflicts.length} conflict${result.conflicts.length === 1 ? "" : "s"}.`;
  } catch (error) {
    status.textContent = `Couldn’t find existing GitHub backups. ${(error as Error).message}`;
  } finally { reconcileGitHubButton.disabled = false; }
});
$("#add-dialog").addEventListener("close", () => window.setTimeout(resumePendingReader, 0));
async function openSavedCopy(article: Article, opener?: HTMLElement) {
  ensureReaderOpener(opener);
  const generation = ++readerLoadGeneration;
  state.selected = article;
  showNotice("Loading Markdown copy…");
  try {
    const result = await request<{ copy: ArticleCopy | null }>(
      `/api/articles/${encodeURIComponent(article.id)}/copy`,
    );
    if (generation !== readerLoadGeneration || state.selected?.id !== article.id) return;
    if (result.copy) {
      showNotice("");
      openReader(article, result.copy);
    } else {
      if (extractionIsPending(article.extraction) || article.extraction?.state === "failed") {
        showNotice("");
        renderPendingReader(article);
      } else {
        showNotice("No Markdown copy saved yet. Add one in article details.");
        openDetail(article);
      }
    }
  } catch (error) {
    if (generation !== readerLoadGeneration || state.selected?.id !== article.id) return;
    showNotice(`Couldn’t load this Markdown copy. ${(error as Error).message}`, true);
    openDetail(article);
  }
}
$("#detail-dialog").addEventListener("close", () => {
  if (parseReaderPath(location.pathname)) navigateReaderAway();
  stopExtractionPolling();
  clearReader();
  $("#detail-content").replaceChildren();
  state.selected = null;
});
async function initialize() {
  try {
    state.session = await request<Session>("/api/session");
    if (state.session.authenticated) await completeExtensionConnection();
    if (state.session.authenticated && browserCaptureDraft) void loadCaptureIntegrationConfiguration();
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
    if (reconcileGitHubButton) reconcileGitHubButton.hidden = true;
    const unauthenticatedRoute = parseReaderPath(location.pathname);
    if (unauthenticatedRoute && "id" in unauthenticatedRoute) {
      try { sessionStorage.setItem(pendingReaderStorageKey, JSON.stringify({ version: 1, articleId: unauthenticatedRoute.id, createdAt: Date.now() })); } catch {}
    }
    const title = $("#add-heading");
    title.textContent = "Your private reading list";
    const form = $("#add-form");
    form.hidden = true;
    $(".title-option").hidden = true;
    $("#add-url-copy-option").hidden = true;
    $("#sign-in-prompt").className = "sign-in-prompt";
    $("#sign-in-prompt").hidden = false;
    $("#sign-in-prompt a").addEventListener("click", () => { rememberReaderForAuthentication(); stashDraft(); });
    $("#library-sign-in").hidden = false;
    $("#library-sign-in").addEventListener("click", () => { rememberReaderForAuthentication(); stashDraft(); });
    $("#empty h3").textContent = "Your list is waiting";
    $("#empty p").textContent =
      "Sign in to see saved articles across your devices.";
  } else {
    $("#logout").hidden = false;
    setListTitle();
    void load();
    void loadLastOpened();
    const route = parseReaderPath(location.pathname);
    if (route) {
      if (!("id" in route)) showNotice("This article link is invalid. Go back to your list and try again.", true);
      else {
        const captureActive = Boolean(browserCaptureDraft || connectRequestId || extensionHandoffId || new URL(location.href).searchParams.has("capture") || sessionStorage.getItem("later-add-draft"));
        if (captureActive) {
          try { sessionStorage.setItem(pendingReaderStorageKey, JSON.stringify({ version: 1, articleId: route.id, createdAt: Date.now() })); } catch {}
        } else {
          try { sessionStorage.removeItem(pendingReaderStorageKey); } catch {}
          readerFromList = Boolean((history.state as ReaderHistoryState | null)?.potem?.kind === "reader" && (history.state as ReaderHistoryState).potem?.fromList);
          if ((history.state as ReaderHistoryState | null)?.potem?.kind !== "reader") history.replaceState(readerHistoryState(route.id, false), "", location.href);
          void openArticleById(route.id);
        }
      }
    } else {
      try {
        const pending = JSON.parse(sessionStorage.getItem(pendingReaderStorageKey) || "null");
        const validPending = pending?.version === 1 && isArticleId(pending.articleId) && Number.isFinite(pending.createdAt) && Date.now() >= pending.createdAt && Date.now() - pending.createdAt < 30 * 60 * 1000;
        const captureActive = Boolean(browserCaptureDraft || connectRequestId || extensionHandoffId || new URL(location.href).searchParams.has("capture") || sessionStorage.getItem("later-add-draft"));
        if (validPending && !captureActive) {
          sessionStorage.removeItem(pendingReaderStorageKey);
          history.replaceState(readerHistoryState(pending.articleId, false), "", `/read/${pending.articleId}`);
          void openArticleById(pending.articleId);
        }
      } catch { try { sessionStorage.removeItem(pendingReaderStorageKey); } catch {} }
    }
  }
  if (!state.session.authenticated) {
    loading.hidden = true;
    empty.hidden = false;
  }
  applyTheme();
  void finishExtensionSetup();
}
async function completeExtensionConnection() {
  const requestId = connectRequestId || sessionStorage.getItem('later-extension-connect-request');
  if (!requestId || !/^[a-f0-9]{48}$/.test(requestId)) return;
  try {
    const { integrations } = await request<{ integrations: IntegrationConfiguration[] }>('/api/integrations');
    const destinations = integrations.filter(item => item.configured);
    extensionPost('connection-config', requestId, { authenticated: true, destinations });
    sessionStorage.removeItem('later-extension-connect-request');
    showNotice('Potem is connected. Return to the extension settings.');
  } catch (error) {
    showNotice(`Could not check the Potem destination. ${(error as Error).message}`, true);
  }
}
async function finishExtensionSetup() {
  const draft = browserCaptureDraft;
  if (!draft?.requestId || !state.session?.authenticated || extensionAutosaveStarted) return;
  if (draft.extractionError) {
    if (draft.mode === 'simple') extensionPost('capture-result', draft.requestId, { result: 'action-required' });
    return;
  }
  if (draft.mode !== 'simple' || !draft.markdown.trim()) return;
  extensionAutosaveStarted = true;
  try {
    await loadCaptureIntegrationConfiguration();
    if (draft.destination && !matchesIntegrationDestination(captureIntegrations.find(item => item.id === draft.destination!.id), draft.destination)) {
      draft.mode = 'review';
      sessionStorage.setItem('later-extension-capture', JSON.stringify(draft));
      showNotice('The consented integration destination changed. Review this capture or reconnect in extension settings.', true);
      extensionPost('capture-result', draft.requestId, { result: 'action-required' });
      return;
    }
    $<HTMLInputElement>('#capture-copy-enabled').checked = true;
    $<HTMLInputElement>('#capture-integration-enabled').checked = Boolean(draft.destination);
    $<HTMLInputElement>('#capture-author').value = draft.author || '';
    $<HTMLTextAreaElement>('#capture-description').value = draft.description || '';
    $<HTMLFormElement>('#add-form').requestSubmit();
  } catch (error) {
    draft.mode = 'review';
    sessionStorage.setItem('later-extension-capture', JSON.stringify(draft));
    showNotice(`Automatic saving needs attention. Review this capture and retry: ${(error as Error).message}`, true);
    extensionPost('capture-result', draft.requestId, { result: 'action-required' });
  }
}
function recoverDraft() {
  const extensionDraft = sessionStorage.getItem('later-extension-capture');
  let restoredExtension = false;
  if (extensionDraft) try {
    const draft = JSON.parse(extensionDraft) as BrowserCaptureDraft;
    if (draft.requestId && (safeHttpUrl(draft.sourceUrl) || draft.extractionError === 'unsupported') && new TextEncoder().encode(draft.markdown || '').byteLength <= 262144) {
      browserCaptureDraft = draft;
      restoredExtension = true;
      sessionStorage.removeItem('later-browser-capture-draft');
      $<HTMLInputElement>('#add-url').value = safeHttpUrl(draft.sourceUrl) || '';
      $<HTMLInputElement>('#add-title').value = draft.title;
      restoreBrowserCaptureDraft();
    }
  } catch {}
  const raw = sessionStorage.getItem("later-add-draft");
  if (raw && !restoredExtension) try {
    const d = JSON.parse(raw);
    if (!$<HTMLInputElement>("#add-url").value) $<HTMLInputElement>("#add-url").value = d.url || "";
    if (!$<HTMLInputElement>("#add-title").value) $<HTMLInputElement>("#add-title").value = d.title || "";
    showNotice("Your unsaved link is back. Save it when you’re ready.");
    if (!$<HTMLDialogElement>("#add-dialog").open)
      showDialog($<HTMLDialogElement>("#add-dialog"), $<HTMLInputElement>("#add-url"));
  } catch {}
  try {
    if (restoredExtension) return;
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
  // Reset shared bookmarklet controls first; extension-specific state below owns them.
  $<HTMLInputElement>("#capture-copy-enabled").checked = true;
  $<HTMLInputElement>("#capture-integration-enabled").checked = false;
  $<HTMLElement>("#capture-copy").hidden = false;
  $("#add-url-copy-option").hidden = true;
  $("#add-dialog .add-heading p").textContent = "Review the link and captured Markdown before saving.";
  $("#capture-copy-status").textContent = "Review the captured Markdown. Saving a copy is enabled; uncheck it to save the link only.";
  const unsupported = browserCaptureDraft.extractionError === 'unsupported' && !safeHttpUrl(browserCaptureDraft.sourceUrl);
  if (!unsupported && $<HTMLInputElement>("#add-url").value.trim() !== browserCaptureDraft.sourceUrl) return;
  $<HTMLTextAreaElement>("#capture-markdown").value = browserCaptureDraft.markdown;
  if (browserCaptureDraft.requestId) {
    $<HTMLElement>('#capture-author-option').hidden = false;
    $<HTMLElement>('#capture-description-option').hidden = false;
    $<HTMLInputElement>('#capture-author').value = browserCaptureDraft.author || '';
    $<HTMLTextAreaElement>('#capture-description').value = browserCaptureDraft.description || '';
    $<HTMLInputElement>('#add-url').readOnly = true;
    if (browserCaptureDraft.extractionError) $('#capture-copy-status').textContent = `Page extraction needs attention (${browserCaptureDraft.extractionError}). Save the link privately or paste Markdown before publishing.`;
    else $('#capture-copy-status').textContent = 'Review the page, metadata, and Markdown. The source URL is locked to this capture.';
    const destination = browserCaptureDraft.destination;
    if (destination) $<HTMLSelectElement>('#capture-integration').value = destination.id;
    $<HTMLInputElement>('#capture-integration-enabled').checked = Boolean(browserCaptureDraft.publishRequested ?? (browserCaptureDraft.mode === 'simple' && browserCaptureDraft.destination));
    $<HTMLButtonElement>('#add-form button').hidden = true;
    if (unsupported) {
      $('#capture-copy-status').textContent = 'This browser page cannot be captured. Open an HTTP(S) article tab and try again.';
      $<HTMLButtonElement>('#extension-save-link').hidden = true;
      $<HTMLButtonElement>('#extension-save-private').hidden = true;
      $<HTMLButtonElement>('#extension-send-integration').hidden = true;
    }
    $<HTMLButtonElement>('#extension-save-link').hidden = !browserCaptureDraft.extractionError;
    if (browserCaptureDraft.extractionError) {
      $<HTMLInputElement>('#capture-copy-enabled').checked = false;
      $<HTMLButtonElement>('#extension-send-integration').disabled = true;
    }
  }
  $<HTMLElement>('#extension-actions').hidden = !browserCaptureDraft.requestId;
  const retry = $<HTMLButtonElement>("#capture-integration-retry");
  const retryPending = Boolean(browserCaptureDraft.savedArticleId && browserCaptureDraft.savedCopyRevision && (!browserCaptureDraft.requestId || browserCaptureDraft.publishRequested));
  const privateComplete = Boolean(browserCaptureDraft.savedArticleId && browserCaptureDraft.savedCopyRevision && !browserCaptureDraft.publishRequested && ['copy-saved', 'complete'].includes(browserCaptureDraft.stage || ''));
  if (privateComplete && browserCaptureDraft.requestId) {
    finishBrowserCaptureDraft();
    showNotice('The Markdown copy was saved privately in Potem.');
    return;
  }
  const urlMatches = $<HTMLInputElement>("#add-url").value.trim() === browserCaptureDraft.sourceUrl;
  retry.hidden = !retryPending || !urlMatches;
  $<HTMLButtonElement>("#capture-integration-done").hidden = !retryPending || !urlMatches;
  $<HTMLTextAreaElement>("#capture-markdown").disabled = retryPending && urlMatches;
  $<HTMLInputElement>("#capture-copy-enabled").disabled = retryPending && urlMatches;
  ($("#add-form button") as HTMLButtonElement).disabled = retryPending && urlMatches;
  if (retryPending) {
    $<HTMLInputElement>("#capture-integration-enabled").disabled = true;
    $("#capture-integration-status").textContent = "The Markdown copy is saved in Potem. Retry sends that saved revision; editor changes are not included.";
  }
  if (state.session?.authenticated) void loadCaptureIntegrationConfiguration();
  if (!$<HTMLDialogElement>("#add-dialog").open)
    showDialog($<HTMLDialogElement>("#add-dialog"), $<HTMLInputElement>("#add-url"));
  renderCapturePreview();
}
function renderCapturePreview() {
  const markdown = $<HTMLTextAreaElement>('#capture-markdown').value;
  const bytes = new TextEncoder().encode(markdown).byteLength;
  $('#capture-byte-count').textContent = `${bytes.toLocaleString()} / 262,144 UTF-8 bytes`;
  const source = browserCaptureDraft?.sourceUrl || $<HTMLInputElement>('#add-url').value;
  $('#capture-preview').replaceChildren(renderMarkdown(markdown, source));
}
function showExtensionConflict(article: Article, copy: ArticleCopy | null, message: string) {
  const draft = browserCaptureDraft;
  if (draft?.requestId) {
    draft.conflict = { article, copy };
    draft.replacementConfirmed = false;
    sessionStorage.setItem('later-extension-capture', JSON.stringify(draft));
  }
  $('#capture-copy-status').textContent = `${message} Saved title: ${article.title}. Saved author: ${article.author || '—'}. Saved description: ${article.description || '—'}.`;
  $('#capture-existing-metadata').textContent = `Saved metadata: ${article.title} · ${article.author || 'No author'} · ${article.description || 'No description'}`;
  $('#capture-existing-preview').replaceChildren(copy ? renderMarkdown(copy.markdown, article.url) : document.createTextNode('No Markdown copy is saved yet.'));
  $<HTMLDetailsElement>('#capture-existing-copy').hidden = false;
  $<HTMLDetailsElement>('#capture-existing-copy').open = true;
  $<HTMLButtonElement>('#extension-confirm-replacement').hidden = false;
  $<HTMLButtonElement>('#extension-confirm-replacement').textContent = copy ? 'Confirm metadata and replace saved copy' : 'Confirm metadata and save copy';
}
function renderCaptureIntegrationConfiguration() {
  const checkbox = $<HTMLInputElement>("#capture-integration-enabled");
  const status = $("#capture-integration-status");
  const select = $<HTMLSelectElement>('#capture-integration');
  const pending = Boolean(browserCaptureDraft?.savedCopyRevision);
  $('#capture-integration-options').hidden = !captureIntegrations.length;
  checkbox.disabled = !captureIntegrationConfiguration?.configured || pending;
  select.disabled = pending || !captureIntegrations.length;
  const send = $<HTMLButtonElement>('#extension-send-integration');
  send.hidden = !captureIntegrations.length;
  send.disabled = !captureIntegrationConfiguration?.configured || pending || Boolean(browserCaptureDraft?.extractionError);
  send.textContent = captureIntegrationConfiguration ? `Save and send to ${captureIntegrationConfiguration.name}` : 'Save and send';
  $('#capture-integration-description').textContent = captureIntegrationConfiguration?.description || '';
  status.textContent = pending
    ? 'The Markdown copy is saved in Potem. Retry sends that saved revision to the selected destination.'
    : captureIntegrationConfiguration ? captureIntegrationConfiguration.message || `Destination: ${captureIntegrationConfiguration.destination}`
    : 'No integrations configured. Your copy will be saved privately in Potem.';
}
async function loadCaptureIntegrationConfiguration() {
  if (!state.session?.authenticated) return;
  if (captureIntegrationConfigurationPromise) return captureIntegrationConfigurationPromise;
  captureIntegrationConfigurationPromise = (async () => {
    $<HTMLInputElement>("#capture-integration-enabled").disabled = true;
    $("#capture-integration-status").textContent = "Checking integrations…";
    try {
      const { integrations } = await request<{ integrations: IntegrationConfiguration[] }>("/api/integrations");
      captureIntegrations = integrations;
      const select = $<HTMLSelectElement>('#capture-integration');
      const selected = browserCaptureDraft?.destination?.id || select.value;
      select.replaceChildren(...integrations.map(item => { const option = el('option', item.name); option.value = item.id; return option; }));
      if (integrations.some(item => item.id === selected)) select.value = selected;
      captureIntegrationConfiguration = integrations.find(item => item.id === select.value) || null;
      renderCaptureIntegrationConfiguration();
    } catch (error) {
      captureIntegrationConfiguration = null;
      renderCaptureIntegrationConfiguration();
      $("#capture-integration-status").textContent = `Couldn’t check integrations. ${(error as Error).message}`;
    }
  })();
  try { await captureIntegrationConfigurationPromise; }
  finally { captureIntegrationConfigurationPromise = null; }
}
$<HTMLSelectElement>('#capture-integration').addEventListener('change', () => {
  captureIntegrationConfiguration = captureIntegrations.find(item => item.id === $<HTMLSelectElement>('#capture-integration').value) || null;
  $<HTMLInputElement>('#capture-integration-enabled').checked = false;
  renderCaptureIntegrationConfiguration();
});
function finishBrowserCaptureDraft(result: 'saved' | 'action-required' = 'saved') {
  if (browserCaptureDraft?.requestId) extensionPost('capture-result', browserCaptureDraft.requestId, { result });
  browserCaptureDraft = null;
  sessionStorage.removeItem("later-browser-capture-draft");
  sessionStorage.removeItem('later-extension-capture');
  sessionStorage.removeItem('later-extension-request');
  sessionStorage.removeItem("later-add-draft");
  $<HTMLElement>("#capture-copy").hidden = true;
  $("#add-url-copy-option").hidden = !state.session?.authenticated;
  $<HTMLInputElement>("#add-capture-markdown").checked = true;
  $<HTMLTextAreaElement>("#capture-markdown").value = "";
  $<HTMLTextAreaElement>("#capture-markdown").disabled = false;
  $<HTMLInputElement>("#add-url").value = "";
  $<HTMLInputElement>("#add-title").value = "";
  $<HTMLInputElement>('#capture-author').value = '';
  $<HTMLTextAreaElement>('#capture-description').value = '';
  $<HTMLElement>('#capture-author-option').hidden = true;
  $<HTMLElement>('#capture-description-option').hidden = true;
  $<HTMLInputElement>('#add-url').readOnly = false;
  $<HTMLButtonElement>('#add-form button').hidden = false;
  $<HTMLButtonElement>('#extension-confirm-replacement').hidden = true;
  $<HTMLElement>('#extension-actions').hidden = true;
  $<HTMLDetailsElement>('#capture-existing-copy').hidden = true;
  $<HTMLInputElement>("#capture-copy-enabled").checked = true;
  $<HTMLInputElement>("#capture-copy-enabled").disabled = false;
  $<HTMLInputElement>("#capture-integration-enabled").checked = false;
  $<HTMLInputElement>("#capture-integration-enabled").disabled = !captureIntegrationConfiguration?.configured;
  renderCaptureIntegrationConfiguration();
  ($("#add-form button") as HTMLButtonElement).disabled = false;
  $<HTMLButtonElement>("#capture-integration-retry").hidden = true;
  $<HTMLButtonElement>("#capture-integration-retry").disabled = false;
  $<HTMLButtonElement>("#capture-integration-done").hidden = true;
  $("#add-dialog .add-heading p").textContent = "Paste a link to save the article and a readable Markdown copy.";
}
function finishPendingBrowserCapture() {
  finishBrowserCaptureDraft();
  $<HTMLDialogElement>("#add-dialog").close();
  showNotice("The Markdown copy remains saved in Potem. You can retry delivery from article details.");
}
async function retryBrowserCaptureIntegration() {
  const draft = browserCaptureDraft;
  if (!draft?.savedArticleId || !draft.savedCopyRevision) return;
  if ($<HTMLInputElement>("#add-url").value.trim() !== draft.sourceUrl) {
    $("#capture-integration-status").textContent = "The URL changed. This delivery retry was stopped; the saved copy remains with its original article.";
    return;
  }
  const button = $<HTMLButtonElement>("#capture-integration-retry");
  const status = $("#capture-integration-status");
  button.disabled = true;
  status.textContent = "Checking the saved copy revision…";
  try {
    const current = await request<{ copy: ArticleCopy | null }>(`/api/articles/${encodeURIComponent(draft.savedArticleId)}/copy`);
    if (current.copy?.revision !== draft.savedCopyRevision) {
      status.textContent = "The saved copy changed after this delivery retry was prepared. Open the article and save its current revision instead.";
      button.disabled = true;
      return;
    }
    if (!draft.destination) throw new Error('Review the integration destination in article details before sending.');
    status.textContent = "Sending saved copy…";
    const result = await sendToIntegration(draft.savedArticleId, draft.savedCopyRevision, draft.destination);
    if (result.integration.state === "outdated") {
      status.textContent = "The copy was sent, but article details changed during delivery. Review the article and retry its current revision.";
      button.disabled = false;
      return;
    }
    finishBrowserCaptureDraft();
    $<HTMLDialogElement>("#add-dialog").close();
    showNotice(`Markdown copy saved in Potem and sent to ${result.integration.name}.`);
    await load();
  } catch (error) {
    status.textContent = `Integration retry failed. The Markdown copy remains saved in Potem. ${(error as Error).message}`;
    button.disabled = false;
  }
}
$<HTMLButtonElement>("#capture-integration-retry").addEventListener("click", () => void retryBrowserCaptureIntegration());
$<HTMLButtonElement>("#capture-integration-done").addEventListener("click", finishPendingBrowserCapture);
$<HTMLInputElement>("#add-url").addEventListener("input", () => {
  stashDraft();
  if (browserCaptureDraft) {
    const matches = $<HTMLInputElement>("#add-url").value.trim() === browserCaptureDraft.sourceUrl;
    $<HTMLElement>("#capture-copy").hidden = !matches;
    const retryPending = Boolean(browserCaptureDraft.savedArticleId && browserCaptureDraft.savedCopyRevision);
    $<HTMLButtonElement>("#capture-integration-retry").hidden = !retryPending || !matches;
    $<HTMLButtonElement>("#capture-integration-done").hidden = !retryPending || !matches;
    ($("#add-form button") as HTMLButtonElement).disabled = retryPending && matches;
    if (!matches) {
      $("#capture-copy-status").textContent = "The link changed. This captured copy will not be attached to it.";
      if (retryPending) $("#capture-integration-status").textContent = "The URL changed. Saving this URL will not retry or publish the previous article’s copy.";
    } else if (retryPending) {
      $("#capture-integration-status").textContent = "The Markdown copy is saved in Potem. Retry sends that saved revision; editor changes are not included.";
    }
  }
});
$<HTMLInputElement>("#add-title").addEventListener("input", () => {
  stashDraft();
  if (browserCaptureDraft?.requestId) {
    browserCaptureDraft.title = $<HTMLInputElement>("#add-title").value;
    sessionStorage.setItem('later-extension-capture', JSON.stringify(browserCaptureDraft));
  }
});
$<HTMLTextAreaElement>("#capture-markdown").addEventListener("input", () => {
  if (!browserCaptureDraft) return;
  browserCaptureDraft.markdown = $<HTMLTextAreaElement>("#capture-markdown").value;
  if (browserCaptureDraft.extractionError && safeHttpUrl(browserCaptureDraft.sourceUrl) && browserCaptureDraft.markdown.trim() && new TextEncoder().encode(browserCaptureDraft.markdown).byteLength <= 262144) {
    browserCaptureDraft.extractionError = undefined;
    browserCaptureDraft.mode = 'review';
    browserCaptureDraft.publishRequested = false;
    $<HTMLInputElement>("#capture-copy-enabled").checked = true;
    $('#capture-copy-status').textContent = 'Extraction failed, but the pasted Markdown is ready. Review it and explicitly choose how to save it.';
    $<HTMLButtonElement>('#extension-save-link').hidden = true;
    renderCaptureIntegrationConfiguration();
  }
  sessionStorage.setItem(browserCaptureDraft.requestId ? 'later-extension-capture' : 'later-browser-capture-draft', JSON.stringify(browserCaptureDraft));
  renderCapturePreview();
});
$('#capture-author').addEventListener('input', () => {
  if (!browserCaptureDraft) return;
  browserCaptureDraft.author = $<HTMLInputElement>('#capture-author').value.trim();
  if (browserCaptureDraft.requestId) sessionStorage.setItem('later-extension-capture', JSON.stringify(browserCaptureDraft));
});
$('#capture-description').addEventListener('input', () => {
  if (!browserCaptureDraft) return;
  browserCaptureDraft.description = $<HTMLTextAreaElement>('#capture-description').value.trim();
  if (browserCaptureDraft.requestId) sessionStorage.setItem('later-extension-capture', JSON.stringify(browserCaptureDraft));
});
$("#add-open").addEventListener("click", () => {
  showDialog($<HTMLDialogElement>("#add-dialog"), $<HTMLInputElement>("#add-url"));
  $("#add-notice").hidden = true;
});
async function confirmExtensionReplacement() {
  const draft = browserCaptureDraft;
  const conflict = draft?.conflict;
  if (!draft?.requestId || !conflict || !draft.savedArticleId) return;
  const button = $<HTMLButtonElement>('#extension-confirm-replacement');
  button.disabled = true;
  $('#capture-copy-status').textContent = 'Checking the saved version before applying your confirmation…';
  try {
    const articleUrl = `/api/articles/${encodeURIComponent(draft.savedArticleId)}`;
    let current = (await request<{ article: Article }>(articleUrl)).article;
    let currentCopy = (await request<{ copy: ArticleCopy | null }>(`${articleUrl}/copy`)).copy;
    const expectedOldRevision = conflict.copy?.revision ?? null;
    const originalStillCurrent = (currentCopy?.revision ?? null) === expectedOldRevision;
    const intendedTitle = $<HTMLInputElement>('#add-title').value.trim();
    const intendedAuthor = $<HTMLInputElement>('#capture-author').value.trim();
    const intendedDescription = $<HTMLTextAreaElement>('#capture-description').value.trim();
    const intendedMarkdown = $<HTMLTextAreaElement>('#capture-markdown').value;
    const metadataAlreadyApplied = current.title === intendedTitle && current.author === (intendedAuthor || null) && current.description === (intendedDescription || null);
    const copyAlreadyApplied = currentCopy?.markdown === intendedMarkdown;
    if (draft.stage === 'metadata-saving' && metadataAlreadyApplied) draft.stage = 'metadata-saved';
    if (draft.stage === 'copy-saving' && copyAlreadyApplied) {
      draft.savedCopyRevision = currentCopy!.revision;
      draft.stage = 'copy-saved';
    }
    if (!draft.replacementConfirmed) {
      draft.replacementConfirmed = true;
      draft.stage = 'metadata-saving';
      sessionStorage.setItem('later-extension-capture', JSON.stringify(draft));
    }
    if (draft.stage !== 'metadata-saved' && draft.stage !== 'copy-saving' && draft.stage !== 'copy-saved' && draft.stage !== 'publishing') {
      if (!originalStillCurrent && !metadataAlreadyApplied) {
        showExtensionConflict(current, currentCopy, 'The saved article changed while you reviewed it. Check the new saved version before confirming again.');
        return;
      }
      current = (await request<{ article: Article }>(articleUrl, {
        method: 'PATCH', body: JSON.stringify({ title: intendedTitle, author: intendedAuthor || null, description: intendedDescription || null }),
      })).article;
      draft.stage = 'metadata-saved';
      sessionStorage.setItem('later-extension-capture', JSON.stringify(draft));
    }
    if (!copyAlreadyApplied) {
      currentCopy = (await request<{ copy: ArticleCopy | null }>(`${articleUrl}/copy`)).copy;
      if ((currentCopy?.revision ?? null) !== expectedOldRevision) {
        showExtensionConflict(current, currentCopy, 'The saved Markdown changed after you reviewed it. Check the new saved version before replacing it.');
        return;
      }
      draft.stage = 'copy-saving';
      sessionStorage.setItem('later-extension-capture', JSON.stringify(draft));
      const saved = await request<{ copy: ArticleCopy }>(`${articleUrl}/copy`, {
        method: 'PUT', body: JSON.stringify({ markdown: intendedMarkdown, source: 'paste', expectedRevision: currentCopy?.revision ?? null }),
      });
      currentCopy = saved.copy;
      draft.savedCopyRevision = saved.copy.revision;
      draft.stage = 'copy-saved';
      sessionStorage.setItem('later-extension-capture', JSON.stringify(draft));
    } else {
      draft.savedCopyRevision = currentCopy!.revision;
      draft.stage = 'copy-saved';
    }
    const publish = $<HTMLInputElement>('#capture-integration-enabled').checked;
    draft.publishRequested = publish;
    if (publish && captureIntegrationConfiguration && draft.mode !== 'simple') draft.destination = integrationConsent(captureIntegrationConfiguration);
    sessionStorage.setItem('later-extension-capture', JSON.stringify(draft));
    let integrationUrl: string | undefined;
    if (publish) {
      if (!draft.destination) throw new Error('Select an integration destination before sending.');
      draft.stage = 'publishing';
      sessionStorage.setItem('later-extension-capture', JSON.stringify(draft));
      const delivery = await sendToIntegration(current.id, draft.savedCopyRevision!, draft.destination);
      if (delivery.integration.state === 'outdated') throw new Error('The copy was sent, but article metadata changed during delivery. Review it and retry.');
      integrationUrl = delivery.integration.url;
      draft.stage = 'complete';
    }
    draft.savedArticleId = current.id;
    draft.savedCopyRevision = currentCopy!.revision;
    sessionStorage.setItem('later-extension-capture', JSON.stringify(draft));
    const sourceUrl = draft.sourceUrl;
    finishBrowserCaptureDraft();
    $<HTMLDialogElement>('#add-dialog').close();
    showExtensionResult(current, sourceUrl, integrationUrl);
    await load();
  } catch (error) {
    $('#capture-copy-status').textContent = `Confirmed Potem changes are retained. ${(error as Error).message}`;
    if (draft.savedCopyRevision) {
      $<HTMLButtonElement>('#capture-integration-retry').hidden = false;
      $<HTMLButtonElement>('#capture-integration-done').hidden = false;
    }
    extensionPost('capture-result', draft.requestId, { result: 'action-required' });
  } finally { button.disabled = false; }
}
$('#extension-confirm-replacement').addEventListener('click', () => { void confirmExtensionReplacement(); });
$('#extension-save-private').addEventListener('click', () => {
  $<HTMLInputElement>('#capture-copy-enabled').checked = !browserCaptureDraft?.extractionError;
  $<HTMLInputElement>('#capture-integration-enabled').checked = false;
  $<HTMLFormElement>('#add-form').requestSubmit();
});
$('#extension-save-link').addEventListener('click', () => {
  $<HTMLInputElement>('#capture-copy-enabled').checked = false;
  $<HTMLInputElement>('#capture-integration-enabled').checked = false;
  $<HTMLFormElement>('#add-form').requestSubmit();
});
$('#extension-send-integration').addEventListener('click', () => {
  if (!captureIntegrationConfiguration?.configured || browserCaptureDraft?.extractionError) return;
  $<HTMLInputElement>('#capture-copy-enabled').checked = true;
  $<HTMLInputElement>('#capture-integration-enabled').checked = true;
  $<HTMLFormElement>('#add-form').requestSubmit();
});
$('#extension-cancel').addEventListener('click', () => {
  finishBrowserCaptureDraft('action-required');
  $<HTMLDialogElement>('#add-dialog').close();
  showNotice('Capture canceled. Any writes already confirmed in Potem remain saved.');
});
$('#add-dialog').addEventListener('cancel', () => {
  if (browserCaptureDraft?.requestId) extensionPost('capture-result', browserCaptureDraft.requestId, { result: 'action-required' });
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
  if (captured?.requestId && captured.savedCopyRevision) {
    if (captured.publishRequested) {
      $<HTMLButtonElement>("#capture-integration-retry").hidden = false;
      $<HTMLButtonElement>("#capture-integration-done").hidden = false;
      showNotice('The Potem copy is already saved. Use the delivery retry to send that saved revision.', true);
      extensionPost('capture-result', captured.requestId!, { result: 'action-required' });
    }
    return;
  }
  const button = $<HTMLButtonElement>("#add-form button");
  button.disabled = true;
  const captureFromUrl = !browserCaptureDraft && $<HTMLInputElement>("#add-capture-markdown").checked;
  const addNotice = $("#add-notice");
  if (captured) {
    captured.publishRequested = Boolean($<HTMLInputElement>("#capture-integration-enabled").checked);
    if (captured.publishRequested && captureIntegrationConfiguration && captured.mode !== 'simple') captured.destination = integrationConsent(captureIntegrationConfiguration);
    sessionStorage.setItem('later-extension-capture', JSON.stringify(captured));
  }
  addNotice.classList.remove("error");
  addNotice.textContent = captureFromUrl ? "Saving the link and queueing Markdown capture…" : "Saving…";
  addNotice.hidden = false;
  try {
    if (captured?.publishRequested) {
      const { integrations } = await request<{ integrations: IntegrationConfiguration[] }>('/api/integrations');
      if (!matchesIntegrationDestination(integrations.find(item => item.id === captured.destination?.id), captured.destination)) {
        throw new Error('The selected integration destination changed. No save was started; review this capture or reconnect in extension settings.');
      }
    }
    invalidateLoads();
    const result = await request<{ article: Article; duplicate: boolean; metadataUpdated?: boolean; extraction?: ExtractionStatus }>(
      "/api/articles",
      {
        method: "POST",
        body: JSON.stringify({
          url, ...(title ? { title } : {}),
          ...(captured?.requestId ? { author: $<HTMLInputElement>('#capture-author').value, description: $<HTMLTextAreaElement>('#capture-description').value } : {}),
          ...(captureFromUrl ? { captureMarkdown: true } : captured ? { captureMarkdown: false } : {}),
        }),
      },
    );
    if (captured?.requestId) {
      captured.savedArticleId = result.article.id;
      captured.stage = 'link-saved';
      sessionStorage.setItem('later-extension-capture', JSON.stringify(captured));
    }
    const copyEnabled = captured && $<HTMLInputElement>("#capture-copy-enabled").checked;
    const alsoSendToIntegration = Boolean(copyEnabled && $<HTMLInputElement>("#capture-integration-enabled").checked);
    let copySaveError = "";
    let integrationSaveError = "";
    let integrationSaved = false;
    let integrationUrl: string | undefined;
    let savedCopy: ArticleCopy | null = null;
    if (copyEnabled) {
      const markdown = $<HTMLTextAreaElement>("#capture-markdown").value;
      const bytes = new TextEncoder().encode(markdown).byteLength;
      if (!markdown.trim() || bytes > 262144) copySaveError = "The Markdown copy is empty or exceeds the 256 KiB limit.";
      else try {
        if (captured?.requestId && result.duplicate) {
          const current = await request<{ copy: ArticleCopy | null }>(`/api/articles/${encodeURIComponent(result.article.id)}/copy`);
          const intendedAuthor = $<HTMLInputElement>('#capture-author').value.trim() || null;
          const intendedDescription = $<HTMLTextAreaElement>('#capture-description').value.trim() || null;
          const metadataMatches = result.article.title === (title || result.article.title) &&
            result.article.author === intendedAuthor && result.article.description === intendedDescription;
          if (!metadataMatches || (current.copy && current.copy.markdown !== markdown)) {
            copySaveError = 'This URL already has a saved version. Review the current metadata and Markdown, then confirm any replacement.';
            showExtensionConflict(result.article, current.copy, copySaveError);
            throw new Error(copySaveError);
          }
          if (current.copy) {
            savedCopy = current.copy;
          }
        }
        if (savedCopy) { /* The persisted identical copy is already the safe revision to publish. */ }
        else {
        if (captured?.requestId) {
          captured.stage = 'copy-saving';
          sessionStorage.setItem('later-extension-capture', JSON.stringify(captured));
        }
        const saved = await request<{ copy: ArticleCopy }>(`/api/articles/${encodeURIComponent(result.article.id)}/copy`, {
          method: "PUT",
          body: JSON.stringify({ markdown, source: "paste", expectedRevision: null }),
        });
        savedCopy = saved.copy;
        if (captured?.requestId) {
          captured.savedCopyRevision = saved.copy.revision;
          captured.stage = 'copy-saved';
          sessionStorage.setItem('later-extension-capture', JSON.stringify(captured));
        }
        }
      } catch (error) {
        copySaveError ||= (error as Error).message;
      }
    }
    if (savedCopy && captured && alsoSendToIntegration) {
      captured.savedArticleId = result.article.id;
      captured.savedCopyRevision = savedCopy.revision;
      captured.stage = 'publishing';
      sessionStorage.setItem("later-browser-capture-draft", JSON.stringify(captured));
      sessionStorage.setItem('later-extension-capture', JSON.stringify(captured));
      try {
        if (!captured.destination) throw new Error('Select an integration destination before sending.');
        const delivery = await sendToIntegration(result.article.id, savedCopy.revision, captured.destination);
        if (delivery.integration.state === "outdated") integrationSaveError = "The copy was sent, but article details changed meanwhile. Review the article and retry its current revision.";
        else {
          integrationSaved = true;
          integrationUrl = delivery.integration.url && safeHttpUrl(delivery.integration.url) ? delivery.integration.url : undefined;
          captured.stage = 'complete';
          sessionStorage.setItem('later-extension-capture', JSON.stringify(captured));
        }
      } catch (error) {
        integrationSaveError = (error as Error).message;
      }
    }
    const pendingCopyLeftBehind = Boolean(browserCaptureDraft?.savedCopyRevision && !captured);
    const copyNotAttached = Boolean(browserCaptureDraft && !captured);
    const copySkipped = Boolean(captured && !copyEnabled);
    if (!copySaveError && !integrationSaveError) {
      $<HTMLInputElement>("#add-url").value = "";
      $<HTMLInputElement>("#add-title").value = "";
      sessionStorage.removeItem("later-add-draft");
      if (browserCaptureDraft) {
        finishBrowserCaptureDraft();
      }
    } else if (copySaveError) {
      stashDraft();
    } else {
      const retry = $<HTMLButtonElement>("#capture-integration-retry");
      retry.hidden = false;
      $<HTMLButtonElement>("#capture-integration-done").hidden = false;
      $<HTMLTextAreaElement>("#capture-markdown").disabled = true;
      $<HTMLInputElement>("#capture-copy-enabled").disabled = true;
      $<HTMLInputElement>("#capture-integration-enabled").disabled = true;
      button.disabled = true;
      $("#capture-integration-status").textContent = `Link and Markdown copy are saved in Potem. The integration could not receive the saved copy: ${integrationSaveError} Retry sends that saved revision; it does not write the copy again.`;
    }
    if (!copySaveError && !integrationSaveError) $<HTMLDialogElement>("#add-dialog").close();
    state.status = "all";
    document
      .querySelectorAll<HTMLButtonElement>("[data-status]")
      .forEach((b) =>
        b.setAttribute("aria-pressed", String(b.dataset.status === "all")),
      );
    if (copySaveError) {
      const addNotice = $("#add-notice");
      addNotice.textContent = `Link saved. Markdown copy was not changed: ${copySaveError} No integration was called. Your draft remains here. Uncheck “Save this Markdown copy” to save the link only.`;
      addNotice.classList.add("error");
      addNotice.hidden = false;
      if (captured?.requestId) extensionPost('capture-result', captured.requestId, { result: 'action-required' });
    } else if (integrationSaveError) {
      const addNotice = $("#add-notice");
      addNotice.textContent = `Link and Markdown copy saved in Potem. Integration delivery failed; retry the same saved revision below.`;
      addNotice.classList.add("error");
      addNotice.hidden = false;
      if (captured?.requestId) extensionPost('capture-result', captured.requestId, { result: 'action-required' });
    } else if (captured?.requestId) {
      showExtensionResult(result.article, captured.sourceUrl, integrationUrl);
    } else showNotice(
      copyNotAttached
          ? pendingCopyLeftBehind
            ? "Link saved. The previous Markdown copy remains on its original article; this new link has no copy or integration delivery."
            : "Link saved. The captured Markdown was not attached because the URL changed."
          : integrationSaved
            ? "Link and Markdown copy saved in Potem and sent to the integration."
          : savedCopy
              ? "Link and Markdown copy saved privately in Potem."
              : copySkipped
                ? "Link saved. Markdown copy was left out by your choice."
      : captureFromUrl && extractionIsPending(result.extraction || result.article.extraction)
        ? (result.extraction || result.article.extraction)?.paused
          ? "Link saved. Capture is paused; Markdown can be added from article details."
          : "Link saved. Capturing Markdown in the background."
        : result.duplicate
          ? result.metadataUpdated ? "Preview details updated." : "That link is already in your list."
          : "Saved for later.",
    );
    if (copySaveError || integrationSaveError) {
      await load();
      return;
    }
    await load();
  } catch (err) {
    const addNotice = $("#add-notice");
    addNotice.textContent = `Couldn’t save this link. ${(err as Error).message}`;
    addNotice.classList.add("error");
    addNotice.hidden = false;
    if (browserCaptureDraft?.requestId) extensionPost('capture-result', browserCaptureDraft.requestId, { result: 'action-required' });
  } finally {
    if (!browserCaptureDraft?.savedCopyRevision) button.disabled = false;
  }
});
const statusOrder = ["unread", "read", "all"] as const;
function setStatus(status: string) {
  if (!statusOrder.includes(status as (typeof statusOrder)[number])) return;
  setSearchOpen(false);
  invalidateLoads();
  stopExtractionPolling();
  state.status = status;
  document
    .querySelectorAll("[data-status]")
    .forEach((button) => button.setAttribute("aria-pressed", String((button as HTMLElement).dataset.status === status)));
  void load();
}
document
  .querySelectorAll<HTMLButtonElement>("[data-status]")
  .forEach((button) => button.addEventListener("click", () => setStatus(button.dataset.status || "unread")));

let statusSwipeStart: { x: number; y: number } | null = null;
statusTabs.addEventListener("touchstart", (event) => {
  const touch = event.changedTouches[0];
  if (touch) statusSwipeStart = { x: touch.clientX, y: touch.clientY };
}, { passive: true });
statusTabs.addEventListener("touchend", (event) => {
  if (!statusSwipeStart) return;
  const touch = event.changedTouches[0];
  const start = statusSwipeStart;
  statusSwipeStart = null;
  if (!touch) return;
  const dx = touch.clientX - start.x;
  const dy = touch.clientY - start.y;
  if (Math.abs(dx) < 48 || Math.abs(dx) <= Math.abs(dy) * 1.25) return;
  const current = statusOrder.indexOf(state.status as (typeof statusOrder)[number]);
  const next = Math.max(0, Math.min(statusOrder.length - 1, current + (dx < 0 ? 1 : -1)));
  if (next !== current) setStatus(statusOrder[next]);
}, { passive: true });
statusTabs.addEventListener("touchcancel", () => { statusSwipeStart = null; }, { passive: true });

let searchTimer: number;
searchToggle.addEventListener("click", () => {
  const open = searchControl.classList.contains("is-open");
  setSearchOpen(!open, !open);
});
searchInput.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  setSearchOpen(false);
  searchToggle.focus({ preventScroll: true });
});
document.addEventListener("click", (event) => {
  if (!searchControl.classList.contains("is-open") || searchControl.contains(event.target as Node)) return;
  setSearchOpen(false);
});
searchInput.addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  stopExtractionPolling();
  invalidateLoads();
  state.query = (e.target as HTMLInputElement).value.trim();
  updateSearchState();
  searchTimer = window.setTimeout(() => void load(), 250);
});
$("#more").addEventListener("click", () => load(false));
$("#logout").addEventListener("click", async () => {
  stopExtractionPolling();
  copyDrafts.clear();
  browserCaptureDraft = null;
  clearLastOpened();
  try { sessionStorage.removeItem(pendingReaderStorageKey); } catch {}
  sessionStorage.removeItem("later-browser-capture-draft");
  sessionStorage.removeItem("later-add-draft");
  discardPrivateContent();
  try {
    await request("/auth/logout", { method: "POST" });
    copyDrafts.clear();
    history.replaceState(listHistoryState(), "", "/");
    setListTitle();
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
  $<HTMLSelectElement>("#theme-toggle").value = state.theme;
}
$("#theme-toggle").addEventListener("change", (e) => {
  state.theme = (e.target as HTMLSelectElement).value;
  try { localStorage.setItem("later-theme", state.theme); } catch { /* Theme selection still applies in memory. */ }
  applyTheme();
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (state.theme === "system") applyTheme();
});
$("#settings-open").addEventListener("click", openSettings);
$("#settings-dialog").addEventListener("close", () => {
  const box = $("#new-token");
  box.replaceChildren();
  box.hidden = true;
});
async function openSettings() {
  showDialog($<HTMLDialogElement>("#settings-dialog"), $<HTMLSelectElement>("#theme-toggle"));
  if (!state.session?.authenticated) {
    $("#settings-status").textContent =
      "Sign in to manage your capture tokens.";
    $("#token-form").hidden = true;
    $("#tokens").replaceChildren();
    return;
  }
  $("#settings-status").textContent = "Signed in";
  $("#token-form").hidden = false;
  void request<{ integrations: IntegrationConfiguration[] }>('/api/integrations').then(({ integrations }) => {
    const container = $('#settings-integrations');
    container.replaceChildren();
    if (!integrations.length) container.append(el('p', 'No integrations configured. Articles are saved privately in Potem.', 'muted'));
    for (const integration of integrations) {
      container.append(el('h4', integration.name), el('p', integration.destination), el('p', integration.message || integration.description, 'muted'));
    }
    if (reconcileGitHubButton) reconcileGitHubButton.hidden = !integrations.some(item => item.id === 'github' && item.configured);
  }).catch(() => { $('#settings-integrations').textContent = 'Couldn’t load integrations. Reopen Settings to retry.'; });
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
$("#import-open").addEventListener("click", () => {
  $<HTMLInputElement>("#import-file").click();
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
  const addNotice = $("#add-notice");
  addNotice.textContent = url
    ? "Link prefilled. Review and choose Save link."
    : "We couldn’t find one clear link. Paste the link you want to save.";
  addNotice.classList.toggle("error", !url);
  addNotice.hidden = false;
  if (!$<HTMLDialogElement>("#add-dialog").open)
    showDialog($<HTMLDialogElement>("#add-dialog"), $<HTMLInputElement>("#add-url"));
}
const captureChannel = params.get("capture");
if (location.pathname === "/add" && captureChannel) {
  // This flow saves the source tab's reviewed clip (or just its link on failure).
  // Do not silently replace a blocked bookmarklet with a different server capture.
  $("#add-url-copy-option").hidden = true;
  $<HTMLInputElement>("#add-capture-markdown").checked = false;
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
if (extensionHandoffId && /^[a-f0-9]{48}$/.test(extensionHandoffId)) extensionPost('ready', extensionHandoffId);
recoverDraft();
initialize();
