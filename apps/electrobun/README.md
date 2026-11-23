# Nanosync desktop

Linux-first Electrobun client for issue [#18](https://github.com/FireSquid6/nanosync/issues/18),
using the approved Field Guide design. Connection onboarding and explicit sync
are implemented; this is not yet the complete desktop client.

## Available now

- Add connections to existing servers with URL, alias, device name and password;
  verify the enrollment code and resume approval after interruption or restart.
- Connect existing vaults to owned local folders, enter recovery keys when needed,
  and acknowledge reconciliation before connecting a nonempty destination.
- Read real server connections and folder bindings from the same private state
  directory as the CLI (`~/.nanosync` by default).
- Explicit one-shot synchronization using the existing engine, scanner, SQLite
  journal and recovery logic. Opening the app or refreshing never starts sync.
- Progress, failures, last successful sync, conflict counts and active ownership.
  A restarted app shows “Not checked” rather than treating past success as current.
- Authenticated local control forwards requests to a cooperating CLI/desktop sync
  owner instead of creating another writer. Quit stops desktop-owned work only.
- Explicit per-connection migration from protected files to the OS credential
  store for existing CLI connections. New desktop connections use the OS store
  directly; headless file-backed CLI operation is unchanged unless migrated.

Disconnecting folders, pause controls, ignore editing, conflict resolution,
opening connected folders, background/start-at-login preferences,
notifications and diagnostics are not yet connected in the live app. Unsupported
controls are omitted, not backed by fake successes. Currently, closing the native
window stops desktop-owned work; keep-running-after-close is not implemented.
A separate `--watch` cannot attach to an existing owner yet; one-shot requests can.
No tray, updater or server administration UI is included.

## Run

```sh
nix develop .#desktop
bun install --frozen-lockfile
bun run dev:electrobun
```

The desktop shell adds `secret-tool` from Nix's `libsecret`. The running user
session must provide a Secret Service implementation and an unlocked credential
store. Missing/locked credentials never fall back to plaintext. Electrobun's
pinned bootstrap downloads Hutch and its paired runtime into user caches; this
is not yet a Nix-packaged desktop release.

Use `NANOSYNC_CLIENT_DIR=/absolute/private/path bun run dev:electrobun` for an
isolated client directory. Do not test synchronization against irreplaceable
files. After changing the Electrobun configuration/native entrypoint, restart the
dev watcher to load it. A second build waits while that watcher holds its lock.

```sh
bun run build:electrobun
bun run typecheck:electrobun
```

## Add connections

1. In **Connections → Add connection**, enter the existing server URL, a local
   alias, a device name and the account password. Verify the displayed code with
   the server operator. **Open administration** opens only an advertised, safe
   administration URL in the system browser; approval is never performed in-app.
2. Use **Connect folder** to select an approved server and existing vault. Enter
   its recovery key only when it is not already cached in the OS store. Choose an
   existing folder through the native picker or enter its absolute path. Copies
   must not overlap each other or private client state. Existing local files are
   preserved and conflicting versions are kept when synchronization begins.
3. Connecting creates shared binding metadata only. Choose **Done** to leave it
   without transfers, or explicitly choose **Start syncing**.

Account passwords and recovery material are never saved. Pending desktop
identities survive restarts in private metadata, with their authentication tokens
in the OS store, not those metadata files. Denied/expired requests require an
explicit fresh request; temporary failures retry the same identity. Pending CLI
requests must be resumed through the CLI, then explicitly migrated for desktop
use. Pending desktop requests resume in the desktop. Neither interface silently
converts the other's credential mode or creates a competing pending identity.
Approved connections and local bindings are shared with the CLI.

This adds **connections** only: server setup and vault creation remain external.

## Credential migration

Connections created by the existing CLI remain protected-file connections until
explicitly migrated through Connections, or using the equivalent CLI command:

```sh
nanosync client connections migrate-credentials --server home
# For automation, --yes explicitly acknowledges the headless-access impact.
```

Stop active owners of affected bindings first. Migration writes and verifies the
OS-store record before committing its mode, then removes the protected-file
copies. A durable journal blocks use until interrupted migration cleanup is
retried. The Connections action remains available for unfinished migration.
Successful migration does not retain a file fallback; headless use may therefore
stop working without an unlocked desktop session. Existing backups/snapshots
cannot be retroactively erased. Do not roll back to an older CLI that does not
understand OS-store registration records.

## Tests

```sh
bun test packages/client-service packages/cli apps/electrobun/src
CHROMIUM_PATH="$(command -v chromium)" bun run test:electrobun
```

Service/native-handler integration tests use real local servers, enrollment and
operator approval, recovery keys, bindings, encrypted transfers and an independent
Bun owner process. Credential tests inject an in-memory store; they
do not unlock or change your actual keyring. Native credential-store behavior
and full window lifecycle still require Linux desktop smoke validation.

Browser tests exercise the live renderer using a test-only RPC transport with
explicit synchronization and fake clocks. The earlier complete mock UI remains
in `src/mainview/index.*` as an interaction fixture; it is **not** the native app
entrypoint. Its browser storage (`nanosync.desktop.mock.v1`) is unrelated to real
client state and is not migrated into it. Live data is obtained through typed
Electrobun RPC, never browser storage. No credentials/keys are returned in snapshots.

Native builds, packaging, credential-store integration, Bun SQLite behavior and
launcher/window lifecycle need real Linux validation before release. macOS and
Windows are not validated desktop targets. Issue #18 remains open.
