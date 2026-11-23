#!/usr/bin/env bun
import { join } from 'node:path';
import { hostname } from 'node:os';
import { readdirSync } from 'node:fs';
import { Command, CommanderError, Option } from 'commander';
import { parseDeviceId, parseVaultId } from '@nanosync/protocol';
import { RemoteError } from '@nanosync/sync-core';
import { api, baseUrl } from './client.ts';
import { privateDirectory, secureCreate, secureRead } from './security.ts';
import { runServer, initializeServerOwner, localAdminReport, withLocalOwner, localOwner } from './server.ts';
import { ClientService } from '@nanosync/client-service/service';
import { listServerMetadata, migrateCredentials } from '@nanosync/client-service/credentials';
import { removalPending } from '@nanosync/client-service/credential-state';
import { connectRegisteredVault, discoverConnection, records, disconnectConnections, removeServerConnection } from './connections.ts';
import { enrollServer, key, server as storedServer, unlockVault, pendingEnrollments } from './vault-client.ts';
import { provisionLocalVault } from './local-provision.ts';
import { CliError, interactive, text, hidden, choose, acknowledge } from './prompts.ts';
import { CliOutput, output, withOutput } from './output.ts';

type Options = { [key: string]: any };
export async function main(args = process.argv.slice(2)): Promise<number> {
  const flagArgs = args.slice(0, args.indexOf('--') < 0 ? args.length : args.indexOf('--'));
  const presentation = new CliOutput(flagArgs.includes('--json'));
  return withOutput(presentation, () => execute(args, presentation));
}

async function execute(args: string[], presentation: CliOutput): Promise<number> {
  try {
    const program = new Command().name('nanosync').description('Explicit server-local administration and client synchronization').exitOverride()
      .configureOutput({ writeErr: () => {} }).showHelpAfterError(false);
    const seen = new Set<string>();
    function flags(command: Command, ...definitions: string[]) {
      for (const definition of definitions) {
        const option = new Option(definition);
        command.addOption(option).on(`option:${option.name()}`, () => {
          if (seen.has(option.long!)) throw new CliError('INVALID_INPUT', `duplicate flag: ${option.long}`);
          seen.add(option.long!);
        });
      }
      return command;
    }
    const common = ['--json', '--non-interactive', '--yes'];
    const local = ['--server-dir <directory>'];
    const clientFlags = ['--client-dir <directory>'];
    flags(program, ...common, ...local, ...clientFlags);
    const opts = (command: Command): Options => command.optsWithGlobals();
    const canPrompt = (command: Command) => interactive(opts(command).nonInteractive);
    const root = (command: Command) => opts(command).clientDir ?? join(process.env.HOME ?? '', '.nanosync');
    const labels: Record<string, string> = {
      'server-dir': 'Server directory', name: 'Vault name', alias: 'Connection alias', url: 'Server URL',
    };
    const need = async (command: Command, flag: string,
      label = `${labels[flag] ?? flag.replaceAll('-', ' ')} (--${flag})`): Promise<string> =>
      opts(command)[flag.replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase())] ?? await text(label, canPrompt(command));
    const serverRoot = async (command: Command) => need(command, 'server-dir');
    const secret = async (command: Command, variable: string, fileFlag: string, label: string): Promise<string> => {
      const path = opts(command)[fileFlag];
      if (!path && process.env[variable] === undefined && !canPrompt(command)) {
        const flag = fileFlag.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
        throw new CliError('INPUT_REQUIRED', `${label} is required; set ${variable} or supply --${flag} <file>.`);
      }
      return path ? secureRead(path, 4096).toString('utf8').trimEnd() : process.env[variable] ?? await hidden(label, canPrompt(command));
    };
    async function selectServerMetadata(command: Command) {
      const list = listServerMetadata(root(command));
      const choice = opts(command).server ?? await choose('Choose a server (--server)',
        list.map(info => ({ name: `${info.name}: ${info.baseUrl}`, value: info.serverId })),
        canPrompt(command), 'No server connections. Run nanosync client connections add.');
      const matches = list.filter(info => info.serverId === choice || info.name === choice || info.baseUrl === choice);
      if (matches.length !== 1) throw new CliError('NOT_FOUND', 'server not found or ambiguous');
      return matches[0]!;
    }
    async function selectServer(command: Command) {
      return storedServer(root(command), (await selectServerMetadata(command)).serverId);
    }
    async function selectLocalVault(command: Command, directory: string) {
      if (!opts(command).vault && !canPrompt(command)) return parseVaultId(await need(command, 'vault'));
      const selected = opts(command).vault ?? await choose('Choose a vault (--vault)',
        await withLocalOwner(directory, owner => owner.listVaults(localOwner).map(vault => ({
          name: `${vault.name} — ${vault.vaultId}`, value: vault.vaultId,
        }))), canPrompt(command), 'No vaults. Create one with nanosync server vaults create.');
      return parseVaultId(selected);
    }
    let result: unknown, exitCode = 0, resultCode = 'OK';
    const server = flags(program.command('server').description('Local server administration'), ...local, ...common);
    flags(server.command('init'), ...local, ...common, '--password-file <file>').action(async (_o, command) => {
      const dir = privateDirectory(await serverRoot(command));
      const password = await secret(command, 'NANOSYNC_PASSWORD', 'passwordFile', 'Owner password');
      if (!opts(command).passwordFile && !process.env.NANOSYNC_PASSWORD && password !== await hidden('Confirm owner password', canPrompt(command))) throw new CliError('INVALID_INPUT', 'password confirmation mismatch');
      output().progress('Initializing server…');
      await initializeServerOwner(dir, password);
      result = { initialized: true, serverDirectory: dir };
    });
    flags(server.command('run'), ...local, ...common, '--host <host>', '--port <port>', '--acknowledge-exposure', '--web-ui', '--external-origin <origin>', '--trusted-proxy <ip>')
      .action(async (_o, command) => {
        const o = opts(command);
        const directory = await serverRoot(command);
        output().progress('Starting server…');
        const running = await runServer({ directory, host:o.host, port:o.port === undefined ? undefined : Number(o.port),
          acknowledgeExposure:!!o.acknowledgeExposure, webUi:!!o.webUi, externalOrigin:o.externalOrigin, trustedProxyAddresses:o.trustedProxy ? [o.trustedProxy] : undefined });
        output().info(`Server listening at ${running.url}`);
        await new Promise<void>(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
        await running.stop(); result = { stopped:true };
      });
    const devices = flags(server.command('devices'), ...local, ...common);
    flags(devices.command('view'), ...local, ...common).action(async (_o, command) => {
      result = await withLocalOwner(await serverRoot(command), owner => ({ devices:owner.devices(localOwner), pending:owner.pending(localOwner) }));
    });
    for (const action of ['approve', 'deny', 'revoke'] as const) {
      flags(devices.command(action), ...local, ...common, '--device-id <uuid>').action(async (_o, command) => {
        const dir = await serverRoot(command);
        if (!opts(command).deviceId && !canPrompt(command)) await need(command, 'device-id');
        const selected = opts(command).deviceId ?? await choose(`Choose a device to ${action} (--device-id)`,
          await withLocalOwner(dir, owner => {
            const candidates = action === 'revoke'
              ? owner.devices(localOwner).filter(device => device.state === 'active') : owner.pending(localOwner);
            return candidates.map(device => ({
              name: `${device.displayName} — ${device.deviceId}`, value: device.deviceId,
            }));
          }), canPrompt(command), action === 'revoke' ? 'No active devices to revoke.'
            : 'No pending requests. Run nanosync client connections add on a client.');
        const id = parseDeviceId(selected);
        if (action === 'revoke') {
          output().warning('Revocation blocks future access; downloaded ciphertext, plaintext and keys are not erased.');
          if (!opts(command).yes && !await acknowledge('Revoke this device?', canPrompt(command))) throw new CliError('CANCELLED', 'revocation cancelled');
        }
        result = await withLocalOwner(dir, owner => {
          if (action === 'revoke') owner.revoke(localOwner, id);
          else {
            const request = owner.pending(localOwner).find(r => r.deviceId === id);
            if (request) output().info(`Verification code: ${request.verificationCode}`);
            owner.decideEnrollment(localOwner, {protocolVersion:1, deviceId:id, decision:action});
          }
          return {deviceId:id, status:action === 'approve' ? 'approved' : action === 'deny' ? 'denied' : 'revoked'};
        });
      });
    }
    const vaults = flags(server.command('vaults'), ...local, ...common);
    flags(vaults.command('view'), ...local, ...common).action(async (_o, command) => {
      result = await withLocalOwner(await serverRoot(command), owner => ({vaults:owner.listVaults(localOwner)}));
    });
    flags(vaults.command('create'), ...local, ...common, '--name <name>', '--recovery-output <file>').action(async (_o, command) => {
      const dir = await serverRoot(command), name = await need(command, 'name');
      if (!opts(command).recoveryOutput && !canPrompt(command)) throw new CliError('INPUT_REQUIRED', '--recovery-output is required in scripts');
      output().progress('Creating vault…');
      result = await provisionLocalVault(dir, name, async recovery => {
        const path = opts(command).recoveryOutput;
        if (path) secureCreate(path, recovery + '\n');
        else {
          output().info('Your vault recovery key unlocks this vault’s encryption key on new devices. It is not your owner password or a backup of your files.');
          output().info('Save it in a password manager or offline. Anyone with this key and the encrypted vault data can decrypt your files.');
          output().info(`Vault recovery key: ${recovery}`);
          if (await hidden('Retype vault recovery key to confirm you saved it', canPrompt(command)) !== recovery) throw new CliError('INVALID_INPUT', 'recovery key acknowledgement mismatch; no vault created');
        }
      }, opts(command).recoveryOutput);
    });
    flags(vaults.command('rename'), ...local, ...common, '--vault <uuid>', '--name <name>').action(async (_o, command) => {
      const dir = await serverRoot(command), id = await selectLocalVault(command, dir), name = await need(command, 'name', 'New vault name (--name)');
      await withLocalOwner(dir, owner => owner.renameVault(localOwner, id, name)); result = {vaultId:id, name};
    });
    flags(vaults.command('delete'), ...local, ...common, '--vault <uuid>', '--confirm-delete <uuid>').action(async (_o, command) => {
      const dir = await serverRoot(command), id = await selectLocalVault(command, dir);
      const vault = await withLocalOwner(dir, owner => owner.listVaults(localOwner).find(v => v.vaultId === id));
      if (!vault) throw new CliError('NOT_FOUND', 'vault not found');
      output().warning(`PERMANENT deletion: ${dir} / ${vault.name} / ${id}. History, encrypted objects and recovery wraps are destroyed. Recovery keys cannot restore data without a server backup. Offline clients may have unsynced work. Client files are preserved.`);
      if (canPrompt(command)) {
        if (await text(`Type exact vault name: ${vault.name}`, true) !== vault.name) throw new CliError('INVALID_INPUT', 'vault name confirmation mismatch');
      } else {
        if (!opts(command).confirmDelete) throw new CliError('INPUT_REQUIRED', '--confirm-delete <same vault UUID> is required in scripts; --yes/--force cannot authorize deletion');
        if (opts(command).confirmDelete !== id) throw new CliError('INVALID_INPUT', '--confirm-delete must equal --vault UUID');
      }
      await withLocalOwner(dir, owner => owner.markVaultDeleted(localOwner, id));
      result = {vaultId:id, status:'deleted', cleanup:'pending'};
    });
    const admin = flags(server.command('admin'), ...local, ...common);
    for (const name of ['storage', 'retention-dry-run', 'gc-dry-run', 'scan', 'diagnostics']) {
      flags(admin.command(name), ...local, ...common).action(async (_o, command) => {
        const directory = await serverRoot(command);
        output().progress('Preparing server report…');
        result = await localAdminReport(directory, name);
      });
    }
    const client = flags(program.command('client').description('Local connections, vault bindings and sync'), ...clientFlags, ...common);
    const connections = flags(client.command('connections'), ...clientFlags, ...common);
    flags(connections.command('view'), ...clientFlags, ...common).action(async (_o, command) => {
      result = {connections:listServerMetadata(root(command)).map(info => ({serverId:info.serverId, alias:info.name, url:info.baseUrl, deviceId:info.deviceId, status:'approved', credentialMode:info.credentialMode})), pending:pendingEnrollments(root(command)).map(p => ({alias:p.alias, url:p.url, deviceId:p.deviceId, deviceName:p.name, status:Date.now() >= p.expiresAtMs ? 'expired' : p.status ?? 'pending'}))};
    });
    flags(connections.command('add'), ...clientFlags, ...common, '--url <url>', '--alias <alias>', '--device-name <name>', '--password-file <file>', '--wait-ms <milliseconds>', '--fresh')
      .action(async (_o, command) => {
        const o = opts(command), dir = root(command), url = baseUrl(await need(command, 'url'));
        const existing = listServerMetadata(dir).find(s => s.baseUrl === url);
        if (existing) { result = await enrollServer(dir, url, undefined, '', 0); return; }
        const pending = pendingEnrollments(dir).find(p => p.url === url);
        const alias = o.alias ?? pending?.alias ?? await need(command, 'alias');
        const deviceName = o.deviceName ?? pending?.name ?? (canPrompt(command) ? await text('Device display name (--device-name)', true, hostname()) : hostname());
        const wait = o.waitMs === undefined ? (canPrompt(command) ? Infinity : 0) : Number(o.waitMs);
        if (o.waitMs !== undefined && (!Number.isSafeInteger(wait) || wait < 0)) throw new CliError('INVALID_INPUT', '--wait-ms must be a nonnegative integer');
        const controller = new AbortController(), stop = () => controller.abort();
        process.once('SIGINT', stop);
        try {
          const response = await enrollServer(dir, url, undefined, deviceName, wait, {alias, fresh:o.fresh, signal:controller.signal,
            password:() => secret(command, 'NANOSYNC_PASSWORD', 'passwordFile', 'Owner password')});
          result = response;
          if (response.status === 'pending') { exitCode = 3; resultCode = 'PENDING_APPROVAL'; }
          if (response.status === 'denied' || response.status === 'expired') { exitCode = 4; resultCode = response.status === 'denied' ? 'ENROLLMENT_DENIED' : 'ENROLLMENT_EXPIRED'; }
        } finally { process.off('SIGINT', stop); }
      });
    flags(connections.command('remove'), ...clientFlags, ...common, '--server <alias-or-id>', '--force').action(async (_o, command) => {
      const dir = root(command), choice = opts(command).server;
      const replayId = typeof choice === 'string' && /^[0-9a-f-]{36}$/.test(choice) && removalPending(dir, parseVaultId(choice)) ? choice : null;
      const serverId = replayId ?? (await selectServerMetadata(command)).serverId;
      output().warning('Local removal only: remote device access is NOT revoked. Files and remote data are preserved. --force discards pending synchronization state.');
      removeServerConnection(dir, serverId, !!opts(command).force);
      result = {serverId, removed:true, remotelyRevoked:false};
    });
    flags(connections.command('migrate-credentials'), ...clientFlags, ...common, '--server <alias-or-id>')
      .action(async (_o, command) => {
        const info = await selectServerMetadata(command);
        const accepted = !!opts(command).yes || await acknowledge('Move credentials to the OS store? Headless CLI access will require an unlocked user session.', canPrompt(command));
        if (!accepted) throw new CliError('CANCELLED', 'credential migration cancelled');
        migrateCredentials(root(command), info.serverId);
        result = {serverId:info.serverId, credentialMode:'os'};
      });
    const bindings = flags(client.command('vaults'), ...clientFlags, ...common);
    flags(bindings.command('view'), ...clientFlags, ...common).action(async (_o, command) => {
      const list = listServerMetadata(root(command)); result = {bindings:records(root(command)).map(c => ({...c, serverAlias:list.find(s => s.serverId === c.serverId)?.name ?? null}))};
    });
    flags(bindings.command('connect'), ...clientFlags, ...common, '--server <alias-or-id>', '--vault <name-or-uuid>', '--path <directory>', '--confirm-nonempty', '--recovery-file <file>')
      .action(async (_o, command) => {
        const o = opts(command), dir = root(command), info = await selectServer(command);
        output().progress('Loading available vaults…');
        const list = (await api(info.baseUrl, '/v1/vaults', {}, info.token)).vaults as {vaultId:string;name:string}[];
        const choice = o.vault ?? await choose('Choose a vault (--vault)',
          list.map(vault => ({ name: `${vault.name} — ${vault.vaultId}`, value: vault.vaultId })),
          canPrompt(command), 'No vaults available. Ask the server owner to run nanosync server vaults create.');
        const matches = list.filter(v => v.vaultId === choice || v.name === choice);
        if (matches.length !== 1) throw new CliError('NOT_FOUND', 'vault not found or ambiguous');
        const vault = matches[0]!, destination = o.path ?? process.cwd();
        let confirmed = !!o.confirmNonempty;
        if (readdirSync(destination).length && !confirmed) confirmed = !!o.yes || await acknowledge('Existing files will participate in synchronization. Continue?', canPrompt(command));
        if (!confirmed && readdirSync(destination).length) throw new CliError('CANCELLED', 'connection cancelled');
        const stored = key(dir, info.serverId, vault.vaultId);
        if (!stored) await unlockVault(dir, info, vault.vaultId, await secret(command, 'NANOSYNC_RECOVERY_SECRET', 'recoveryFile', 'Vault recovery key (unlocks encryption on this device; not your owner password)'));
        else stored.fill(0);
        result = connectRegisteredVault(dir, destination, info.serverId, vault.vaultId, info.deviceId, confirmed);
        if (presentation.json) output().info('Connected; no files transferred. Next: nanosync client sync');
      });
    flags(bindings.command('disconnect'), ...clientFlags, ...common, '--path <directory>', '--force').action(async (_o, command) => {
      const dir = root(command), binding = discoverConnection(dir, opts(command).path ?? process.cwd(), !!opts(command).force);
      if (opts(command).force) output().warning('Disconnect discards pending synchronization state. Local files and remote data are preserved.');
      disconnectConnections(dir, [binding], !!opts(command).force); result = {connectionId:binding.connectionId, disconnected:true, filesPreserved:true};
    });
    flags(client.command('sync'), ...clientFlags, ...common, '--path <directory>', '--watch').action(async (_o, command) => {
      const dir = root(command), binding = discoverConnection(dir, opts(command).path ?? process.cwd());
      const service = new ClientService(dir, {owner:'CLI', onProgress:message => presentation.syncProgress(message, !!opts(command).watch)});
      try {
        if (!opts(command).watch) result = await service.sync(binding.connectionId);
        else {
          const controller = new AbortController(), stop = () => controller.abort();
          process.once('SIGINT', stop); process.once('SIGTERM', stop);
          try {
            await service.watch(binding.connectionId, controller.signal,
              head => presentation.synced(head), error => presentation.syncError(error));
          }
          finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
          result = {stopped:true};
        }
      } finally { await service.stop(); }
    });
    function configureHelp(command: Command) {
      if (command.commands.length) {
        command.addHelpCommand(true);
        command.allowExcessArguments().action(() => {
          if (command.args.length) {
            const invocation = ['nanosync', presentation.command].filter(Boolean).join(' ');
            throw new CliError('INVALID_INPUT', `Unknown subcommand: ${command.args[0]}. Run ${invocation} --help.`);
          }
          command.outputHelp();
        });
      }
      for (const child of command.commands) configureHelp(child);
    }
    configureHelp(program);
    program.hook('preAction', (_command, action) => {
      const path: string[] = [];
      for (let current: Command | null = action; current?.parent; current = current.parent) {
        path.unshift(current.name());
      }
      presentation.command = path.join(' ');
    });
    await program.parseAsync(args, {from:'user'});
    if (result !== undefined) presentation.result(result, resultCode);
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return 0;
    const interrupted = error instanceof Error && error.name === 'ExitPromptError';
    const code = error instanceof CliError ? error.code : interrupted ? 'INTERRUPTED' : error instanceof RemoteError ? error.code : error instanceof CommanderError ? 'INVALID_INPUT' : 'OPERATION_FAILED';
    const exitCode = error instanceof CliError ? error.exitCode : interrupted ? 130 : error instanceof RemoteError ? 5 : 2;
    let message = error instanceof Error ? error.message : 'Command failed';
    if (!presentation.json && error instanceof CommanderError) {
      message += '\nRun nanosync --help to see available commands and flags.';
    }
    presentation.error(code, message, exitCode);
    return exitCode;
  } finally { presentation.stop(); }
}
if (import.meta.main) process.exitCode = await main();
