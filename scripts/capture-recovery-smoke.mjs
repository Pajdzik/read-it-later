import assert from 'node:assert/strict';
import { expect } from 'playwright/test';

/** Browser contract fixtures; real D1/processor transactions are covered by recovery.test.ts. */
export async function captureRecoverySmoke(browser, base) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let article = {
    id: 'recover1', url: 'https://example.com/recover', title: 'Recovery fixture',
    author: 'Original author', description: 'Original description',
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', readAt: null,
  };
  let copy = { markdown: '# Original content', revision: 'original', source: 'upload', capturedAt: article.createdAt };
  let extraction = { state: 'ready', attempts: 0, errorCode: null, nextAttemptAt: null, paused: false, undoAvailable: false };
  let previous;
  let refresh = false;
  let polls = 0;
  let requests = 0;
  const complete = (failure = false) => {
    if (!failure) {
      previous = { article: { ...article }, copy: { ...copy } };
      copy = { ...copy, markdown: '# Recovered content', revision: `recovered-${requests}` };
      if (refresh) article = { ...article, title: 'Refreshed fixture', author: 'Refreshed author', description: 'Refreshed description' };
    }
    extraction = { ...extraction, undoAvailable: !failure || extraction.undoAvailable,
      recovery: { ...extraction.recovery, state: failure ? 'failed' : 'succeeded', errorCode: failure ? 'upstream_http' : null } };
  };
  await context.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    let body;
    let status = 200;
    if (pathname === '/api/session') body = { authenticated: true, csrfToken: 'fixture-csrf' };
    else if (pathname === '/api/articles') body = { items: [{ ...article, hasCopy: true, extraction }], nextCursor: null };
    else if (pathname === '/api/articles/suggestion') body = { article: null, hasAlternative: false };
    else if (pathname === '/api/articles/recover1') body = { article: { ...article, hasCopy: true, extraction } };
    else if (pathname === '/api/articles/recover1/copy') body = { copy };
    else if (pathname === '/api/articles/recover1/integrations') body = { integrations: [] };
    else if (pathname === '/api/articles/recover1/extraction') { polls++; body = { extraction }; }
    else if (pathname === '/api/articles/recover1/extraction/recapture' && method === 'POST') {
      const input = route.request().postDataJSON();
      assert.equal(input.expectedRevision, copy.revision);
      refresh = input.refreshMetadata;
      requests++;
      extraction = { ...extraction, recovery: { generation: requests, state: 'queued', attempts: 0, errorCode: null, nextAttemptAt: null } };
      body = { extraction }; status = 202;
    } else if (pathname === '/api/articles/recover1/extraction/undo' && method === 'POST') {
      assert.equal(route.request().postDataJSON().expectedRevision, copy.revision);
      copy = { ...previous.copy, revision: 'restored' };
      article = previous.article;
      extraction = { ...extraction, undoAvailable: false };
      body = { extraction };
    } else { await route.continue(); return; }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const detail = page.locator('#detail-content');
  const edit = async () => {
    await page.locator('.article[data-id="recover1"]').getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(detail.getByRole('textbox', { name: 'Markdown copy', exact: true })).toHaveValue(copy.markdown);
  };
  const poll = async () => {
    const previousPolls = polls;
    await page.clock.fastForward(5001);
    await expect.poll(() => polls).toBeGreaterThan(previousPolls);
  };
  try {
    await page.clock.install();
    await page.goto(base);
    await edit();
    const recapture = detail.getByRole('button', { name: 'Recapture article', exact: true });
    const markdown = detail.getByRole('textbox', { name: 'Markdown copy', exact: true });
    const refreshMetadata = detail.getByRole('checkbox', { name: 'Also refresh title, author, and description' });
    await expect(refreshMetadata).not.toBeChecked();
    await markdown.fill('Unsaved draft');
    await expect(recapture).toBeDisabled();
    await detail.getByRole('button', { name: 'Discard unsaved changes' }).click();
    await detail.getByRole('textbox', { name: 'Title', exact: true }).fill('Unsaved title');
    await expect(recapture).toBeDisabled();
    await detail.getByRole('button', { name: 'Discard unsaved changes' }).click();
    await refreshMetadata.check();
    await recapture.click();
    await expect(detail.locator('#detail-extraction-status')).toHaveText('Recapture queued');
    assert.equal(refresh, true);
    await expect(markdown).toHaveValue('# Original content');
    // Keep both title and Markdown drafts even if the background copy completes.
    await markdown.fill('Draft typed while recapturing');
    await detail.getByRole('textbox', { name: 'Title', exact: true }).fill('Title typed while recapturing');
    complete();
    await poll();
    await expect(detail.locator('#detail-extraction-status')).toHaveText('Recapture completed');
    await expect(page.locator('.article[data-id="recover1"] .article-title')).toHaveText('Refreshed fixture');
    await expect(markdown).toHaveValue('Draft typed while recapturing');
    await expect(detail.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Title typed while recapturing');
    await expect(recapture).toBeDisabled();
    await detail.getByRole('button', { name: 'Discard unsaved changes' }).click();
    await expect(markdown).toHaveValue('# Recovered content');
    await expect(detail.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Refreshed fixture');
    await detail.getByRole('button', { name: 'Undo last recapture' }).click();
    await expect(markdown).toHaveValue('# Original content');
    await expect(detail.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Recovery fixture');
    await expect(page.locator('.article[data-id="recover1"] .article-title')).toHaveText('Recovery fixture');
    await expect(detail.getByRole('button', { name: 'Undo last recapture' })).toBeHidden();
    // Reopen during an active job and verify the persisted status is shown.
    await recapture.click();
    await expect(detail.locator('#detail-extraction-status')).toHaveText('Recapture queued');
    await page.reload();
    await edit();
    await expect(detail.locator('#detail-extraction-status')).toHaveText('Recapture queued');
    complete(true);
    await poll();
    await expect(detail.locator('#detail-extraction-status')).toContainText('Recapture failed');
    await expect(markdown).toHaveValue('# Original content');
    await expect(recapture).toBeEnabled();
    // Read the old copy while another capture finishes; polling must not replace its body.
    await recapture.click();
    await expect(detail.locator('#detail-extraction-status')).toHaveText('Recapture queued');
    await detail.getByRole('button', { name: 'Read saved copy' }).click();
    await expect(page.locator('#reader-body')).toHaveText('Original content');
    complete();
    await poll();
    await expect(page.getByRole('button', { name: 'New copy available' })).toBeVisible();
    await expect(page.locator('#reader-body')).toHaveText('Original content');
    await page.getByRole('button', { name: 'New copy available' }).click();
    await expect(page.locator('#reader-body')).toHaveText('Recovered content');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
}
