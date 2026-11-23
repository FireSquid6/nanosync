import { expect, test } from '@playwright/test';
import type { ClientSnapshot } from '../src/shared/rpc.ts';
const server = '12345678-1234-1234-1234-123456789abc';
const first = '22345678-1234-1234-1234-123456789abc';
const second = '32345678-1234-1234-1234-123456789abc';
const snapshot = (): ClientSnapshot => ({
  servers: [{ id: server, name: 'Home <server>', url: 'https://example.test', credentialMode: 'protected-file' }],
  folders: [first, second].map((id, i) => ({ id, name: i ? 'Other folder' : '<img src=x onerror=alert(1)>', serverId: server, serverName: 'Home <server>', vaultId: 'vault', path: '/home/user/' + 'long-folder/'.repeat(30), status: 'Not checked', owner: null, progress: null, error: null, lastSync: null, sequence: null, conflicts: 0 })),
});

test('live starts empty without storage or unsupported actions', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('nanosync', '{"folders":[{"name":"Fake stored folder"}]}'));
  await page.goto('/live.html');
  await expect(page.getByText('No connected folders.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: /pause|settings|open folder/i })).toHaveCount(0);
  await expect(page.getByText(/mock|demo|Fake stored folder/i)).toHaveCount(0);
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(page.getByText('No connections.', { exact: false })).toBeVisible();
});

test('live safely renders real metadata, full card selection, keyboard and explicit sync', async ({ page }) => {
  await page.addInitScript(state => { (window as any).liveState = state; }, snapshot());
  await page.goto('/live.html');
  await expect(page.getByRole('heading', { name: '<img src=x onerror=alert(1)>' })).toBeVisible();
  await expect(page.locator('main img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).liveCalls.every((c: any) => ['snapshot', 'listEnrollments'].includes(c.method)))).toBe(true);
  await page.locator('[data-folder]').filter({ hasText: 'Other folder' }).first().locator('.path').click();
  await expect(page.getByRole('heading', { name: 'Other folder' })).toBeVisible();
  const firstButton = page.getByRole('button', { name: '<img src=x onerror=alert(1)>' });
  await firstButton.focus(); await page.keyboard.press('Enter');
  await expect(firstButton).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Sync now', exact: true }).click();
  await expect(page.getByText('Checking remote state').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sync now' })).toBeDisabled();
  await page.evaluate(() => (window as any).liveCompleteSync());
  await expect(page.getByText('Up to date').first()).toBeVisible();
  expect(await page.evaluate(() => (window as any).liveCalls.filter((c: any) => c.method === 'sync'))).toEqual([{ method: 'sync', params: { id: first } }]);
  for (const width of [1280, 760, 390]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  }
});

test('credential migration needs per-server confirmation, handles failure, and quit is RPC only', async ({ page }) => {
  await page.addInitScript(state => { (window as any).liveState = state; }, snapshot());
  await page.goto('/live.html');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const migrate = page.getByRole('button', { name: 'Migrate credentials to OS store', exact: true });
  await migrate.click();
  await expect(page.getByRole('dialog')).toContainText('Headless CLI use may stop working');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await page.evaluate(() => (window as any).liveCalls.some((c: any) => c.method === 'migrate'))).toBe(false);
  await migrate.click();
  await page.getByRole('button', { name: 'Confirm migration' }).click();
  await expect(page.getByText('Credentials: OS store')).toBeVisible();
  expect(await page.evaluate(() => (window as any).liveCalls.filter((c: any) => c.method === 'migrate'))).toEqual([{ method: 'migrate', params: { id: server } }]);
  await page.evaluate(() => { (window as any).liveFailure = 'Operation failed. Refresh and check the client status.'; });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Operation failed');
  await page.evaluate(() => { (window as any).liveFailure = undefined; });
  await page.getByRole('button', { name: 'Quit nanosync', exact: true }).click();
  expect(await page.evaluate(() => (window as any).liveCalls.at(-1).method)).toBe('quit');
});

test('unfinished OS migration remains available for explicit retry', async ({ page }) => {
  const state = snapshot();
  state.servers[0]!.credentialMode = 'os';
  state.servers[0]!.migrationPending = true;
  await page.addInitScript(state => { (window as any).liveState = state; }, state);
  await page.goto('/live.html');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: 'Migrate credentials to OS store', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm migration' }).click();
  await expect(page.getByRole('button', { name: 'Migrate credentials to OS store', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).liveCalls.filter((c: any) => c.method === 'migrate'))).toEqual([{ method: 'migrate', params: { id: server } }]);
});

test('poll refreshes external CLI progress and pushed state updates without restarting sync', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(state => { (window as any).liveState = state; }, snapshot());
  await page.goto('/live.html');
  await expect(page.getByRole('button', { name: 'Sync now' })).toBeEnabled();
  await page.evaluate(() => {
    const folder = (window as any).liveState.folders[0];
    folder.owner = 'CLI'; folder.status = 'Syncing'; folder.progress = 'CLI transfer in progress';
  });
  await page.clock.runFor(3000);
  await expect(page.getByText('CLI transfer in progress').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sync now' })).toBeDisabled();
  await page.evaluate(() => {
    const state = (window as any).liveState;
    state.folders[0].status = 'Failed'; state.folders[0].error = '<server failure>'; state.folders[0].progress = null;
    (window as any).livePush(state);
  });
  await expect(page.getByText('<server failure>').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sync now' })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).liveCalls.some((c: any) => c.method === 'sync'))).toBe(false);
});
