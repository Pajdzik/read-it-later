import assert from 'node:assert/strict';
import { expect } from 'playwright/test';

export async function enrichmentSmoke(browser, base) {
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const now = '2026-10-31T12:00:00.000Z';
    const extraction = { state: 'ready', attempts: 0, paused: false, errorCode: null, nextAttemptAt: null, undoAvailable: false };
    const articles = [
      { id: 'enrich01', title: 'Database transactions', tags: ['databases'], readAt: null },
      { id: 'enrich02', title: 'Database indexes', tags: ['databases'], readAt: now },
      { id: 'enrich03', title: 'Security fundamentals', tags: ['security'], readAt: null },
    ].map(a => ({ url: `https://example.com/${a.id}`, author: null, description: 'Generated summary of the saved article.', descriptionOrigin: 'generated',
      tagsManuallyEdited: false, createdAt: now, updatedAt: now, hasCopy: true, extraction,
      enrichment: { state: 'queued', paused: false }, ...a }));
    const listingRequests = [];
    const patches = [];
    let pendingReader = false;
    let polls = 0;
    let copyReads = 0;
    let copyGate = null;
    await context.route('**/api/**', async route => {
      const req = route.request(), url = new URL(req.url()), pathname = url.pathname;
      let body;
      if (pathname === '/api/session') body = { authenticated: true, csrfToken: 'fixture' };
      else if (pathname === '/api/tags') {
        const counts = new Map();
        for (const a of articles) for (const tag of a.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
        body = { tags: [...counts].sort().map(([tag, count]) => ({ tag, count })) };
      } else if (pathname === '/api/articles/suggestion') body = { article: null, hasAlternative: false };
      else if (pathname === '/api/articles') {
        listingRequests.push(url.searchParams);
        const status = url.searchParams.get('status'), tag = url.searchParams.get('tag'), q = url.searchParams.get('q');
        body = { items: articles.filter(a => (!tag || a.tags.includes(tag)) && (!q || a.title.toLowerCase().includes(q.toLowerCase()))
          && (status === 'all' || status === 'read' ? status === 'all' || !!a.readAt : !a.readAt)), nextCursor: null };
      } else {
        const match = /^\/api\/articles\/(enrich0[123])(?:\/(copy|integrations|extraction))?$/.exec(pathname);
        if (!match) { await route.continue(); return; }
        const article = articles.find(a => a.id === match[1]);
        if (match[2] === 'copy') { copyReads++; if (copyGate) await copyGate; body = { copy: pendingReader && article.id === 'enrich03' ? null : { markdown: '# Saved article\n\nThe original body.', capturedAt: now, source: 'paste', revision: 'fixture-copy' } }; }
        else if (match[2] === 'integrations') body = { integrations: [] };
        else if (match[2] === 'extraction') body = { extraction };
        else if (req.method() === 'PATCH') {
          const input = req.postDataJSON();
          patches.push(input);
          Object.assign(article, input);
          if ('description' in input) article.descriptionOrigin = 'manual';
          if ('tags' in input) { article.tags = [...new Set(input.tags.map(t => t.toLowerCase().trim()))].sort(); article.tagsManuallyEdited = true; }
          article.enrichment = { state: 'skipped', paused: false };
          body = { article };
        } else { polls++; body = { article }; }
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    try {
      await page.clock.install(); await page.goto(base);
      await expect(page.locator('.article')).toHaveCount(2);
      await expect(page.getByLabel('Filter by tag')).toBeVisible();
      await page.screenshot({ path: `/tmp/potem-enrichment-${width}.png` });
      await page.locator('.article[data-id=enrich01]').getByRole('button', { name: 'Filter by databases', exact: true }).click();
      await expect(page.locator('.article')).toHaveCount(1);
      await page.getByRole('button', { name: 'All', exact: true }).click();
      await expect(page.locator('.article')).toHaveCount(2);
      assert.equal(listingRequests.at(-1).get('tag'), 'databases');
      assert.equal(listingRequests.at(-1).has('cursor'), false);
      // Opening and returning from a saved article retains the tag filter.
      await page.locator('.article[data-id=enrich01] .article-title').click();
      await expect(page.locator('#reader-dialog')).toBeVisible();
      await page.goBack(); await expect(page.locator('#reader-dialog')).toBeHidden();
      await expect(page.getByLabel('Filter by tag')).toHaveValue('databases');
      await page.locator('.article[data-id=enrich01]').getByRole('button', { name: 'More actions', exact: true }).click();
      await page.locator('.article[data-id=enrich01]').getByRole('button', { name: 'Edit', exact: true }).click();
      const detail = page.locator('#detail-content');
      const tags = detail.getByRole('textbox', { name: 'Tags (comma separated)', exact: true });
      const description = detail.getByRole('textbox', { name: 'Description', exact: true });
      await expect(detail.getByRole('heading', { name: 'Edit article', exact: true })).toBeVisible();
      await expect(detail.locator('.article-tags')).toHaveCount(0);
      const markdownDisclosure = detail.locator('details[data-disclosure="markdown"]');
      const captureDisclosure = detail.locator('details[data-disclosure="capture"]');
      await markdownDisclosure.evaluate(node => { node.open = true; });
      await captureDisclosure.evaluate(node => { node.open = true; });
      await page.screenshot({ path: `/tmp/potem-enrichment-editor-${width}.png` });
      await detail.getByRole('button', { name: 'Save changes', exact: true }).click();
      assert.equal(patches.length, 0, 'An unchanged details form must not protect the title or write metadata.');
      await tags.fill('Storage, Databases'); await description.fill('An owner-written description.');
      // Pending jobs retain their polling age and leave an unchanged editor alone.
      await description.focus();
      await description.evaluate(field => field.setSelectionRange(3, 10));
      const originalEditor = await description.elementHandle();
      await page.clock.fastForward(60_001);
      await expect.poll(() => polls).toBeGreaterThan(0);
      // Drain the first pending response, then check that the next request uses the slow interval.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      const afterMinute = polls;
      const copyReadsAfterMinute = copyReads;
      await page.clock.fastForward(5_001);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      assert.equal(polls, afterMinute, 'After one minute a pending enrichment must back off to thirty-second polling.');
      assert.equal(copyReads, copyReadsAfterMinute, 'Unchanged enrichment must not reload the copy editor.');
      assert.equal(await originalEditor.evaluate(field => field.isConnected), true, 'An unchanged pending job must retain editor DOM nodes.');
      await expect(description).toBeFocused();
      assert.deepEqual(await description.evaluate(field => [field.selectionStart, field.selectionEnd]), [3, 10]);
      const savedMarkdown = detail.getByRole('textbox', { name: 'Markdown copy', exact: true });
      await savedMarkdown.focus(); await savedMarkdown.evaluate(field => field.setSelectionRange(2, 9));
      const oldCopyField = await savedMarkdown.elementHandle();
      articles[0].tags = ['databases', 'storage'];
      let beforeUpdate = polls;
      await page.clock.fastForward(30_001); await expect.poll(() => polls).toBeGreaterThan(beforeUpdate);
      await expect.poll(() => oldCopyField.evaluate(field => field.isConnected)).toBe(false);
      await expect(savedMarkdown).toHaveValue('# Saved article\n\nThe original body.');
      await expect(savedMarkdown).toBeFocused();
      await expect.poll(() => savedMarkdown.evaluate(field => [field.selectionStart, field.selectionEnd])).toEqual([2, 9]);
      // If the owner leaves the textarea while its replacement body loads, do not steal focus back.
      let releaseCopy;
      copyGate = new Promise(resolve => { releaseCopy = resolve; });
      const readsBeforeGate = copyReads;
      articles[0].tags = ['databases', 'indexing'];
      beforeUpdate = polls;
      await page.clock.fastForward(30_001); await expect.poll(() => polls).toBeGreaterThan(beforeUpdate);
      await expect.poll(() => copyReads).toBeGreaterThan(readsBeforeGate);
      await description.focus(); await description.evaluate(field => field.setSelectionRange(3, 10));
      releaseCopy(); copyGate = null;
      await expect(savedMarkdown).toHaveValue('# Saved article\n\nThe original body.');
      await expect(description).toBeFocused();
      const prior = polls;
      articles[0].enrichment.state = 'succeeded';
      articles[0].tags = ['databases', 'transactions'];
      await page.clock.fastForward(30_001); await expect.poll(() => polls).toBeGreaterThan(prior);
      await expect(tags).toHaveValue('Storage, Databases');
      await expect(description).toHaveValue('An owner-written description.');
      await expect(description).toBeFocused();
      await expect(markdownDisclosure).toHaveAttribute('open', '');
      await expect(captureDisclosure).toHaveAttribute('open', '');
      assert.deepEqual(await description.evaluate(field => [field.selectionStart, field.selectionEnd]), [3, 10]);
      await expect(detail.getByRole('button', { name: 'Recapture article', exact: true })).toBeDisabled();
      await detail.getByRole('button', { name: 'Save changes', exact: true }).click();
      await expect(tags).toHaveValue('databases, storage');
      assert.equal(articles[0].tagsManuallyEdited, true);
      assert.equal('title' in patches.at(-1), false, 'Editing tags and description must not protect an untouched title.');
      assert.equal(articles[0].descriptionOrigin, 'manual');
      await detail.getByRole('button', { name: 'Clear tags', exact: true }).click();
      await detail.getByRole('button', { name: 'Clear description', exact: true }).click();
      await detail.getByRole('button', { name: 'Save changes', exact: true }).click();
      await expect(tags).toHaveValue(''); await expect(description).toHaveValue('');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Clear tag filter', exact: true }).click();
      await expect(page.locator('.article')).toHaveCount(3);
      await page.getByLabel('Filter by tag').selectOption('security');
      await expect(page.locator('.article')).toHaveCount(1);
      // Details opened from a pending reader must carry a new filter through history restoration.
      pendingReader = true;
      articles[2].tags = ['databases', 'security'];
      articles[2].extraction = { ...extraction, state: 'queued' };
      articles[2].enrichment = { state: 'skipped', paused: false };
      articles[2].hasCopy = false;
      articles[2].title = 'example.com/enrich03';
      await page.locator('.article[data-id=enrich03] .article-title').click();
      await page.locator('#reader-manual-copy').click();
      await page.keyboard.press('Escape');
      await page.getByLabel('Filter by tag').selectOption('databases');
      await expect(page).toHaveURL(base + '/');
      await page.locator('#loading').waitFor({ state: 'hidden' });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await expect(page.getByLabel('Filter by tag')).toHaveValue('databases');
      await expect(page.locator('.article')).toHaveCount(2);
      assert.equal(listingRequests.at(-1).get('tag'), 'databases');
      assert.equal(listingRequests.at(-1).has('cursor'), false);
      // A tag edit while source capture is pending must not submit the fallback title.
      await page.locator('.article[data-id=enrich03]').getByRole('button', { name: 'More actions', exact: true }).click();
      await page.locator('.article[data-id=enrich03]').getByRole('button', { name: 'Edit', exact: true }).click();
      await tags.fill('databases, security, web');
      await detail.getByRole('button', { name: 'Save changes', exact: true }).click();
      await expect.poll(() => tags.evaluate(field => field.defaultValue)).toBe('databases, security, web');
      assert.equal('title' in patches.at(-1), false);
      articles[2].title = 'Source security headline';
      articles[2].extraction = extraction;
      pendingReader = false;
      const beforeHeadline = polls;
      await page.clock.fastForward(5_001); await expect.poll(() => polls).toBeGreaterThan(beforeHeadline);
      await expect(detail.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Source security headline');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      // Direct reader entry can have an empty background list and an older unfiltered request in flight.
      pendingReader = true;
      articles[2].extraction = { ...extraction, state: 'queued' };
      const direct = await context.newPage();
      direct.on('pageerror', error => errors.push(error.message));
      let releaseInitial;
      const initialGate = new Promise(resolve => { releaseInitial = resolve; });
      let initialHeld = false;
      await direct.route('**/api/articles?*', async route => {
        if (!new URL(route.request().url()).searchParams.has('tag') && !initialHeld) { initialHeld = true; await initialGate; }
        await route.fallback();
      });
      await direct.goto(`${base}/read/enrich03`);
      await direct.locator('#reader-manual-copy').click();
      assert.equal(initialHeld, true);
      await expect(direct.locator('.article')).toHaveCount(0);
      await direct.keyboard.press('Escape');
      releaseInitial();
      await expect(direct).toHaveURL(base + '/');
      await direct.locator('#loading').waitFor({ state: 'hidden' });
      await direct.getByLabel('Filter by tag').selectOption('databases');
      await expect(direct).toHaveURL(base + '/');
      await direct.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await expect(direct.getByLabel('Filter by tag')).toHaveValue('databases');
      await expect(direct.locator('.article')).toHaveCount(1);
      await expect(direct.locator('.article')).toHaveAttribute('data-id', 'enrich03');
      await direct.close();
      assert.deepEqual(errors, []);
      console.log(`Enrichment browser checks passed at ${width}px: filtering, reader return, draft preservation, editing, and clearing.`);
    } finally { await context.close(); }
  }
}
