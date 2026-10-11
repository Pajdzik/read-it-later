import type { DestinationConsent, ExtensionMessage, ExtensionSettings } from './contracts';
const api: BrowserApi = typeof browser === 'undefined' ? chrome : browser;
const mode = document.querySelector<HTMLSelectElement>('#mode')!;
const dest = document.querySelector<HTMLElement>('#destination')!;
const status = document.querySelector<HTMLElement>('#status')!;
const consentPanel = document.querySelector<HTMLElement>('#consent-panel')!;
const consent = document.querySelector<HTMLInputElement>('#consent')!;
const visibility = document.querySelector<HTMLElement>('#visibility')!;
let settings: ExtensionSettings | null = null;
let refreshGeneration = 0;
function send(message: ExtensionMessage): Promise<unknown> { return api.runtime.sendMessage(message); }
function display(value: ExtensionSettings) {
  settings = value; mode.value = value.mode;
  const destination = value.destination;
  if (!destination) { dest.textContent = 'GitHub saving is not configured. Review mode can still save privately.'; consentPanel.hidden = true; return; }
  dest.textContent = `${destination.repository} · ${destination.branch} · ${destination.folder || '(repository root)'}`;
  const publicTarget = value.origin === 'https://read.pajdzik.pl' && destination.repository === 'Pajdzik/Kamilpedia';
  visibility.textContent = publicTarget ? 'The production repository Pajdzik/Kamilpedia is public. Any captured content saved there can be read by anyone.' : 'Files inherit the visibility of this repository. Check its visibility before enabling automatic saves.';
  consent.checked = value.consent?.origin === value.origin && value.consent.destination.repository === destination.repository && value.consent.destination.branch === destination.branch && value.consent.destination.folder === destination.folder;
  consentPanel.hidden = false;
}
async function refresh() {
  const generation = ++refreshGeneration;
  const value = await send({ version: 1, type: 'read-settings' }) as ExtensionSettings;
  if (generation !== refreshGeneration) return;
  applySettings(value);
}
void refresh().catch(() => { status.textContent = 'Could not read extension settings.'; });
window.addEventListener('focus', () => { void refresh().catch(() => {}); });
window.addEventListener('pageshow', () => { void refresh().catch(() => {}); });
api.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.settings?.newValue) return;
  refreshGeneration++;
  applySettings(changes.settings.newValue as ExtensionSettings);
});
function applySettings(value: ExtensionSettings) {
  settings = value;
  document.querySelector('#origin')!.textContent = value.origin;
  display(value);
}
mode.addEventListener('change', async () => {
  const requestedMode = mode.value as 'simple' | 'review';
  const result = await send({ version: 1, type: 'set-mode', mode: requestedMode }) as { mode?: string };
  if (result.mode !== requestedMode) status.textContent = 'Connect and confirm the current destination before enabling Simple mode.';
  await refresh();
});
document.querySelector('#connect')!.addEventListener('click', async () => {
  status.textContent = 'Opening Potem. Sign in there, then return to these settings.';
  await send({ version: 1, type: 'begin-connect' });
});
document.querySelector('#save-consent')!.addEventListener('click', async () => {
  const destination = settings?.destination as DestinationConsent | undefined;
  if (!destination || !consent.checked) { status.textContent = 'Check the consent box to enable automatic saving.'; return; }
  await send({ version: 1, type: 'accept-consent', destination });
  status.textContent = 'Automatic saving is enabled for this destination.';
  await refresh();
});
