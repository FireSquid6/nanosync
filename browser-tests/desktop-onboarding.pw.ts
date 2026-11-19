import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { DesktopCommand, DesktopReply, DesktopSnapshot } from '../apps/desktop/src/rpc';

let http: ReturnType<typeof Bun.serve>, url: string;
test.beforeAll(async () => {
  const built = await Bun.build({
    entrypoints: ['apps/desktop/tests/presentation.tsx'],
    target: 'browser',
    naming: 'index.[ext]',
  });
  if (!built.success) throw new AggregateError(built.logs, 'Desktop presentation bundle failed');
  const assets = new Map(
    built.outputs.map((output) => ['/' + output.path.split('/').pop()!, output]),
  );
  http = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/')
        return new Response(
          '<!doctype html><html lang="en"><head><title>Nanosync presentation test</title><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/index.css"></head><body><div id="root"></div><script type="module" src="/index.js"></script></body></html>',
          { headers: { 'content-type': 'text/html' } },
        );
      const asset = assets.get(path);
      return asset ? new Response(asset) : new Response(null, { status: 404 });
    },
  });
  url = http.url.href;
});
test.afterAll(() => http?.stop(true));
const serverId = '11111111-1111-4111-8111-111111111111',
  vaultId = '22222222-2222-4222-8222-222222222222',
  deviceId = '33333333-3333-4333-8333-333333333333',
  binding = '44444444-4444-4444-8444-444444444444';
function initial(): DesktopSnapshot {
  return {
    removal: null,
    clientRoot: '/temporary/test-client',
    credentials: {
      mode: 'os-store',
      decisionRequired: false,
      migrationPending: false,
      cleanupPending: false,
      phase: null,
      canRollback: false,
    },
    settings: {
      version: 2,
      revision: 0,
      globalPaused: false,
      bindingPaused: {},
      continuousRequested: {},
      lifecycle: { startAtLogin: false, trayEnabled: null, keepSyncingAfterClose: true },
    },
    nativeEffects: {
      startup: 'not-installed',
      tray: 'not-installed',
      backgroundPolicy: 'not-applied',
    },
    connections: [],
    pending: [],
    status: { settingsRevision: 0, globalPaused: false, observedAt: 0, bindings: [] },
    administration: [],
    runtimeErrors: {},
  };
}
for (const start of [false, true])
  test(`five-step keyboard-capable setup ${start ? 'requests explicit continuous Start' : 'connects without any Start'}; light/dark accessible`, async ({
    page,
  }) => {
    const state = initial(),
      commands: DesktopCommand[] = [];
    let checks = 0;
    await page.exposeBinding(
      'desktopPresentation',
      async (_source, command: DesktopCommand): Promise<DesktopReply> => {
        commands.push(structuredClone(command));
        const reply = { ok: true as const, snapshot: state };
        switch (command.type) {
          case 'enroll':
            if (++checks === 1)
              state.pending = [
                {
                  alias: 'test',
                  url: 'https://example.test',
                  deviceId,
                  deviceName: 'test-device',
                  expiresAtMs: 9999999999999,
                  status: 'pending',
                  verificationCode: '123 456',
                },
              ];
            else {
              state.pending = [];
              state.connections = [
                {
                  serverId,
                  deviceId,
                  alias: 'test',
                  url: 'https://example.test',
                  status: 'approved',
                },
              ];
            }
            return {
              ...reply,
              enrollment:
                checks === 1
                  ? {
                      status: 'pending',
                      alias: 'test',
                      url: 'https://example.test',
                      deviceId,
                      deviceName: 'test-device',
                    }
                  : state.connections[0]!,
            };
          case 'vaults':
            return { ...reply, vaults: [{ vaultId, name: 'test-vault' }] };
          case 'key-status':
            return { ...reply, key: { keyRequired: true, credentialWritePending: false } };
          case 'unlock':
            return { ...reply, key: { keyRequired: false, credentialWritePending: false } };
          case 'pick-folder':
            return {
              ...reply,
              folder: { selection: binding, path: '/temporary/nonempty-folder', nonempty: true },
            };
          case 'settings':
            state.settings.lifecycle = command.lifecycle;
            state.settings.revision++;
            return reply;
          case 'connect':
            return { ...reply, binding };
          case 'start':
            return { ...reply, started: true };
          default:
            return reply;
        }
      },
    );
    await page.setViewportSize({ width: 960, height: 1000 });
    await page.goto(url);
    await page.getByLabel('Server URL', { exact: true }).fill('https://example.test');
    await page.getByLabel('Connection alias').fill('test');
    await page.getByLabel('Device name', { exact: true }).fill('test-device');
    await page.getByLabel('Owner password', { exact: true }).fill('password-sentinel');
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.getByRole('button', { name: 'Enroll device', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Verify device', exact: true })).toBeFocused();
    await expect(page.getByText('123 456', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Open advertised administration page' }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.getByLabel('Owner password', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: 'test — pending', exact: true }).click();
    await page.getByRole('button', { name: 'Check approval / resume', exact: true }).click();
    await page.getByRole('button', { name: 'Choose vault and folder', exact: true }).click();
    await page.getByLabel('Remote vault', { exact: true }).selectOption(vaultId);
    await page.getByLabel('Vault recovery key', { exact: true }).fill('recovery-sentinel');
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.getByRole('button', { name: 'Unlock vault', exact: true }).click();
    await expect(page.getByLabel('Vault recovery key', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Choose existing local folder…', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Background choices', exact: true }),
    ).toBeDisabled();
    await page
      .getByLabel(
        'I understand this folder already contains files and they will participate in synchronization.',
      )
      .check();
    await page.getByRole('button', { name: 'Background choices', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Save choices and review', exact: true }),
    ).toBeDisabled();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.getByRole('radio', { name: 'No', exact: true }).check();
    await expect(page.getByText(/Saved intent is separate from native availability/)).toBeVisible();
    await page.getByRole('button', { name: 'Save choices and review', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Ready to sync', exact: true })).toBeFocused();
    expect(
      commands.filter((command) => command.type === 'connect' || command.type === 'start'),
    ).toEqual([]);
    for (const theme of ['light', 'dark']) {
      await page.getByLabel('Theme', { exact: true }).selectOption(theme);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    await page
      .getByRole('button', {
        name: start ? 'Start syncing' : 'Finish without syncing',
        exact: true,
      })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Folders', exact: true }),
    ).toBeVisible();
    expect(commands.filter((command) => command.type === 'connect')).toHaveLength(1);
    expect(commands.filter((command) => command.type === 'start')).toHaveLength(start ? 1 : 0);
  });
test('failed secret submissions clear fields and a locked vault never prompts for recovery', async ({
  page,
}) => {
  const state = initial();
  state.connections = [
    { serverId, deviceId, alias: 'test', url: 'https://example.test', status: 'approved' },
  ];
  await page.exposeBinding(
    'desktopPresentation',
    async (_source, command: DesktopCommand): Promise<DesktopReply> => {
      if (command.type === 'enroll')
        return {
          ok: false,
          code: 'REQUEST_TIMEOUT',
          message: 'Request timed out; pending state is preserved.',
        };
      if (command.type === 'vaults')
        return { ok: true, snapshot: state, vaults: [{ vaultId, name: 'test-vault' }] };
      if (command.type === 'key-status')
        return {
          ok: false,
          code: 'CREDENTIALS_UNAVAILABLE',
          message: 'Unlock your credential store, then retry.',
        };
      return { ok: true, snapshot: state };
    },
  );
  await page.goto(url);
  await page.getByLabel('Server URL', { exact: true }).fill('https://another.test');
  await page.getByLabel('Connection alias').fill('another');
  await page.getByLabel('Device name', { exact: true }).fill('device');
  await page.getByLabel('Owner password', { exact: true }).fill('password-sentinel');
  await page.getByRole('button', { name: 'Enroll device', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Request timed out');
  await expect(page.getByLabel('Owner password', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'test — https://example.test', exact: true }).click();
  await page.getByLabel('Remote vault', { exact: true }).selectOption(vaultId);
  await expect(page.getByRole('alert')).toContainText('Unlock your credential store');
  await expect(page.getByLabel('Vault recovery key', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry vault key check' })).toBeVisible();
});
test('a superseded enrollment reply cannot clear a newly typed password; busy drafts are disabled and cancellation stays enabled', async ({
  page,
}) => {
  const state = initial(),
    received = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  await page.exposeBinding(
    'desktopPresentation',
    async (_source, command: DesktopCommand): Promise<DesktopReply> => {
      if (command.type === 'enroll') {
        received.resolve();
        await release.promise;
        return { ok: false, code: 'INTERRUPTED', message: 'Cancelled' };
      }
      return { ok: true, snapshot: state };
    },
  );
  try {
    await page.goto(url);
    await page.evaluate(() => {
      const host = window as unknown as {
        desktopPresentation(command: DesktopCommand): Promise<DesktopReply>;
        enrollmentReply?: Promise<DesktopReply>;
      };
      const original = host.desktopPresentation;
      host.desktopPresentation = (command) => {
        const response = original(command);
        if (command.type === 'enroll') host.enrollmentReply = response;
        return response;
      };
    });
    await page.getByLabel('Server URL', { exact: true }).fill('https://example.test');
    await page.getByLabel('Connection alias').fill('test');
    await page.getByLabel('Device name', { exact: true }).fill('test-device');
    await page.getByLabel('Owner password', { exact: true }).fill('old-secret');
    await page.getByRole('button', { name: 'Enroll device', exact: true }).click();
    await received.promise;
    for (const label of ['Server URL', 'Connection alias', 'Device name', 'Owner password'])
      await expect(page.getByLabel(label, { exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Cancel active enrollment' })).toBeEnabled();
    await page.getByRole('button', { name: 'Cancel active enrollment' }).click();
    await expect(page.getByLabel('Owner password', { exact: true })).toBeEnabled();
    await page.getByLabel('Owner password', { exact: true }).fill('new-secret');
    release.resolve();
    // Both request() and this check await the same promise, in registration order.
    await page.evaluate(async () => {
      await (window as unknown as { enrollmentReply: Promise<DesktopReply> }).enrollmentReply;
    });
    await expect(page.getByLabel('Owner password', { exact: true })).toHaveValue('new-secret');
    await expect(page.getByRole('heading', { name: 'Server', exact: true })).toBeVisible();
  } finally {
    release.resolve();
  }
});
for (const scenario of [
  { raw: 'https://example.test/', canonical: 'https://example.test', approved: false },
  { raw: 'localhost:8123', canonical: 'http://localhost:8123', approved: false },
  { raw: 'https://existing.test/', canonical: 'https://existing.test', approved: true },
])
  test(`enrollment adopts authoritative identity for ${scenario.raw}${scenario.approved ? ' with an existing different alias' : ' and advertised administration'}`, async ({
    page,
  }) => {
    const state = initial(),
      commands: DesktopCommand[] = [];
    if (scenario.approved)
      state.connections = [
        { serverId, deviceId, alias: 'actual-alias', url: scenario.canonical, status: 'approved' },
      ];
    await page.exposeBinding(
      'desktopPresentation',
      async (_source, command: DesktopCommand): Promise<DesktopReply> => {
        commands.push(structuredClone(command));
        if (command.type === 'enroll') {
          if (scenario.approved)
            return { ok: true, snapshot: state, enrollment: state.connections[0]! };
          state.pending = [
            {
              alias: 'entered-alias',
              url: scenario.canonical,
              deviceId,
              deviceName: 'device',
              expiresAtMs: 9999999999999,
              status: 'pending',
              verificationCode: '123 456',
            },
          ];
          state.administration = [scenario.canonical];
          return {
            ok: true,
            snapshot: state,
            enrollment: {
              status: 'pending',
              alias: 'entered-alias',
              url: scenario.canonical,
              deviceId,
              deviceName: 'device',
            },
          };
        }
        return { ok: true, snapshot: state };
      },
    );
    await page.goto(url);
    await page.getByLabel('Server URL', { exact: true }).fill(scenario.raw);
    await page.getByLabel('Connection alias').fill('entered-alias');
    await page.getByLabel('Device name', { exact: true }).fill('device');
    await page.getByRole('button', { name: 'Enroll device', exact: true }).click();
    if (scenario.approved) {
      await expect(page.getByText('Device approved.', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Choose vault and folder' })).toBeEnabled();
      await expect(page.getByRole('button', { name: 'Check approval / resume' })).toHaveCount(0);
      expect(commands.filter((command) => command.type === 'enroll')).toHaveLength(1);
      expect(
        commands.some((command) => ['unlock', 'connect', 'start'].includes(command.type)),
      ).toBe(false);
    } else {
      await page.getByRole('button', { name: 'Open advertised administration page' }).click();
      expect(commands.find((command) => command.type === 'administration')).toEqual({
        type: 'administration',
        urlIdentity: scenario.canonical,
      });
    }
  });
test('background draft captures metadata revision, refreshes explicitly after conflict, locks during save and reviews saved values', async ({
  page,
}) => {
  const state = initial(),
    saved = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  state.connections = [
    { serverId, deviceId, alias: 'test', url: 'https://example.test', status: 'approved' },
  ];
  const writes: Extract<DesktopCommand, { type: 'settings' }>[] = [];
  await page.exposeBinding(
    'desktopPresentation',
    async (_source, command: DesktopCommand): Promise<DesktopReply> => {
      const reply = { ok: true as const, snapshot: state };
      if (command.type === 'vaults') return { ...reply, vaults: [{ vaultId, name: 'test-vault' }] };
      if (command.type === 'key-status')
        return { ...reply, key: { keyRequired: false, credentialWritePending: false } };
      if (command.type === 'pick-folder') {
        state.settings.revision = 1;
        state.settings.lifecycle = {
          startAtLogin: true,
          trayEnabled: false,
          keepSyncingAfterClose: false,
        };
        return {
          ...reply,
          folder: { selection: binding, path: '/temporary/empty-folder', nonempty: false },
        };
      }
      if (command.type === 'settings') {
        writes.push(structuredClone(command));
        if (writes.length === 1) {
          state.settings.revision = 2;
          state.settings.lifecycle = {
            startAtLogin: false,
            trayEnabled: true,
            keepSyncingAfterClose: true,
          };
          return {
            ok: false,
            code: 'CONFLICT',
            message: 'Settings changed; refresh and choose again.',
          };
        }
        saved.resolve();
        await release.promise;
        state.settings.revision = 3;
        state.settings.lifecycle = {
          startAtLogin: false,
          trayEnabled: false,
          keepSyncingAfterClose: false,
        };
      }
      return reply;
    },
  );
  try {
    await page.goto(url);
    await page.getByRole('button', { name: 'test — https://example.test', exact: true }).click();
    await page.getByLabel('Remote vault', { exact: true }).selectOption(vaultId);
    await page.getByRole('button', { name: 'Choose existing local folder…' }).click();
    await page.getByRole('button', { name: 'Background choices', exact: true }).click();
    const login = page.getByLabel('Start at user login (not before login)', { exact: true });
    const keep = page.getByLabel('Keep syncing after closing the window', { exact: true });
    await expect(login).toBeChecked();
    await expect(keep).not.toBeChecked();
    await page.getByRole('button', { name: 'Save choices and review' }).click();
    await expect(page.getByRole('alert')).toContainText('Settings changed');
    expect(writes[0]).toMatchObject({
      expectedRevision: 1,
      lifecycle: { startAtLogin: true, trayEnabled: false, keepSyncingAfterClose: false },
    });
    await page.getByRole('button', { name: 'Refresh client state' }).click();
    await expect(login).not.toBeChecked();
    await expect(keep).toBeChecked();
    await expect(page.getByRole('radio', { name: 'Yes', exact: true })).toBeChecked();
    await login.check();
    await page.getByRole('button', { name: 'Save choices and review' }).click();
    await saved.promise;
    await expect(login).toBeDisabled();
    await expect(keep).toBeDisabled();
    await expect(page.getByRole('radio', { name: 'No', exact: true })).toBeDisabled();
    expect(writes[1]).toMatchObject({
      expectedRevision: 2,
      lifecycle: { startAtLogin: true, trayEnabled: true, keepSyncingAfterClose: true },
    });
    release.resolve();
    await expect(page.getByRole('heading', { name: 'Ready to sync' })).toBeVisible();
    await expect(
      page.getByText(
        'Login: off; tray: off; background after close: off. Native effects have not been observed.',
        { exact: true },
      ),
    ).toBeVisible();
  } finally {
    release.resolve();
  }
});
test('retry consent is identity- and operation-specific and consumed by each attempt', async ({
  page,
}) => {
  const state = initial(),
    commands: DesktopCommand[] = [];
  const secondVault = '55555555-5555-4555-8555-555555555555';
  await page.exposeBinding(
    'desktopPresentation',
    async (_source, command: DesktopCommand): Promise<DesktopReply> => {
      commands.push(structuredClone(command));
      const reply = { ok: true as const, snapshot: state };
      if (command.type === 'enroll') {
        state.connections = [
          { serverId, deviceId, alias: 'test', url: 'https://example.test', status: 'approved' },
        ];
        return { ...reply, enrollment: state.connections[0]! };
      }
      if (command.type === 'vaults')
        return {
          ...reply,
          vaults: [
            { vaultId, name: 'first' },
            { vaultId: secondVault, name: 'second' },
          ],
        };
      if (command.type === 'key-status')
        return { ...reply, key: { keyRequired: false, credentialWritePending: true } };
      if (command.type === 'unlock')
        return {
          ok: false,
          code: 'CREDENTIALS_UNAVAILABLE',
          message: 'Unlock your credential store and retry.',
        };
      return reply;
    },
  );
  await page.goto(url);
  await page.getByLabel('Server URL', { exact: true }).fill('https://example.test');
  await page.getByLabel('Connection alias').fill('test');
  await page.getByLabel('Device name', { exact: true }).fill('device');
  const enrollmentConsent = page.getByLabel(
    'Explicitly retry an interrupted initial credential write',
    { exact: true },
  );
  await enrollmentConsent.check();
  await page.getByLabel('Device name', { exact: true }).fill('other-device');
  await expect(enrollmentConsent).not.toBeChecked();
  await enrollmentConsent.check();
  await page.getByRole('button', { name: 'Enroll device', exact: true }).click();
  expect(commands.find((command) => command.type === 'enroll')).toMatchObject({
    retryCredentialWrite: true,
  });
  await page.getByRole('button', { name: 'Choose vault and folder' }).click();
  await page.getByLabel('Remote vault', { exact: true }).selectOption(vaultId);
  const keyConsent = page.getByLabel('Retry the interrupted credential write', { exact: true });
  await expect(keyConsent).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Unlock vault', exact: true })).toBeDisabled();
  await keyConsent.check();
  await page.getByLabel('Vault recovery key', { exact: true }).fill('temporary-key');
  await page.getByRole('button', { name: 'Unlock vault', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Unlock your credential store');
  expect(commands.find((command) => command.type === 'unlock')).toMatchObject({
    retryCredentialWrite: true,
  });
  await expect(keyConsent).not.toBeChecked();
  await expect(page.getByLabel('Vault recovery key', { exact: true })).toHaveValue('');
  await keyConsent.check();
  await page.getByLabel('Remote vault', { exact: true }).selectOption(secondVault);
  await expect(keyConsent).not.toBeChecked();
});
test('cancelled migration confirmation cannot authorize a later fresh enrollment', async ({
  page,
}) => {
  const state = initial(),
    commands: DesktopCommand[] = [];
  state.credentials = { ...state.credentials, mode: 'protected-file', decisionRequired: true };
  await page.exposeBinding(
    'desktopPresentation',
    async (_source, command: DesktopCommand): Promise<DesktopReply> => {
      commands.push(command);
      return { ok: true, snapshot: state };
    },
  );
  await page.goto(url);
  await page.getByRole('button', { name: 'Migrate entire root to OS store…' }).click();
  await page
    .getByLabel('I understand and authorize this whole-root operation', { exact: true })
    .check();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  state.credentials = { ...state.credentials, mode: 'os-store', decisionRequired: false };
  state.pending = [
    {
      alias: 'denied',
      url: 'https://example.test',
      deviceId,
      deviceName: 'device',
      expiresAtMs: 9999999999999,
      status: 'denied',
      verificationCode: '123 456',
    },
  ];
  await page.getByRole('button', { name: 'Refresh credential state' }).click();
  await page.getByRole('button', { name: 'denied — denied', exact: true }).click();
  await expect(
    page.getByLabel('Replace the denied or expired request', { exact: true }),
  ).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Start fresh enrollment' })).toBeDisabled();
  expect(commands.every((command) => command.type === 'snapshot')).toBe(true);
});
test('file migration cancellation is non-mutating and rollback is unavailable after cleanup', async ({
  page,
}) => {
  const state = initial(),
    commands: DesktopCommand[] = [];
  state.credentials = { ...state.credentials, mode: 'protected-file', decisionRequired: true };
  await page.exposeBinding(
    'desktopPresentation',
    async (_source, command: DesktopCommand): Promise<DesktopReply> => {
      commands.push(command);
      return { ok: true, snapshot: state };
    },
  );
  await page.goto(url);
  await page.getByRole('button', { name: 'Migrate entire root to OS store…' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(commands.every((command) => command.type === 'snapshot')).toBe(true);
  state.credentials = {
    ...state.credentials,
    migrationPending: true,
    phase: 'cleanup',
    canRollback: false,
  };
  await page.getByRole('button', { name: 'Refresh credential state', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume migration…' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Roll back staged migration…' })).toHaveCount(0);
});
