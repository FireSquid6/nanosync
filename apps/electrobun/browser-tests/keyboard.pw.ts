import { test, expect, openApp, savedState } from './fixtures';

async function enter(page: import('@playwright/test').Page, name: string) {
  const button = page.getByRole('button', { name, exact: true });
  await button.focus();
  await page.keyboard.press('Enter');
}

test('keyboard onboarding creates a second copy on the same connection and explicitly starts it', async ({ page }) => {
  await openApp(page);
  const before = await savedState(page);
  await enter(page, 'Connect folder');
  const connection = page.getByRole('combobox', { name: 'Server connection', exact: true });
  await connection.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await enter(page, 'Request enrollment');
  await expect(page.getByRole('heading', { name: 'Give this vault a local home', exact: true })).toBeVisible();
  const recovery = page.getByLabel('Recovery key', { exact: false });
  await recovery.focus();
  await page.keyboard.type('keyboard-recovery-secret');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('textbox', { name: 'Local folder', exact: true })).toBeFocused();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('/home/alex/Sync/keyboard-copy');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Choose folder…', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('checkbox', { name: /I understand.*reconciled/ })).toBeFocused();
  await page.keyboard.press('Space');
  await enter(page, 'Connect folder');
  const start = page.getByRole('checkbox', { name: 'Start at user login', exact: true });
  await start.focus();
  await page.keyboard.press('Space');
  await expect(start).toBeFocused();
  await expect(start).toBeChecked();
  await page.keyboard.press('Tab');
  const background = page.getByRole('checkbox', { name: 'Keep syncing after closing the window', exact: true });
  await expect(background).toBeFocused();
  await page.keyboard.press('Space');
  await expect(background).toBeFocused();
  await enter(page, 'Continue');
  await expect(page.getByRole('heading', { name: 'Connected. Not syncing yet.', exact: true })).toBeVisible();
  await enter(page, 'Start syncing');
  const after = await savedState(page);
  expect(after.connections).toEqual(before.connections);
  expect(after.folders.find(f => f.path === '/home/alex/Sync/keyboard-copy')).toMatchObject({ server: 'home', paused: false, owner: 'Desktop' });
  expect(after.settings).toMatchObject({ startAtLogin: true, background: false });
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('keyboard-recovery-secret');
});

test('password and recovery material never enter persisted mock state', async ({ page }) => {
  await openApp(page);
  await enter(page, 'Connect folder');
  await page.getByLabel('Account password', { exact: false }).fill('password-secret-not-for-storage');
  await enter(page, 'Request enrollment');
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('password-secret-not-for-storage');
  await enter(page, 'Check approval');
  await enter(page, 'Continue');
  await page.getByLabel('Recovery key', { exact: false }).fill('another-vault-secret');
  await page.getByRole('checkbox', { name: /I understand.*reconciled/ }).check();
  await enter(page, 'Connect folder');
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('another-vault-secret');
  await page.reload();
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('password-secret-not-for-storage');
});
