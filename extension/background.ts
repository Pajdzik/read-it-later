import type { DestinationConsent, ExtensionCapture, ExtensionMessage, ExtensionSettings, PendingRequest } from './contracts';
import { MAX_MARKDOWN_BYTES, MAX_PENDING, MAX_URL_BYTES, PENDING_TTL } from './contracts';

declare const __POTEM_ORIGIN__: string;
const api: BrowserApi = typeof browser === 'undefined' ? chrome : browser;
const PENDING_KEY = 'pendingRequests';
const SETTINGS_KEY = 'settings';
const now = () => Date.now();
const randomId = () => [...crypto.getRandomValues(new Uint8Array(24))].map((n) => n.toString(16).padStart(2, '0')).join('');
let pendingQueue: Promise<void> = Promise.resolve();
const launchingTabs = new Set<number>();

async function readPending(): Promise<PendingRequest[]> {
  const value = (await api.storage.session.get(PENDING_KEY))[PENDING_KEY];
  return Array.isArray(value) ? value as PendingRequest[] : [];
}
async function writePending(pending: PendingRequest[]) { await api.storage.session.set({ [PENDING_KEY]: pending }); }
async function mutatePending<T>(operation: (items: PendingRequest[]) => Promise<T> | T): Promise<T> {
  let result!: T;
  const run = pendingQueue.then(async () => {
    const items = (await readPending()).filter((item) => item.createdAt + PENDING_TTL > now());
    result = await operation(items);
    await writePending(items);
  });
  pendingQueue = run.then(() => {}, () => {});
  await run;
  return result;
}
async function readSettings(): Promise<ExtensionSettings> {
  const value = (await api.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] as ExtensionSettings | undefined;
  return value?.origin === __POTEM_ORIGIN__ ? value : { origin: __POTEM_ORIGIN__, mode: 'review' };
}
async function cleanup(): Promise<PendingRequest[]> {
  return mutatePending((items) => items);
}
const destinationPath = (value: DestinationConsent) => `${value.repository}|${value.branch}|${value.folder}`;
async function setBadge(tabId: number, text: string, title: string, color: string) {
  try {
    await api.action.setBadgeBackgroundColor({ color, tabId });
    await api.action.setBadgeText({ text, tabId });
    await api.action.setTitle({ title, tabId });
  } catch { /* The source tab may close while its result tab is saving. */ }
}

async function openOptions() { await api.runtime.openOptionsPage(); }
api.runtime.onInstalled.addListener(() => { void openOptions(); });
api.action.onClicked.addListener((tab) => { void captureActive(tab); });
api.tabs.onRemoved.addListener((tabId) => {
  void mutatePending((items) => {
    const index = items.findIndex((item) => item.targetTabId === tabId);
    if (index >= 0) items.splice(index, 1);
  });
});

export async function captureActive(tab: { id?: number; url?: string; incognito?: boolean }): Promise<void> {
  if (tab.id === undefined) return;
  if (launchingTabs.has(tab.id)) {
    const current = await cleanup();
    const active = current.find((item) => item.sourceTabId === tab.id);
    if (active && active.targetTabId > 0) await api.tabs.update(active.targetTabId, { active: true });
    return;
  }
  launchingTabs.add(tab.id);
  try {
  const pending = await cleanup();
  const existing = pending.find((item) => item.sourceTabId === tab.id);
  if (existing) { await api.tabs.update(existing.targetTabId, { active: true }); return; }
  const settings = await readSettings();
  const mode = settings.mode;
  const target = await api.tabs.create({ url: 'about:blank', active: mode === 'review', openerTabId: tab.id });
  if (target.id === undefined) return;
  const requestId = randomId();
  const request: PendingRequest = {
    requestId, sourceTabId: tab.id, targetTabId: target.id, sourceUrl: tab.url || '', mode,
    createdAt: now(), kind: 'capture',
  };
  const stored = await mutatePending((items) => {
    const existing = items.find((item) => item.sourceTabId === tab.id);
    if (existing) return existing;
    items.push(request);
    if (items.length > MAX_PENDING) items.splice(0, items.length - MAX_PENDING);
    return request;
  });
  if (stored !== request) { await api.tabs.update(stored.targetTabId, { active: true }); return; }

  let capture: ExtensionCapture;
  if (tab.incognito) capture = failedCapture(request, 'unsupported');
  else {
    try {
      await api.scripting.executeScript({ target: { tabId: tab.id }, files: ['extractor.js'] });
      const result = (await api.scripting.executeScript({ target: { tabId: tab.id }, func: () => (window as Window & { __potemExtract?: () => unknown }).__potemExtract?.() }))[0]?.result as Record<string, unknown> | undefined;
      const current = await api.tabs.get(tab.id);
      if (!result || current.url !== request.sourceUrl || (typeof result.sourceUrl === 'string' && result.sourceUrl !== request.sourceUrl)) capture = failedCapture(request, 'navigation');
      else {
        const error = ['empty', 'oversized', 'unsupported', 'navigation', 'failed'].includes(String(result.error)) ? result.error as ExtensionCapture['extractionError'] : undefined;
        const markdown = typeof result.markdown === 'string' ? result.markdown : '';
        capture = {
          version: 1, requestId, mode, sourceUrl: request.sourceUrl,
          title: typeof result.title === 'string' ? result.title.slice(0, 500) : request.sourceUrl.slice(0, 500),
          ...(typeof result.author === 'string' ? { author: result.author.slice(0, 200) } : {}),
          ...(typeof result.description === 'string' ? { description: result.description.slice(0, 500) } : {}),
          markdown: new TextEncoder().encode(markdown).byteLength <= MAX_MARKDOWN_BYTES ? markdown : '',
          capturedAt: new Date().toISOString(), ...(error || (markdown && !markdown.trim()) ? { extractionError: error || 'empty' } : {}),
        };
      }
    } catch { capture = failedCapture(request, 'unsupported'); }
  }
  if (new TextEncoder().encode(request.sourceUrl).byteLength > MAX_URL_BYTES || !/^https?:/i.test(request.sourceUrl)) capture = failedCapture(request, 'unsupported');
  if (mode === 'simple') {
    const consent = settings.consent;
    if (!consent || consent.origin !== settings.origin) {
      capture = { ...capture, mode: 'review' };
    } else capture.destination = consent.destination;
  }
  const saved = await mutatePending((items) => {
    const item = items.find((entry) => entry.requestId === requestId);
    if (item) item.capture = capture;
    return item;
  });
  if (!saved) return;
  await setBadge(tab.id, '…', 'Sending page to Potem', '#77704f');
  await api.tabs.update(target.id, { url: `${settings.origin}/add?extension=${encodeURIComponent(requestId)}`, active: mode === 'review' });
  // Acknowledgment is the durable website sessionStorage receipt; if it does not
  // arrive, keep the request for the visible 20-second deadline and next action.
  setTimeout(() => { void handoffTimeout(requestId); }, 20_000);
  } finally { launchingTabs.delete(tab.id); }
}

function failedCapture(request: PendingRequest, error: NonNullable<ExtensionCapture['extractionError']>): ExtensionCapture {
  const sourceUrl = request.sourceUrl || '';
  return { version: 1, requestId: request.requestId, mode: request.mode, sourceUrl: sourceUrl.slice(0, MAX_URL_BYTES), title: 'Unsupported page', markdown: '', capturedAt: new Date().toISOString(), extractionError: error };
}
async function handoffTimeout(requestId: string) {
  const pending = await cleanup();
  const request = pending.find((item) => item.requestId === requestId);
  if (!request || request.acknowledged) return;
  await setBadge(request.sourceTabId, '!', 'Potem needs attention: capture handoff was not received', '#a33d32');
}

api.runtime.onMessage.addListener((unknownMessage, sender, sendResponse) => {
  void handleMessage(unknownMessage, sender).then(sendResponse, () => sendResponse({ ok: false }));
  return true;
});
async function handleMessage(unknownMessage: unknown, sender: { tab?: { id?: number; url?: string }; frameId?: number; url?: string }): Promise<unknown> {
  if (!unknownMessage || typeof unknownMessage !== 'object') return { ok: false };
  const message = unknownMessage as ExtensionMessage;
  if (message.version !== 1) return { ok: false };
  const extensionOrigin = api.runtime.getURL('');
  if (message.type === 'read-settings') return sender.url?.startsWith(extensionOrigin) ? readSettings() : { ok: false };
  if (message.type === 'set-mode') {
    if (!sender.url?.startsWith(extensionOrigin) || !['simple', 'review'].includes(message.mode)) return { ok: false };
    const settings = await readSettings();
    const mode = message.mode === 'simple' && !settings.consent ? 'review' : message.mode;
    await api.storage.local.set({ [SETTINGS_KEY]: { ...settings, mode } });
    return { ok: true, mode };
  }
  if (message.type === 'accept-consent') {
    if (!sender.url?.startsWith(extensionOrigin)) return { ok: false };
    const settings = await readSettings();
    if (!settings.destination || destinationPath(settings.destination) !== destinationPath(message.destination)) return { ok: false };
    await api.storage.local.set({ [SETTINGS_KEY]: { ...settings, mode: 'simple', consent: { origin: settings.origin, destination: message.destination, acceptedAt: new Date().toISOString() } } });
    return { ok: true };
  }
  if (message.type === 'begin-connect') {
    if (!sender.url?.startsWith(extensionOrigin)) return { ok: false };
    const requestId = randomId();
    const target = await api.tabs.create({ url: 'about:blank', active: true });
    if (target.id === undefined) return { ok: false };
    await mutatePending((items) => {
      items.push({ requestId, sourceTabId: -1, targetTabId: target.id!, sourceUrl: '', mode: 'review', createdAt: now(), kind: 'connect' });
      if (items.length > MAX_PENDING) items.splice(0, items.length - MAX_PENDING);
    });
    const settings = await readSettings();
    await api.tabs.update(target.id, { url: `${settings.origin}/extension-connect?request=${encodeURIComponent(requestId)}` });
    return { ok: true, requestId };
  }
  if (sender.frameId !== 0 || sender.tab?.id === undefined || typeof message.requestId !== 'string') return { ok: false };
  const pending = await cleanup();
  const request = pending.find((item) => item.requestId === message.requestId && item.targetTabId === sender.tab!.id);
  const senderUrl = sender.url ? new URL(sender.url) : null;
  let currentTabUrl: URL | null = null;
  try { currentTabUrl = sender.tab.url ? new URL(sender.tab.url) : null; } catch {}
  const authReturnMessage = senderUrl?.pathname === '/' && ['connection-config', 'capture-result'].includes(message.type);
  if (!request || !senderUrl || senderUrl.origin !== __POTEM_ORIGIN__ ||
      (!['/add', '/extension-connect'].includes(senderUrl.pathname) && !authReturnMessage) ||
      !currentTabUrl || currentTabUrl.origin !== __POTEM_ORIGIN__ || currentTabUrl.pathname !== senderUrl.pathname) return { ok: false };
  if (message.type === 'get-capture' && request.kind === 'capture') {
    if (!request.capture || request.acknowledged) return { ok: false };
    void api.tabs.sendMessage?.(sender.tab.id, { version: 1, type: 'deliver-capture', requestId: message.requestId, capture: request.capture });
    return { ok: true };
  }
  if (message.type === 'ack-capture' && request.kind === 'capture') {
    await mutatePending((items) => {
      const current = items.find((item) => item.requestId === message.requestId && item.targetTabId === sender.tab!.id);
      if (current) { current.acknowledged = true; if (current.capture) current.capture.markdown = ''; }
    });
    return { ok: true };
  }
  if (message.type === 'capture-result' && request.kind === 'capture') {
    await setBadge(request.sourceTabId, message.result === 'saved' ? '✓' : '!', message.result === 'saved' ? 'Saved to Potem' : 'Potem needs attention', message.result === 'saved' ? '#527a55' : '#a33d32');
    if (message.result === 'action-required') await api.tabs.update(request.targetTabId, { active: true });
    else await mutatePending((items) => { const index = items.findIndex((item) => item.requestId === message.requestId); if (index >= 0) items.splice(index, 1); });
    return { ok: true };
  }
  if (message.type === 'get-connection' && request.kind === 'connect') return { ok: true };
  if (message.type === 'connection-config' && request.kind === 'connect') {
    const settings = await readSettings();
    if (!message.authenticated) return { ok: false };
    const same = settings.consent && message.destination && destinationPath(settings.consent.destination) === destinationPath(message.destination);
    const updated: ExtensionSettings = {
      origin: settings.origin, mode: same ? settings.mode : 'review',
      ...(message.destination ? { destination: message.destination } : {}),
      ...(same && settings.consent ? { consent: settings.consent } : {}),
    };
    await api.storage.local.set({ [SETTINGS_KEY]: updated });
    await mutatePending((items) => { const index = items.findIndex((item) => item.requestId === message.requestId); if (index >= 0) items.splice(index, 1); });
    return { ok: true };
  }
  return { ok: false };
}
