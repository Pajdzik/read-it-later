export type CaptureMode = 'review' | 'simple';
export type DestinationConsent = { repository: string; branch: string; folder: string };
export type ExtensionCapture = {
  version: 1; requestId: string; mode: CaptureMode; sourceUrl: string; title: string;
  author?: string; description?: string; markdown: string; capturedAt: string;
  destination?: DestinationConsent; extractionError?: 'empty' | 'oversized' | 'unsupported' | 'navigation' | 'failed';
};
export type ExtensionSettings = {
  origin: string; mode: CaptureMode; destination?: DestinationConsent;
  consent?: { origin: string; destination: DestinationConsent; acceptedAt: string };
};
export type PendingRequest = {
  requestId: string; sourceTabId: number; targetTabId: number; sourceUrl: string; mode: CaptureMode;
  createdAt: number; capture?: ExtensionCapture; acknowledged?: boolean; kind: 'capture' | 'connect';
};
export type ExtensionMessage =
  | { version: 1; type: 'begin-connect' }
  | { version: 1; type: 'read-settings' }
  | { version: 1; type: 'set-mode'; mode: CaptureMode }
  | { version: 1; type: 'accept-consent'; destination: DestinationConsent }
  | { version: 1; type: 'get-capture'; requestId: string }
  | { version: 1; type: 'ack-capture'; requestId: string }
  | { version: 1; type: 'capture-result'; requestId: string; result: 'saved' | 'action-required' }
  | { version: 1; type: 'connection-config'; requestId: string; authenticated: boolean; destination?: DestinationConsent }
  | { version: 1; type: 'get-connection'; requestId: string };

export const MAX_PENDING = 10;
export const PENDING_TTL = 30 * 60 * 1000;
export const MAX_MARKDOWN_BYTES = 256 * 1024;
export const MAX_URL_BYTES = 8 * 1024;
