import { expect } from 'playwright/test';

/** A global pause never changes whether an individual article has a saved copy. */
export async function captureStatusSmoke(browser, base) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  let paused = true;
  let empty = false;
  const articles = [
    { id: 'ready001', title: 'Already saved', state: 'ready' },
    { id: 'queued01', title: 'Waiting for a copy', state: 'queued', hasCopy: true },
    { id: 'fail0001', title: 'Saved copy with failed recapture', state: 'failed', hasCopy: true },
    { id: 'recov001', title: 'Saved copy being recaptured', state: 'ready', hasCopy: true, recovery: 'queued' },
    { id: 'recov002', title: 'Saved copy after successful recapture', state: 'ready', hasCopy: true, recovery: 'succeeded' },
    { id: 'recov003', title: 'Saved copy with failed recapture', state: 'ready', hasCopy: true, recovery: 'failed' },
    { id: 'link0001', title: 'Link only', state: 'none' },
  ];
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let body;
    if (path === '/api/session') body = { authenticated: true, csrfToken: 'status-fixture' };
    else if (path === '/api/articles') body = {
      capture: { paused }, nextCursor: null,
      items: empty ? [] : articles.map(article => ({
        id: article.id, title: article.title, url: `https://example.com/${article.id}`,
        author: null, description: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', readAt: null,
        hasCopy: article.hasCopy ?? article.state === 'ready',
        extraction: {
          state: article.state, attempts: 0, errorCode: null, nextAttemptAt: null, paused,
          ...(article.recovery ? { recovery: { state: article.recovery, attempts: 0, errorCode: null, nextAttemptAt: null } } : {}),
        },
      })),
    };
    else if (path === '/api/articles/suggestion') body = { article: null, hasAlternative: false };
    else return route.continue();
    await route.fulfill({ status: 200, json: body });
  });
  try {
    await page.goto(base);
    await expect(page.locator('#capture-status')).toBeVisible();
    await expect(page.locator('#articles')).not.toContainText(/paused/i);
    await expect(page.locator('[data-id="ready001"] .extraction-badge')).toBeHidden();
    await expect(page.locator('[data-id="queued01"]').getByRole('img', { name: 'Capture queued', exact: true })).toBeVisible();
    await expect(page.locator('[data-id="fail0001"]').getByRole('img', { name: 'Capture failed', exact: true })).toBeVisible();
    await expect(page.locator('[data-id="recov001"]').getByRole('img', { name: 'Recapture queued', exact: true })).toBeVisible();
    await expect(page.locator('[data-id="recov002"] .extraction-badge')).toBeHidden();
    await expect(page.locator('[data-id="recov003"]').getByRole('img', { name: /Recapture failed/ })).toBeVisible();
    await expect(page.locator('[data-id="link0001"] .extraction-badge')).toBeHidden();
    await expect(page.locator('#capture-status')).toHaveCount(1);

    empty = true;
    await page.reload();
    await expect(page.locator('#empty')).toBeVisible();
    await expect(page.locator('#capture-status')).toBeVisible();

    paused = false;
    empty = false;
    await page.reload();
    await expect(page.locator('[data-id="ready001"]')).toBeVisible();
    await expect(page.locator('#capture-status')).toBeHidden();
    await expect(page.locator('[data-id="ready001"] .extraction-badge')).toBeHidden();
    await expect(page.locator('[data-id="queued01"]').getByRole('img', { name: 'Capture queued', exact: true })).toBeVisible();
    await expect(page.locator('[data-id="fail0001"]').getByRole('img', { name: 'Capture failed', exact: true })).toBeVisible();
    console.log('Capture status smoke passed: one global pause notice, pending/failed indicators, hidden routine success, and empty libraries.');
  } finally { await context.close(); }
}
