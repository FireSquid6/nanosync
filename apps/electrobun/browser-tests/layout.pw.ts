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
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), name).toBe(true);
        if (name === 'Folders') await page.screenshot({ path: testInfo.outputPath(`folders-${colorScheme}-${width}.png`), fullPage: true });
      }
    });
  }
}

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
