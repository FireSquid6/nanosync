import { test, expect, openApp, pendingEnrollment, savedState } from './fixtures';

test('pending enrollment identity survives reload and cannot advance without approval', async ({ page }) => {
  await openApp(page, state => { state.enrollment = pendingEnrollment(); });
  await page.getByRole('button', { name: 'Resume enrollment', exact: true }).click();
  await expect(page.getByText('TEST–18AB', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Resume enrollment', exact: true }).click();
  await expect(page.getByText('TEST–18AB', { exact: true })).toBeVisible();
  expect((await savedState(page)).enrollment?.id).toBe('test-pending-identity');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  expect((await savedState(page)).enrollment?.step).toBe(1);
});

for (const outcome of ['approved', 'denied', 'expired', 'error'] as const) {
  test(`enrollment handles ${outcome} through the seeded mock adapter`, async ({ page }) => {
    await openApp(page, state => { state.enrollment = pendingEnrollment(outcome); });
    await page.getByRole('button', { name: 'Resume enrollment', exact: true }).click();
    await page.getByRole('button', { name: 'Check approval', exact: true }).click();
    const title = { approved: 'Device approved', denied: 'Enrollment denied', expired: 'Enrollment expired', error: 'Connection interrupted' }[outcome];
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    expect((await savedState(page)).enrollment?.status).toBe(outcome);
    expect((await savedState(page)).enrollment?.id).toBe('test-pending-identity');
    await page.reload();
    expect((await savedState(page)).enrollment?.status).toBe(outcome);
    if (outcome === 'denied' || outcome === 'expired') {
      await page.getByRole('button', { name: 'Resume enrollment', exact: true }).click();
      await page.getByRole('button', { name: 'Request new enrollment', exact: true }).click();
      expect((await savedState(page)).enrollment?.id).not.toBe('test-pending-identity');
      expect((await savedState(page)).enrollment?.status).toBe('pending');
    }
  });
}

test('nonempty folder requires consent, rejects overlapping roots, and waits for explicit start', async ({ page }) => {
  await openApp(page, state => {
    state.enrollment = { ...pendingEnrollment('approved'), status: 'approved', step: 2 };
  });
  await page.getByRole('button', { name: 'Resume enrollment', exact: true }).click();
  const folder = page.getByRole('textbox', { name: 'Local folder', exact: true });
  const connect = page.getByRole('button', { name: 'Connect folder', exact: true });
  await page.getByLabel('Recovery key', { exact: false }).fill('RECOVERY-SECRET-MUST-NOT-PERSIST');
  await connect.click();
  await expect(page.getByRole('alert')).toContainText('Acknowledge reconciliation');
  expect((await savedState(page)).enrollment?.step).toBe(2);
  await page.getByRole('checkbox', { name: /I understand.*reconciled/ }).check();
  for (const path of ['/home/alex/Documents', '/home/alex/Documents/nested', '/home/alex', '/home/alex/Sync/../Documents']) {
    await folder.fill(path);
    await connect.click();
    expect((await savedState(page)).enrollment?.step, path).toBe(2);
  }
  await folder.fill('/home/alex/Sync/new-copy');
  await page.getByLabel('Recovery key', { exact: false }).fill('RECOVERY-SECRET-MUST-NOT-PERSIST');
  await connect.click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connected. Not syncing yet.', exact: true })).toBeVisible();
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  expect(storage).not.toContain('RECOVERY-SECRET-MUST-NOT-PERSIST');
  await page.getByRole('button', { name: 'Finish without syncing', exact: true }).click();
  const newFolder = (await savedState(page)).folders.find(f => f.path === '/home/alex/Sync/new-copy');
  expect(newFolder?.paused).toBe(true);
});
