import { inspectArchive, restoreArchive } from "./archive";
import { markdownDownload, markdownDownloadName, renderMarkdown } from "./markdown.js";
import type { IntegrationConfiguration, IntegrationStatus, IntegrationConsent } from "../src/integrations/contracts.js";
import type { ArticlePreview } from "../src/articles/preview-contract.js";
import { articlePath, isArticleId } from "../src/articles/identity.js";
import { normalizeArticleUrl, ValidationError } from "../src/articles/validation.js";

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
  originalPdf?: { id: string; bytes: number; capturedAt: string };
  id: string;
  url: string;
  title: string;
  author: string | null;
  description: string | null;
  tags?: string[];
  descriptionOrigin?: 'manual' | 'extracted' | 'generated' | null;
  enrichment?: { state: 'queued' | 'running' | 'retry_wait' | 'deferred' | 'succeeded' | 'failed' | 'skipped'; paused: boolean };
  createdAt: string;
  updatedAt: string;
  readAt: string | null;
  readingTimeMinutes?: number | null;
  rating: 'up' | 'down' | null;
  favorite: boolean;
  hasCopy?: boolean;
  extraction?: ExtractionStatus;
  podcastFit?: PodcastSuitability;
};
type ExtractionState = "none" | "queued" | "running" | "retry_wait" | "ready" | "failed";
type ExtractionStatus = {
  state: ExtractionState; attempts: number; errorCode: string | null; nextAttemptAt: string | null; paused: boolean;
  undoAvailable?: boolean;
  recovery?: { generation: number; state: 'queued' | 'running' | 'retry_wait' | 'succeeded' | 'failed'; attempts: number; errorCode: string | null; nextAttemptAt: string | null };
};
type Session = { authenticated: boolean; csrfToken?: string; audioEnabled?: boolean };
type Page = { items: Article[]; nextCursor: string | null; capture?: { paused: boolean } };
type ArticleCopy = { markdown: string; capturedAt: string; source: "paste" | "upload"; revision: string; readingTimeMinutes?: number | null };
type PodcastSuitability = { tier: "good" | "mixed" | "poor"; reason: string; spokenWords: number; codeBlocks: number; codeSharePercent: number };
type AudioStatus = { enabled: boolean; state: "none" | "queued" | "generating" | "ready" | "failed"; episodeId: string | null; sourceRevision: string | null; characters: number; estimatedDurationSeconds: number; estimatedCostUsd: number; errorCode: string | null; suitability: PodcastSuitability | null };
type PodcastSettings = { enabled: boolean; token: { createdAt: string } | null; usage: { month: string; usedCharacters: number; reservedCharacters: number; freeCharacters: number; budgetUsd: number; estimatedCostUsd: number } };
let privateFeedUrl: string | null = null;
let audioPollTimer = 0;
let audioPollGeneration = 0;
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
function readerToolbarAnchorY(dialog: HTMLDialogElement, toolbar: HTMLElement): number {
  // Use the sticky slot's layout edge; its visual rect moves when the toolbar slides away.
  return dialog.getBoundingClientRect().top + toolbar.offsetHeight;
}
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
  const anchorY = readerToolbarAnchorY(dialog, toolbar);
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
          dialog.scrollTop + bounds.top + position.fraction * bounds.height - readerToolbarAnchorY(dialog, toolbar)));
      } else dialog.scrollTop = position.scrollTop;
    }
    const restoredScrollTop = dialog.scrollTop;
    requestAnimationFrame(() => {
      if (readerPositionContext === context && generation === readerPositionRestoreGeneration) {
        // WebKit can reset the dialog's scroll after reopening at a different viewport size.
        if (dialog.open && restoredScrollTop > 0 && dialog.scrollTop === 0) {
          dialog.scrollTop = restoredScrollTop;
        }
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
function listHistoryState(view?: "feeds"): ReaderHistoryState { return { potem: { version: 1, kind: "list", ...(view ? { view } : {}) } }; }
function isFeedsPath(pathname = location.pathname) { return pathname === "/feeds" || pathname === "/feeds/"; }
function readerHistoryState(id: string, fromList: boolean): ReaderHistoryState { return { potem: { version: 1, kind: "reader", articleId: id, fromList } }; }
function setListTitle() { document.title = "potem — your reading list"; }
function setArticleTitle(article: Pick<Article, "title">) { document.title = `${article.title} · Potem`; }
function isShortcutView() {
  return state.status === "unread" && !state.query.trim() && !state.tag;
}
function rememberListView(opener?: HTMLElement) {
  const active = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const article = active?.closest<HTMLElement>(".article");
  listSnapshot = { scrollY: window.scrollY, cursor: state.cursor, pageCount: Math.max(1, Math.ceil(list.children.length / 50)), focus: active, focusArticleId: article?.dataset.id || null, focusKind: active?.classList.contains("article-lead") ? "lead" : article ? "title" : "other", status: state.status, query: state.query, tag: state.tag, rowCount: list.children.length };
}
async function restoreListView() {
  const completion = pendingReadCompletion;
  pendingReadCompletion = null;
  if (!listSnapshot && !completion) return;
  const snapshot = listSnapshot;
  if (snapshot) {
    state.status = snapshot.status;
    state.query = snapshot.query;
    state.tag = snapshot.tag;
    $<HTMLInputElement>("#search").value = snapshot.query;
    document.querySelectorAll<HTMLButtonElement>("[data-status]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.status === snapshot.status)));
    renderLastOpened();
  }
  let refreshed = true;
  if (completion || snapshot?.forceRefresh || (snapshot && list.children.length !== snapshot.rowCount)) {
    for (let page = 0; page < (snapshot?.pageCount ?? 1); page++) {
      const task = load(page === 0);
      const generation = loadGeneration;
      refreshed = await task === true;
      if (parseReaderPath(location.pathname) || generation !== loadGeneration) return;
      if (!refreshed || !state.cursor) break;
    }
  }
  if (parseReaderPath(location.pathname)) return;
  if (refreshed && snapshot?.forceRefresh && listSnapshot === snapshot) listSnapshot = { ...snapshot, forceRefresh: false, rowCount: list.children.length, cursor: state.cursor };
  const fallback = snapshot?.focusArticleId
    ? list.querySelector<HTMLElement>(`.article[data-id="${CSS.escape(snapshot.focusArticleId)}"] .${snapshot.focusKind === "lead" ? "article-lead" : "article-title"}`)
    : null;
  const shortcutTitle = document.querySelector<HTMLElement>("#last-opened-title");
  const candidates = [
    !completion ? snapshot?.focus : null,
    fallback,
    !completion ? shortcutTitle : null,
    !completion && isShortcutView() && shortcutTitle && shortcutTitle.closest("[hidden]") && lastOpenedArticle && !lastOpenedArticle.readAt &&
      list.firstElementChild?.getAttribute("data-id") === lastOpenedArticle.id
      ? list.querySelector<HTMLElement>(".article-title") : null,
    document.querySelector<HTMLElement>("[data-status][aria-pressed='true']"),
    document.querySelector<HTMLElement>("#search"),
  ];
  const target = candidates.find((candidate): candidate is HTMLElement =>
    Boolean(candidate?.isConnected && !candidate.closest("[hidden]") && candidate.getClientRects().length),
  );
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
  const isContinueReading = Boolean(inProgress || lastOpenedError);
  const label = isContinueReading ? "Continue reading" : "Picked for you";
  const firstArticle = list.firstElementChild as HTMLElement | null;
  const duplicatesFirstArticle = Boolean(inProgress && firstArticle?.dataset.id === inProgress.id);
  const wasVisible = !row.hidden;
  row.hidden = !state.session?.authenticated || !isShortcutView() || duplicatesFirstArticle || (!article && !error && !suggestionLoading);
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
  if (wasVisible && row.hidden && row.contains(document.activeElement) && duplicatesFirstArticle) {
    const fallback = list.querySelector<HTMLElement>(".article-title");
    fallback?.focus({ preventScroll: true });
  }
  // Updating the shortcut above the list must not move its background view.
  window.scrollTo(scrollX, scrollY);
}
async function loadSuggestion(shuffle = false) {
  if (!state.session?.authenticated || !isShortcutView() || !lastOpenedReady || lastOpenedError ||
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
  tag: "",
  cursor: null as string | null,
  loading: false,
  theme: (() => { try { const value = localStorage.getItem("later-theme"); return value === "light" || value === "dark" ? value : "system"; } catch { return "system"; } })(),
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
type ReaderHistoryState = { potem?: { version: 1; kind: "list" | "reader" | "preview"; view?: "feeds"; articleId?: string; fromList?: boolean; previewId?: string } };
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
type ReaderFeedbackPatch = { rating: Article['rating'] } | { favorite: boolean };
type ReaderFeedbackRetry = { patch: ReaderFeedbackPatch; error: string };
const readerFeedbackRetries = new Map<string, ReaderFeedbackRetry>();
const readerFeedbackPending = new Set<string>();
let readerFeedbackSessionGeneration = 0;
let listSnapshot: { scrollY: number; cursor: string | null; pageCount: number; focus: HTMLElement | null; focusArticleId: string | null; focusKind: "title" | "lead" | "other"; status: string; query: string; tag: string; rowCount: number; forceRefresh?: boolean } | null = null;
let favoritesRefreshGeneration = 0;
let extractionPollTimer = 0;
let extractionPollStartedAt = 0;
const detailDisclosureState = new Map<string, Map<string, boolean>>();
function rememberDetailDisclosure(articleId: string, disclosure: HTMLDetailsElement) {
  const key = disclosure.dataset.disclosure;
  if (!key) return;
  let state = detailDisclosureState.get(articleId);
  if (!state) { state = new Map(); detailDisclosureState.set(articleId, state); }
  state.set(key, disclosure.open);
}
function revealDetailDisclosure(disclosure: HTMLDetailsElement) {
  const articleId = disclosure.dataset.articleId;
  if (!articleId || !disclosure.isConnected || !$('#detail-content').contains(disclosure) || state.selected?.id !== articleId) return;
  disclosure.open = true;
  rememberDetailDisclosure(articleId, disclosure);
}
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
  $<HTMLButtonElement>("#clear-search").hidden = true;
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
    privateFeedUrl = null;
    clearAudioPoll();
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
function formatAudioEstimate(audio: AudioStatus) {
  const minutes = Math.max(1, Math.round(audio.estimatedDurationSeconds / 60));
  return `About ${minutes} min · $${audio.estimatedCostUsd.toFixed(3)}`;
}
function audioStateLabel(audio: AudioStatus) {
  return audio.state === "queued" ? "Audio queued" : audio.state === "generating" ? "Generating audio…"
    : audio.state === "ready" ? "Audio ready in your podcast feed"
      : audio.state === "failed" && audio.errorCode === "budget_exceeded" ? "Monthly audio budget reached"
        : audio.state === "failed" && ["provider_timeout_ambiguous", "provider_outcome_unknown"].includes(audio.errorCode || "")
          ? "Speech outcome is uncertain. Retrying could incur another charge."
          : audio.state === "failed" ? "Audio preparation failed" : "";
}
function clearAudioPoll() { window.clearTimeout(audioPollTimer); audioPollTimer = 0; audioPollGeneration++; }
function scheduleAudioPoll(article: Article, active: () => boolean, refresh: () => Promise<void>) {
  clearAudioPoll();
  const generation = audioPollGeneration;
  audioPollTimer = window.setTimeout(async () => {
    if (generation !== audioPollGeneration || !state.session?.authenticated || document.visibilityState === "hidden" || !active()) return;
    await refresh();
  }, 3000);
}
async function fetchAudioStatus(article: Article) {
  const result = await request<{ audio: AudioStatus }>(`/api/articles/${encodeURIComponent(article.id)}/audio`);
  return result.audio;
}
async function prepareArticleAudio(article: Article, button: HTMLButtonElement, status: HTMLElement, done: (audio: AudioStatus) => void = () => {}) {
  button.disabled = true;
  status.textContent = "Checking the saved copy…";
  try {
    // The API supplies the revision used for generation. Never infer it from stale UI state.
    const { copy } = await request<{ copy: ArticleCopy | null }>(`/api/articles/${encodeURIComponent(article.id)}/copy`);
    if (!copy) { status.textContent = "Save a reading copy before preparing audio."; button.disabled = false; return; }
    const result = await request<{ audio: AudioStatus }>(`/api/articles/${encodeURIComponent(article.id)}/audio`, { method: "POST", body: JSON.stringify({ expectedRevision: copy.revision }) });
    let audio = result.audio;
    try { audio = await fetchAudioStatus(article); } catch { /* The prepare response still carries the authoritative job state. */ }
    status.textContent = audioStateLabel(audio);
    done(audio);
  } catch (error) {
    status.textContent = `Couldn’t prepare audio. ${(error as Error).message}`;
    button.disabled = false;
  }
}
let podcastDialogArticle: Article | null = null;
let podcastDialogCopyAvailable = true;
let podcastDialogGeneration = 0;
function setPodcastFitIndicator(tier: PodcastSuitability["tier"] | null, label: string) {
  const indicator = $<HTMLElement>("#podcast-fit-icon");
  indicator.classList.remove("podcast-fit-good", "podcast-fit-mixed", "podcast-fit-poor");
  if (tier) indicator.classList.add(`podcast-fit-${tier}`);
  indicator.setAttribute("aria-label", label);
  indicator.title = label;
  indicator.innerHTML = iconMarkup("podcast");
}
function renderPodcastStatus(audio: AudioStatus, generation = podcastDialogGeneration) {
  if (generation !== podcastDialogGeneration) return;
  const article = podcastDialogArticle;
  if (!article) return;
  const fit = audio.suitability;
  if (!podcastDialogCopyAvailable) {
    setPodcastFitIndicator(null, "Fit unavailable");
    $("#podcast-fit-reason").textContent = "Save a reading copy to check podcast fit.";
  } else if (fit) {
    const label = fit.tier === "good" ? "Good fit" : fit.tier === "mixed" ? "Mixed fit" : "Less suitable";
    setPodcastFitIndicator(fit.tier, `${label}. ${fit.reason}`);
    $("#podcast-fit-reason").textContent = fit.reason;
  } else {
    setPodcastFitIndicator(null, "Fit unavailable");
    $("#podcast-fit-reason").textContent = "Couldn’t check the saved copy’s format.";
  }
  $("#podcast-estimate").textContent = podcastDialogCopyAvailable ? formatAudioEstimate(audio) : "";
  const status = $<HTMLElement>("#podcast-status");
  status.textContent = !podcastDialogCopyAvailable ? "Save a reading copy before preparing audio."
    : audio.state === "none" && !audio.enabled ? "Audio preparation is unavailable."
      : audioStateLabel(audio);
  const button = $<HTMLButtonElement>("#podcast-prepare");
  button.hidden = !audio.enabled || audio.state === "ready";
  button.textContent = audio.state === "failed" ? "Retry audio" : "Prepare audio";
  button.disabled = !podcastDialogCopyAvailable || !audio.enabled || audio.state === "queued" || audio.state === "generating";
  if (audio.state === "queued" || audio.state === "generating") {
    scheduleAudioPoll(article, () => generation === podcastDialogGeneration && $<HTMLDialogElement>("#podcast-dialog").open,
      async () => { try { renderPodcastStatus(await fetchAudioStatus(article), generation); } catch { /* Keep the last known status. */ } });
  }
}
function openPodcastDialog(article: Article, copyAvailable = article.hasCopy !== false) {
  const dialog = $<HTMLDialogElement>("#podcast-dialog");
  podcastDialogArticle = article;
  podcastDialogCopyAvailable = copyAvailable;
  const generation = ++podcastDialogGeneration;
  $("#podcast-article-title").textContent = article.title;
  setPodcastFitIndicator(null, "Checking podcast fit…");
  $("#podcast-fit-reason").textContent = "";
  $("#podcast-estimate").textContent = "";
  $("#podcast-status").textContent = "Checking audio status…";
  const prepare = $<HTMLButtonElement>("#podcast-prepare");
  prepare.hidden = false;
  prepare.disabled = true;
  prepare.textContent = "Prepare audio";
  showDialog(dialog, $("#podcast-heading"));
  void fetchAudioStatus(article).then(audio => renderPodcastStatus(audio, generation)).catch(() => {
    if (generation !== podcastDialogGeneration) return;
    setPodcastFitIndicator(null, "Fit unavailable");
    $("#podcast-fit-reason").textContent = copyAvailable ? "Couldn’t check this saved copy." : "Save a reading copy to check podcast fit.";
    $("#podcast-estimate").textContent = "";
    $("#podcast-status").textContent = "Couldn’t load podcast status.";
    prepare.disabled = true;
  });
}
$<HTMLButtonElement>("#podcast-prepare").addEventListener("click", () => {
  const article = podcastDialogArticle;
  if (!article) return;
  void prepareArticleAudio(article, $<HTMLButtonElement>("#podcast-prepare"), $("#podcast-status"), audio => renderPodcastStatus(audio));
});
$<HTMLDialogElement>("#podcast-dialog").addEventListener("close", () => {
  podcastDialogGeneration++;
  podcastDialogArticle = null;
  clearAudioPoll();
});
function attachAudioControl(parent: HTMLElement, article: Article, copyAvailable = true) {
  parent.replaceChildren();
  const button = el("button", undefined, "podcast-options-button");
  button.type = "button";
  button.setAttribute("aria-label", "Podcast options");
  button.innerHTML = `${iconMarkup("podcast")}<span>Podcast options</span>`;
  button.addEventListener("click", () => openPodcastDialog(article, copyAvailable));
  parent.append(button);
  parent.hidden = false;
  return button;
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
    return recovery.state === 'queued' ? 'Recapture queued' : recovery.state === 'retry_wait' ? 'Recapture retrying' : 'Recapturing article';
  }
  if (!extraction || extraction.state === "none") return "";
  if (extraction.state === "ready") return "Markdown ready";
  if (extraction.state === "failed") return "Capture failed";
  if (extraction.state === "queued") return "Capture queued";
  return extraction.state === "retry_wait" ? "Capture retrying" : "Capturing Markdown";
}
function readingTimeLabel(minutes?: number | null) {
  return minutes && minutes > 0 ? `${minutes} min read` : "";
}
function updateArticleReadingTime(meta: HTMLElement, minutes?: number | null) {
  const current = meta.querySelector(".article-reading-time");
  const label = readingTimeLabel(minutes);
  if (!label) current?.remove();
  else if (current) current.textContent = ` · ${label}`;
  else meta.append(el("span", ` · ${label}`, "article-reading-time"));
}
function renderArticleMeta(article: Article) {
  const meta = el("p", undefined, "article-meta");
  meta.append(el("span", sourceHost(article.url), "article-meta-domain"));
  if (article.author) {
    meta.append(document.createTextNode(" · "));
    meta.append(el("span", `By ${article.author}`));
  }
  updateArticleReadingTime(meta, article.readingTimeMinutes);
  return meta;
}
function updateExtractionBadge(badge: HTMLElement, extraction?: ExtractionStatus) {
  const failed = extraction?.recovery?.state === 'failed' || extraction?.state === "failed";
  const pending = extractionIsPending(extraction);
  badge.classList.toggle("extraction-badge-pending", pending);
  badge.classList.remove("extraction-badge-ready");
  badge.classList.toggle("extraction-badge-failed", failed);
  if (!pending && !failed) {
    badge.hidden = true;
    badge.removeAttribute("role");
    badge.removeAttribute("aria-label");
    badge.removeAttribute("title");
    badge.replaceChildren();
    return;
  }
  const label = extractionLabel(extraction);
  badge.hidden = false;
  if (pending) {
    badge.setAttribute("role", "img");
    badge.setAttribute("aria-label", label);
    badge.title = label;
    badge.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3 2" /></svg>';
    return;
  }
  if (failed) {
    badge.setAttribute("role", "img");
    badge.setAttribute("aria-label", label);
    badge.title = label;
    badge.innerHTML = iconMarkup("capture-failed");
    return;
  }
}
function extractionIsPending(extraction?: ExtractionStatus) {
  return Boolean(extraction && ["queued", "running", "retry_wait"].includes(extraction.recovery?.state ?? extraction.state));
}
function extractionFailureMessage(code: string | null | undefined) {
  switch (code) {
    case 'pdf_no_text': return 'PDF saved; no extractable text. Scanned PDFs need OCR, which is not available yet.';
    case 'markdown_too_large': return 'The extracted text exceeds the reading-copy limit.';
    case 'invalid_pdf': return 'The source did not contain a valid PDF.';
    case 'pdf_storage_unavailable': return 'PDF storage is temporarily unavailable. Retry capture.';
    case 'converter_unavailable':
    case 'conversion_timeout': return 'Document conversion is temporarily unavailable. Retry capture.';
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
  if (!state.session?.authenticated || document.visibilityState === "hidden" || (!extractionIsPending(article.extraction) && !enrichmentIsPending(article))) return;
  if (!$<HTMLDialogElement>("#detail-dialog").open && !$<HTMLDialogElement>("#reader-dialog").open) return;
  const generation = extractionPollGeneration;
  const delay = Date.now() - extractionPollStartedAt < 60_000 ? 5_000 : 30_000;
  extractionPollTimer = window.setTimeout(async () => {
    try {
      const detail = await request<{ article: Article }>(`/api/articles/${encodeURIComponent(article.id)}`);
      if (generation !== extractionPollGeneration || state.selected?.id !== article.id) return;
      const updated = detail.article;
      const result = { extraction: updated.extraction! };
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
        if (meta) meta.replaceWith(renderArticleMeta(updated));
        const badge = row.querySelector<HTMLElement>(".extraction-badge");
        if (badge) updateExtractionBadge(badge, result.extraction);
      }
      if (!extractionIsPending(result.extraction) && result.extraction.state === "ready") {
        if ($<HTMLDialogElement>("#reader-dialog").open) {
          if (!$("#reader-body").hidden && result.extraction.recovery) {
            if (result.extraction.recovery.state === 'succeeded') $("#reader-new-copy").hidden = false;
            else showNotice(extractionLabel(result.extraction), true);
          } else if ($("#reader-body").hidden) {
            const copy = await request<{ copy: ArticleCopy | null }>(`/api/articles/${encodeURIComponent(article.id)}/copy`);
            if (copy.copy && generation === extractionPollGeneration && state.selected?.id === article.id && $<HTMLDialogElement>("#reader-dialog").open && !$<HTMLDialogElement>("#detail-dialog").open) openReader(updated, copy.copy);
          }
        } else if ($<HTMLDialogElement>("#detail-dialog").open) refreshDetailAfterExtraction(updated);
        stopExtractionPolling();
        if (enrichmentIsPending(updated)) scheduleExtractionPoll(updated);
        return;
      }
      if (result.extraction.state === "failed") {
        if ($<HTMLDialogElement>("#detail-dialog").open) refreshDetailAfterExtraction(updated);
        else if ($("#reader-body").hidden) renderPendingReader(updated);
        stopExtractionPolling();
        if (enrichmentIsPending(updated)) scheduleExtractionPoll(updated);
        return;
      }
      const status = $("#reader-pending-status");
      if ($<HTMLDialogElement>("#reader-dialog").open && !status.hidden) status.textContent = extractionLabel(result.extraction);
      if ($<HTMLDialogElement>("#detail-dialog").open) {
        const detailStatus = $("#detail-extraction-status");
        if (detailStatus) detailStatus.textContent = extractionLabel(result.extraction);
      }
      if (!extractionIsPending(updated.extraction) && $<HTMLDialogElement>('#detail-dialog').open) refreshDetailAfterExtraction(updated);
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
function detailContentKey(article: Article): string {
  return JSON.stringify([article.id, article.url, article.title, article.author, article.description, article.descriptionOrigin,
    article.tags, article.createdAt, article.readAt, article.originalPdf, article.extraction]);
}
function refreshDetailAfterExtraction(article: Article) {
  const root = $("#detail-content");
  const status = root.querySelector<HTMLElement>('.enrichment-status');
  if (status) { status.textContent = enrichmentLabel(article); status.hidden = !status.textContent; }
  // Status-only polls must leave the editor, its focus, and its copy request intact.
  if (root.dataset.contentKey === detailContentKey(article)) return;
  if (root.querySelector<HTMLElement>('.copy-editor')?.dataset.saving === 'true') return;
  if (root.querySelector<HTMLElement>('.edit-form')?.dataset.saving === 'true') return;
  const active = document.activeElement;
  const focused = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : null;
  const fieldSelector = focused
    ? focused.dataset.field ? `.edit-form [data-field="${CSS.escape(focused.dataset.field)}"]`
      : focused.matches('.copy-editor textarea') ? '.copy-editor textarea' : null : null;
  const selection = fieldSelector && focused && root.contains(focused) ? {
    selector: fieldSelector, start: focused.selectionStart, end: focused.selectionEnd,
    direction: focused.selectionDirection, top: focused.scrollTop, left: focused.scrollLeft,
  } : null;
  const fields = [...root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('.edit-form [data-field]')];
  const drafts = fields.filter(field => field.value !== field.defaultValue || field.dataset.cleared === 'true')
    .map(field => ({ key: field.dataset.field!, value: field.value, cleared: field.dataset.cleared }));
  const editorLoaded = renderDetail(article, false);
  for (const draft of drafts) {
    const field = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`.edit-form [data-field="${draft.key}"]`);
    if (field) { field.value = draft.value; if (draft.cleared) field.dataset.cleared = draft.cleared; field.dispatchEvent(new Event('input')); }
  }
  if (selection) {
    const field = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(selection.selector);
    if (field) {
      field.focus({ preventScroll: true });
      const restoreSelection = () => {
        if (selection.start !== null && selection.end !== null) field.setSelectionRange(selection.start, selection.end, selection.direction ?? 'none');
        field.scrollTop = selection.top; field.scrollLeft = selection.left;
      };
      if (selection.selector === '.copy-editor textarea') {
        // The saved body loads asynchronously. Do not clamp the selection on an
        // empty textarea, or restore it after the owner has interacted again.
        let moved = false;
        const cancel = () => { moved = true; };
        const events = ['input', 'keydown', 'pointerdown', 'blur'];
        events.forEach(event => field.addEventListener(event, cancel));
        const cleanup = () => events.forEach(event => field.removeEventListener(event, cancel));
        void editorLoaded.then(() => {
          cleanup();
          if (!moved && field.isConnected && document.activeElement === field) restoreSelection();
        }, cleanup);
      } else restoreSelection();
    }
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    stopExtractionPolling();
    return;
  }
  if (state.selected && (extractionIsPending(state.selected.extraction) || enrichmentIsPending(state.selected))) scheduleExtractionPoll(state.selected);
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
type IconName = "capture-failed" | "mark-read" | "mark-unread" | "more" | "podcast";
function iconMarkup(name: IconName): string {
  switch (name) {
    case "capture-failed":
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v6m0 4h.01" /></svg>';
    case "mark-unread":
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7" /></svg>';
    case "mark-read":
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4.5 4.5L19 7" /></svg>';
    case "more":
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>';
    case "podcast":
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13v-1a8 8 0 0 1 16 0v1"/><path d="M4 13h3v7H6a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2m13 0h1a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-1z"/></svg>';
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
function enrichmentIsPending(article: Article): boolean {
  return !!article.enrichment && !article.enrichment.paused && ['queued', 'running', 'retry_wait'].includes(article.enrichment.state);
}
function enrichmentLabel(article: Article): string {
  if (!article.enrichment) return '';
  if (article.enrichment.paused && ['queued','running','retry_wait','deferred'].includes(article.enrichment.state)) return 'Automatic tags paused';
  if (article.enrichment.state === 'failed') return 'Automatic tags unavailable. You can add tags below.';
  if (article.enrichment.state === 'deferred') return 'Automatic tags waiting for the daily allowance';
  return enrichmentIsPending(article) ? 'Generating tags…' : '';
}
async function refreshTagPicker() {
  const generation = loadGeneration;
  try {
    const result = await request<{ tags: Array<{ tag: string; count: number }> }>('/api/tags');
    if (!state.session?.authenticated || generation !== loadGeneration) return;
    const picker = $<HTMLSelectElement>('#tag-filter');
    picker.replaceChildren(new Option('All tags', ''));
    for (const item of result.tags) picker.add(new Option(`${item.tag} (${item.count})`, item.tag));
    if (state.tag && !result.tags.some(t => t.tag === state.tag)) picker.add(new Option(state.tag, state.tag));
    picker.value = state.tag;
    $<HTMLButtonElement>('#tag-clear').hidden = !state.tag;
    $('#tag-controls').hidden = !result.tags.length && !state.tag;
  } catch { /* Tag discovery does not block the reading list. */ }
}
function selectTag(tag: string) {
  state.tag = tag;
  renderLastOpened();
  $<HTMLSelectElement>('#tag-filter').value = tag;
  $<HTMLButtonElement>('#tag-clear').hidden = !tag;
  if (parseReaderPath(location.pathname)) {
    // Closing reader-backed details restores the saved list asynchronously.
    // Make this explicit filter choice the view that history restores.
    if (!listSnapshot) rememberListView();
    invalidateLoads();
    listSnapshot = { ...listSnapshot!, tag, cursor: null, pageCount: 1, forceRefresh: true, scrollY: 0,
      focus: $<HTMLSelectElement>('#tag-filter'), focusArticleId: null, focusKind: 'other' };
    navigateReaderAway();
  } else void load();
}
$('#tag-filter').addEventListener('change', event => selectTag((event.target as HTMLSelectElement).value));
$('#tag-clear').addEventListener('click', () => selectTag(''));
function renderTags(article: Article, compact = false): HTMLElement {
  const tags = el('div', undefined, 'article-tags');
  tags.setAttribute('aria-label', 'Article tags');
  const allTags = article.tags ?? [];
  const visibleTags = compact ? allTags.slice(0, 2) : allTags;
  const appendTag = (container: HTMLElement, tag: string) => {
    const chip = el('button', tag, 'tag-chip'); chip.type = 'button';
    chip.setAttribute('aria-label', `Filter by ${tag}`);
    chip.addEventListener('click', () => {
      if ($<HTMLDialogElement>('#detail-dialog').open) $<HTMLDialogElement>('#detail-dialog').close();
      selectTag(tag);
    });
    container.append(chip);
  };
  for (const tag of visibleTags) appendTag(tags, tag);
  const hiddenTags = allTags.slice(2);
  if (compact && hiddenTags.length) {
    const disclosure = el('details', undefined, 'article-tags-more');
    const summary = el('summary', `+${hiddenTags.length}`);
    summary.setAttribute('aria-label', `Show ${hiddenTags.length} more tags`);
    summary.setAttribute('aria-expanded', 'false');
    disclosure.append(summary);
    for (const tag of hiddenTags) appendTag(disclosure, tag);
    disclosure.addEventListener('toggle', () => {
      summary.textContent = disclosure.open ? 'Less' : `+${hiddenTags.length}`;
      summary.setAttribute('aria-label', disclosure.open ? 'Hide additional tags' : `Show ${hiddenTags.length} more tags`);
      summary.setAttribute('aria-expanded', String(disclosure.open));
    });
    tags.append(disclosure);
  }
  return tags;
}
function renderArticle(article: Article) {
  const li = el("li", undefined, `article${article.readAt ? " is-read" : ""}`);
  li.dataset.id = article.id;
  const main = el("div", undefined, "article-main");
  const headingRow = el("div", undefined, "article-heading-row");
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
  const actions = el("div", undefined, "article-actions");
  const read = iconButton(
    article.readAt ? "Mark as unread" : "Mark as read",
    article.readAt ? "mark-unread" : "mark-read",
    "read-action",
  );
  read.addEventListener("click", () => mutateRead(article, !article.readAt));
  metaRow.append(meta, extractionBadge);
  if (state.session?.audioEnabled === true && article.podcastFit?.tier === "good") {
    const fitIcon = iconButton(`Good podcast candidate. ${article.podcastFit.reason}`, "podcast", "podcast-fit-icon-button podcast-fit-good");
    fitIcon.addEventListener("click", () => openPodcastDialog(article, article.hasCopy === true));
    metaRow.append(fitIcon);
  }
  const more = el("div", undefined, "article-more");
  const moreButton = iconButton("More actions", "more", "subtle more-action");
  const menu = el("div", undefined, "article-action-menu");
  menu.id = `article-actions-${article.id}`;
  menu.setAttribute("popover", "auto");
  moreButton.setAttribute("popovertarget", menu.id);
  const edit = el("button", "Edit", "article-menu-item edit-action");
  edit.type = "button";
  edit.addEventListener("click", () => {
    menu.hidePopover();
    openDetail(article, moreButton);
  });
  const link = el("a", "Open original", "article-menu-item original-link");
  link.href = safeHttpUrl(article.url) || "#";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.addEventListener("click", (e) => { e.stopPropagation(); menu.hidePopover(); });
  menu.append(edit, link);
  more.append(moreButton, menu);
  menu.addEventListener("beforetoggle", (event) => {
    if ((event as ToggleEvent).newState !== "open") return;
    // The popover has dimensions after it opens. Position it before the first paint.
    requestAnimationFrame(() => {
      if (!menu.matches(":popover-open")) return;
      const bounds = moreButton.getBoundingClientRect();
      const menuHeight = menu.offsetHeight;
      const below = bounds.bottom + menuHeight + 5 <= window.innerHeight;
      menu.style.top = `${below ? bounds.bottom + 5 : Math.max(8, bounds.top - menuHeight - 5)}px`;
      menu.style.right = `${Math.max(8, window.innerWidth - bounds.right)}px`;
    });
  });
  actions.append(read, more);
  headingRow.append(title, actions);
  main.append(headingRow);
  if (description) main.append(description);
  main.append(metaRow);
  const tags = renderTags(article, true);
  if (article.descriptionOrigin === 'generated') tags.prepend(el('span', 'Generated description', 'generated-label'));
  if (tags.childElementCount) metaRow.append(tags);
  li.append(main);
  return li;
}
window.addEventListener("scroll", () => {
  document.querySelector<HTMLElement>(".article-action-menu:popover-open")?.hidePopover();
}, { passive: true });
function render(items: Article[], append = false) {
  if (!append) list.replaceChildren();
  const visibleItems = state.status === "podcast" ? items.filter(item => item.podcastFit?.tier === "good") : items;
  for (const item of visibleItems) list.append(renderArticle(item));
  const count = list.children.length;
  $("#result-count").textContent = count ? `${count} shown` : "";
  empty.hidden = count !== 0;
  if (!count) {
    const heading = $("#empty h3");
    const message = $("#empty p");
    const clearSearch = $<HTMLButtonElement>("#clear-search");
    const authenticated = state.session?.authenticated === true;
    clearSearch.hidden = !authenticated || !state.query;
    if (state.query) {
      heading.textContent = `No matches for ‘${state.query}’`;
      message.textContent = state.tag ? `No matches in this tag.` : "Try a different search.";
    } else if (state.status === "podcast") {
      heading.textContent = "No podcast picks on this page";
      message.textContent = state.cursor ? "Show more to check older articles." : "Save more prose-focused articles to find good podcast candidates.";
    } else if (state.status === "favorites") {
      heading.textContent = state.tag ? `No favorites tagged ‘${state.tag}’` : "No favorites yet";
      message.textContent = state.tag ? "Try another tag or change the list filter." : "Star an article at the end of the reader to find it here.";
    } else if (state.tag) {
      heading.textContent = `No ${state.status === "all" ? "" : state.status + " "}articles tagged ‘${state.tag}’`;
      message.textContent = "Try another tag or change the list filter.";
    } else if (state.status === "unread") {
      heading.textContent = "No unread articles";
      message.textContent = "You’re all caught up.";
    } else if (state.status === "read") {
      heading.textContent = "No articles marked as read";
      message.textContent = "Articles you mark as read will appear here.";
    } else {
      heading.textContent = "Nothing here yet";
      message.textContent = "When you save an article, it’ll be waiting here.";
    }
  }
  $("#more").hidden = !state.cursor;
}
async function load(reset = true, preserveCurrent = false) {
  if (!state.session?.authenticated) return;
  const generation = ++loadGeneration;
  if (reset) {
    if (!preserveCurrent) {
      state.cursor = null;
      list.replaceChildren();
    }
    empty.hidden = true;
    $("#clear-search").hidden = true;
  }
  setBusy(true);
  if (preserveCurrent) loading.hidden = true;
  $<HTMLButtonElement>("#more").disabled = true;
  try {
    const p = new URLSearchParams({ status: state.status === "podcast" ? "all" : state.status, limit: "50" });
    if (state.query) p.set("q", state.query);
    if (state.tag) p.set("tag", state.tag);
    if (state.cursor && !reset) p.set("cursor", state.cursor);
    const page = await request<Page>(`/api/articles?${p}`);
    if (generation !== loadGeneration) return;
    $("#capture-status").hidden = page.capture?.paused !== true;
    state.cursor = page.nextCursor;
    render(page.items, !reset);
    if (reset) void refreshTagPicker();
    if (reset && !suggestedArticle && !suggestionError) suggestionLoaded = false;
    renderLastOpened();
    void loadSuggestion();
    return true;
  } catch (e) {
    if (generation !== loadGeneration) return;
    if ($<HTMLDialogElement>("#detail-dialog").open)
      showDetailError(`Couldn’t refresh the list. ${(e as Error).message}`);
    else
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
async function refreshFavoritesAfterFeedback() {
  const refreshGeneration = ++favoritesRefreshGeneration;
  if (!state.session?.authenticated) return;
  if (state.status !== "favorites") {
    if (listSnapshot?.status === "favorites") listSnapshot = { ...listSnapshot, forceRefresh: true };
    return;
  }
  if ($<HTMLDialogElement>("#reader-dialog").open || $<HTMLDialogElement>("#detail-dialog").open) {
    if (listSnapshot) listSnapshot = { ...listSnapshot, forceRefresh: true };
    return;
  }
  const snapshot = state.loading && listSnapshot?.status === "favorites" && listSnapshot.query === state.query && listSnapshot.tag === state.tag
    ? listSnapshot : null;
  const scrollY = snapshot?.scrollY ?? window.scrollY;
  const focus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const focusedArticle = focus?.closest<HTMLElement>(".article");
  const focusArticleId = focusedArticle?.dataset.id ?? snapshot?.focusArticleId;
  const focusKind = snapshot?.focusKind ?? (focus?.classList.contains("article-lead") ? "lead" : "title");
  const pageCount = snapshot?.pageCount ?? Math.max(1, Math.ceil(list.children.length / 50));
  const view = { status: state.status, query: state.query, tag: state.tag };
  const sameView = () => refreshGeneration === favoritesRefreshGeneration && state.status === view.status && state.query === view.query && state.tag === view.tag && !parseReaderPath(location.pathname) && !$<HTMLDialogElement>("#reader-dialog").open && !$<HTMLDialogElement>("#detail-dialog").open;
  for (let page = 0; page < pageCount; page++) {
    const task = load(page === 0);
    const generation = loadGeneration;
    if (!await task || !sameView() || loadGeneration !== generation) return;
    if (!state.cursor) break;
  }
  window.scrollTo(0, scrollY);
  if (!focusArticleId || document.activeElement !== document.body) return;
  const rowTarget = list.querySelector<HTMLElement>(`.article[data-id="${CSS.escape(focusArticleId)}"] .${focusKind === "lead" ? "article-lead" : "article-title"}`);
  (rowTarget ?? document.querySelector<HTMLElement>('[data-status="favorites"]'))?.focus({ preventScroll: true });
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
function showDetailStatus(message: string, bad = false) {
  const status = document.querySelector<HTMLElement>("#detail-status");
  if (!status) return;
  status.textContent = message;
  status.hidden = !message;
  status.classList.toggle("error", bad);
}
function renderDetail(article: Article, restartPolling = true) {
  state.selected = article;
  const root = $("#detail-content");
  const disclosures = detailDisclosureState.get(article.id);
  root.replaceChildren();
  root.dataset.contentKey = detailContentKey(article);
  const eyebrow = el("p", sourceHost(article.url), "eyebrow");
  const status = el("p", undefined, "notice");
  status.id = "detail-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.hidden = true;
  const form = el("form", undefined, "edit-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = input.value.trim();
    if (!title) return;
    const patch = {
      ...(title !== input.defaultValue ? { title } : {}),
      ...(tagInput.value !== tagInput.defaultValue || tagInput.dataset.cleared === 'true' ? { tags: tagInput.value.split(',').map(tag => tag.trim()).filter(Boolean) } : {}),
      ...(descriptionInput.value !== descriptionInput.defaultValue || descriptionInput.dataset.cleared === 'true' ? { description: descriptionInput.value.trim() || null } : {}),
    };
    if (!Object.keys(patch).length) return;
    const active = document.activeElement;
    const focusedField = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
      ? active.dataset.field : undefined;
    const selection = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
      ? { start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection }
      : null;
    form.dataset.saving = "true";
    try {
      invalidateLoads();
      const result = await request<{ article: Article }>(
        `/api/articles/${encodeURIComponent(article.id)}`,
        { method: "PATCH", body: JSON.stringify(patch) },
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
      const listRefreshed = await load();
      showNotice("");
      renderDetail(result.article);
      showDetailStatus(
        listRefreshed === false ? "Article details updated. Couldn’t refresh the list." : "Article details updated.",
        listRefreshed === false,
      );
      if (focusedField) {
        const field = $("#detail-content").querySelector<HTMLInputElement | HTMLTextAreaElement>(
          `.edit-form [data-field="${CSS.escape(focusedField)}"]`,
        );
        if (field) {
          field.focus({ preventScroll: true });
          if (selection && selection.start !== null && selection.end !== null)
            field.setSelectionRange(selection.start, selection.end, selection.direction ?? "none");
        }
      }
    } catch (err) {
      showDetailError((err as Error).message);
    } finally { form.dataset.saving = 'false'; }
  });
  const label = el("label", "Title", "field-label");
  const input = el("input");
  input.value = article.title;
  input.defaultValue = article.title;
  input.dataset.field = "title";
  input.maxLength = 500;
  label.append(input);
  const save = el("button", "Save changes", "button primary");
  save.type = "submit";
  const tagField = el('div', undefined, 'edit-field');
  const tagLabel = el('label', 'Tags (comma separated)', 'field-label');
  const tagInput = el('input'); tagInput.dataset.field = 'tags';
  tagInput.value = (article.tags ?? []).join(', '); tagInput.defaultValue = tagInput.value;
  tagInput.maxLength = 600; tagInput.placeholder = 'e.g. programming, databases'; tagLabel.append(tagInput);
  tagField.append(tagLabel);
  const descriptionLabel = el('label', 'Description', 'field-label');
  const descriptionInput = el('textarea'); descriptionInput.dataset.field = 'description';
  descriptionInput.setAttribute('aria-label', 'Description');
  descriptionInput.rows = 3; descriptionInput.maxLength = 500;
  descriptionInput.value = article.description ?? ''; descriptionInput.defaultValue = descriptionInput.value;
  if (article.descriptionOrigin === 'generated') {
    const generated = el('span', 'Generated', 'generated-label');
    generated.id = 'detail-description-origin';
    descriptionInput.setAttribute('aria-describedby', generated.id);
    descriptionLabel.append(generated);
  }
  descriptionLabel.append(descriptionInput);
  const descriptionField = el('div', undefined, 'edit-field');
  descriptionField.append(descriptionLabel);
  const clearTags = el('button', 'Clear', 'inline-action'); clearTags.type = 'button';
  clearTags.setAttribute('aria-label', 'Clear tags');
  clearTags.addEventListener('click', () => { tagInput.value = ''; tagInput.dataset.cleared = 'true'; tagInput.dispatchEvent(new Event('input')); tagInput.focus(); });
  tagField.append(clearTags);
  const clearDescription = el('button', 'Clear', 'inline-action'); clearDescription.type = 'button';
  clearDescription.setAttribute('aria-label', 'Clear description');
  clearDescription.addEventListener('click', () => { descriptionInput.value = ''; descriptionInput.dataset.cleared = 'true'; descriptionInput.dispatchEvent(new Event('input')); descriptionInput.focus(); });
  descriptionField.append(clearDescription);
  form.append(label, tagField, descriptionField, save);
  const url = el("a", article.url, "detail-url");
  url.href = safeHttpUrl(article.url) || "#";
  url.target = "_blank";
  url.rel = "noopener noreferrer";
  const actions = el("div", undefined, "detail-actions");
  const readLabel = article.readAt ? "Mark as unread" : "Mark as read";
  const toggle = el(
    "button",
    readLabel,
    "button secondary",
  );
  toggle.type = "button";
  toggle.setAttribute("aria-label", readLabel);
  toggle.title = readLabel;
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
  if (article.originalPdf) {
    const saved = el('a', 'Open saved PDF', 'button secondary');
    saved.href = `/api/articles/${article.id}/pdf?asset=${article.originalPdf.id}`; saved.target = '_blank'; saved.rel = 'noopener noreferrer';
    const download = el('a', 'Download PDF', 'button secondary');
    download.href = `/api/articles/${article.id}/pdf?asset=${article.originalPdf.id}&download=1`; download.target = '_blank'; download.rel = 'noopener noreferrer';
    actions.append(saved, download);
  }
  const extractionPanel = el("section", undefined, "extraction-panel");
  extractionPanel.setAttribute("aria-live", "polite");
  const extractionStatus = el("p", `${article.originalPdf ? "PDF saved · " : ""}${extractionLabel(article.extraction)}`, "extraction-detail-status");
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
      revealDetailDisclosure(captureDisclosure);
      retryCapture.disabled = false;
    }
  });
  if (article.extraction) {
    if (article.extraction.state === "failed") extractionStatus.textContent = `${extractionFailureMessage(article.extraction.errorCode)} Paste or upload a browser copy below, or retry.`;
    extractionPanel.append(extractionStatus, retryCapture);
  }
  const captureDisclosure = el('details', undefined, 'detail-disclosure');
  captureDisclosure.dataset.disclosure = 'capture';
  captureDisclosure.dataset.articleId = article.id;
  captureDisclosure.append(el('summary', 'Capture and recovery'), extractionPanel);
  captureDisclosure.open = article.extraction?.state === 'failed' || article.extraction?.recovery?.state === 'failed'
    ? true : disclosures?.get('capture') ?? false;
  const enrichmentStatus = el('p', enrichmentLabel(article), 'muted enrichment-status');
  enrichmentStatus.hidden = !enrichmentStatus.textContent;
  root.append(
    eyebrow,
    el("h2", "Edit article"),
    status,
    ...(article.author ? [el("p", `By ${article.author}`, "muted")] : []),
    el("p", `Saved ${dateLabel(article.createdAt)}`, "muted"),
    enrichmentStatus,

    form,
    el("h3", "Original link"),
    url,
    actions,
    captureDisclosure,
  );
  const editorLoaded = renderCopyEditor(article, captureDisclosure);
  for (const disclosure of root.querySelectorAll<HTMLDetailsElement>('details[data-disclosure]')) {
    disclosure.addEventListener('toggle', () => rememberDetailDisclosure(article.id, disclosure));
  }
  if (restartPolling && (extractionIsPending(article.extraction) || enrichmentIsPending(article))) startExtractionPolling(article);
  return editorLoaded;
}

async function renderCopyEditor(article: Article, captureDisclosure: HTMLDetailsElement) {
  const root = $("#detail-content");
  const section = el("details", undefined, "copy-editor detail-disclosure");
  section.dataset.disclosure = 'markdown';
  section.dataset.articleId = article.id;
  section.append(el('summary', 'Edit Markdown copy'));
  section.open = detailDisclosureState.get(article.id)?.has('markdown')
    ? detailDisclosureState.get(article.id)!.get('markdown')!
    : article.hasCopy === false;
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
  const integrationDisclosure = el('details', undefined, 'detail-disclosure integration-disclosure');
  integrationDisclosure.dataset.disclosure = 'integrations';
  integrationDisclosure.dataset.articleId = article.id;
  integrationDisclosure.append(el('summary', 'Integrations'));
  integrationDisclosure.open = detailDisclosureState.get(article.id)?.get('integrations') ?? false;
  integrationRetry.hidden = true;
  let saved: ArticleCopy | null = null;
  let integrations: IntegrationStatus[] = [];
  let integrationError: string | null = null;
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
  const recoveryError = el('p', undefined, 'notice error');
  recoveryError.setAttribute('role', 'alert');
  recoveryError.hidden = true;
  const metadataFields = [...root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('.edit-form [data-field]')];
  const isDirty = () => Boolean(copyDrafts.has(article.id) || metadataFields.some(field => field.value !== field.defaultValue || field.dataset.cleared === 'true'));
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
  metadataFields.forEach(field => field.addEventListener('input', updateRecoveryControls));
  discard.addEventListener('click', () => {
    copyDrafts.delete(article.id);
    textarea.value = saved?.markdown ?? '';
    source = saved?.source ?? 'paste';
    for (const field of metadataFields) { field.value = field.defaultValue; delete field.dataset.cleared; }
    showStatus(saved ? `Saved ${dateLabel(saved.capturedAt)}` : 'No Markdown copy saved yet.');
    updateRecoveryControls();
  });
  const recover = async (action: 'recapture' | 'undo') => {
    if (!loaded || saving || isDirty()) return;
    saving = true;
    recoveryError.hidden = true;
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
      if (root.contains(section)) {
        recoveryError.textContent = `Couldn’t ${action === 'undo' ? 'undo recapture' : 'queue recapture'}. ${(error as Error).message}`;
        recoveryError.hidden = false;
        revealDetailDisclosure(captureDisclosure);
      }
    } finally { saving = false; updateRecoveryControls(); }
  };
  recapture.addEventListener('click', () => { void recover('recapture'); });
  undo.addEventListener('click', () => { void recover('undo'); });
  const recoveryActions = el('div', undefined, 'saved-copy-actions');
  recoveryActions.append(recapture, undo, discard);
  recovery.append(refreshLabel, recoveryActions, recoveryHint, recoveryError);
  captureDisclosure.append(recovery);
  updateRecoveryControls();
  save.disabled = true;
  const showError = (text: string, disclosure: HTMLDetailsElement = section) => {
    message.textContent = text;
    message.classList.add("error");
    message.hidden = false;
    revealDetailDisclosure(disclosure);
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
    integrationStatus.classList.toggle('error', Boolean(integrationError));
    if (integrationError) { integrationStatus.textContent = integrationError; return; }
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
  integrationSelect.addEventListener('change', () => { integrationCheckbox.checked = false; integrationError = null; renderIntegrationStatus(); });
  const refreshIntegrationStatus = async () => {
    try {
      const result = await request<{ integrations: IntegrationStatus[] }>(`/api/articles/${encodeURIComponent(article.id)}/integrations`);
      if (state.selected?.id !== article.id || !root.contains(section)) return;
      integrationError = null;
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
      integrationError = `Couldn’t load integrations. ${(error as Error).message}`;
      renderIntegrationStatus();
      revealDetailDisclosure(integrationDisclosure);
    }
  };
  const sendSavedCopy = async (destination: IntegrationConsent) => {
    if (!saved) return;
    integrationStatus.textContent = "Sending saved copy…";
    try {
      const result = await sendToIntegration(article.id, saved.revision, destination);
      integrationError = null;
      integrations = integrations.map(item => item.id === result.integration.id ? result.integration : item);
      renderIntegrationStatus();
      if (result.integration.state === "outdated") {
        integrationError = "The saved copy was sent, but this article changed meanwhile. Reload it and send again.";
        renderIntegrationStatus();
        revealDetailDisclosure(integrationDisclosure);
      }
      else showNotice(`Markdown copy sent to ${result.integration.name}.`);
    } catch (error) {
      await refreshIntegrationStatus();
      integrationError = `Your Markdown copy is saved in Potem. Couldn’t send it. ${(error as Error).message} Use “Send saved copy” to retry.`;
      renderIntegrationStatus();
      revealDetailDisclosure(integrationDisclosure);
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
      const meta = list.querySelector<HTMLElement>(`[data-id="${CSS.escape(article.id)}"] .article-meta`);
      if (meta) updateArticleReadingTime(meta, saved.readingTimeMinutes);
      if (state.selected?.id === article.id && root.contains(section)) {
        stopExtractionPolling();
        state.selected.readingTimeMinutes = saved.readingTimeMinutes;
      }
      showCopyActions();
      copyDrafts.delete(article.id);
      try {
        const extraction = await request<{ extraction: ExtractionStatus }>(`/api/articles/${encodeURIComponent(article.id)}/extraction`);
        if (state.selected?.id === article.id && root.contains(section)) state.selected.extraction = extraction.extraction;
      } catch { /* A status refresh failure does not change the successful copy save. */ }
      if (state.selected?.id === article.id && root.contains(section)) scheduleExtractionPoll(state.selected);
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
  section.append(label, fileLabel, save, message);
  integrationDisclosure.append(integrationLabel, integrationSelect, integrationDescription, integrationStatus, integrationRetry);
  root.append(status, savedActions, section, integrationDisclosure);
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
    if (!saved) revealDetailDisclosure(section);
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
    revealDetailDisclosure(section);
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
  const menu = $<HTMLElement>("#reader-actions-menu");
  if (menu.matches(":popover-open")) menu.hidePopover();
  $<HTMLButtonElement>("#reader-more-button").disabled = false;
  $("#reader-completion").hidden = !article;
  $("#reader-read-error").hidden = true;
  $("#reader-read-error").textContent = "";
  const button = $<HTMLButtonElement>("#reader-read-toggle");
  button.disabled = false;
  button.removeAttribute("aria-busy");
  const deleteButton = $<HTMLButtonElement>("#reader-delete-button");
  deleteButton.disabled = false;
  deleteButton.removeAttribute("aria-busy");
  const readLabel = article?.readAt ? "Mark as unread" : "Mark as read";
  $("#reader-read-label").textContent = readLabel;
  button.setAttribute("aria-label", readLabel);
  button.title = readLabel;
  button.querySelector("svg")!.outerHTML = iconMarkup(article?.readAt ? "mark-unread" : "mark-read");
  renderReaderFeedback(article);
}
function renderReaderFeedback(article?: Article) {
  const up = $<HTMLButtonElement>("#reader-rating-up");
  const down = $<HTMLButtonElement>("#reader-rating-down");
  const favorite = $<HTMLButtonElement>("#reader-favorite-toggle");
  const error = $("#reader-feedback-error");
  const retry = readerFeedbackRetries.get(article?.id || "");
  const pending = Boolean(article && readerFeedbackPending.has(article.id));
  up.setAttribute("aria-pressed", String(article?.rating === "up"));
  down.setAttribute("aria-pressed", String(article?.rating === "down"));
  favorite.setAttribute("aria-pressed", String(article?.favorite === true));
  const locked = !article || readerReadRequest !== null;
  for (const control of [up, down, favorite]) {
    control.disabled = locked;
    control.setAttribute("aria-disabled", String(locked || pending));
    if (pending) control.setAttribute("aria-busy", "true");
    else control.removeAttribute("aria-busy");
  }
  $<HTMLButtonElement>("#reader-read-toggle").disabled = !article || pending || readerReadRequest !== null;
  $<HTMLButtonElement>("#reader-delete-button").disabled = !article || pending || readerReadRequest !== null;
  error.replaceChildren();
  error.hidden = !retry;
  if (article && retry) {
    error.append(document.createTextNode(`Couldn’t save feedback. ${retry.error} `));
    const button = el("button", "Retry", "button secondary");
    button.type = "button";
    button.addEventListener("click", () => {
      if (document.activeElement === button) {
        const selector = "favorite" in retry.patch ? "#reader-favorite-toggle"
          : retry.patch.rating === "down" || (retry.patch.rating === null && article.rating === "down") ? "#reader-rating-down" : "#reader-rating-up";
        $(selector).focus({ preventScroll: true });
      }
      void submitReaderFeedback(article, retry.patch);
    });
    error.append(button);
  }
}
async function submitReaderFeedback(article: Article, patch: ReaderFeedbackPatch) {
  if (readerFeedbackPending.has(article.id) || readerReadRequest || !state.session?.authenticated) return;
  const sessionGeneration = readerFeedbackSessionGeneration;
  const currentSession = () => sessionGeneration === readerFeedbackSessionGeneration && state.session?.authenticated;
  const reader = $<HTMLDialogElement>("#reader-dialog");
  readerFeedbackPending.add(article.id);
  readerFeedbackRetries.delete(article.id);
  renderReaderFeedback(article);
  try {
    const { article: updated } = await request<{ article: Article }>(`/api/articles/${encodeURIComponent(article.id)}`, {
      method: "PATCH", body: JSON.stringify(patch),
    });
    if (!currentSession()) return;
    if (state.selected?.id === article.id) {
      state.selected = { ...state.selected, rating: updated.rating, favorite: updated.favorite };
      if (reader.open || $<HTMLDialogElement>("#detail-dialog").open) scheduleExtractionPoll(state.selected);
    }
    if ("favorite" in patch) void refreshFavoritesAfterFeedback();
  } catch (error) {
    if (currentSession()) readerFeedbackRetries.set(article.id, { patch, error: (error as Error).message });
  } finally {
    readerFeedbackPending.delete(article.id);
    if (currentSession() && reader.open && readerArticleId === article.id && state.selected?.id === article.id) {
      renderReaderFeedback(state.selected);
    }
  }
}
for (const [selector, rating] of [
  ["#reader-rating-up", "up"],
  ["#reader-rating-down", "down"],
  ["#reader-favorite-toggle", null],
] as const) {
  $<HTMLButtonElement>(selector).addEventListener("click", () => {
    const article = state.selected;
    if (!article || readerArticleId !== article.id || $("#reader-completion").hidden) return;
    void submitReaderFeedback(article, rating ? { rating: article.rating === rating ? null : rating } : { favorite: !article.favorite });
  });
}
$("#reader-actions-menu").addEventListener("toggle", (event) => {
  const expanded = (event as ToggleEvent).newState === "open";
  $("#reader-more-button").setAttribute("aria-expanded", String(expanded));
});
function positionReaderActions() {
  const menu = $<HTMLElement>("#reader-actions-menu");
  if (!menu.matches(":popover-open")) return;
  const trigger = $<HTMLButtonElement>("#reader-more-button").getBoundingClientRect();
  const bounds = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(trigger.left, window.innerWidth - bounds.width - 8));
  const below = trigger.bottom + bounds.height + 5 <= window.innerHeight;
  menu.style.left = `${left}px`;
  menu.style.top = `${below ? trigger.bottom + 5 : Math.max(8, trigger.top - bounds.height - 5)}px`;
}
$("#reader-actions-menu").addEventListener("beforetoggle", (event) => {
  if ((event as ToggleEvent).newState !== "open") return;
  requestAnimationFrame(positionReaderActions);
});
function dismissReaderActions() {
  const menu = $<HTMLElement>("#reader-actions-menu");
  if (menu.matches(":popover-open")) menu.hidePopover();
}
$<HTMLDialogElement>("#reader-dialog").addEventListener("scroll", positionReaderActions, { passive: true });
window.addEventListener("resize", dismissReaderActions, { passive: true });
$("#reader-read-toggle").addEventListener("click", async () => {
  const article = state.selected;
  const dialog = $<HTMLDialogElement>("#reader-dialog");
  if (!article || readerArticleId !== article.id || !dialog.open || $("#reader-completion").hidden || readerReadRequest || readerFeedbackPending.has(article.id)) return;
  const generation = readerLoadGeneration;
  const operation = {};
  readerReadRequest = operation;
  const isCurrent = () => generation === readerLoadGeneration && readerReadRequest === operation && readerArticleId === article.id && dialog.open;
  const button = $<HTMLButtonElement>("#reader-read-toggle");
  button.disabled = true;
  $<HTMLButtonElement>("#reader-more-button").disabled = true;
  $<HTMLButtonElement>("#reader-delete-button").disabled = true;
  renderReaderFeedback(article);
  button.setAttribute("aria-busy", "true");
  $("#reader-read-label").textContent = "Saving…";
  button.setAttribute("aria-label", "Saving…");
  button.title = "Saving…";
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
  } finally {
    if (readerReadRequest === operation) {
      readerReadRequest = null;
      if (readerArticleId === article.id && dialog.open) renderReaderFeedback(state.selected || article);
    }
  }
});
$("#reader-delete-button").addEventListener("click", async () => {
  const article = state.selected;
  const dialog = $<HTMLDialogElement>("#reader-dialog");
  const button = $<HTMLButtonElement>("#reader-delete-button");
  if (!article || readerArticleId !== article.id || !dialog.open || $("#reader-completion").hidden || button.disabled || readerReadRequest || readerFeedbackPending.has(article.id)) return;
  const readerMenu = $<HTMLElement>("#reader-actions-menu");
  if (readerMenu.matches(":popover-open")) readerMenu.hidePopover();
  if (!confirm(`Delete “${article.title}”? This can’t be undone.`)) {
    $<HTMLButtonElement>("#reader-more-button").focus({ preventScroll: true });
    return;
  }

  const generation = readerLoadGeneration;
  const operation = {};
  readerReadRequest = operation;
  button.disabled = true;
  $<HTMLButtonElement>("#reader-more-button").disabled = true;
  button.setAttribute("aria-busy", "true");
  $<HTMLButtonElement>("#reader-read-toggle").disabled = true;
  renderReaderFeedback(article);
  $("#reader-read-error").hidden = true;
  try {
    invalidateLoads();
    await request(`/api/articles/${encodeURIComponent(article.id)}`, { method: "DELETE" });
    const isCurrent = generation === readerLoadGeneration && readerReadRequest === operation && readerArticleId === article.id && dialog.open;
    clearLastOpened(article.id);
    copyDrafts.delete(article.id);
    if (listSnapshot) {
      listSnapshot = { ...listSnapshot, forceRefresh: true, focus: null, focusArticleId: null, focusKind: "title" };
    }
    if (!isCurrent) {
      const refreshed = await load();
      showNotice(refreshed === false ? "Article deleted. Couldn’t refresh your library." : "Article deleted.", refreshed === false);
      return;
    }

    pendingReadCompletion = "Article deleted.";
    state.selected = null;
    const detail = $<HTMLDialogElement>("#detail-dialog");
    if (detail.open) detail.close();
    navigateReaderAway();
    clearReader();
  } catch (error) {
    if (generation !== readerLoadGeneration || readerArticleId !== article.id || !dialog.open) return;
    button.disabled = false;
    $<HTMLButtonElement>("#reader-more-button").disabled = false;
    button.removeAttribute("aria-busy");
    $<HTMLButtonElement>("#reader-read-toggle").disabled = false;
    const feedback = $("#reader-read-error");
    feedback.textContent = `Couldn’t delete this article. ${(error as Error).message} Try again.`;
    feedback.hidden = false;
    $<HTMLButtonElement>("#reader-more-button").focus({ preventScroll: true });
  } finally {
    if (readerReadRequest === operation) {
      readerReadRequest = null;
      if (readerArticleId === article.id && dialog.open) renderReaderFeedback(state.selected || article);
    }
  }
});
function setReaderTitle(text: string) {
  $("#reader-title").textContent = text;
  $(".reader-toolbar").classList.remove("is-compact");
  resetReaderToolbarScrollState();
}
let readerToolbarLastScrollTop = 0;
let readerToolbarUpwardDistance = 0;
function resetReaderToolbarScrollState() {
  const dialog = $<HTMLDialogElement>("#reader-dialog");
  readerToolbarLastScrollTop = dialog.scrollTop;
  readerToolbarUpwardDistance = 0;
  $(".reader-toolbar").classList.remove("is-hidden");
}
function updateReaderToolbarCompactState() {
  const dialog = $<HTMLDialogElement>("#reader-dialog");
  const title = $("#reader-title");
  const toolbar = $(".reader-toolbar");
  const shownToolbarBottom = readerToolbarAnchorY(dialog, toolbar);
  toolbar.classList.toggle("is-compact", dialog.open && Boolean(title.textContent) &&
    title.getBoundingClientRect().bottom <= shownToolbarBottom);
}
function updateReaderToolbarOnScroll() {
  const dialog = $<HTMLDialogElement>("#reader-dialog");
  const toolbar = $(".reader-toolbar");
  const current = dialog.scrollTop;
  const delta = current - readerToolbarLastScrollTop;
  readerToolbarLastScrollTop = current;
  updateReaderToolbarCompactState();
  if (!dialog.open || current <= 1 || !toolbar.classList.contains("is-compact")) {
    readerToolbarUpwardDistance = 0;
    toolbar.classList.remove("is-hidden");
    return;
  }
  if (delta > 0) {
    readerToolbarUpwardDistance = 0;
    toolbar.classList.add("is-hidden");
  } else if (delta < 0 && toolbar.classList.contains("is-hidden")) {
    readerToolbarUpwardDistance += -delta;
    if (readerToolbarUpwardDistance >= 24) {
      toolbar.classList.remove("is-hidden");
      readerToolbarUpwardDistance = 0;
    }
  }
}
function updatePdfReader(article?: Article) {
  $('#reader-pdf-actions').hidden = !article?.originalPdf;
  for (const [selector, suffix] of [['#reader-pdf-open', ''], ['#reader-pdf-download', '&download=1']]) {
    const anchor = $<HTMLAnchorElement>(selector);
    if (article?.originalPdf) anchor.href = `/api/articles/${article.id}/pdf?asset=${article.originalPdf.id}${suffix}`;
    else anchor.removeAttribute('href');
  }
}
type ReaderPreview = {
  url: string;
  article?: ArticlePreview;
  status: string;
  scrollTop: number;
  saveState?: "saving" | "saved";
};
type ReaderLink = { url: string; saveKey: string | null };
type ReaderLinkSaveResult = { duplicate: boolean };
const readerPreviews = new Map<string, ReaderPreview>();
const readerLinkDialog = $<HTMLDialogElement>("#reader-link-dialog");
const readerLinkWebsite = $<HTMLAnchorElement>("#reader-link-website");
const readerLinkSave = $<HTMLButtonElement>("#reader-link-save");
const readerLinkSaveStatus = $("#reader-link-save-status");
const pendingReaderLinkSaves = new Map<string, Promise<ReaderLinkSaveResult>>();
let readerLink: ReaderLink | undefined;
let readerPreview: ReaderPreview | undefined;
let readerPreviewLoad: AbortController | undefined;

function updateReaderPreviewActions(preview?: ReaderPreview) {
  const back = $(".reader-back");
  back.setAttribute("aria-label", preview ? "Back to previous article" : "Close saved copy");
  $("#reader-preview-actions").hidden = !preview;
  $("#reader-preview-status").textContent = preview?.status ?? "";
  const save = $<HTMLButtonElement>("#reader-preview-save");
  save.hidden = !preview?.article || preview.saveState === "saved";
  save.disabled = preview?.saveState === "saving";
}

function leaveReaderPreview() {
  if (readerLinkDialog.open) readerLinkDialog.close();
  if (!readerPreview) return;
  const dialog = $<HTMLDialogElement>("#reader-dialog");
  readerPreview.scrollTop = dialog.scrollTop;
  if (readerPreviewLoad) {
    readerPreviewLoad.abort();
    readerPreviewLoad = undefined;
    readerPreview.status = "";
  }
  readerPreview = undefined;
  updateReaderPreviewActions();
}

function renderReaderPreview(preview: ReaderPreview) {
  const article = preview.article;
  const url = article?.url ?? preview.url;
  const title = article?.title ?? sourceHost(url);
  setReaderTitle(title);
  setArticleTitle({ title });
  $("#reader-metadata").textContent = article
    ? [sourceHost(url), article.author ? `By ${article.author}` : ""].filter(Boolean).join(" · ")
    : "";
  $<HTMLAnchorElement>("#reader-original").href = url;
  const body = $("#reader-body");
  body.hidden = !article;
  body.replaceChildren();
  if (article) body.append(renderMarkdown(article.markdown, url, article.title));
  updateReaderPreviewActions(preview);
}

async function showReaderPreview(preview: ReaderPreview) {
  leaveReaderPreview();
  saveReadingPosition();
  readerPositionContext = null;
  readerLoadGeneration++;
  stopExtractionPolling();
  clearAudioPoll();
  resetReaderCompletion();
  readerArticleId = null;
  state.selected = null;
  $("#reader-pending").hidden = true;
  $("#reader-new-copy").hidden = true;
  $("#reader-audio").hidden = true;
  $("#reader-audio").replaceChildren();
  updatePdfReader();
  readerPreview = preview;
  const loading = !preview.article && !preview.status;
  if (loading) preview.status = "Loading linked article…";
  renderReaderPreview(preview);
  const dialog = $<HTMLDialogElement>("#reader-dialog");
  const title = $("#reader-title");
  if (!dialog.open) showDialog(dialog);
  dialog.scrollTop = preview.scrollTop;
  updateReaderToolbarCompactState();
  title.focus({ preventScroll: true });
  if (!loading) return;

  const controller = new AbortController();
  readerPreviewLoad = controller;
  try {
    const { article } = await request<{ article: ArticlePreview }>("/api/articles/preview", {
      method: "POST", body: JSON.stringify({ url: preview.url }), signal: controller.signal,
    });
    if (readerPreviewLoad !== controller) return;
    preview.article = article;
    preview.status = "";
  } catch (error) {
    if (readerPreviewLoad !== controller) return;
    preview.status = (error as Error).message;
  } finally {
    if (readerPreviewLoad === controller) {
      readerPreviewLoad = undefined;
      renderReaderPreview(preview);
      updateReaderToolbarCompactState();
    }
  }
}

$("#reader-body").addEventListener("click", (event) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || readerReturnPending || readerLinkDialog.open) return;
  const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
  const url = link && safeHttpUrl(link.href);
  if (!link || !url) return;
  event.preventDefault();

  const key = readerLinkKey(url);
  const sourceKey = readerLinkKey($<HTMLAnchorElement>("#reader-original").href);
  const saveKey = key === sourceKey ? null : key;
  readerLink = { url, saveKey };
  readerLinkSave.hidden = !saveKey;
  setReaderLinkSaveStatus();
  readerLinkWebsite.href = url;
  $("#reader-link-host").textContent = sourceHost(url);
  // The native dialog restores focus to the element active when it opened.
  link.focus({ preventScroll: true });
  showDialog(readerLinkDialog, $("#reader-link-read"));

  const pending = saveKey ? pendingReaderLinkSaves.get(saveKey) : undefined;
  if (pending) void showReaderLinkSaveResult(readerLink, pending);
});

readerLinkDialog.addEventListener("close", () => {
  if (!readerLinkDialog.open) readerLink = undefined;
});
$("#reader-link-read").addEventListener("click", () => {
  const preview: ReaderPreview = { url: readerLinkWebsite.href, status: "", scrollTop: 0 };
  readerLinkDialog.close();
  const previewId = crypto.randomUUID();
  readerPreviews.set(previewId, preview);
  history.pushState({ potem: { version: 1, kind: "preview", previewId, fromList: readerFromList } } satisfies ReaderHistoryState, "", location.href);
  void showReaderPreview(preview);
});
readerLinkWebsite.addEventListener("click", () => readerLinkDialog.close());

function refreshLibraryAfterReaderSave() {
  if (parseReaderPath(location.pathname)) {
    if (!listSnapshot) rememberListView(readerReturnFocus ?? undefined);
    if (listSnapshot) listSnapshot = { ...listSnapshot, forceRefresh: true };
  } else {
    void load();
  }
}

$("#reader-preview-save").addEventListener("click", async () => {
  const preview = readerPreview;
  const article = preview?.article;
  if (!preview || !article || preview.saveState) return;
  preview.saveState = "saving";
  preview.status = "Saving…";
  updateReaderPreviewActions(preview);
  try {
    await request("/api/articles", {
      method: "POST",
      body: JSON.stringify({
        url: article.url, title: article.title,
        author: article.author ?? undefined, description: article.description ?? undefined,
        previewMarkdown: article.markdown,
      }),
    });
    preview.saveState = "saved";
    preview.status = "Saved to library.";
    refreshLibraryAfterReaderSave();
  } catch (error) {
    preview.saveState = undefined;
    preview.status = `Couldn’t save this article. ${(error as Error).message}`;
  }
  if (readerPreview === preview) updateReaderPreviewActions(preview);
});

function readerLinkKey(url: string) {
  try {
    return normalizeArticleUrl(url).normalizedUrl;
  } catch (error) {
    if (error instanceof ValidationError) return null;
    throw error;
  }
}
function setReaderLinkSaveStatus(message = "", disabled = false, failed = false) {
  if (disabled) readerLinkSave.setAttribute("aria-disabled", "true");
  else readerLinkSave.removeAttribute("aria-disabled");
  readerLinkSaveStatus.classList.toggle("error", failed);
  readerLinkSaveStatus.textContent = message;
}
async function showReaderLinkSaveResult(link: ReaderLink, pending: Promise<ReaderLinkSaveResult>) {
  setReaderLinkSaveStatus("Saving…", true);
  const isCurrent = () => readerLinkDialog.open && readerLink === link;
  try {
    const { duplicate } = await pending;
    if (isCurrent()) setReaderLinkSaveStatus(duplicate ? "Already saved" : "Saved to library", true);
  } catch {
    if (isCurrent()) setReaderLinkSaveStatus("Couldn’t save. Try again.", false, true);
  }
}
readerLinkSave.addEventListener("click", () => {
  const link = readerLink;
  const key = link?.saveKey;
  if (!readerLinkDialog.open || !link || !key || readerLinkSave.getAttribute("aria-disabled") === "true") return;
  const pending = request<ReaderLinkSaveResult>("/api/articles", {
    method: "POST",
    body: JSON.stringify({ url: link.url, captureMarkdown: true }),
  }).then((result) => {
    refreshLibraryAfterReaderSave();
    return result;
  }).finally(() => {
    pendingReaderLinkSaves.delete(key);
  });
  pendingReaderLinkSaves.set(key, pending);
  void showReaderLinkSaveResult(link, pending);
});

function openReader(article: Article, copy: ArticleCopy, opener?: HTMLElement) {
  if (state.selected?.id !== article.id) return;
  if (readerPositionContext && (readerPositionContext.id !== article.id || readerPositionContext.revision !== copy.revision)) saveReadingPosition();
  const title = $("#reader-title");
  const metadata = $("#reader-metadata");
  const original = $<HTMLAnchorElement>("#reader-original");
  const body = $("#reader-body");
  updatePdfReader(article);
  setReaderTitle(article.title);
  readerArticleId = article.id;
  setArticleTitle(article);
  const canonicalPath = articlePath(article);
  if (location.pathname !== canonicalPath) history.replaceState(readerHistoryState(article.id, readerFromList), "", canonicalPath);
  const capturedOn = dateLabel(copy.capturedAt);
  metadata.textContent = [
    sourceHost(article.url),
    article.author ? `By ${article.author}` : "",
    readingTimeLabel(copy.readingTimeMinutes),
    capturedOn ? `Captured ${capturedOn}` : "",
  ].filter(Boolean).join(" · ");
  $("#reader-pending").hidden = true;
  $("#reader-new-copy").hidden = true;
  body.hidden = false;
  original.href = safeHttpUrl(article.url) || "#";
  body.replaceChildren(renderMarkdown(copy.markdown, article.url, article.title));
  const audioPanel = $("#reader-audio"); audioPanel.hidden = true; audioPanel.replaceChildren();
  if (state.session?.audioEnabled === true) attachAudioControl(audioPanel, article, true);
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
  updateReaderToolbarCompactState();
  title.focus({ preventScroll: true });
  restoreReadingPosition(positionContext);
  stopExtractionPolling();
  if (extractionIsPending(article.extraction) || enrichmentIsPending(article)) startExtractionPolling(article);
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
  updatePdfReader(article);
  setReaderTitle(article.title);
  readerArticleId = article.id;
  setArticleTitle(article);
  const canonicalPath = articlePath(article);
  if (location.pathname !== canonicalPath) history.replaceState(readerHistoryState(article.id, readerFromList), "", canonicalPath);
  $("#reader-metadata").textContent = [sourceHost(article.url), ...(article.author ? [`By ${article.author}`] : [])].join(" · ");
  const audioPanel = $("#reader-audio"); audioPanel.hidden = true; audioPanel.replaceChildren();
  if (state.session?.audioEnabled === true) attachAudioControl(audioPanel, article, false);
  const original = $<HTMLAnchorElement>("#reader-original");
  original.href = safeHttpUrl(article.url) || "#";
  $("#reader-pending-status").textContent = article.extraction?.state === "failed"
    ? `${extractionFailureMessage(article.extraction.errorCode)} You can paste or upload a browser copy in article details.`
    : article.extraction?.paused ? "Your link is saved and its Markdown copy is queued. You can add Markdown manually in article details."
      : "Markdown is being prepared in the background. You can close this view; the link is already saved.";
  $("#reader-pending").hidden = false;
  const retry = $<HTMLButtonElement>("#reader-retry");
  retry.hidden = article.extraction?.state !== "failed";
  retry.disabled = false;
  $("#reader-body").hidden = true;
  const dialog = $<HTMLDialogElement>("#reader-dialog");
  if (!dialog.open) {
    ensureReaderOpener();
    showDialog(dialog, title);
  }
  dialog.scrollTop = 0;
  updateReaderToolbarCompactState();
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
  leaveReaderPreview();
  clearAudioPoll();
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
  $("#reader-audio").replaceChildren(); $("#reader-audio").hidden = true;
  setReaderTitle("");
  $("#reader-metadata").textContent = "";
  $("#reader-pending").hidden = true;
  $("#reader-pending-status").textContent = "";
  $("#reader-body").hidden = false;
  updatePdfReader();
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
  readerFeedbackSessionGeneration++;
  readerFeedbackRetries.clear();
  invalidateLoads();
  $('#tag-controls').hidden = true;
  $<HTMLSelectElement>('#tag-filter').replaceChildren(new Option('All tags', ''));
  state.tag = '';
  $('#tag-clear').hidden = true;
  $("#capture-status").hidden = true;
  pendingReadCompletion = null;
  lastOpenedFetchGeneration++;
  lastOpenedArticle = null;
  lastOpenedError = "";
  lastOpenedReady = false;
  resetSuggestion();
  renderLastOpened();
  clearReader();
  readerPreviews.clear();
  const detailDialog = $<HTMLDialogElement>("#detail-dialog");
  if (detailDialog.open) detailDialog.close();
  $("#detail-content").replaceChildren();
  state.selected = null;
}
$("#reader-dialog").addEventListener("close", () => {
  const dialog = $<HTMLDialogElement>("#reader-dialog");
  if ($<HTMLDialogElement>("#podcast-dialog").open) $<HTMLDialogElement>("#podcast-dialog").close();
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
  setReaderTitle("");
  $("#reader-metadata").textContent = "";
  $("#reader-pending").hidden = true;
  $("#reader-pending-status").textContent = "";
  $("#reader-body").hidden = false;
  updatePdfReader();
  $<HTMLAnchorElement>("#reader-original").removeAttribute("href");
  if (!$<HTMLDialogElement>("#detail-dialog").open) {
    stopExtractionPolling();
    state.selected = null;
  }
  restoreReaderFocus(closed?.opener);
});
$("#reader-dialog .reader-close").addEventListener("submit", (event) => {
  event.preventDefault();
  closeReaderView();
});
$("#reader-dialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  closeReaderView();
});
document.addEventListener("pointerdown", (event) => {
  const dialog = $<HTMLDialogElement>("#reader-dialog");
  if (!dialog.open || readerLinkDialog.open) return;

  const bounds = dialog.getBoundingClientRect();
  const clickedOutside = event.clientX < bounds.left || event.clientX > bounds.right ||
    event.clientY < bounds.top || event.clientY > bounds.bottom;
  if (clickedOutside) closeReaderView();
}, true);
$("#reader-dialog").addEventListener("scroll", () => {
  updateReaderToolbarOnScroll();
  scheduleReadingPositionSave();
}, { passive: true });
const readerTitleResizeObserver = new ResizeObserver(updateReaderToolbarCompactState);
readerTitleResizeObserver.observe($("#reader-title"));
readerTitleResizeObserver.observe($(".reader-toolbar"));
window.addEventListener("pagehide", saveReadingPosition);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveReadingPosition(); });
let detailReturnFocus: HTMLElement | null = null;
function openDetail(article: Article, opener: HTMLElement | null = document.activeElement instanceof HTMLElement ? document.activeElement : null) {
  detailReturnFocus = opener;
  clearReader();
  renderDetail(article);
  showDialog($<HTMLDialogElement>("#detail-dialog"), $<HTMLInputElement>("#detail-content input"));
  if (extractionIsPending(article.extraction) || enrichmentIsPending(article)) startExtractionPolling(article);
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
function closeReaderView() {
  if (readerReturnPending) return;
  if (readerPreview) {
    readerReturnPending = true;
    history.back();
  } else {
    navigateReaderAway();
    clearReader();
  }
}
window.addEventListener("popstate", () => {
  readerReturnPending = false;
  const entry = (history.state as ReaderHistoryState | null)?.potem;
  const preview = entry?.kind === "preview" && entry.previewId ? readerPreviews.get(entry.previewId) : undefined;
  if (preview && state.session?.authenticated) {
    void showReaderPreview(preview);
    return;
  }
  const wasPreview = Boolean(readerPreview);
  leaveReaderPreview();
  if (wasPreview) $("#reader-body").hidden = true;
  const route = parseReaderPath(location.pathname);
  if (route) {
    if (!("id" in route)) { clearReader(); setListTitle(); showNotice("This article link is invalid. Go back to your list and try again.", true); return; }
    readerFromList = Boolean(entry?.fromList);
    if (state.session?.authenticated) void openArticleById(route.id);
    return;
  }
  readerFromList = false;
  const showingFeeds = isFeedsPath();
  if (showingFeeds && location.pathname !== "/feeds") history.replaceState(listHistoryState("feeds"), "", "/feeds");
  setFeedMode(showingFeeds, false);
  setListTitle();
  clearReader();
  if (!showingFeeds) restoreListView();
});
const lastOpenedRetry = document.querySelector<HTMLButtonElement>("#last-opened-retry");
lastOpenedRetry?.addEventListener("click", () => {
  if (lastOpenedError) void loadLastOpened();
  else void loadSuggestion(true);
});
$("#suggestion-shuffle").addEventListener("click", () => void loadSuggestion(true));
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
  const target = detailReturnFocus;
  detailReturnFocus = null;
  if (target?.isConnected) target.focus({ preventScroll: true });
});
async function initialize() {
  try {
    state.session = await request<Session>("/api/session");
    $("#primary-tabs").hidden = !state.session.authenticated;
    $<HTMLButtonElement>('[data-status="podcast"]').hidden = state.session.audioEnabled !== true;
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
    const showingFeeds = isFeedsPath();
    if (showingFeeds && location.pathname !== "/feeds") history.replaceState(listHistoryState("feeds"), "", "/feeds");
    setFeedMode(showingFeeds, false);
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
  if (feedMode) {
    const panel = $("#feed-add-panel");
    panel.hidden = !panel.hidden;
    $("#add-open").setAttribute("aria-expanded", String(!panel.hidden));
    if (!panel.hidden) $<HTMLInputElement>("#feed-url").focus();
    return;
  }
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
          ...(captureFromUrl ? { captureMarkdown: true } : captured ? { captureMarkdown: false, enrichAfterCopy: $<HTMLInputElement>('#capture-copy-enabled').checked } : {}),
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
          ? "Link saved. Markdown capture queued."
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
const statusOrder = ["unread", "read", "all", "favorites", "podcast"] as const;
type Feed = { id: string; url: string; title: string; lastFetchedAt: string | null; lastError: string | null };
type FeedItem = { id: string; feedId: string; url: string; title: string; preview: string; publishedAt: string; seen: boolean; saved: boolean };
let feedItems: FeedItem[] = [];
let feeds: Feed[] = [];
let feedCursor: string | null = null;
let feedStatus: "new" | "all" = "new";
let feedMode = false;
let feedLoadGeneration = 0;
let feedListGeneration = 0;
let feedLoading = false;
let feedSubmitting = false;
let libraryNeedsRefresh = false;
const feedItemUpdates = new Set<string>();
async function refreshFeeds() {
  const generation = ++feedListGeneration;
  try {
    const result = await request<{ feeds: Feed[] }>("/api/feeds");
    if (generation !== feedListGeneration) return false;
    feeds = result.feeds;
    const select = $<HTMLSelectElement>("#feed-source");
    const previous = select.value;
    select.replaceChildren(new Option("All feeds", ""));
    for (const feed of feeds) select.add(new Option(feed.title || feed.url, feed.id));
    if (feeds.some(feed => feed.id === previous)) select.value = previous;
    const list = $("#feed-list");
    list.replaceChildren();
    for (const feed of feeds) {
      const li = el("li", "", "feed-source-row");
      const label = el("span", feed.title || feed.url);
      label.title = feed.url;
      li.append(label);
      if (feed.lastError) {
        const error = el("span", "Couldn’t refresh", "muted");
        error.title = feed.lastError;
        li.append(error);
      }
      const remove = el("button", "Remove", "text-button");
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove ${feed.title || feed.url}`);
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        await deleteFeed(feed);
        remove.disabled = false;
      });
      li.append(remove);
      list.append(li);
    }
    $("#feed-manage-toggle").hidden = feeds.length === 0;
    if (!feeds.length) {
      $("#feed-manage-panel").hidden = true;
      $("#feed-manage-toggle").setAttribute("aria-expanded", "false");
    }
    return true;
  } catch (error) {
    if (generation === feedListGeneration) feedMessage(`Couldn’t load feeds. ${(error as Error).message}`, true);
    return false;
  }
}
function feedMessage(message: string, error = false) {
  const node = $("#feed-notice");
  node.replaceChildren(document.createTextNode(message));
  node.classList.toggle("error", error);
  node.hidden = false;
}
function renderFeedItems() {
  const list = $("#feed-items");
  list.replaceChildren();
  const visibleFeedItems = feedItems.filter(item => feedStatus === "all" || !item.seen);
  for (const item of visibleFeedItems) {
    const li = el("li", "", "article feed-item");
    li.dataset.id = item.id;
    const main = el("div", "", "article-main");
    const title = el("a", item.title || item.url, "article-title");
    title.href = item.url;
    title.target = "_blank";
    title.rel = "noopener noreferrer";
    main.append(title);
    if (item.preview) main.append(el("p", item.preview, "feed-preview"));
    const source = feeds.find(feed => feed.id === item.feedId);
    const meta = el("div", `${source?.title || "Feed"} · ${new Date(item.publishedAt).toLocaleDateString()}`, "muted feed-meta");
    main.append(meta);
    const actions = el("div", "", "article-actions");
    const save = el("button", item.saved ? "Saved" : "Save for later", "text-button");
    save.type = "button";
    save.disabled = item.saved || feedItemUpdates.has(item.id);
    save.addEventListener("click", () => void saveFeedItem(item));
    actions.append(save);
    const seen = el("button", item.seen ? "Mark as new" : "Mark seen", "text-button");
    seen.type = "button";
    seen.dataset.feedSeen = "";
    seen.disabled = feedItemUpdates.has(item.id);
    seen.addEventListener("click", () => void setFeedSeen(item, !item.seen));
    actions.append(seen);
    main.append(actions);
    li.append(main);
    list.append(li);
  }
  $("#feed-empty").hidden = list.children.length > 0;
  if (!list.children.length && feedItems.length) {
    $("#feed-empty h3").textContent = "You’re all caught up";
    $("#feed-empty p").textContent = "Seen articles remain available in All.";
  } else {
    $("#feed-empty h3").textContent = feeds.length ? "No feed items yet" : "No feeds yet";
    $("#feed-empty p").textContent = feeds.length
      ? "Your feeds will appear here as new articles arrive."
      : "Add an RSS or Atom feed to see its latest articles here.";
  }
  $("#feed-more").hidden = !feedCursor;
}
async function loadFeeds(append = false) {
  if (!feedMode || (append && (feedLoading || !feedCursor))) return false;
  feedLoading = true;
  const generation = ++feedLoadGeneration;
  const loading = $("#feed-loading");
  const more = $<HTMLButtonElement>("#feed-more");
  loading.hidden = false;
  more.disabled = true;
  $("#feed-notice").hidden = true;
  if (!append) {
    feedItems = [];
    feedCursor = null;
    renderFeedItems();
    $("#feed-empty").hidden = true;
  }
  try {
    const params = new URLSearchParams({ status: feedStatus });
    const feedId = $<HTMLSelectElement>("#feed-source").value;
    if (feedId) params.set("feedId", feedId);
    if (append && feedCursor) params.set("cursor", feedCursor);
    const result = await request<{items: FeedItem[]; nextCursor: string | null}>(`/api/feeds/items?${params}`);
    if (generation !== feedLoadGeneration) return;
    feedItems = append ? [...feedItems, ...result.items] : result.items;
    feedCursor = result.nextCursor;
    renderFeedItems();
    return true;
  } catch (error) {
    if (generation === feedLoadGeneration) feedMessage(`Couldn’t load feed items. ${(error as Error).message}`, true);
    return false;
  } finally {
    if (generation === feedLoadGeneration) {
      loading.hidden = true;
      feedLoading = false;
      more.disabled = false;
    }
  }
}
function feedItemRow(id: string) {
  return document.querySelector<HTMLElement>(`#feed-items [data-id="${CSS.escape(id)}"]`);
}
function setFeedItemBusy(item: FeedItem) {
  const row = feedItemRow(item.id);
  const hadFocus = Boolean(row?.contains(document.activeElement) || $("#feed-notice").contains(document.activeElement));
  feedItemUpdates.add(item.id);
  row?.querySelectorAll("button").forEach(button => { button.disabled = true; });
  return hadFocus;
}
async function setFeedSeen(item: FeedItem, seen: boolean) {
  if (feedItemUpdates.has(item.id)) return;
  const hadFocus = setFeedItemBusy(item);
  let undo: HTMLButtonElement | undefined;
  try {
    await request(`/api/feeds/items/${encodeURIComponent(item.id)}`, { method: "PATCH", body: JSON.stringify({ seen }) });
    item.seen = seen;
    const displayed = feedItems.find(candidate => candidate.id === item.id);
    if (displayed) displayed.seen = seen;
    feedMessage(seen ? "Marked as seen." : "Marked as new.");
    if (seen) {
      undo = el("button", "Undo", "text-button");
      undo.type = "button";
      undo.setAttribute("aria-label", `Undo marking ${item.title || "article"} as seen`);
      undo.addEventListener("click", () => void setFeedSeen(item, false));
      $("#feed-notice").append(document.createTextNode(" "), undo);
    }
  } catch (error) {
    feedMessage(`Couldn’t update item. ${(error as Error).message}`, true);
  } finally {
    feedItemUpdates.delete(item.id);
    renderFeedItems();
    if (feedMode && hadFocus && document.activeElement === document.body) {
      (undo ?? feedItemRow(item.id)?.querySelector<HTMLElement>("[data-feed-seen]") ?? $("#feed-source")).focus({ preventScroll: true });
    }
  }
}
function refreshLibraryAfterFeedSave() {
  if (!libraryNeedsRefresh) return;
  libraryNeedsRefresh = false;
  void load().then(ok => { if (!ok) libraryNeedsRefresh = true; });
}
async function saveFeedItem(item: FeedItem) {
  if (item.saved || feedItemUpdates.has(item.id)) return;
  const hadFocus = setFeedItemBusy(item);
  try {
    await request("/api/articles", {
      method: "POST",
      body: JSON.stringify({ url: item.url, title: item.title, captureMarkdown: true }),
    });
    const savedUrl = normalizeArticleUrl(item.url).normalizedUrl;
    for (const candidate of feedItems) {
      if (normalizeArticleUrl(candidate.url).normalizedUrl === savedUrl) candidate.saved = true;
    }
    feedMessage("Saved for later.");
    libraryNeedsRefresh = true;
    if (!feedMode) refreshLibraryAfterFeedSave();
  } catch (error) {
    feedMessage(`Couldn’t save this link. ${(error as Error).message}`, true);
  } finally {
    feedItemUpdates.delete(item.id);
    renderFeedItems();
    if (feedMode && hadFocus && document.activeElement === document.body) {
      feedItemRow(item.id)?.querySelector<HTMLElement>("[data-feed-seen]")?.focus({ preventScroll: true });
    }
  }
}
async function deleteFeed(feed: Feed) {
  try {
    await request(`/api/feeds/${encodeURIComponent(feed.id)}`, { method: "DELETE" });
    if (await refreshFeeds()) await loadFeeds();
  } catch (error) {
    feedMessage(`Couldn’t remove feed. ${(error as Error).message}`, true);
  }
}
function setFeedMode(on: boolean, updateUrl = true) {
  const path = on ? "/feeds" : "/";
  if (updateUrl && location.pathname !== path) history.pushState(listHistoryState(on ? "feeds" : undefined), "", path);
  if (feedMode === on) return;
  feedMode = on;
  if (!on) {
    feedLoadGeneration++;
    feedListGeneration++;
  }
  $(".library").hidden = on;
  $("#feeds-view").hidden = !on;
  $("#search-control").hidden = on;
  const addButton = $<HTMLButtonElement>("#add-open");
  addButton.hidden = false;
  addButton.setAttribute("aria-label", on ? "Add feed" : "Add article");
  addButton.title = on ? "Add feed" : "Add article";
  if (on) {
    addButton.setAttribute("aria-controls", "feed-add-panel");
    addButton.setAttribute("aria-expanded", String(!$("#feed-add-panel").hidden));
  } else {
    $("#feed-add-panel").hidden = true;
    addButton.removeAttribute("aria-controls");
    addButton.removeAttribute("aria-expanded");
  }
  $("#reading-tab").setAttribute("aria-pressed", String(!on));
  $("#feeds-tab").setAttribute("aria-pressed", String(on));
  if (on) {
    setSearchOpen(false);
    void refreshFeeds().then(ok => { if (ok) return loadFeeds(); });
  } else refreshLibraryAfterFeedSave();
}
$("#reading-tab").addEventListener("click", () => setFeedMode(false));
$("#feeds-tab").addEventListener("click", () => setFeedMode(true));
$("#feed-new").addEventListener("click", () => {
  feedStatus = "new";
  $("#feed-new").setAttribute("aria-pressed", "true");
  $("#feed-all").setAttribute("aria-pressed", "false");
  void loadFeeds();
});
$("#feed-all").addEventListener("click", () => {
  feedStatus = "all";
  $("#feed-new").setAttribute("aria-pressed", "false");
  $("#feed-all").setAttribute("aria-pressed", "true");
  void loadFeeds();
});
$("#feed-source").addEventListener("change", () => void loadFeeds());
$("#feed-more").addEventListener("click", () => void loadFeeds(true));
$("#feed-manage-toggle").addEventListener("click", () => {
  const panel = $("#feed-manage-panel");
  panel.hidden = !panel.hidden;
  $("#feed-manage-toggle").setAttribute("aria-expanded", String(!panel.hidden));
});
$("#feed-add-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (feedSubmitting) return;
  feedSubmitting = true;
  const form = $<HTMLFormElement>("#feed-add-form");
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const input = $<HTMLInputElement>("#feed-url");
  submit.disabled = true;
  try {
    await request("/api/feeds", { method: "POST", body: JSON.stringify({ url: input.value }) });
    input.value = "";
    const refreshed = await refreshFeeds();
    if (refreshed && await loadFeeds()) {
      feedMessage("Feed added.");
      const returnFocus = form.contains(document.activeElement);
      $("#feed-add-panel").hidden = true;
      $("#add-open").setAttribute("aria-expanded", "false");
      if (returnFocus) $("#add-open").focus();
    }
  } catch (error) {
    feedMessage(`Couldn’t add feed. ${(error as Error).message}`, true);
  } finally {
    feedSubmitting = false;
    submit.disabled = false;
  }
});
let searchTimer: number;
function setStatus(status: string) {
  if (!statusOrder.includes(status as (typeof statusOrder)[number])) return;
  if (status === "podcast" && $<HTMLButtonElement>('[data-status="podcast"]').hidden) return;
  clearTimeout(searchTimer);
  setSearchOpen(false);
  invalidateLoads();
  stopExtractionPolling();
  state.status = status;
  renderLastOpened();
  document
    .querySelectorAll("[data-status]")
    .forEach((button) => button.setAttribute("aria-pressed", String((button as HTMLElement).dataset.status === status)));
  void load();
}
document
  .querySelectorAll<HTMLButtonElement>("[data-status]")
  .forEach((button) => button.addEventListener("click", () => setStatus(button.dataset.status || "unread")));

const library = $<HTMLElement>(".library");
const pullRefreshIndicator = $<HTMLElement>("#library-refresh");
const pullRefreshIcon = $<HTMLElement>("#library-refresh-icon");
const pullRefreshLabel = $<HTMLElement>("#library-refresh-label");
const pullRefreshThreshold = 76;
let pullRefreshStart: { id: number; x: number; y: number; distance: number; active: boolean } | null = null;
let pullRefreshHideTimer = 0;
function showPullRefresh(distance: number, refreshing = false) {
  window.clearTimeout(pullRefreshHideTimer);
  pullRefreshIndicator.hidden = false;
  pullRefreshIndicator.classList.toggle("is-dragging", !refreshing);
  pullRefreshIndicator.classList.toggle("is-refreshing", refreshing);
  pullRefreshIndicator.setAttribute("aria-busy", String(refreshing));
  pullRefreshIndicator.style.setProperty("--refresh-height", `${distance}px`);
  pullRefreshIcon.textContent = refreshing ? "" : distance >= pullRefreshThreshold * 0.58 ? "↑" : "↓";
  pullRefreshLabel.textContent = refreshing
    ? "Refreshing your list…"
    : distance >= pullRefreshThreshold * 0.58 ? "Release to refresh" : "Pull to refresh";
}
function hidePullRefresh() {
  pullRefreshIndicator.classList.remove("is-dragging", "is-refreshing");
  pullRefreshIndicator.setAttribute("aria-busy", "false");
  pullRefreshIndicator.style.setProperty("--refresh-height", "0px");
  window.clearTimeout(pullRefreshHideTimer);
  pullRefreshHideTimer = window.setTimeout(() => {
    if (!pullRefreshStart) pullRefreshIndicator.hidden = true;
  }, 180);
}
async function refreshLibraryFromPull() {
  showPullRefresh(48, true);
  try {
    await load(true, true);
  } finally {
    hidePullRefresh();
  }
}
let statusSwipeStart: { id: number; x: number; y: number } | null = null;
library.addEventListener("touchstart", (event) => {
  const target = event.target;
  const touch = event.touches.length === 1 ? event.touches[0] : null;
  if (!touch || !window.matchMedia("(max-width: 620px)").matches || feedMode || state.loading ||
      !state.session?.authenticated || window.scrollY > 1 ||
      (target instanceof Element && target.closest("input, textarea, select, [contenteditable='true']"))) {
    pullRefreshStart = null;
    return;
  }
  window.clearTimeout(pullRefreshHideTimer);
  pullRefreshIndicator.hidden = true;
  pullRefreshIndicator.style.setProperty("--refresh-height", "0px");
  pullRefreshStart = { id: touch.identifier, x: touch.clientX, y: touch.clientY, distance: 0, active: false };
}, { passive: true });
library.addEventListener("touchmove", (event) => {
  if (!pullRefreshStart) return;
  const touch = event.touches[0];
  if (event.touches.length !== 1 || touch.identifier !== pullRefreshStart.id) {
    const wasActive = pullRefreshStart.active;
    pullRefreshStart = null;
    if (wasActive) hidePullRefresh();
    return;
  }
  const dx = touch.clientX - pullRefreshStart.x;
  const dy = touch.clientY - pullRefreshStart.y;
  if (!pullRefreshStart.active) {
    if (Math.abs(dx) > 10 && Math.abs(dx) >= dy) {
      pullRefreshStart = null;
      return;
    }
    if (dy < 8) return;
    if (window.scrollY > 1 || dy < Math.abs(dx) * 1.2) {
      pullRefreshStart = null;
      return;
    }
    pullRefreshStart.active = true;
  }
  if (event.cancelable) event.preventDefault();
  pullRefreshStart.distance = Math.max(0, Math.min(60, dy * 0.58));
  showPullRefresh(pullRefreshStart.distance);
}, { passive: false });
library.addEventListener("touchend", (event) => {
  const start = pullRefreshStart;
  if (!start) return;
  pullRefreshStart = null;
  const touch = Array.from(event.changedTouches).find((touch) => touch.identifier === start.id);
  if (start.active && touch && start.distance >= pullRefreshThreshold * 0.58 && !state.loading) {
    if (event.cancelable) event.preventDefault();
    void refreshLibraryFromPull();
  } else if (start.active) hidePullRefresh();
}, { passive: false });
library.addEventListener("touchcancel", () => {
  if (pullRefreshStart?.active) hidePullRefresh();
  pullRefreshStart = null;
}, { passive: true });
library.addEventListener("touchstart", (event) => {
  const touch = event.touches.length === 1 ? event.touches[0] : null;
  statusSwipeStart = touch ? { id: touch.identifier, x: touch.clientX, y: touch.clientY } : null;
}, { passive: true });
library.addEventListener("touchmove", (event) => {
  if (!statusSwipeStart) return;
  const touch = event.touches[0];
  if (event.touches.length !== 1 || touch.identifier !== statusSwipeStart.id) {
    statusSwipeStart = null;
    return;
  }
  const dx = Math.abs(touch.clientX - statusSwipeStart.x);
  const dy = Math.abs(touch.clientY - statusSwipeStart.y);
  // Once a vertical scroll starts, it must not turn into a tab change.
  if (dy > 10 && dy >= dx) statusSwipeStart = null;
}, { passive: true });
library.addEventListener("touchend", (event) => {
  if (!statusSwipeStart) return;
  const start = statusSwipeStart;
  statusSwipeStart = null;
  const touch = Array.from(event.changedTouches).find((touch) => touch.identifier === start.id);
  if (!touch || event.touches.length) return;
  const dx = touch.clientX - start.x;
  const dy = touch.clientY - start.y;
  if (Math.abs(dx) < 48 || Math.abs(dx) <= Math.abs(dy) * 1.25) return;
  const availableStatuses = statusOrder.filter(status => status !== "podcast" || !$<HTMLButtonElement>('[data-status="podcast"]').hidden);
  const current = availableStatuses.indexOf(state.status as (typeof statusOrder)[number]);
  const next = Math.max(0, Math.min(availableStatuses.length - 1, current + (dx < 0 ? 1 : -1)));
  // Swiping over a link or button should not also activate it on release.
  if (event.cancelable) event.preventDefault();
  if (next !== current) setStatus(availableStatuses[next]!);
}, { passive: false });
library.addEventListener("touchcancel", () => { statusSwipeStart = null; }, { passive: true });

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
  renderLastOpened();
  searchTimer = window.setTimeout(() => void load(), 250);
});
$("#clear-search").addEventListener("click", () => {
  if (!state.session?.authenticated || !state.query) return;
  searchInput.value = "";
  searchInput.dispatchEvent(new Event("input", { bubbles: true }));
  searchToggle.focus({ preventScroll: true });
});
$("#more").addEventListener("click", () => load(false));
$("#logout").addEventListener("click", async () => {
  feedLoadGeneration++;
  feedListGeneration++;
  $("#primary-tabs").hidden = true;
  $(".library").hidden = true;
  $("#feeds-view").hidden = true;
  $("#articles").replaceChildren();
  $("#feed-items").replaceChildren();
  $("#feed-list").replaceChildren();
  $<HTMLSelectElement>("#feed-source").replaceChildren(new Option("All feeds", ""));
  $("#feed-notice").replaceChildren();
  feedItems = [];
  feeds = [];
  privateFeedUrl = null;
  clearAudioPoll();
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
    $("#primary-tabs").hidden = false;
    if (feedMode) setFeedMode(false);
    $(".library").hidden = false;
    void load();
    showNotice((e as Error).message, true);
  }
});
function applyTheme() {
  (window as Window & { potemTheme?: { apply(preference: string): void } }).potemTheme?.apply(state.theme);
  $<HTMLSelectElement>("#theme-toggle").value = state.theme;
}
$("#theme-toggle").addEventListener("change", (e) => {
  state.theme = (e.target as HTMLSelectElement).value;
  try { localStorage.setItem("later-theme", state.theme); } catch { /* Theme selection still applies in memory. */ }
  applyTheme();
});
$("#settings-open").addEventListener("click", openSettings);
$("#settings-dialog").addEventListener("close", () => {
  const box = $("#new-token");
  box.replaceChildren();
  box.hidden = true;
  privateFeedUrl = null;
  clearAudioPoll();
});
async function openSettings() {
  showDialog($<HTMLDialogElement>("#settings-dialog"), $<HTMLSelectElement>("#theme-toggle"));
  if (!state.session?.authenticated) {
    $("#settings-status").textContent =
      "Sign in to manage your library and device settings.";
    $("#settings-library").hidden = true;
    $("#settings-private-podcast").hidden = true;
    $("#settings-saving-devices").hidden = true;
    $("#settings-integrations-disclosure").hidden = true;
    $("#token-form").hidden = true;
    $("#tokens").replaceChildren();
    return;
  }
  $("#settings-library").hidden = false;
  $("#settings-private-podcast").hidden = false;
  $("#settings-saving-devices").hidden = false;
  $("#settings-integrations-disclosure").hidden = false;
  $("#settings-status").textContent = "Signed in";
  $("#token-form").hidden = false;
  void loadPodcastSettings();
  void request<{ integrations: IntegrationConfiguration[] }>('/api/integrations').then(({ integrations }) => {
    const container = $('#settings-integrations');
    container.replaceChildren();
    if (!integrations.length) container.append(el('p', 'No integrations configured. Articles are saved privately in Potem.', 'muted'));
    for (const integration of integrations) {
      container.append(el('h4', integration.name), el('p', integration.destination), el('p', integration.message || integration.description, 'muted'));
    }
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
async function loadPodcastSettings() {
  const container = $("#podcast-settings");
  container.replaceChildren(el("p", "Loading podcast settings…", "muted"));
  try {
    const data = await request<PodcastSettings & { readyEpisodes?: number }>("/api/podcast/settings");
    container.replaceChildren();
    const usage = el("p", "This month: " + data.usage.usedCharacters.toLocaleString() + " characters used · " + data.usage.reservedCharacters.toLocaleString() + " reserved · " + data.usage.freeCharacters.toLocaleString() + " free. Estimated spend $" + data.usage.estimatedCostUsd.toFixed(2) + " of $" + data.usage.budgetUsd.toFixed(2) + ".", "muted");
    container.append(usage);
    const tokenStatus = el("p", data.token ? "Private feed active · created " + dateLabel(data.token.createdAt) + "." : "No private feed token yet.", "muted");
    container.append(tokenStatus);
    if ((data.readyEpisodes ?? 0) > 0) container.append(el("p", "On iPhone: open Library → … → Follow a Show by URL, then paste your feed URL. Downloads and playback position are managed by your podcast app; Potem does not change article read status.", "muted"));
    else container.append(el("p", "Prepare at least one episode in your library before following this feed in a podcast app.", "muted"));
    if (privateFeedUrl) {
      const reveal = el("div", undefined, "new-token"); reveal.append(el("strong", "Copy this private feed URL now"), el("p", "It is shown only once. Keep it private; anyone with this URL can access the feed."));
      const code = el("code", privateFeedUrl); code.className = "feed-url"; reveal.append(code);
      const copy = el("button", "Copy feed URL", "button secondary"); copy.type = "button";
      const result = el("span", "", "muted"); result.setAttribute("role", "status");
      copy.addEventListener("click", async () => { try { await navigator.clipboard.writeText(privateFeedUrl!); result.textContent = "Copied."; } catch { result.textContent = "Copy unavailable. Select the URL above."; } });
      reveal.append(copy, result); container.append(reveal);
    }
    const controls = el("div", undefined, "podcast-actions");
    const tokenButton = el("button", data.token ? "Rotate feed URL" : "Create private feed", "button secondary"); tokenButton.type = "button";
    tokenButton.addEventListener("click", async () => {
      if (data.token && !confirm("Rotate the private feed URL? Your current podcast subscription will stop working until you update it.")) return;
      tokenButton.disabled = true;
      try { const created = await request<{ feedUrl: string; createdAt: string }>("/api/podcast/token", { method: "POST", body: JSON.stringify({}) }); privateFeedUrl = created.feedUrl; await loadPodcastSettings(); }
      catch (error) { tokenStatus.textContent = "Couldn’t create feed URL. " + (error as Error).message; tokenButton.disabled = false; }
    });
    controls.append(tokenButton);
    if (data.token) {
      const revoke = el("button", "Revoke feed", "button secondary danger-text"); revoke.type = "button";
      revoke.addEventListener("click", async () => {
        if (!confirm("Revoke this private podcast feed? Your podcast app will no longer be able to access it.")) return;
        revoke.disabled = true;
        try { await request("/api/podcast/token", { method: "DELETE" }); privateFeedUrl = null; await loadPodcastSettings(); }
        catch (error) { tokenStatus.textContent = "Couldn’t revoke feed. " + (error as Error).message; revoke.disabled = false; }
      });
      controls.append(revoke);
    }
    container.append(controls);
    if (!data.enabled) container.prepend(el("p", "New audio generation is paused. Existing episodes remain available through your private feed.", "muted"));
  } catch (error) { container.replaceChildren(el("p", "Couldn’t load podcast settings. " + (error as Error).message, "muted")); }
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
$('#import-archive-open').addEventListener('click', () => $<HTMLInputElement>('#import-archive-file').click());
$<HTMLInputElement>('#import-archive-file').addEventListener('change', async event => {
  const input = event.target as HTMLInputElement, file = input.files?.[0];
  if (!file) return;
  const button = $<HTMLButtonElement>('#import-archive-open');
  const progress = (text: string) => { $('#settings-status').textContent = text; };
  button.disabled = true;
  try {
    progress('Checking archive…');
    const archive = await inspectArchive(file, progress);
    if (!confirm(`Restore ${archive.library.articles.length} articles and ${archive.pdfs.length} PDF associations? Existing links will be skipped.`)) { progress('Restore cancelled.'); return; }
    invalidateLoads();
    const result = await restoreArchive(file, archive, request, progress);
    progress(`Restored ${result.imported} articles; skipped ${result.skipped}.`);
    await load();
  } catch (error) { progress(`Archive restore failed. ${(error as Error).message}`); }
  finally { button.disabled = false; input.value = ''; }
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
