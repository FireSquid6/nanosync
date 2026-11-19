import { expect, spyOn, test } from 'bun:test';
import * as credentialRegistry from '../../../packages/client-service/src/credentials.ts';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { ClientLocal } from '@nanosync/client-local';
import {
  createConnection,
  initializeCredentials,
  privateDirectory,
  secureCreate,
  records,
  openBoundSync,
  observeSyncLock,
  disconnectConnections,
} from '@nanosync/client-service';
import { createDesktopBackend, validateCommand } from '../src/backend';
import type { DesktopReply } from '../src/rpc';
function ok(reply: DesktopReply) {
  if (!reply.ok) throw Error(`${reply.code}: ${reply.message}`);
  return reply;
}
function setup() {
  const base = mkdtempSync('/tmp/ns-desktop-tools-'),
    root = join(base, 'state'),
    files = join(base, 'files');
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(files);
  initializeCredentials(root, 'protected-file');
  const serverId = randomUUID(),
    vaultId = randomUUID(),
    deviceId = randomUUID();
  secureCreate(
    join(privateDirectory(join(root, 'servers')), `${serverId}.json`),
    JSON.stringify({
      version: 1,
      serverId,
      deviceId,
      baseUrl: 'https://example.test',
      name: 'home',
      token: 'A'.repeat(43),
    }),
  );
  secureCreate(
    join(privateDirectory(join(root, 'keys')), `${serverId}-${vaultId}.json`),
    JSON.stringify({ version: 1, serverId, vaultId, masterKey: 'ab'.repeat(32) }),
  );
  const binding = createConnection(root, files, serverId, vaultId, deviceId);
  return { base, root, files, binding };
}
test('typed tools reject arbitrary paths, payload extras and unsafe signatures before dispatch', () => {
  for (const command of [
    {
      type: 'open-conflict',
      binding: randomUUID(),
      conflict: randomUUID(),
      path: '/etc',
    },
    {
      type: 'ignores-set',
      binding: randomUUID(),
      text: '',
      expectedFileSignature: 'overwrite',
    },
    {
      type: 'remove',
      selection: randomUUID(),
      force: 'true',
      stopOwner: false,
      confirmed: true,
    },
    { type: 'resume-removal', requestId: randomUUID(), confirmed: false },
  ])
    expect(() => validateCommand(command)).toThrow('Invalid client request');
  expect(validateCommand({ type: 'ignores-validate', text: '# multi\n*.tmp\n' }).type).toBe(
    'ignores-validate',
  );
});
test('real backend conflict list/open is ID constrained and does not acknowledge, ignore validation/save uses CAS', async () => {
  const fixture = setup(),
    opened: string[] = [];
  const backend = createDesktopBackend(fixture.root, {
    async pickFolder() {
      return [];
    },
    async openAdministration() {
      return { ok: true };
    },
    async openFolder(path) {
      opened.push(path);
      return { ok: true };
    },
    quit() {},
  });
  try {
    const conflict = randomUUID(),
      revision = randomUUID();
    mkdirSync(join(fixture.files, 'notes'));
    writeFileSync(join(fixture.files, 'notes', 'copy'), 'PRESERVED_CONTENT');
    const local = new ClientLocal(
      join(fixture.root, 'replicas', fixture.binding.connectionId),
      fixture.binding.vaultId,
      fixture.binding.deviceId,
    );
    local.upsertEntry({
      id: conflict,
      path: 'notes/copy',
      kind: 'file',
      fingerprint: 'a'.repeat(64),
      hydration: 'downloaded',
      revision,
    });
    local.addConflict(conflict, conflict, revision);
    local.close();
    const listing = ok(await backend.execute({ type: 'conflicts' })).conflicts!;
    expect(listing.bindings[0]?.conflicts[0]?.id).toBe(conflict);
    ok(
      await backend.execute({
        type: 'open-conflict',
        binding: fixture.binding.connectionId,
        conflict,
      }),
    );
    expect(opened).toEqual([join(fixture.files, 'notes')]);
    expect(ok(await backend.execute({ type: 'conflicts' })).conflicts).toEqual(listing);
    expect(
      await backend.execute({
        type: 'open-conflict',
        binding: fixture.binding.connectionId,
        conflict: randomUUID(),
      }),
    ).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(
      ok(
        await backend.execute({
          type: 'ignores-validate',
          text: '!PRIVATE_PATTERN_SENTINEL',
        }),
      ).validation,
    ).toEqual({ valid: false, code: 'IGNORE_INVALID', line: 1 });
    const rules = ok(
      await backend.execute({
        type: 'ignores-view',
        binding: fixture.binding.connectionId,
      }),
    ).ignores!;
    ok(
      await backend.execute({
        type: 'ignores-set',
        binding: fixture.binding.connectionId,
        text: '*.tmp\n',
        expectedFileSignature: rules.fileSignature,
      }),
    );
    expect(
      await backend.execute({
        type: 'ignores-set',
        binding: fixture.binding.connectionId,
        text: '# stale',
        expectedFileSignature: rules.fileSignature,
      }),
    ).toMatchObject({ ok: false, code: 'CONFLICT' });
    expect(readFileSync(join(fixture.files, '.nanosyncignore'), 'utf8')).toBe('*.tmp\n');
  } finally {
    await backend.shutdown();
    rmSync(fixture.base, { recursive: true, force: true });
  }
});
test('real removal preview requires checked selection and explicit force; partial cleanup remains recoverable in snapshot', async () => {
  const fixture = setup();
  let crash = true;
  writeFileSync(join(fixture.files, 'keep'), 'PRESERVE_ME');
  const backend = createDesktopBackend(
    fixture.root,
    {
      async pickFolder() {
        return [];
      },
      async openAdministration() {
        return { ok: true };
      },
      quit() {},
    },
    {
      checkpoint(phase) {
        if (crash && phase === 'removal-record') throw Error('PRIVATE_ERROR_SENTINEL');
      },
    },
  );
  try {
    const preview = ok(
      await backend.execute({
        type: 'inspect-disconnect',
        binding: fixture.binding.connectionId,
      }),
    ).removalPreview!;
    expect(preview.bindings[0]?.dirty).toBe(true);
    expect(
      await backend.execute({
        type: 'remove',
        selection: preview.selection,
        force: false,
        stopOwner: false,
        confirmed: true,
      }),
    ).toMatchObject({ ok: false, code: 'UNSYNCED_WORK' });
    expect(records(fixture.root)).toHaveLength(1);
    const failed = await backend.execute({
      type: 'remove',
      selection: preview.selection,
      force: true,
      stopOwner: false,
      confirmed: true,
    });
    expect(failed).toMatchObject({ ok: false });
    expect(JSON.stringify(failed)).not.toContain('PRIVATE_ERROR_SENTINEL');
    const snapshot = ok(await backend.execute({ type: 'snapshot' })).snapshot;
    expect(snapshot.removal?.bindings[0]?.connection).toEqual(fixture.binding);
    crash = false;
    ok(
      await backend.execute({
        type: 'resume-removal',
        requestId: snapshot.removal!.requestId,
        confirmed: true,
      }),
    );
    expect(records(fixture.root)).toEqual([]);
    expect(readFileSync(join(fixture.files, 'keep'), 'utf8')).toBe('PRESERVE_ME');
  } finally {
    await backend.shutdown();
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('removal stops an independent CLI owner only with explicit stop consent, never on list or Quit', async () => {
  const fixture = setup(),
    replica = join(fixture.root, 'replicas', fixture.binding.connectionId);
  const native = {
    async pickFolder() {
      return [];
    },
    async openAdministration() {
      return { ok: true };
    },
    quit() {},
  };
  const owner = await openBoundSync(fixture.root, fixture.files, {
    origin: 'cli',
    instanceId: randomUUID(),
  });
  const first = createDesktopBackend(fixture.root, native),
    second = createDesktopBackend(fixture.root, native);
  try {
    const preview = ok(
      await first.execute({ type: 'inspect-disconnect', binding: fixture.binding.connectionId }),
    ).removalPreview!;
    expect(preview.bindings[0]).toMatchObject({ ownerPresent: true, dirty: null });
    expect(
      await first.execute({
        type: 'remove',
        selection: preview.selection,
        force: true,
        stopOwner: false,
        confirmed: true,
      }),
    ).toMatchObject({ ok: false });
    expect(records(fixture.root)).toHaveLength(1);
    expect(observeSyncLock(replica)?.live).toBe(true);
    await first.shutdown();
    expect(observeSyncLock(replica)?.live).toBe(true);
    const next = ok(
      await second.execute({ type: 'inspect-disconnect', binding: fixture.binding.connectionId }),
    ).removalPreview!;
    ok(
      await second.execute({
        type: 'remove',
        selection: next.selection,
        force: true,
        stopOwner: true,
        confirmed: true,
      }),
    );
    expect(observeSyncLock(replica)).toBeNull();
    expect(records(fixture.root)).toEqual([]);
  } finally {
    await first.shutdown();
    await second.shutdown();
    await owner.close();
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

for (const kind of ['original', 'replacement'] as const) {
  test(`desktop ignore setter owns legacy WAL recovery before historical root checks (${kind}) without OS provider access`, async () => {
    const fixture = setup(),
      replica = join(fixture.root, 'replicas', fixture.binding.connectionId);
    const local = new ClientLocal(replica, fixture.binding.vaultId, fixture.binding.deviceId);
    const stat = lstatSync(fixture.files, { bigint: true }),
      rootId = randomUUID();
    local.recordScan(
      [
        {
          id: rootId,
          path: '',
          kind: 'directory',
          fingerprint: null,
          hydration: 'downloaded',
          revision: null,
        },
      ],
      [{ entryId: rootId, device: String(stat.dev), inode: String(stat.ino) }],
    );
    const facts = local.statusFacts(),
      wal = readFileSync(join(replica, 'local.sqlite-wal'));
    local.close();
    rmSync(join(replica, 'root-identity.json'));
    writeFileSync(join(replica, 'local.sqlite-wal'), wal, { mode: 0o600 });
    expect(existsSync(join(replica, 'local.sqlite-shm'))).toBe(false);
    let providerCalls = 0;
    const unavailable = async () => {
      providerCalls++;
      throw Error('unexpected OS provider');
    };
    const backend = createDesktopBackend(
      fixture.root,
      {
        async pickFolder() {
          return [];
        },
        async openAdministration() {
          return { ok: true };
        },
        quit() {},
      },
      { store: { get: unavailable, set: unavailable, delete: unavailable } },
    );
    try {
      const before = readdirSync(replica);
      expect(
        await backend.execute({ type: 'ignores-view', binding: fixture.binding.connectionId }),
      ).toMatchObject({ ok: false });
      expect(readdirSync(replica)).toEqual(before);
      if (kind === 'replacement') {
        renameSync(fixture.files, fixture.files + '-original');
        mkdirSync(fixture.files);
        copyFileSync(
          join(fixture.files + '-original', '.nanosync'),
          join(fixture.files, '.nanosync'),
        );
      }
      const reply = await backend.execute({
        type: 'ignores-set',
        binding: fixture.binding.connectionId,
        text: '*.tmp\n',
        expectedFileSignature: 'absent',
      });
      if (kind === 'original') {
        expect(reply).toMatchObject({
          ok: true,
          ignores: { text: '*.tmp\n', connectionId: fixture.binding.connectionId },
        });
        expect(readFileSync(join(fixture.files, '.nanosyncignore'), 'utf8')).toBe('*.tmp\n');
      } else {
        expect(reply).toMatchObject({ ok: false, code: 'FOLDER_UNAVAILABLE' });
        expect(existsSync(join(fixture.files, '.nanosyncignore'))).toBe(false);
      }
      expect(
        ClientLocal.readStatus(replica, fixture.binding.vaultId, fixture.binding.deviceId),
      ).toEqual(facts);
      expect(providerCalls).toBe(0);
      expect(existsSync(join(replica, 'root-identity.json'))).toBe(false);
    } finally {
      await backend.shutdown();
      rmSync(fixture.base, { recursive: true, force: true });
    }
  });
}

test('desktop ignore UUID is rechecked under initial registry coordination after the old path is rebound', async () => {
  const fixture = setup();
  const backend = createDesktopBackend(fixture.root, {
    async pickFolder() {
      return [];
    },
    async openAdministration() {
      return { ok: true };
    },
    quit() {},
  });
  const originalRegistry = credentialRegistry.withCredentialRegistry;
  let rebind = true,
    replacementId = '';
  const handoff = spyOn(credentialRegistry, 'withCredentialRegistry').mockImplementation(
    async (root, action) => {
      if (rebind) {
        rebind = false;
        await disconnectConnections(fixture.root, [fixture.binding], true);
        replacementId = createConnection(
          fixture.root,
          fixture.files,
          fixture.binding.serverId,
          fixture.binding.vaultId,
          fixture.binding.deviceId,
        ).connectionId;
      }
      return originalRegistry(root, action);
    },
  );
  try {
    const reply = await backend.execute({
      type: 'ignores-set',
      binding: fixture.binding.connectionId,
      text: '# must not reach replacement',
      expectedFileSignature: 'absent',
    });
    expect(reply).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(replacementId).not.toBe(fixture.binding.connectionId);
    expect(records(fixture.root).map((item) => item.connectionId)).toEqual([replacementId]);
    expect(existsSync(join(fixture.files, '.nanosyncignore'))).toBe(false);
  } finally {
    handoff.mockRestore();
    await backend.shutdown();
    rmSync(fixture.base, { recursive: true, force: true });
  }
});
