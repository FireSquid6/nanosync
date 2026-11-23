import { test, expect, openApp } from './fixtures';

for (const colorScheme of ['light', 'dark'] as const) {
  for (const width of [960, 1280]) {
    test(`${colorScheme} at ${width}px: core surfaces fit without horizontal overflow`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: 900 });
      await openApp(page);
      for (const name of ['Folders', 'Conflicts', 'Connections', 'Settings']) {
        await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('button', { name, exact: true }).click();
        await expect(page.getByRole('heading', { name, exact: true, level: 1 })).toBeVisible();
        await expect(page).toHaveTitle('nanosync');
        await expect(page.locator('body')).not.toContainText(/\b(mock|demo|simulat\w*|synthetic|fictional)\b/i);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), name).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight), name).toBe(true);
        await page.evaluate(() => window.scrollTo(0, 100));
        expect(await page.evaluate(() => window.scrollY), name).toBe(0);
        await expect(page.getByRole('button', { name: 'Quit nanosync', exact: true })).toBeInViewport();
        if (name === 'Folders') await page.screenshot({ path: testInfo.outputPath(`folders-${colorScheme}-${width}.png`), fullPage: true });
      }
    });
  }
}

test('long folder lists scroll inside the content pane, not the window', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 600 });
  await openApp(page);
  const content = page.locator('main');
  expect(await content.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await page.getByRole('button', { name: 'Research', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Research', exact: true })).toBeInViewport();
  expect(await content.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.getByRole('button', { name: 'Quit nanosync', exact: true })).toBeInViewport();
});

test('dialog keeps keyboard focus inside and Escape restores its trigger', async ({ page }) => {
  await openApp(page);
  const quit = page.getByRole('button', { name: 'Quit nanosync', exact: true });
  await quit.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Tab');
    // Chromium can focus browser chrome (reported as body) at the native dialog boundary.
    expect(await dialog.evaluate(el => el.contains(document.activeElement) || document.activeElement === document.body)).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(quit).toBeFocused();
});
