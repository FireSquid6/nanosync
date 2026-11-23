import { expect, test } from '@playwright/test';

const enrollment = { id: 'pending-1', url: 'https://sync.example.test', alias: 'Home', deviceName: 'Laptop', status: 'pending', verificationCode: '123-456', adminUrl: null, error: null };

test('requests enrollment without retaining secrets; resumes pending and checks approval explicitly', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(e => { (window as any).liveEnrollments = []; (window as any).liveReplies = { enroll: { ok: true, value: e } }; }, enrollment);
  await page.goto('/live.html');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: 'Add connection', exact: true }).click();
  await page.getByLabel('Server URL', { exact: true }).fill(enrollment.url);
  await page.getByLabel('Alias', { exact: true }).fill('Home');
  await page.getByLabel('Device name', { exact: true }).fill('Laptop');
  await page.getByLabel('Password', { exact: true }).fill('secret-test');
  await page.clock.runFor(6000);
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('secret-test');
  await page.getByRole('button', { name: 'Request enrollment', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('123-456');
  await expect(page.getByRole('dialog')).toContainText('Contact your server operator');
  await expect(page.getByRole('button', { name: 'Open administration' })).toHaveCount(0);
  await expect(page.locator('input[type=password]')).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('secret-test');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('button', { name: /Home.*pending/i })).toBeVisible();
  await page.evaluate(e => { (window as any).liveEnrollments = [e]; }, enrollment);
  // The persisted enrollment is supplied by the service on the next mount, never browser storage.
  await page.addInitScript(e => { (window as any).liveEnrollments = [e]; }, enrollment);
  await page.reload();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: /Home.*pending/i }).click();
  await page.evaluate(e => { (window as any).liveReplies = { checkEnrollment: { ok: true, value: { ...e, status: 'denied' } } }; }, enrollment);
  await page.getByRole('button', { name: 'Check approval' }).click();
  await expect(page.getByRole('dialog')).toContainText('denied');
  await page.getByRole('button', { name: 'Request fresh enrollment' }).click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('required', '');
});

const server = '12345678-1234-1234-1234-123456789abc';
const binding = '22345678-1234-1234-1234-123456789abc';
const state = { servers: [{ id: server, name: 'Home', url: 'https://sync.example.test', credentialMode: 'os' }], folders: [] };
const vaults = [{ id: 'cached', name: 'Cached key', needsRecoveryKey: false }, { id: 'locked', name: 'Private', needsRecoveryKey: true }];

test('existing OS server skips enrollment, gates consent, clears recovery secrets, and connects without syncing', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(({ state, vaults }) => {
    Object.assign(window, { liveState: state, liveReplies: { listVaults: { ok: true, value: vaults }, chooseFolder: { ok: true, value: '/home/user/Documents' } }, liveDeferred: ['connectFolder'] });
  }, { state, vaults });
  await page.goto('/live.html');
  await page.getByRole('button', { name: 'Connect folder', exact: true }).click();
  await page.getByRole('combobox', { name: 'Server', exact: true }).selectOption(server);
  await page.getByRole('button', { name: 'Choose vault' }).click();
  await page.getByRole('combobox', { name: 'Vault', exact: true }).selectOption('cached');
  await expect(page.getByLabel('Recovery key', { exact: true })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Vault', exact: true }).selectOption('locked');
  await page.getByLabel('Recovery key', { exact: true }).fill('recovery-secret');
  await page.getByRole('button', { name: 'Choose folder', exact: true }).click();
  await expect(page.getByLabel('Folder path (absolute)')).toHaveValue('/home/user/Documents');
  await expect(page.getByRole('dialog')).toContainText('We have not checked whether this folder is empty.');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  expect(await page.evaluate(() => (window as any).liveCalls.some((c: any) => c.method === 'connectFolder'))).toBe(false);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('input[type=password]')).toHaveCount(0);
  await page.clock.runFor(3000);
  await expect(page.getByLabel('Folder path (absolute)')).toHaveValue('/home/user/Documents');
  await page.evaluate(() => (window as any).liveResolve.connectFolder({ ok: false, error: 'Folder overlaps another connection. ' + 'long-error/'.repeat(90) }));
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Folder overlaps');
  await expect(page.getByLabel('Recovery key', { exact: true })).toHaveValue('');
  for (const width of [960, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  }
  await page.getByLabel('Recovery key', { exact: true }).fill('new-key');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.evaluate(({ server, binding }) => {
    const host = window as any;
    host.liveState.folders = [{ id: binding, serverId: server, serverName: 'Home', vaultId: 'locked', name: 'Documents', path: '/home/user/Documents', status: 'Not checked', owner: null, progress: null, error: null, lastSync: null, sequence: null, conflicts: 0 }];
    host.liveResolve.connectFolder({ ok: true, value: { id: binding } });
  }, { server, binding });
  await expect(page.getByRole('dialog')).toContainText('No files have been transferred.');
  expect(await page.evaluate(() => (window as any).liveCalls.some((c: any) => ['enroll', 'sync', 'migrate'].includes(c.method)))).toBe(false);
  await page.getByRole('button', { name: 'Start syncing', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(await page.evaluate(() => (window as any).liveCalls.filter((c: any) => c.method === 'sync'))).toEqual([{ method: 'sync', params: { id: binding } }]);
  expect(await page.evaluate(() => JSON.stringify({ calls: (window as any).liveCalls, local: { ...localStorage }, session: { ...sessionStorage } }))).not.toMatch(/recovery-secret|new-key/);
});

test('advertised administration uses pending ID only; expiry requires a fresh password and errors remain retryable', async ({ page }) => {
  await page.addInitScript(e => Object.assign(window, { liveEnrollments: [{ ...e, adminUrl: 'https://sync.example.test/admin' }], liveReplies: { checkEnrollment: { ok: true, value: { ...e, status: 'expired' } } } }), enrollment);
  await page.goto('/live.html');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: /Home.*pending/i }).click();
  await page.getByRole('button', { name: 'Open administration' }).click();
  expect(await page.evaluate(() => (window as any).liveCalls.find((c: any) => c.method === 'openAdministration'))).toEqual({ method: 'openAdministration', params: { id: enrollment.id } });
  await page.getByRole('button', { name: 'Check approval' }).click();
  await page.getByRole('button', { name: 'Request fresh enrollment' }).click();
  await page.getByRole('button', { name: 'Request enrollment', exact: true }).click();
  expect(await page.evaluate(() => (window as any).liveCalls.some((c: any) => c.method === 'enroll'))).toBe(false);
  await page.getByLabel('Password', { exact: true }).fill('fresh-secret');
  await page.evaluate(() => { (window as any).liveReplies.enroll = { ok: false, error: 'Server is unavailable.' }; });
  await page.getByRole('button', { name: 'Request enrollment', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Server is unavailable.');
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Alias', { exact: true })).toHaveValue('Home');
  expect(await page.evaluate(() => (window as any).liveCalls.find((c: any) => c.method === 'enroll').params.fresh)).toBe(true);
});

test('keyboard Escape restores the polled trigger and reload reads actual bindings without auto sync', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(({ state, server, binding }) => Object.assign(window, { liveState: { ...state, folders: [{ id: binding, serverId: server, serverName: 'Home', vaultId: 'cached', name: 'Documents', path: '/home/user/Documents', status: 'Not checked', owner: null, progress: null, error: null, lastSync: null, sequence: null, conflicts: 0 }] } }), { state, server, binding });
  await page.goto('/live.html');
  const trigger = page.getByRole('button', { name: 'Connect folder', exact: true });
  await trigger.focus(); await page.keyboard.press('Enter');
  await page.clock.runFor(3000);
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await page.reload();
  await expect(page.getByText('Not checked').first()).toBeVisible();
  expect(await page.evaluate(() => (window as any).liveCalls.some((c: any) => c.method === 'sync'))).toBe(false);
});

test('approval continues to vaults; Done leaves the registered binding unchecked', async ({ page }) => {
  await page.addInitScript(({ e, vaults }) => Object.assign(window, {
    liveEnrollments: [e], liveReplies: { checkEnrollment: { ok: true, value: { ...e, status: 'approved' } }, listVaults: { ok: true, value: vaults } }, liveDeferred: ['connectFolder'],
  }), { e: enrollment, vaults });
  await page.goto('/live.html');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: /Home.*pending/ }).click();
  await page.getByRole('button', { name: 'Check approval' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Connect folder' }).click();
  await page.getByRole('combobox', { name: 'Vault', exact: true }).selectOption('cached');
  await page.getByLabel('Folder path (absolute)').fill('/home/user/Documents');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.evaluate(() => (window as any).liveResolve.connectFolder({ ok: true, value: { id: 'binding' } }));
  await expect(page.getByRole('heading', { name: 'Folder connected' })).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  expect(await page.evaluate(() => (window as any).liveCalls.some((c: any) => c.method === 'sync'))).toBe(false);
});

test('resumed error can re-enter enrollment; per-server card opens vaults directly', async ({ page }) => {
  await page.addInitScript(({ e, state, vaults }) => Object.assign(window, { liveState: state, liveEnrollments: [{ ...e, status: 'error', error: 'Authentication must be retried.' }], liveReplies: { listVaults: { ok: true, value: vaults } } }), { e: enrollment, state, vaults });
  await page.goto('/live.html');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: /Home.*error/ }).click();
  await expect(page.getByRole('dialog')).toContainText('Authentication must be retried.');
  await page.getByRole('button', { name: 'Retry enrollment' }).click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  await page.evaluate(e => { (window as any).liveReplies.enroll = { ok: true, value: e }; }, enrollment);
  await page.getByLabel('Password', { exact: true }).fill('retry-password');
  await page.getByRole('button', { name: 'Request enrollment', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('123-456');
  expect(await page.evaluate(() => (window as any).liveCalls.find((c: any) => c.method === 'enroll').params)).toEqual({ url: enrollment.url, alias: enrollment.alias, deviceName: enrollment.deviceName });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.locator('[data-connect]').filter({ has: page.getByRole('heading', { name: 'Home', exact: true }) }).locator('.path').click();
  await expect(page.getByRole('combobox', { name: 'Vault', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).liveCalls.filter((c: any) => c.method === 'listVaults'))).toEqual([{ method: 'listVaults', params: { id: server } }]);
});
