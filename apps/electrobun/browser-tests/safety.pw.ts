import { test, expect, openApp, savedState } from './fixtures';

async function navigate(page: import('@playwright/test').Page, name: string) {
  await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('button', { name, exact: true }).click();
}

test('conflicts persist until explicit manual review, without choosing or deleting a version', async ({ page }) => {
  await openApp(page);
  await navigate(page, 'Conflicts');
  await expect(page.getByText('Preserved copy: project-plan (conflict-laptop).md', { exact: false })).toBeVisible();
  await page.reload();
  await navigate(page, 'Conflicts');
  const before = (await savedState(page)).conflicts;
  await page.getByRole('button', { name: 'I have resolved this', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Acknowledge resolution', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Confirm manual review');
  expect((await savedState(page)).conflicts).toEqual(before);
  await dialog.getByRole('checkbox', { name: /I reviewed both preserved versions/ }).check();
  await dialog.getByRole('button', { name: 'Acknowledge resolution', exact: true }).click();
  expect((await savedState(page)).conflicts).toEqual(before.slice(1));
  await expect(page.getByRole('status')).toContainText('Both file versions preserved');
  await page.reload();
  expect((await savedState(page)).conflicts).toEqual(before.slice(1));
});

test('ignore rules validate real syntax and invalidate validation when edited', async ({ page }) => {
  await openApp(page);
  const before = await savedState(page);
  await page.getByRole('button', { name: 'Edit ignore rules', exact: true }).click();
  const rules = page.getByRole('textbox', { name: '.nanosyncignore rules', exact: true });
  await rules.fill('!unsupported');
  await page.getByRole('button', { name: 'Validate rules', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'unsupported .nanosyncignore' })).toBeVisible();
  await page.getByRole('button', { name: 'Save rules', exact: true }).click();
  expect((await savedState(page)).folders).toEqual(before.folders);
  await rules.fill('cache/\n*.tmp\n');
  await page.getByRole('button', { name: 'Validate rules', exact: true }).click();
  await rules.fill('cache/\n*.log\n');
  await page.getByRole('button', { name: 'Save rules', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Validate the current rules' })).toBeVisible();
  await page.getByRole('button', { name: 'Validate rules', exact: true }).click();
  await page.getByRole('button', { name: 'Save rules', exact: true }).click();
  const after = await savedState(page);
  expect(after.folders[0]?.rules).toBe('cache/\n*.log\n');
  expect(after.folders.slice(1)).toEqual(before.folders.slice(1));
  expect(after.conflicts).toEqual(before.conflicts);
  await page.reload();
  expect((await savedState(page)).folders[0]?.rules).toBe('cache/\n*.log\n');
});

test('disconnect requires acknowledgment, preserves other bindings, and cannot bypass CLI ownership', async ({ page }) => {
  await openApp(page);
  const before = await savedState(page);
  await page.getByRole('button', { name: 'Disconnect folder', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Local files and remote data are preserved');
  await dialog.getByRole('button', { name: 'Confirm disconnect', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Explicit acknowledgment');
  expect((await savedState(page)).folders).toEqual(before.folders);
  await dialog.getByRole('checkbox', { name: /I explicitly accept abandoning/ }).check();
  await dialog.getByRole('button', { name: 'Confirm disconnect', exact: true }).click();
  expect((await savedState(page)).folders).toEqual(before.folders.slice(1));
  await page.getByRole('button', { name: 'Documents · second copy', exact: true }).click();
  await page.getByRole('button', { name: 'Disconnect folder', exact: true }).click();
  await dialog.getByRole('checkbox', { name: /I explicitly accept abandoning/ }).check();
  await dialog.getByRole('button', { name: 'Confirm disconnect', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Blocked by active CLI owner');
  expect((await savedState(page)).folders).toEqual(before.folders.slice(1));
});

test('connection removal respects pending consent and active CLI ownership', async ({ page }) => {
  await openApp(page);
  const before = await savedState(page);
  await navigate(page, 'Connections');
  await page.getByRole('button', { name: 'Details: home', exact: true }).click();
  await page.getByRole('button', { name: 'Remove connection', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Confirm removal', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Explicit acknowledgment');
  await dialog.getByRole('checkbox', { name: /I explicitly accept abandoning/ }).check();
  await dialog.getByRole('button', { name: 'Confirm removal', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Blocked by active CLI owner');
  expect((await savedState(page)).connections).toEqual(before.connections);
  expect((await savedState(page)).folders).toEqual(before.folders);
});

test('locked credentials require explicit unlock, protected-file migration requires consent', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'Private', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Selected folder' })).toContainText('Credentials locked');
  await page.getByRole('button', { name: 'Unlock credentials', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('No plaintext fallback');
  await expect(dialog.getByRole('textbox')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await savedState(page)).connections.find(c => c.id === 'locked')?.credential).toBe('locked');
  await navigate(page, 'Connections');
  await page.getByRole('button', { name: 'Details: headless', exact: true }).click();
  await page.getByRole('button', { name: 'Review credential migration', exact: true }).click();
  await dialog.getByRole('button', { name: 'Keep protected-file mode', exact: true }).click();
  expect((await savedState(page)).connections.find(c => c.id === 'headless')?.credential).toBe('protected-file');
  await page.getByRole('button', { name: 'Details: headless', exact: true }).click();
  await page.getByRole('button', { name: 'Review credential migration', exact: true }).click();
  await dialog.getByRole('button', { name: 'Migrate to OS credential store', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Explicit migration consent');
  await dialog.getByRole('checkbox', { name: /I explicitly choose migration/ }).check();
  await dialog.getByRole('button', { name: 'Migrate to OS credential store', exact: true }).click();
  expect((await savedState(page)).connections.find(c => c.id === 'headless')?.credential).toBe('os');
});
