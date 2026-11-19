import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { DesktopCommand, DesktopReply, DesktopSnapshot } from '../apps/desktop/src/rpc';
let http: ReturnType<typeof Bun.serve>, url: string;
test.beforeAll(async () => {
  const result = await Bun.build({
    entrypoints: ['apps/desktop/tests/presentation.tsx'],
    target: 'browser',
    naming: 'index.[ext]',
  });
  if (!result.success) throw new AggregateError(result.logs);
  const assets = new Map(
    result.outputs.map((asset) => ['/' + asset.path.split('/').pop()!, asset]),
  );
  http = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/')
        return new Response(
          '<!doctype html><html lang="en"><head><title>Folders presentation test</title><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/index.css"></head><body><div id="root"></div><script type="module" src="/index.js"></script></body></html>',
          { headers: { 'content-type': 'text/html' } },
        );
      const asset = assets.get(path);
      return asset ? new Response(asset) : new Response(null, { status: 404 });
    },
  });
  url = http.url.href;
});
test.afterAll(() => http?.stop(true));
const firstId = '11111111-1111-4111-8111-111111111111',
  secondId = '22222222-2222-4222-8222-222222222222',
  serverId = '33333333-3333-4333-8333-333333333333',
  vaultId = '44444444-4444-4444-8444-444444444444',
  deviceId = '55555555-5555-4555-8555-555555555555';
function state(): DesktopSnapshot {
  const binding = {
    version: 1 as const,
    connectionId: firstId,
    root: '/temporary/documents',
    serverId,
    vaultId,
    deviceId,
    owner: { origin: 'desktop' as const, instanceId: deviceId },
    ownerPresent: true,
    pause: { global: false, binding: false, effective: false },
    phase: 'idle' as const,
    freshness: 'observed' as const,
    enginePhase: null,
    progressUnit: 'completed-ciphertext-frames' as const,
    progress: { upload: { count: 2, bytes: 144 }, download: { count: 3, bytes: 240 } },
    facts: {
      heads: {
        observed: { revisionId: deviceId, sequence: 7 },
        accepted: { revisionId: deviceId, sequence: 7 },
        applied: { revisionId: deviceId, sequence: 7 },
      },
      pending: {
        operations: 0,
        transfers: 0,
        applies: 0,
        hydration: 0,
        proposal: 0,
        restore: 0,
        reconciliation: 0,
      },
      conflicts: 0,
      rootIdentity: { device: '1', inode: '2' },
    },
    upToDate: true,
    lastRemoteCheck: 100000,
    lastSuccessfulSync: 90000,
    observationTime: 100000,
    attentionRequired: false,
    statusIssues: [],
    error: null,
  };
  return {
    clientRoot: '/temporary/client',
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
      bindingPaused: { [secondId]: true },
      continuousRequested: { [firstId]: 'desktop', [secondId]: 'cli' },
      lifecycle: { startAtLogin: false, trayEnabled: false, keepSyncingAfterClose: true },
    },
    connections: [
      { serverId, deviceId, alias: 'home', url: 'https://example.test', status: 'approved' },
    ],
    pending: [],
    nativeEffects: {
      startup: 'not-installed',
      tray: 'not-installed',
      backgroundPolicy: 'not-applied',
    },
    administration: [],
    runtimeErrors: {},
    status: {
      settingsRevision: 0,
      globalPaused: false,
      observedAt: 100000,
      bindings: [
        binding,
        {
          ...binding,
          connectionId: secondId,
          root: '/temporary/documents-copy',
          owner: { origin: 'cli', instanceId: secondId },
          pause: { global: false, binding: true, effective: true },
          phase: 'paused',
          upToDate: false,
          facts: { ...binding.facts, conflicts: 2 },
          attentionRequired: true,
          error: 'FORBIDDEN',
        },
      ],
    },
  };
}
function pause(snapshot: DesktopSnapshot, command: DesktopCommand): DesktopReply {
  if (command.type !== 'pause-all' && command.type !== 'pause-folder')
    return { ok: true, snapshot };
  if (command.expectedRevision !== snapshot.settings.revision)
    return { ok: false, code: 'CONFLICT', message: 'Settings changed. Refresh before retrying.' };
  snapshot.settings.revision++;
  if (command.type === 'pause-all') snapshot.settings.globalPaused = command.paused;
  else snapshot.settings.bindingPaused[command.binding] = command.paused;
  for (const binding of snapshot.status!.bindings) {
    binding.pause = {
      global: snapshot.settings.globalPaused,
      binding: snapshot.settings.bindingPaused[binding.connectionId] ?? false,
      effective:
        snapshot.settings.globalPaused ||
        (snapshot.settings.bindingPaused[binding.connectionId] ?? false),
    };
    if (binding.pause.effective) {
      binding.phase = 'paused';
      binding.upToDate = false;
    }
  }
  return { ok: true, snapshot };
}
test('folders start directly with real copy identities, orthogonal conflicts, independent pauses, keyboard and themes', async ({
  page,
}) => {
  const snapshot = state(),
    commands: DesktopCommand[] = [];
  await page.exposeBinding('desktopPresentation', async (_source, command: DesktopCommand) => {
    commands.push(structuredClone(command));
    return pause(snapshot, command);
  });
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Folders', exact: true })).toBeVisible();
  await expect(page.locator('.folder-row')).toHaveCount(2);
  await expect(page.locator('.folder-row').first()).toContainText('Up to date (observed)');
  expect(commands.some((command) => ['start', 'sync-now', 'enroll'].includes(command.type))).toBe(
    false,
  );
  const copy = page.locator('.folder-row').filter({ hasText: '/temporary/documents-copy' });
  await copy.focus();
  await page.keyboard.press('Enter');
  const inspector = page.locator('.folder-inspector');
  await expect(inspector).toContainText(secondId);
  await expect(inspector).toContainText(vaultId);
  await expect(inspector).toContainText('Independent CLI owner');
  await expect(inspector).toContainText('Paused');
  await expect(inspector).toContainText('2 unresolved conflict(s)');
  await expect(inspector).toContainText('FORBIDDEN');
  await expect(inspector).toContainText('Current owner counters');
  await expect(inspector).toContainText('Totals unknown');
  await page.getByRole('button', { name: 'Pause all', exact: true }).click();
  await page.getByRole('button', { name: 'Resume all', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume folder', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pause all', exact: true }).click();
  await page.getByRole('button', { name: 'Resume folder', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Global pause remains active');
  await expect(inspector).toContainText('Global: on; folder: off');
  await expect(inspector).toContainText('2 unresolved conflict(s)');
  await page.getByRole('button', { name: 'Sync now', exact: true }).click();
  await page.getByRole('button', { name: 'Open local folder', exact: true }).click();
  expect(commands.find((command) => command.type === 'sync-now')).toEqual({
    type: 'sync-now',
    binding: secondId,
  });
  expect(commands.find((command) => command.type === 'open-folder')).toEqual({
    type: 'open-folder',
    binding: secondId,
  });
  expect(commands.some((command) => command.type === 'start')).toBe(false);
  for (const width of [1280, 960, 700]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ['light', 'dark']) {
      await page.getByLabel('Theme', { exact: true }).selectOption(theme);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
  }
});
test('locked and missing folders retain metadata, unknown progress, error recovery and explicit retry; protected mode blocks transfers only', async ({
  page,
}) => {
  const snapshot = state(),
    commands: DesktopCommand[] = [];
  const locked = snapshot.status!.bindings[0]!;
  locked.phase = 'credentials-locked';
  locked.error = 'CREDENTIALS_UNAVAILABLE';
  locked.upToDate = false;
  locked.progress = null;
  locked.facts = null;
  const missing = snapshot.status!.bindings[1]!;
  missing.phase = 'folder-unavailable';
  missing.error = 'FOLDER_UNAVAILABLE';
  missing.owner = null;
  missing.ownerPresent = false;
  missing.freshness = 'stale-or-unknown';
  await page.exposeBinding(
    'desktopPresentation',
    async (_source, command: DesktopCommand): Promise<DesktopReply> => {
      commands.push(command);
      if (command.type === 'sync-now')
        return {
          ok: false,
          code: 'CREDENTIALS_UNAVAILABLE',
          message: 'Unlock the credential store, then retry.',
        };
      return pause(snapshot, command);
    },
  );
  await page.goto(url);
  await expect(page.locator('.folder-inspector')).toContainText('Unlock the credential store');
  await expect(page.locator('.folder-inspector')).toContainText('Transfer counters not observed');
  await expect(page.locator('.folder-inspector')).toContainText('Conflict observation unavailable');
  await page.getByRole('button', { name: 'Sync now', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Unlock the credential store');
  await page.locator('.folder-row').filter({ hasText: '/temporary/documents-copy' }).click();
  await expect(page.locator('.folder-inspector')).toContainText('will not be recreated');
  expect(commands.filter((command) => command.type === 'sync-now')).toHaveLength(1);
  expect(commands.some((command) => command.type === 'unlock')).toBe(false);
  snapshot.credentials = {
    ...snapshot.credentials,
    mode: 'protected-file',
    decisionRequired: true,
  };
  await page.getByRole('button', { name: 'Refresh observed status' }).click();
  await expect(page.getByRole('button', { name: 'Sync now', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Open local folder' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Pause all', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Review credential decision' })).toBeVisible();
});
test('unavailable live ownership and never-started copies stay distinct and requests never imply takeover', async ({
  page,
}) => {
  const snapshot = state(),
    commands: DesktopCommand[] = [];
  snapshot.settings.continuousRequested = {};
  const unavailable = snapshot.status!.bindings[0]!;
  unavailable.owner = null;
  unavailable.ownerPresent = true;
  unavailable.phase = 'failed';
  unavailable.freshness = 'stale-or-unknown';
  unavailable.upToDate = false;
  unavailable.error = 'OWNER_UNAVAILABLE';
  unavailable.statusIssues = [
    {
      code: 'OWNER_UNAVAILABLE',
      message: 'The sync owner cannot be safely inspected.',
      retryable: false,
      recoveryAction: 'Stop the owner and retry with a compatible client; do not bypass its lock.',
    },
  ];
  const never = snapshot.status!.bindings[1]!;
  never.owner = null;
  never.ownerPresent = false;
  never.phase = 'not-started';
  never.freshness = 'stale-or-unknown';
  never.facts = null;
  never.progress = null;
  never.lastSuccessfulSync = null;
  never.lastRemoteCheck = null;
  never.observationTime = null;
  never.error = null;
  never.attentionRequired = false;
  never.pause = { global: false, binding: false, effective: false };
  snapshot.settings.bindingPaused[secondId] = false;
  await page.exposeBinding(
    'desktopPresentation',
    async (_source, command: DesktopCommand): Promise<DesktopReply> => {
      commands.push(command);
      return command.type === 'sync-now'
        ? {
            ok: false,
            code: 'OWNER_UNAVAILABLE',
            message: 'Owner unavailable. Stop it explicitly and retry; its lock was not bypassed.',
          }
        : { ok: true, snapshot };
    },
  );
  await page.goto(url);
  await expect(page.locator('.folder-inspector')).toContainText('Live owner unavailable');
  await page.getByRole('button', { name: 'Sync now', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('lock was not bypassed');
  await page.locator('.folder-row').filter({ hasText: '/temporary/documents-copy' }).click();
  await expect(page.locator('.folder-inspector')).toContainText('Not started');
  await expect(page.locator('.folder-inspector')).toContainText('Transfer counters not observed');
  expect(
    commands.every((command) => command.type === 'snapshot' || command.type === 'sync-now'),
  ).toBe(true);
  expect(commands.filter((command) => command.type === 'sync-now')).toHaveLength(1);
});
test('failed polling demotes cached verified observations and owner counters until a successful refresh', async ({
  page,
}) => {
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
  const snapshot = state();
  let fail = false;
  await page.exposeBinding('desktopPresentation', async (): Promise<DesktopReply> => {
    if (fail) throw Error('synthetic transport failure');
    return { ok: true, snapshot };
  });
  await page.goto(url);
  await expect(page.locator('.folder-row').first()).toContainText('Up to date (observed)');
  fail = true;
  await page.clock.runFor(1500);
  await expect(page.getByRole('alert')).toContainText('Previous data is historical');
  await expect(page.locator('.folder-row').first()).not.toContainText('Up to date');
  await expect(page.locator('.healthy-marker')).toHaveCount(0);
  await expect(page.locator('.folder-row').first()).toContainText('stale or unknown');
  await expect(page.locator('.folder-inspector')).toContainText('Historical owner counters');
  await expect(page.locator('.folder-inspector')).toContainText('Last observed: Desktop owner');
  fail = false;
  await page.clock.runFor(1500);
  await expect(page.locator('.folder-row').first()).toContainText('Up to date (observed)');
  await expect(page.getByRole('alert')).toHaveCount(0);
});
test('a deferred pre-mutation poll cannot overwrite saved pause intent', async ({ page }) => {
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
  const snapshot = state(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let reads = 0;
  await page.exposeBinding(
    'desktopPresentation',
    async (_source, command: DesktopCommand): Promise<DesktopReply> => {
      if (command.type === 'snapshot' && ++reads === 2) {
        const old = structuredClone(snapshot);
        entered.resolve();
        await release.promise;
        return { ok: true, snapshot: old };
      }
      return pause(snapshot, command);
    },
  );
  try {
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'Folders', exact: true })).toBeVisible();
    await page.evaluate(() => {
      const host = window as unknown as {
        desktopPresentation(command: DesktopCommand): Promise<DesktopReply>;
        pollReply?: Promise<DesktopReply>;
      };
      const original = host.desktopPresentation;
      host.desktopPresentation = (command) => {
        const result = original(command);
        if (command.type === 'snapshot') host.pollReply = result;
        return result;
      };
    });
    await page.clock.runFor(1500);
    await entered.promise;
    await page.getByRole('button', { name: 'Pause all', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Resume all', exact: true })).toBeVisible();
    release.resolve();
    await page.evaluate(async () => {
      await (window as unknown as { pollReply: Promise<DesktopReply> }).pollReply;
    });
    await expect(page.getByRole('button', { name: 'Resume all', exact: true })).toBeVisible();
    await expect(page.locator('.folder-inspector')).toContainText('Global: on');
  } finally {
    release.resolve();
  }
});
test('dashboard polling unmounts during setup and late replies never clear new secret input', async ({
  page,
}) => {
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
  const snapshot = state(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let reads = 0;
  await page.exposeBinding('desktopPresentation', async (): Promise<DesktopReply> => {
    if (++reads === 2) {
      entered.resolve();
      await release.promise;
    }
    return { ok: true, snapshot };
  });
  try {
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'Folders', exact: true })).toBeVisible();
    await page.evaluate(() => {
      const host = window as unknown as {
        desktopPresentation(command: DesktopCommand): Promise<DesktopReply>;
        heldReply?: Promise<DesktopReply>;
      };
      const original = host.desktopPresentation;
      let calls = 0;
      host.desktopPresentation = (command) => {
        const result = original(command);
        if (++calls === 1) host.heldReply = result;
        return result;
      };
    });
    await page.clock.runFor(1500);
    await entered.promise;
    await page.getByRole('button', { name: 'Connect folder', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Server', exact: true })).toBeVisible();
    await page.getByLabel('Owner password', { exact: true }).fill('new-setup-secret');
    release.resolve();
    await page.evaluate(async () => {
      await (window as unknown as { heldReply: Promise<DesktopReply> }).heldReply;
    });
    const before = reads;
    await page.clock.runFor(4500);
    expect(reads).toBe(before);
    await expect(page.getByLabel('Owner password', { exact: true })).toHaveValue(
      'new-setup-secret',
    );
    await page.getByRole('button', { name: 'Return to folders' }).click();
    await expect(page.getByRole('heading', { name: 'Folders', exact: true })).toBeVisible();
  } finally {
    release.resolve();
  }
});
