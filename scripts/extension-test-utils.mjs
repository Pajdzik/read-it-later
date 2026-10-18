export async function openExtensionOptions(context, extensionId) {
  const optionsUrl = `chrome-extension://${extensionId}/options.html`;
  const findOptions = () => context.pages().find((page) => page.url() === optionsUrl);
  // The onInstalled handler opens Options itself. Let that navigation settle
  // before opening a page manually, and recover if both paths still race.
  for (let attempt = 0; attempt < 20; attempt++) {
    const options = findOptions();
    if (options) return options;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const options = await context.newPage();
  try {
    await options.goto(optionsUrl);
  } catch (error) {
    if (!String(error).includes('interrupted by another navigation')) throw error;
  }
  for (let attempt = 0; attempt < 200; attempt++) {
    const opened = findOptions();
    if (opened) return opened;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Extension did not open its Options page: ${optionsUrl}`);
}
