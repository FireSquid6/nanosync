import { test, expect, openApp, savedState } from './fixtures';

test('folder selection shows identity, progress, CLI owner, and missing-root safety', async ({ page }) => {
  await openApp(page);
  await expect(page.getByRole('heading', { name: 'Folders', exact: true })).toBeVisible();
  await expect(page.locator('.mock-banner, footer')).toHaveCount(0);
  for (const text of [
    'Connected folders, not another filesystem.',
    'local editing remains unrestricted',
    'Desktop owns this binding.',
    'Mock engine state;',
  ]) {
    await expect(page.getByText(text, { exact: false })).toHaveCount(0);
  }
  const inspector = page.getByRole('region', { name: 'Selected folder' });
  await expect(inspector).toContainText('/home/alex/Documents');
  await expect(inspector).toContainText('Last successful sync');
  await page.getByRole('button', { name: 'Documents · second copy', exact: true }).click();
  await expect(inspector).toContainText('CLI');
  await expect(inspector).toContainText('/home/alex/Work/reference');
  await page.getByRole('button', { name: 'Media', exact: true }).click();
  await expect(inspector).toContainText('Folder unavailable');
  const before = await savedState(page);
  await page.getByRole('button', { name: 'Retry folder', exact: true }).click();
  const after = await savedState(page);
  expect(after.folders.find(f => f.id === 'media')).toEqual(before.folders.find(f => f.id === 'media'));
  await page.reload();
  await page.getByRole('button', { name: 'Media', exact: true }).click();
  await expect(inspector).toContainText('Folder unavailable');
});

test('clicking folder card details or padding selects the folder', async ({ page }) => {
  await openApp(page);
  const inspector = page.getByRole('region', { name: 'Selected folder' });
  for (const target of ['.path', '.status', '.meta']) {
    await page.getByRole('button', { name: 'Documents', exact: true }).click();
    const card = page.locator('article[data-folder="notes"]');
    await card.locator(target).click();
    await expect(card).toHaveClass(/selected/);
    await expect(inspector.getByRole('heading', { name: 'Notes', exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Notes', exact: true })).toHaveAttribute('aria-pressed', 'true');
  }
  const media = page.locator('article[data-folder="media"]');
  await media.click({ position: { x: 2, y: 2 } });
  await expect(media).toHaveClass(/selected/);
  await expect(inspector.getByRole('heading', { name: 'Media', exact: true })).toBeVisible();
});

test('global pause and individual pause persist independently across reload', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'Pause folder', exact: true }).click();
  await page.getByRole('button', { name: 'Pause globally', exact: true }).click();
  await page.reload();
  expect((await savedState(page)).globalPaused).toBe(true);
  await page.getByRole('button', { name: 'Resume globally', exact: true }).first().click();
  const state = await savedState(page);
  expect(state.globalPaused).toBe(false);
  expect(state.folders.find(f => f.id === 'documents')?.paused).toBe(true);
  expect(state.folders.find(f => f.id === 'reference')?.paused).toBe(true);
  await expect(page.getByRole('button', { name: 'Resume folder', exact: true })).toBeVisible();
  await page.reload();
  expect((await savedState(page)).folders.find(f => f.id === 'documents')?.paused).toBe(true);
});
