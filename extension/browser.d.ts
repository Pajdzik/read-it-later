type ExtTab = { id?: number; url?: string; active?: boolean; incognito?: boolean };
type ExtEvent<T> = { addListener(listener: T): void; removeListener(listener: T): void };
interface BrowserApi {
  runtime: { id: string; getURL(path: string): string; onMessage: ExtEvent<(message: unknown, sender: { tab?: ExtTab; frameId?: number; url?: string }, sendResponse: (value?: unknown) => void) => boolean | void>; onInstalled: ExtEvent<() => void>; sendMessage(message: unknown): Promise<unknown>; openOptionsPage(): Promise<void>; lastError?: { message?: string } };
  action: { onClicked: ExtEvent<(tab: ExtTab) => void>; setBadgeText(details: { text: string; tabId?: number }): Promise<void>; setTitle(details: { title: string; tabId?: number }): Promise<void>; setBadgeBackgroundColor(details: { color: string; tabId?: number }): Promise<void> };
  tabs: { create(details: { url?: string; active?: boolean; openerTabId?: number }): Promise<ExtTab>; update(id: number, details: { url?: string; active?: boolean }): Promise<ExtTab>; get(id: number): Promise<ExtTab>; remove(id: number): Promise<void>; sendMessage(id: number, message: unknown): Promise<unknown>; query(query: { active: boolean; currentWindow: boolean }): Promise<ExtTab[]>; onRemoved: ExtEvent<(tabId: number) => void>; onUpdated: ExtEvent<(tabId: number, change: { status?: string; url?: string }, tab: ExtTab) => void> };
  scripting: { executeScript(details: { target: { tabId: number; allFrames?: boolean }; func?: (...args: never[]) => unknown; files?: string[]; args?: unknown[] }): Promise<Array<{ result?: unknown }>> };
  storage: { onChanged: ExtEvent<(changes: Record<string, { newValue?: unknown }>, areaName: string) => void>; local: { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> }; session: { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> }; };
}
declare const browser: BrowserApi;
declare const chrome: BrowserApi;
