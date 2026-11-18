# Native Android client

The Android product is an offline-first **synchronization dashboard**, not a file
manager or editor. The specification is [issue #6](https://github.com/FireSquid6/nanosync/issues/6);
[implementation milestones and verification gates](android-implementation.md)
track completion. Minimum Android version is 12. Pixel 9 on Android 17 is the
required real-device acceptance target; emulator success is not that acceptance.

## Connections and storage

The home page groups connected vaults under collapsible servers. **Add new
server** enrolls an approved device; **Connect vault** attaches an existing remote
vault to a local folder. Enrollment remains password authentication,
administrator approval, then per-vault recovery-key decryption. Pending enrollment
is resumable and independent per server.

Each vault uses one ordinary, supported shared local folder. Android controls
other applications' access, including the exception for applications with broad
file permissions; Nanosync does not enforce an application allowlist. The native
path adapter needs Android's **All files access** grant as well as a selected
supported destination. A system picker grant alone does not provide the native
filesystem access used by this implementation. Protected Android directories,
cloud document providers and unsupported volumes must be rejected visibly.

Shared files are plaintext, relying on device encryption and Android permissions.
There is no second authoritative app-private mirror. Credentials, keys, journals,
transfer stages and synchronization metadata remain private; saved configuration
is authenticated-encrypted using Android Keystore key material. Copies made by
external applications are outside Nanosync's lifecycle control.

- Reject overlapping roots across connections.
- Import populated folders safely; initial local absence is not a remote deletion.
- Keep every current non-ignored entry verified offline before reporting success.
- Follow existing device-local `.nanosyncignore` rules, without editor-specific
  exclusions. Never traverse an excluded directory merely to build an inventory.
- Preserve stable manifest entry IDs across supported moves and renames.
- Preserve both versions of concurrent edits; show conflict counts and paths for
  external resolution. Delete/edit conflict behavior remains protocol-defined.
- Treat permission loss, failed enumeration and unavailable storage as blocked
  synchronization, never as an empty folder or mass deletion.
- Preflight additional capacity and preserve the last complete local state when
  space is insufficient. Files up to the protocol's 50 GB limit require bounded
  chunk processing, not whole-file buffers.

Disconnecting stops work and removes no-longer-needed private synchronization
state/keys. Removing a server disconnects its vaults and forgets its credentials.
Neither action deletes the shared files or revokes the device remotely; remaining
plaintext files are still readable by applications Android permits to access them.

## Runtime boundaries

Native UI, settings, scheduling, permissions, HTTP and folder operations are
separate from the portable protocol, cryptography, merge and reconciliation code.
The Linux CLI keeps its own Bun/POSIX adapters and ownership lifecycle. Android
must not import those adapters or weaken their safety checks to make them run.

The Android computation worker executes only bundled synchronization JavaScript
on a restricted local HTTPS asset origin in WebView. It is not a remotely hosted
UI. External resource loading/navigation and file/content URLs are blocked;
network access goes through a native transport scoped to the configured server.
Native requests enforce network policy and reject redirects. Runtime loss is a
failed/recoverable run, never a successful synchronization result.

The native journal persists frozen publication requests, verified transfer state
and apply checkpoints. Recover pending work before scanning for new changes.
Writes stage away from the last complete file, validate sources and destination
preconditions, and only then commit. Reauthenticate resumed chunks. Durably
complete filesystem and metadata application before advancing the applied head.

The WebView runtime is replaceable and must pass platform feasibility tests,
including service-only creation, renderer/process death, screen-off operation,
and required Web API feature checks. A successful TypeScript test does not prove
those platform behaviors. No synchronization authority belongs in browser
localStorage or IndexedDB.

## Controls and network policy

Each vault page shows actual connection/sync state, last success, pending
uploads/downloads, progress, errors, conflicts, folder and sync controls.

- **Background sync** is explicitly enabled per vault, including during initial
  synchronization. A consolidated ongoing notification makes active work visible.
- Initial synchronization reports scanning, reconciliation, download paths and
  saved byte counts, application, and final verification rather than silent waiting.
- **Pause** stops uploads and downloads but leaves local editing available.
- **Sync now** performs one full reconciliation, even while paused, and restores
  the existing persistent pause/background preferences afterwards.
- Global settings include a **default mobile-data policy**, asked in an onboarding
  popup. A vault chooses **Use global default**, **Allow mobile data**, or
  **Wi-Fi only**. Make the editing scope and effective inherited value explicit.
- Manual work that needs a mobile-data exception prompts for that run only,
  without changing either stored policy.
- HTTPS is required unless the easily discoverable global **Allow HTTP
  connections** setting is enabled. That developer option is not per-server and
  does not disable HTTPS certificate validation.

Vaults have independent work ownership and failures. One offline server, blocked
folder or failed connection must not block healthy vaults. Bound shared resources
without starving other connections. Retry temporary network failures with backoff;
notify about actionable errors/conflicts without repeated notification spam.

## Background execution is best-effort

Native scheduling drives reconciliation; it must not rely on hidden WebView
interval timers. Periodic scans recover missed external-save events; stable-save
sync targets a few seconds when execution and connectivity permit.

A configured background preference is not evidence that work is currently
running. Android can deny starts, stop the process or restrict networking. Modern
`dataSync` foreground services have a background time budget (six hours per
24-hour period on applicable Android versions, shared by the application's
services). Stop promptly on timeout and show the restriction. Do not misrepresent
a foreground service as a guarantee of uninterrupted synchronization.

Remember enabled preferences across restart and attempt Android-supported
recovery after reboot/unlock. Do not directly start a prohibited `dataSync`
foreground service from `BOOT_COMPLETED`; use supported deferred work and expose
when user intervention is necessary. Force-stop and OEM/platform restrictions
remain limitations, not reasons to discard pending work.

## Verification

Prefer one high-level seam: native app, real server, second existing client, and
ordinary shared folders edited by a simple external editor. Verify observable
files, convergence, settings, status and notifications. Reuse portable protocol,
crypto, merge and ignore vectors plus existing Linux real-server tests.

Android instrumentation covers folder access, permissions, secure storage,
renderer/service lifecycle and platform execution. Required cases include initial
import, offline/concurrent saves, rename/delete, conflicts, ignored paths,
interrupted transfer/apply, permission loss, insufficient storage, revocation,
network-policy exceptions and independent vault progress. Build success and
small chunk fixtures do not prove completed 50 GB transfer/resume behavior.

## Deferred platforms and features

This scope does not include iOS, a built-in editor/file browser, selective
on-demand files, history/restore UI, visual merge tools, server administration,
vault creation or Play Store distribution. Prior iOS File Provider and Android
app-private DocumentsProvider proposals are not requirements for this client.
