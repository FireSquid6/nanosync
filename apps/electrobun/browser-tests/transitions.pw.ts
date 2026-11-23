import { test, expect, openApp, pendingEnrollment, savedState } from './fixtures';

test('editing approved enrollment identity invalidates approval before requesting again', async ({ page }) => {
  await openApp(page, state => {
    state.enrollment = { ...pendingEnrollment('approved'), status: 'approved' };
  });
  await page.getByRole('button', { name: 'Resume enrollment', exact: true }).click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('textbox', { name: 'Server URL', exact: true }).fill('https://changed-server.example');
  await page.getByRole('textbox', { name: 'Device name', exact: true }).fill('changed-device');
  await page.getByRole('button', { name: 'Request enrollment', exact: true }).click();
  const enrollment = (await savedState(page)).enrollment;
  expect(enrollment?.status).toBe('pending');
  expect(enrollment?.id).not.toBe('test-pending-identity');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  expect((await savedState(page)).enrollment?.step).toBe(1);
});

test('removing a selected connection during onboarding cannot create an orphan binding', async ({ page }) => {
  await openApp(page, state => {
    state.enrollment = {
      ...pendingEnrollment('approved'), status: 'approved', step: 4, consent: true,
      connectionId: 'offsite', name: 'offsite', server: 'https://sync.offsite.example',
    };
  });
  await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: 'Details: offsite', exact: true }).click();
  await page.getByRole('button', { name: 'Remove connection', exact: true }).click();
  await page.getByRole('checkbox', { name: /I explicitly accept abandoning/ }).check();
  await page.getByRole('button', { name: 'Confirm removal', exact: true }).click();
  expect((await savedState(page)).connections.some(c => c.id === 'offsite')).toBe(false);
  await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('button', { name: 'Folders', exact: true }).click();
  if ((await savedState(page)).enrollment) {
    await page.getByRole('button', { name: 'Resume enrollment', exact: true }).click();
    const finish = page.getByRole('button', { name: 'Finish without syncing', exact: true });
    if (await finish.isVisible()) await finish.click();
  }
  const state = await savedState(page);
  expect(state.folders.every(f => state.connections.some(c => c.id === f.server))).toBe(true);
  expect(state.folders.some(f => f.path === '/home/alex/Sync/test')).toBe(false);
});

test('disconnecting a conflicted binding removes active conflict records without deleting file copies', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await page.getByRole('button', { name: 'Disconnect folder', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Local files and remote data are preserved');
  await page.getByRole('checkbox', { name: /I explicitly accept abandoning/ }).check();
  await page.getByRole('button', { name: 'Confirm disconnect', exact: true }).click();
  expect((await savedState(page)).conflicts).toEqual([]);
  await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('button', { name: 'Conflicts', exact: true }).click();
  await expect(page.getByText('No unresolved conflicts.', { exact: true })).toBeVisible();
});

test('successful unlock restores focus to meaningful application content', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'Private', exact: true }).click();
  await page.getByRole('button', { name: 'Unlock credentials', exact: true }).click();
  await page.getByRole('button', { name: 'Simulate unlock', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect((await savedState(page)).connections.find(c => c.id === 'locked')?.credential).toBe('os');
  expect(await page.evaluate(() => document.activeElement !== document.body && document.activeElement !== document.documentElement)).toBe(true);
});
