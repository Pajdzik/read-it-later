import type { ExtensionMessage } from './contracts';

const api: BrowserApi = typeof browser === 'undefined' ? chrome : browser;
const origin = location.origin;
function valid(event: MessageEvent, data: Record<string, unknown>): boolean {
  return event.source === window && event.origin === origin && data.namespace === 'potem-extension' && data.version === 1 && typeof data.requestId === 'string';
}
window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as Record<string, unknown>;
  if (!data || typeof data !== 'object' || !valid(event, data)) return;
  if (data.type !== 'ready' && data.type !== 'ack-capture' && data.type !== 'capture-result' && data.type !== 'connection-config') return;
  const message: ExtensionMessage = data.type === 'ready'
    ? (location.pathname === '/extension-connect' ? { version: 1, type: 'get-connection', requestId: data.requestId as string } : { version: 1, type: 'get-capture', requestId: data.requestId as string })
    : data.type === 'connection-config'
      ? { version: 1, type: 'connection-config', requestId: data.requestId as string, authenticated: data.authenticated === true, ...(Array.isArray(data.destinations) ? { destinations: data.destinations as never } : {}) }
      : data.type === 'ack-capture'
      ? { version: 1, type: 'ack-capture', requestId: data.requestId as string }
      : { version: 1, type: 'capture-result', requestId: data.requestId as string, result: data.result === 'saved' ? 'saved' : 'action-required' };
  void api.runtime.sendMessage(message);
});

api.runtime.onMessage.addListener((message: unknown) => {
  if (!message || typeof message !== 'object') return;
  const m = message as Record<string, unknown>;
  if (m.version !== 1 || typeof m.requestId !== 'string') return;
  if (m.type === 'deliver-capture') window.postMessage({ namespace: 'potem-extension', version: 1, type: 'deliver-capture', requestId: m.requestId, capture: m.capture }, origin);
  if (m.type === 'deliver-connection') window.postMessage({ namespace: 'potem-extension', version: 1, type: 'deliver-connection', requestId: m.requestId, authenticated: m.authenticated, destination: m.destination }, origin);
});
