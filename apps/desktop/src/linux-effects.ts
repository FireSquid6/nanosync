import {
  constants,
  accessSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { secureRead } from '@nanosync/client-service';
import { unavailable, type NativeEffect } from './lifecycle';

declare const NANOSYNC_GDBUS: string;
declare const NANOSYNC_SYSTEMCTL: string;

async function commandOutput(
  tool: 'gdbus' | 'systemctl',
  args: string[],
): Promise<string | null> {
  const executable =
    tool === 'gdbus'
      ? typeof NANOSYNC_GDBUS === 'string'
        ? NANOSYNC_GDBUS
        : Bun.which(tool)
      : typeof NANOSYNC_SYSTEMCTL === 'string'
        ? NANOSYNC_SYSTEMCTL
        : Bun.which(tool);
  if (!executable) return null;
  try {
    const child = Bun.spawn([executable, ...args], { stdout: 'pipe', stderr: 'ignore' });
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      const reader = child.stdout.getReader(),
        chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 16384) {
            child.kill('SIGKILL');
            await reader.cancel();
            await child.exited;
            return null;
          }
          chunks.push(chunk.value);
        }
      } catch {
        child.kill('SIGKILL');
        await child.exited;
        return null;
      } finally {
        reader.releaseLock();
      }
      return (await child.exited) === 0 ? Buffer.concat(chunks).toString('utf8').trim() : null;
    } finally {
      clearTimeout(watchdog);
    }
  } catch {
    return null;
  }
}
export async function trayWatcherAvailable() {
  if (!process.env.DBUS_SESSION_BUS_ADDRESS) return false;
  const owned = await commandOutput('gdbus', [
    'call',
    '--session',
    '--dest',
    'org.freedesktop.DBus',
    '--object-path',
    '/org/freedesktop/DBus',
    '--method',
    'org.freedesktop.DBus.NameHasOwner',
    'org.kde.StatusNotifierWatcher',
  ]);
  if (owned !== '(true,)') return false;
  const host = await commandOutput('gdbus', [
    'call',
    '--session',
    '--dest',
    'org.kde.StatusNotifierWatcher',
    '--object-path',
    '/StatusNotifierWatcher',
    '--method',
    'org.freedesktop.DBus.Properties.Get',
    'org.kde.StatusNotifierWatcher',
    'IsStatusNotifierHostRegistered',
  ]);
  return trayHostAvailable(owned, host);
}
export function trayHostAvailable(owner: string | null, host: string | null) {
  return owner === '(true,)' && host === '(<true>,)';
}
export async function ownTrayRegistered(trayId?: number) {
  if (!trayId) return false;
  const items = await commandOutput('gdbus', [
    'call',
    '--session',
    '--dest',
    'org.kde.StatusNotifierWatcher',
    '--object-path',
    '/StatusNotifierWatcher',
    '--method',
    'org.freedesktop.DBus.Properties.Get',
    'org.kde.StatusNotifierWatcher',
    'RegisteredStatusNotifierItems',
  ]);
  if (!items) return false;
  // GVariant strings are accepted only in the restricted D-Bus service/path alphabet.
  const entries = [...items.matchAll(/'([:A-Za-z0-9_.-]+)(\/[A-Za-z0-9_\/]+)'/g)].filter(
    (match) => new RegExp(`/electrobun_tray_${trayId}_[0-9]+$`).test(match[2]!),
  );
  // shortcut: probe at most eight matching candidates; use a structured bus client if hosts exceed this bound.
  for (const entry of entries.slice(-8).reverse()) {
    const service = entry[1]!,
      path = entry[2]!;
    const owner = await commandOutput('gdbus', [
      'call',
      '--session',
      '--dest',
      'org.freedesktop.DBus',
      '--object-path',
      '/org/freedesktop/DBus',
      '--method',
      'org.freedesktop.DBus.GetConnectionUnixProcessID',
      service,
    ]);
    if (owner !== `(uint32 ${process.pid},)`) continue;
    const status = await commandOutput('gdbus', [
      'call',
      '--session',
      '--dest',
      service,
      '--object-path',
      path,
      '--method',
      'org.freedesktop.DBus.Properties.Get',
      'org.kde.StatusNotifierItem',
      'Status',
    ]);
    if (status === "(<'Active'>,)") return true;
  }
  return false;
}
export async function autostartConsumerAvailable() {
  if (!process.env.DBUS_SESSION_BUS_ADDRESS) return false;
  const directories = [
    ...(process.env.XDG_RUNTIME_DIR
      ? [join(process.env.XDG_RUNTIME_DIR, 'systemd/user-generators')]
      : []),
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd/user-generators'),
    '/etc/systemd/user-generators',
    '/run/systemd/user-generators',
    '/usr/local/lib/systemd/user-generators',
    '/usr/lib/systemd/user-generators',
    '/lib/systemd/user-generators',
    '/run/current-system/systemd/lib/systemd/user-generators',
  ];
  let generator: string | undefined;
  for (const directory of directories) {
    const candidate = join(directory, 'systemd-xdg-autostart-generator');
    try {
      lstatSync(candidate);
      generator = candidate;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
  }
  if (!generator) return false;
  try {
    const resolved = realpathSync(generator),
      stat = lstatSync(resolved);
    if (!stat.isFile() || stat.uid !== 0 || stat.mode & 0o022) return false;
    accessSync(resolved, constants.X_OK);
  } catch {
    return false;
  }
  const properties = await commandOutput('systemctl', [
    '--user',
    'show',
    'xdg-desktop-autostart.target',
    '--property=LoadState',
    '--property=ActiveState',
  ]);
  return properties?.split('\n').sort().join('\n') === 'ActiveState=active\nLoadState=loaded';
}

/** Desktop Entry Exec grammar, not shell quoting; percent is a field-code escape. */
export function desktopExec(argv: string[]) {
  return argv
    .map((value) => {
      if (/[\u0000-\u001f\u007f]/u.test(value)) throw Error('STARTUP_ARGUMENT_INVALID');
      return `"${value
        .replaceAll('%', '%%')
        .replace(/[\\"`$]/g, '\\$&')
        .replaceAll('\\', '\\\\')}"`;
    })
    .join(' ');
}

export function launcherEvidenceValid(launcher: string, evidence: unknown): boolean {
  if (!evidence || typeof evidence !== 'object') return false;
  const value = evidence as Record<string, unknown>;
  return (
    Object.keys(value).sort().join(',') === 'argv,launcherSha256,sdkCommit,version' &&
    value.version === 1 &&
    value.argv === 'verified-resources-main-worker-v1' &&
    value.sdkCommit === 'c9e637c4e8acc8d53fc4a1703346196b004a00d8' &&
    value.launcherSha256 === createHash('sha256').update(readFileSync(launcher)).digest('hex')
  );
}

export function installedLauncher(): string | null {
  // Installation wrappers are the stable public command; argv0 is the SDK's inner Bun.
  const candidates = [
    join(homedir(), '.nix-profile/bin/nanosync-desktop'),
    '/run/current-system/sw/bin/nanosync-desktop',
    '/usr/bin/nanosync-desktop',
  ];
  for (const path of candidates) {
    try {
      const resolved = realpathSync(path),
        stat = lstatSync(resolved);
      if (
        !stat.isFile() ||
        stat.mode & 0o022 ||
        ![0, process.getuid!()].includes(stat.uid) ||
        !(resolved.startsWith('/nix/store/') || resolved === '/usr/bin/nanosync-desktop')
      )
        continue;
      accessSync(path, constants.X_OK);
      const evidencePath = resolved.startsWith('/nix/store/')
        ? join(dirname(dirname(resolved)), 'share/nanosync/desktop-launcher.json')
        : '/usr/share/nanosync/desktop-launcher.json';
      const evidenceStat = lstatSync(evidencePath);
      if (
        !evidenceStat.isFile() ||
        evidenceStat.uid !== 0 ||
        evidenceStat.mode & 0o022 ||
        evidenceStat.size > 4096
      )
        continue;
      if (!launcherEvidenceValid(resolved, JSON.parse(readFileSync(evidencePath, 'utf8'))))
        continue;
      return path;
    } catch {
      /* A missing installation is unavailable, never a development-path fallback. */
    }
  }
  return null;
}
const marker = '# Managed by Nanosync desktop lifecycle v1\n';
function ownedDirectory(path: string) {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid!() ||
    stat.mode & 0o022 ||
    realpathSync(path) !== path
  )
    throw Error('STARTUP_DIRECTORY_UNSAFE');
}
function flushDirectory(path: string) {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
function writeEntry(path: string, text: string, replacing: boolean) {
  const stage = replacing ? `${path}.${randomBytes(16).toString('hex')}.stage` : path;
  const descriptor = openSync(
    stage,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, text);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  if (replacing) renameSync(stage, path);
  flushDirectory(dirname(path));
}
export function reconcileStartup(options: {
  enabled: boolean;
  root: string;
  configHome: string;
  launcher: string | null;
  consumer: boolean;
}): NativeEffect {
  const { enabled, root, configHome, launcher, consumer } = options;
  const name = `nanosync-${createHash('sha256').update(root).digest('hex').slice(0, 32)}.desktop`;
  try {
    if (!isAbsolute(configHome)) throw Error('CONFIG_HOME_INVALID');
    // Never create/edit a foreign or Nix-managed registration, even when disabling.
    const directory = join(configHome, 'autostart'),
      path = join(directory, name);
    if (existsSync(configHome)) ownedDirectory(configHome);
    if (existsSync(directory)) ownedDirectory(directory);
    const expectedPrefix = `${marker}# Profile ${createHash('sha256').update(root).digest('hex')}\n`;
    const present = existsSync(path);
    if (present && !secureRead(path, 16384).toString().startsWith(expectedPrefix))
      return unavailable(
        'Startup entry is user/Nix managed. Remove or manage that entry yourself; it was not changed.',
      );
    if (!enabled) {
      if (present) {
        unlinkSync(path);
        flushDirectory(directory);
      }
      return {
        available: null,
        applied: false,
        message:
          'Login startup is off; no Nanosync-managed entry remains. Consumer availability was not probed.',
      };
    }
    if (!launcher)
      return unavailable(
        'Login intent saved. A trusted installed nanosync-desktop wrapper with verified Resources/main.js → Worker argument forwarding is required. The upstream outer launcher, development and inner Bun paths are not registered.',
      );
    if (!consumer)
      return unavailable(
        'Login intent saved, not installed. No proven active XDG autostart consumer/generator. Configure your session manager explicitly; graphical-session.target alone is insufficient.',
      );
    ownedDirectory(configHome);
    ownedDirectory(directory);
    const text = `${expectedPrefix}[Desktop Entry]\nType=Application\nName=Nanosync\nExec=${desktopExec([launcher, '--startup', '--client-dir', root])}\nTerminal=false\n`;
    if (present) {
      if (secureRead(path, 16384).toString() !== text) writeEntry(path, text, true);
    } else writeEntry(path, text, false);
    if (secureRead(path, 16384).toString() !== text) throw Error('STARTUP_ENTRY_CHANGED');
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    flushDirectory(directory);
    return {
      available: true,
      applied: true,
      message:
        'Owned XDG startup registration installed for the active consumer. New-login execution still requires installed-session validation.',
    };
  } catch {
    return unavailable(
      'Startup effect failed or its directory/entry is unsafe/read-only. Intent is retained. Check your owned XDG autostart configuration.',
    );
  }
}
