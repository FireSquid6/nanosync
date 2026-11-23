import { readFile } from 'node:fs/promises';
import { test, expect, openApp, savedState } from './fixtures';

async function settings(page: import('@playwright/test').Page) {
  await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('button', { name: 'Settings', exact: true }).click();
}

test('lifecycle choices persist and close/quit preserve independently CLI-owned work', async ({ page }) => {
  await openApp(page, state => { state.folders.find(f => f.owner === 'CLI')!.paused = false; });
  const before = await savedState(page);
  await settings(page);
  await expect(page.getByRole('checkbox', { name: 'Start at user login', exact: true })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Keep syncing after closing the window', exact: true })).toBeChecked();
  await page.getByRole('checkbox', { name: 'Start at user login', exact: true }).check();
  await page.getByRole('button', { name: 'Close window', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Close window', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Window hidden (simulated)', exact: true })).toBeVisible();
  expect((await savedState(page)).quit).toBe(false);
  await page.getByRole('button', { name: 'Reopen nanosync', exact: true }).click();
  await settings(page);
  await page.getByRole('checkbox', { name: 'Keep syncing after closing the window', exact: true }).uncheck();
  await page.reload();
  const state = await savedState(page);
  expect(state.settings.startAtLogin).toBe(true);
  expect(state.settings.background).toBe(false);
  await page.getByRole('button', { name: 'Close window', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Independently CLI-owned syncing continues');
  await page.getByRole('dialog').getByRole('button', { name: 'Close window', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Desktop stopped', exact: true })).toBeVisible();
  expect((await savedState(page)).folders.find(f => f.owner === 'CLI')).toEqual(before.folders.find(f => f.owner === 'CLI'));
  await page.getByRole('button', { name: 'Reopen nanosync', exact: true }).click();
  await page.getByRole('button', { name: 'Quit nanosync', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Quit desktop', exact: true }).click();
  expect((await savedState(page)).quit).toBe(true);
  expect((await savedState(page)).folders.find(f => f.owner === 'CLI')).toEqual(before.folders.find(f => f.owner === 'CLI'));
});

test('notification privacy defaults and independent categories survive global disable and reload', async ({ page }) => {
  await openApp(page);
  await settings(page);
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  const conflicts = page.getByRole('checkbox', { name: 'Conflicts', exact: true });
  const revoked = page.getByRole('checkbox', { name: 'Revoked access', exact: true });
  await expect(page.getByRole('checkbox', { name: 'Include filenames and paths in notifications', exact: true })).not.toBeChecked();
  await conflicts.uncheck();
  await expect(revoked).toBeChecked();
  await page.getByRole('checkbox', { name: 'Enable notifications', exact: true }).uncheck();
  await expect(conflicts).toBeDisabled();
  await expect(revoked).toBeDisabled();
  await page.reload();
  await settings(page);
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Enable notifications', exact: true }).check();
  await expect(conflicts).not.toBeChecked();
  await expect(revoked).toBeChecked();
  expect((await savedState(page)).settings.includePaths).toBe(false);
});

test('explicit diagnostics download contains only synthetic redacted state', async ({ page }) => {
  await openApp(page, state => {
    state.folders[0]!.path = '/private/unique-path-marker';
    state.folders[0]!.name = 'unique-filename-marker.txt';
    state.conflicts[0]!.file = 'unique-conflict-marker.txt';
  });
  await settings(page);
  await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
  await page.getByRole('button', { name: 'Review diagnostic report', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Synthetic report only');
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export diagnostics', exact: true }).click();
  const download = await downloadPromise;
  const report = await readFile((await download.path())!, 'utf8');
  expect(JSON.parse(report)).toMatchObject({ source: 'synthetic mock demo' });
  for (const marker of ['/private/', '/home/', 'unique-path-marker', 'unique-filename-marker', 'unique-conflict-marker', 'https://', 'H7KM', 'TEST–18AB']) {
    expect(report).not.toContain(marker);
  }
});
