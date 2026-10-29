import type { DestinationConsent, ExtensionMessage, ExtensionSettings } from './contracts';
const api: BrowserApi = typeof browser === 'undefined' ? chrome : browser;
const mode = document.querySelector<HTMLSelectElement>('#mode')!;
const dest = document.querySelector<HTMLElement>('#destination')!;
const status = document.querySelector<HTMLElement>('#status')!;
const consentPanel = document.querySelector<HTMLElement>('#consent-panel')!;
const consent = document.querySelector<HTMLInputElement>('#consent')!;
const visibility = document.querySelector<HTMLElement>('#visibility')!;
const destinationSelect = document.querySelector<HTMLSelectElement>('#integration')!;
let settings: ExtensionSettings | null = null;
let refreshGeneration = 0;
function send(message: ExtensionMessage): Promise<unknown> { return api.runtime.sendMessage(message); }
function display(value: ExtensionSettings) {
  settings = value;
  mode.value = value.mode;
  document.querySelector('#origin')!.textContent = value.origin;
  destinationSelect.replaceChildren(new Option('Save privately in Potem', ''));
  for (const integration of value.destinations || []) {
    if (integration.configured) destinationSelect.append(new Option(integration.name, integration.id));
  }
  destinationSelect.value = value.destination?.id || '';
  renderDestination();
}
function renderDestination() {
  const destination = settings?.destinations?.find(item => item.id === destinationSelect.value);
  consentPanel.hidden = false;
  document.querySelector<HTMLElement>('#consent-label')!.hidden = !destination;
  if (!destination) {
    dest.textContent = 'Pages are saved privately in Potem. No external integration is selected.';
    visibility.textContent = settings?.destinations?.length ? '' : 'No integrations configured. Connect to Potem to refresh available destinations.';
    consent.checked = false;
    return;
  }
  dest.textContent = destination.destination;
  visibility.textContent = destination.description;
  consent.checked = settings?.consent?.origin === settings?.origin && settings?.consent?.destination.id === destination.id && settings?.consent?.destination.destinationKey === destination.destinationKey;
}
destinationSelect.addEventListener('change', renderDestination);
async function refresh() {
  const generation = ++refreshGeneration;
  const value = await send({ version: 1, type: 'read-settings' }) as ExtensionSettings;
  if (generation === refreshGeneration) display(value);
}
void refresh().catch(() => { status.textContent = 'Could not read extension settings.'; });
window.addEventListener('focus', () => { void refresh().catch(() => {}); });
window.addEventListener('pageshow', () => { void refresh().catch(() => {}); });
api.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.settings?.newValue) return;
  refreshGeneration++;
  display(changes.settings.newValue as ExtensionSettings);
});
mode.addEventListener('change', async () => {
  const requestedMode = mode.value as 'simple' | 'review';
  const result = await send({ version: 1, type: 'set-mode', mode: requestedMode }) as { mode?: string };
  if (result.mode !== requestedMode) status.textContent = 'Confirm the selected integration before enabling automatic sending.';
  await refresh();
});
document.querySelector('#connect')!.addEventListener('click', async () => {
  status.textContent = 'Opening Potem. Sign in there, then return to these settings.';
  await send({ version: 1, type: 'begin-connect' });
});
document.querySelector('#save-consent')!.addEventListener('click', async () => {
  const selected = settings?.destinations?.find(item => item.id === destinationSelect.value);
  if (selected && !consent.checked) { status.textContent = 'Confirm the destination to enable automatic sending.'; return; }
  const destination: DestinationConsent | undefined = selected ? { id: selected.id, destinationKey: selected.destinationKey } : undefined;
  const result = await send({ version: 1, type: 'accept-consent', ...(destination ? { destination } : {}) }) as { ok?: boolean };
  status.textContent = result.ok ? destination ? 'Automatic saving and sending is enabled for this destination.' : 'Automatic private saving is enabled.' : 'The destination changed. Connect to Potem and review it again.';
  await refresh();
});
