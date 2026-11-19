import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createDesktopBackend } from '../apps/desktop/src/backend';
import { createConnection, readPreferences, setPaused } from '../packages/client-service/src/index.ts';
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
    progress: {
      upload: { count: 2, bytes: 144 },
      download: { count: 3, bytes: 240 },
    },
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
    failureEpisode: null,
    observationTime: 100000,
    attentionRequired: false,
    statusIssues: [],
    error: null,
  };
  return {
    removal: null,
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
      version: 3,
      notifications: { enabled: true, conflicts: true, revokedAccess: true, persistentFailures: true, includeNamesAndPaths: false },
      revision: 0,
      globalPaused: false,
      bindingPaused: { [secondId]: true },
      continuousRequested: { [firstId]: 'desktop', [secondId]: 'cli' },
      lifecycle: {
        startAtLogin: false,
        trayEnabled: false,
        keepSyncingAfterClose: true,
      },
    },
    connections: [
      {
        serverId,
        deviceId,
        alias: 'home',
        url: 'https://example.test',
        status: 'approved',
      },
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
    return {
      ok: false,
      code: 'CONFLICT',
      message: 'Settings changed. Refresh before retrying.',
    };
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
  expect(
    commands.some((command) => ['start', 'sync-now', 'enroll'].includes(command.type)),
  ).toBe(false);
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
  await expect(inspector).toContainText('Observed pass counters');
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
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
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
  await expect(page.locator('.folder-inspector')).toContainText(
    'Transfer counters not observed',
  );
  await expect(page.locator('.folder-inspector')).toContainText(
    'Conflict observation unavailable',
  );
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
      recoveryAction:
        'Stop the owner and retry with a compatible client; do not bypass its lock.',
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
            message:
              'Owner unavailable. Stop it explicitly and retry; its lock was not bypassed.',
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
  await expect(page.locator('.folder-inspector')).toContainText(
    'Transfer counters not observed',
  );
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
  await expect(page.locator('.folder-inspector')).toContainText('Historical pass counters');
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

test('manual conflicts, validated ignore CAS and explicit removal have keyboard-accessible themed responsive screens', async ({
  page,
}) => {
  const snapshot = state(),
    commands: DesktopCommand[] = [];
  let saved = '*.tmp\n',
    signature = 'a'.repeat(64);
  await page.exposeBinding(
    'desktopPresentation',
    async (_source, command: DesktopCommand): Promise<DesktopReply> => {
      commands.push(structuredClone(command));
      if (command.type === 'conflicts')
        return {
          ok: true,
          snapshot,
          conflicts: {
            version: 1,
            bindings: [
              {
                connectionId: firstId,
                root: '/temporary/documents',
                issue: null,
                conflicts: [
                  {
                    id: deviceId,
                    entryId: deviceId,
                    path: 'notes/conflict-copy.md',
                    sourceRevisionId: vaultId,
                  },
                ],
              },
            ],
          },
        };
      if (command.type === 'ignores-validate')
        return {
          ok: true,
          snapshot,
          validation: command.text.startsWith('!')
            ? { valid: false, code: 'IGNORE_INVALID', line: 1 }
            : { valid: true },
        };
      if (command.type === 'ignores-set') {
        expect(command.expectedFileSignature).toBe(signature);
        saved = command.text;
        signature = 'b'.repeat(64);
      }
      if (command.type === 'ignores-view' || command.type === 'ignores-set')
        return {
          ok: true,
          snapshot,
          ignores: {
            version: 1,
            connectionId: firstId,
            text: saved,
            fileSignature: signature,
          },
        };
      if (command.type === 'inspect-disconnect') {
        const source = snapshot.status!.bindings[0]!;
        const connection = {
          version: 1 as const,
          connectionId: source.connectionId,
          root: source.root,
          serverId: source.serverId,
          vaultId: source.vaultId,
          deviceId: source.deviceId,
        };
        return {
          ok: true,
          snapshot,
          removalPreview: {
            version: 1,
            selection: deviceId,
            bindings: [
              {
                connection,
                ownerPresent: true,
                rootAvailable: true,
                dirty: null,
              },
            ],
          },
        };
      }
      return { ok: true, snapshot };
    },
  );
  await page.goto(url);
  await page.getByRole('button', { name: 'Conflicts', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Conflicts', exact: true })).toBeVisible();
  await expect(page.getByText('notes/conflict-copy.md', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Only applied manifest reconciliation clears a conflict.', {
      exact: false,
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Open containing folder' }).click();
  expect(commands.find((command) => command.type === 'open-conflict')).toEqual({
    type: 'open-conflict',
    binding: firstId,
    conflict: deviceId,
  });
  await page.getByRole('button', { name: 'Back to folders' }).click();
  await page.getByRole('button', { name: 'Edit ignore rules' }).click();
  await page
    .getByLabel('.nanosyncignore (maximum 64 KiB UTF-8)', { exact: true })
    .fill('!PRIVATE_RULE');
  await expect(page.getByRole('button', { name: 'Save validated rules' })).toBeDisabled();
  await page.getByRole('button', { name: 'Validate rules' }).click();
  await expect(page.getByRole('alert')).toContainText('Invalid rules at line 1');
  await expect(page.getByRole('alert')).not.toContainText('PRIVATE_RULE');
  await page
    .getByLabel('.nanosyncignore (maximum 64 KiB UTF-8)', { exact: true })
    .fill('# local\n*.bak\n');
  await page.getByRole('button', { name: 'Validate rules' }).click();
  await page.getByRole('button', { name: 'Save validated rules' }).click();
  await expect(page.getByText('Ignore rules saved durably.', { exact: false })).toBeVisible();
  for (const width of [1280, 700]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ['light', 'dark']) {
      await page.getByLabel('Theme', { exact: true }).selectOption(theme);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
    }
  }
  await page.getByRole('button', { name: 'Back to folders' }).click();
  await page.getByRole('button', { name: 'Inspect disconnect' }).click();
  await expect(page.getByRole('heading', { name: 'Review local removal' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm local removal' })).toBeDisabled();
  await page
    .getByLabel('Explicitly abandon pending synchronization state', {
      exact: false,
    })
    .check();
  await page.getByLabel('Explicitly stop affected live owners', { exact: false }).check();
  await page.getByLabel('I confirm this local removal.', { exact: false }).check();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Confirm local removal' }).click();
  expect(commands.find((command) => command.type === 'remove')).toEqual({
    type: 'remove',
    selection: deviceId,
    force: true,
    stopOwner: true,
    confirmed: true,
  });
  expect(
    commands.some((command) =>
      ['start', 'sync-now', 'pause-all', 'pause-folder'].includes(command.type),
    ),
  ).toBe(false);
});

test('incomplete removal remains visible and explicitly resumable with absent records and locked credentials', async ({
  page,
}) => {
  const snapshot = state(),
    commands: DesktopCommand[] = [];
  const source = snapshot.status!.bindings[0]!;
  snapshot.status = null;
  snapshot.connections = [];
  snapshot.credentials.cleanupPending = true;
  snapshot.removal = {
    version: 1,
    requestId: deviceId,
    kind: 'server',
    serverId,
    force: true,
    phase: 'cleaning-credentials',
    credentialPaths: [`servers/${serverId}.json`],
    bindings: [
      {
        connection: {
          version: 1,
          connectionId: source.connectionId,
          root: source.root,
          serverId,
          vaultId,
          deviceId,
        },
        rootIdentity: { device: '1', inode: '2' },
        rootWasMissing: false,
      },
    ],
  };
  await page.exposeBinding(
    'desktopPresentation',
    async (_source, command: DesktopCommand): Promise<DesktopReply> => {
      commands.push(command);
      return { ok: true, snapshot };
    },
  );
  await page.goto(url);
  await page.getByRole('button', { name: 'Review removal recovery' }).click();
  await expect(
    page.getByRole('heading', {
      name: 'Incomplete removal — original identities preserved',
    }),
  ).toBeVisible();
  await expect(
    page.getByText('/temporary/documents — local copy', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Explicitly resume authorized removal' }).click();
  expect(commands.find((command) => command.type === 'resume-removal')).toEqual({
    type: 'resume-removal',
    requestId: deviceId,
    confirmed: true,
  });
});

test('General settings separates intent/effects and refuses a draft made stale by CLI without overwriting pauses', async ({
  page,
}) => {
  const snapshot = state();
  snapshot.lifecycle = {
    startup: {
      available: false,
      applied: false,
      message: 'No proven active XDG autostart consumer.',
    },
    tray: {
      available: false,
      applied: false,
      message: 'No StatusNotifierWatcher; reopen with launcher.',
    },
    session: {
      available: true,
      applied: true,
      message: 'Associated graphical session monitored.',
    },
    closing: false,
  };
  await page.exposeBinding(
    'desktopPresentation',
    async (_source, command: DesktopCommand): Promise<DesktopReply> => {
      if (command.type === 'settings') {
        if (command.expectedRevision !== snapshot.settings.revision)
          return {
            ok: false,
            code: 'CONFLICT',
            message: 'Settings changed. Refresh before retrying.',
          };
        snapshot.settings.lifecycle = command.lifecycle;
        snapshot.settings.revision++;
      }
      return { ok: true, snapshot };
    },
  );
  await page.goto(url);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings — General' })).toBeVisible();
  await expect(page.getByText('No StatusNotifierWatcher;', { exact: false })).toBeVisible();
  await page.getByLabel('Start at login').check();
  snapshot.settings.globalPaused = true;
  snapshot.settings.revision++;
  await page.getByRole('button', { name: 'Save preferences' }).click();
  await expect(page.getByRole('alert')).toContainText('Settings changed');
  expect(snapshot.settings.lifecycle.startAtLogin).toBe(false);
  expect(snapshot.settings.globalPaused).toBe(true);
  await page.getByRole('button', { name: 'Refresh saved settings' }).click();
  await expect(page.getByLabel('Start at login')).not.toBeChecked();
  await page.getByLabel('Start at login').check();
  await page.getByRole('button', { name: 'Save preferences' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(snapshot.settings.lifecycle.startAtLogin).toBe(true);
  expect(snapshot.settings.globalPaused).toBe(true);
  await expect(page.getByText('No proven active XDG autostart consumer.')).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  }
});

test('General observes native loss without rebasing drafts, rejects pre-save polls and demotes failed observations', async ({
  page,
}) => {
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
  const snapshot = state(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  snapshot.lifecycle = {
    startup: { available: null, applied: false, message: 'Login off.' },
    tray: { available: true, applied: true, message: 'Tray registered.' },
    session: { available: true, applied: true, message: 'Session associated.' },
    closing: false,
  };
  let reads = 0,
    fail = false;
  await page.exposeBinding(
    'desktopPresentation',
    async (_source, command: DesktopCommand): Promise<DesktopReply> => {
      if (command.type === 'snapshot') {
        if (fail) throw Error('synthetic transport loss');
        if (++reads === 2) {
          const old = structuredClone(snapshot);
          entered.resolve();
          await release.promise;
          return { ok: true, snapshot: old };
        }
      }
      if (command.type === 'settings') {
        if (command.expectedRevision !== snapshot.settings.revision)
          return {
            ok: false,
            code: 'CONFLICT',
            message: 'Settings changed. Refresh before retrying.',
          };
        snapshot.settings.lifecycle = command.lifecycle;
        snapshot.settings.revision++;
        snapshot.lifecycle!.tray = {
          available: false,
          applied: false,
          message: 'Watcher lost.',
        };
      }
      return { ok: true, snapshot };
    },
  );
  try {
    await page.goto(url);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const tray = page.getByRole('heading', { name: 'tray', exact: true }).locator('..');
    await expect(tray).toContainText('Available · Applied');
    await page.getByLabel('Start at login').check();
    await page.evaluate(() => {
      const host = window as unknown as {
        desktopPresentation(command: DesktopCommand): Promise<DesktopReply>;
        pollReply?: Promise<DesktopReply>;
      };
      const original = host.desktopPresentation;
      host.desktopPresentation = (command) => {
        const reply = original(command);
        if (command.type === 'snapshot') host.pollReply = reply;
        return reply;
      };
    });
    await page.clock.runFor(1500);
    await entered.promise;
    await page.getByRole('button', { name: 'Save preferences' }).click();
    await expect(tray).toContainText('Unavailable · Not applied');
    release.resolve();
    await page.evaluate(async () => {
      await (window as unknown as { pollReply: Promise<DesktopReply> }).pollReply;
    });
    await expect(tray).toContainText('Watcher lost.');
    await page.getByLabel('Keep syncing after closing the window').uncheck();
    snapshot.settings.revision++;
    snapshot.settings.globalPaused = true;
    snapshot.lifecycle!.session = {
      available: false,
      applied: false,
      message: 'Session lost.',
    };
    await page.clock.runFor(1500);
    await expect(page.getByText('Session lost.', { exact: false })).toBeVisible();
    await expect(page.getByLabel('Start at login')).toBeChecked();
    await expect(page.getByLabel('Keep syncing after closing the window')).not.toBeChecked();
    await page.getByRole('button', { name: 'Save preferences' }).click();
    await expect(page.getByRole('alert')).toContainText('Settings changed');
    expect(snapshot.settings.lifecycle.keepSyncingAfterClose).toBe(true);
    expect(snapshot.settings.globalPaused).toBe(true);
    fail = true;
    await page.clock.runFor(1500);
    await expect(
      page.getByText('Native observation unavailable.', { exact: false }),
    ).toBeVisible();
    await expect(page.getByText('Available · Applied', { exact: false })).toHaveCount(0);
    await expect(page.getByLabel('Keep syncing after closing the window')).not.toBeChecked();
  } finally {
    release.resolve();
  }
});

test('real backend notification settings and native-picked diagnostics preserve privacy and keyboard access', async ({ page }) => {
  const base = mkdtempSync('/tmp/ns-browser-settings-'), root = join(base, 'state'), files = join(base, 'files'), documents = join(base, 'Documents');
  mkdirSync(root, { mode: 0o700 }); mkdirSync(files); mkdirSync(documents, { mode: 0o755 });
  createConnection(root, files, serverId, vaultId, deviceId);
  let pick: string[] = [];
  const backend = createDesktopBackend(root, {
    pickFolder: async () => pick, openAdministration: async () => ({ ok: false }), quit() {},
    notificationStatus: () => ({ available: false, actions: false, code: 'NOTIFICATIONS_UNAVAILABLE' }),
  });
  try {
    await page.clock.install({ time: 0 });
    await page.exposeBinding('desktopPresentation', (_source, command: DesktopCommand) => backend.execute(command));
    await page.goto(url);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Notifications', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Include local names and paths in notifications')).not.toBeChecked();
    await page.getByLabel('Conflicts', { exact: true }).uncheck();
    await page.getByLabel('Enable notifications', { exact: true }).uncheck();
    await page.getByRole('button', { name: 'Save notification preferences' }).click();
    expect(readPreferences(root).notifications).toMatchObject({ enabled: false, conflicts: false, revokedAccess: true });
    await page.getByLabel('Enable notifications', { exact: true }).check();
    setPaused(root, { all: true }, true);
    await page.clock.runFor(1500);
    await expect(page.getByLabel('Enable notifications', { exact: true })).toBeChecked();
    await page.getByRole('button', { name: 'Save notification preferences' }).click();
    await expect(page.getByRole('alert')).toContainText('Saved state changed');
    await page.getByRole('button', { name: 'Refresh notification settings' }).click();
    await expect(page.getByLabel('Enable notifications', { exact: true })).not.toBeChecked();
    await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
    await page.getByRole('button', { name: 'Choose directory and export diagnostics' }).click();
    await expect(page.getByRole('status')).toContainText('Export cancelled');
    pick = [documents];
    await page.getByRole('button', { name: 'Choose directory and export diagnostics' }).click();
    await expect(page.getByRole('status')).toContainText('Diagnostics exported locally');
    const exported = readdirSync(documents);
    expect(exported).toHaveLength(1);
    const report = JSON.parse(readFileSync(join(documents, exported[0]!), 'utf8'));
    expect(report.identifiers).toBeUndefined(); expect(JSON.stringify(report)).not.toContain(files);
    await page.getByLabel('Include identifying binding IDs and local folder paths for this export only').check();
    await expect(page.getByRole('status').filter({ hasText: 'Privacy warning' })).toBeVisible();
    await page.getByRole('button', { name: 'Choose directory and export diagnostics' }).click();
    await expect(page.getByLabel('Include identifying binding IDs and local folder paths for this export only')).not.toBeChecked();
    const reports = readdirSync(documents).map(file => JSON.parse(readFileSync(join(documents, file), 'utf8')));
    expect(reports.some(report => report.identifiers?.bindings[0]?.root === files)).toBe(true);
    const accessibility = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(accessibility.violations).toEqual([]);
  } finally { await backend.shutdown(); rmSync(base, { recursive: true, force: true }); }
});
