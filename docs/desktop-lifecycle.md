# Desktop lifecycle — issue 18, step 10

This is implementation scope, not installed-session certification. The native gate uses only disposable Xvfb, HOME/XDG directories and activation-free private D-Bus. No host panel, keyring, user startup configuration or compositor/login service is changed. Notifications/diagnostics and release packaging remain steps 11/12.

## Trusted main and saved intent

`apps/desktop/src/main.ts` applies shared settings v2 without rewriting them. Native reconciliation rereads preferences after capability probes. Periodic ticks skip a pending probe; explicit settings changes await a fresh follow-up. Close reads current preferences synchronously, including CLI edits. There is no cached preference writeback and no new daemon, encryption implementation or SQLite path.

Snapshots expose `lifecycle.{startup,tray,session}` with independent `available` (true/false/null = unprobed), `applied` and fixed actionable `message`, plus closing/shutdown-error state. General settings consumes fresh parent observations while preserving the draft's original CAS revision. Its requests share the Folders mutation epoch; a pre-save poll cannot overwrite a mutation response. Failed reads demote native observations to unknown/historical. Neither a saved checkbox nor a successful file write certifies a working native integration.

## Close, launcher and Quit

Keep-after-close defaults true: synchronous `will-close` veto then hide, regardless of tray choice/availability. Keep-off closes through safe Quit. `before-quit` vetoes synchronously, coalesces cleanup, then re-enters `Utils.quit()` only after success. The maintained SDK's `quitGracefully` path is retained. Renderer Quit enters this same coordinator immediately, so singleton activation honestly refuses while closing. Metadata remains readable; mutations/new work are refused. A failed stop retains ownership, reports failure and permits explicit retry.

Existing backend shutdown remains authority: stop admission, abort enrollment/desktop remote work, detach attached clients, await in-flight operations and own runners, journal/key cleanup and lock release. Independent CLI owners survive; global/folder pause flags are not changed. Continuous intent remains persisted, but restart only attempts explicitly accepted desktop-origin work with no observed owner, valid OS-store state and proven session association. CLI-origin watch intent is never adopted.

Ordinary authenticated launcher activation shows/focuses the known window. A destroyed window gets a **new** window/RPC/view with packaged-only navigation. Startup activation pings without raising an existing window. A fresh `--startup` launch is hidden with keep-on and visible with keep-off; persisted login-off refuses startup work and removes only a recognized owned registration. The existing CSP, SDK bootstrap/aliases/provenance, trusted argv folder opener and Paper notice remain in place.

### Linux singleton boundary

`singleton.ts` reuses shared `privateDirectory`, checked secure state and the existing atomic PID + `/proc` start-time/inode ownership lock, not a new PID-death algorithm. Before identity capture it creates only an empty owned 0700 client directory, **not** credentials or bindings. Canonical aliases share identity; different canonical profiles have different endpoints.

Runtime state is outside the credential root, under checked 0700 `/tmp/nanosync-desktop-UID/<canonical-root-hash>`. A 0600 socket/capability/discovery record binds root device/inode, session identity, lock process/starttime/inode, instance-directory inode and socket inode. Main revalidates identity before RPC/native reconciliation; a replaced root initiates own shutdown rather than rebinding work to the replacement.

The endpoint accepts only authenticated `reopen`/`ping` on one fixed route, with 32-byte body and eight concurrent readers. Exact `Bearer ` plus 64 lowercase hex characters is checked before constant-time byte comparison, including malformed/non-ASCII requests. There is no generic execution, path/URL/SQL/credential operation or new TCP listener. The SDK's existing authenticated renderer loopback transport is separate.

Unavailable/live/uncertain ownership, different sessions and lost replies never authorize a second owner. Only successful shared lock acquisition after definitive process-identity death permits stale endpoint cleanup. Wrong permissions, substituted identities and discovery publication gaps fail closed. Same-UID compromise able to read private capabilities, root compromise and forensic erasure are not isolated by this transport.

## Session association and logout limits

`linux-session.ts` uses maintained libsystemd `sd_pid_get_session`, session UID/type/display/state APIs and `sd_login_monitor_new/flush`. It rechecks at sync admission and every second while alive. Closing/removal or a failed monitor/query stops admission and invokes existing own-only shutdown. `online` is accepted: lock/VT switching and `Active=false` are **not** logout. This is periodic observation, not an instantaneous logout deadline or a claim that a user-manager cgroup belongs to a login session.

Association provenance is retained:

- Own-PID association: local matching-UID graphical session, app X11 backend, nonempty DISPLAY. A Wayland **login session** may run the XWayland app and normally has no logind X display; that is distinct from native GTK Wayland.
- Only `-ENODATA`, not permission/identity uncertainty, permits trying an explicitly inherited `XDG_SESSION_ID`. It is revalidated against UID/local/type/state **and a positive exact logind display match**. Empty Wayland display plus an inherited ID is not proof: stale session-A user-manager environment with current display B fails closed. No UID-session enumeration/guessing is performed.
- An unproven association uses an unassociated display identity for the singleton, not the stale inherited session ID. It exposes unavailable logout safety and blocks desktop synchronization. Many Wayland user-manager launches therefore remain unavailable until a positive association mechanism is validated; CLI ownership is independent.

The app's worker records `GDK_BACKEND=x11` before SDK import. This JavaScript assignment alone is not native-environment proof: a parent Bun 1.4.4 FFI probe showed it does not update libc `getenv`. The pinned native wrapper independently calls C `setenv("GDK_BACKEND", "x11", 1)` immediately before `gtk_init` (`native/linux/nativeWrapper.cpp`, `initializeGTK`), enforcing the actual X11/XWayland backend. Native GTK Wayland is not validated. libsystemd is project-Nix-provided/pinned into the desktop build; absence fails closed without creating a CLI dependency.

The source-preparation probe (`/tmp/nanosync-issue18-lifecycle-prep.md`) observed private X-display loss killing hidden/no-window applications with exit 1 **without** a before-quit hook. That is crash-recovery fallback evidence, not graceful logout detection, proof that every logout disconnects a display, or native Wayland certification. No host logout was performed here. Existing filesystem/recovery barriers are unchanged.

## Optional tray

False/null choice constructs no Tray. Availability requires the standard watcher owner **and** `IsStatusNotifierHostRegistered=true`. Applied status additionally requires the current pinned AppIndicator tray-ID object path in the watcher's registry, its D-Bus owner PID equal to this process, and native item `Status=Active`. Constructor success/`Tray.visible` alone is insufficient. A missing/failed registration remains unapplied with launcher guidance.

Read-only tool calls use build-pinned Nix gdbus/systemctl paths, a streaming 16 KiB output bound and a kill/reap watchdog. At most eight matching tray-ID registry candidates are probed; pathological hosts exceeding that bound remain honestly unproven rather than applied. This pinned Linux backend is menu-only: exactly **Open Nanosync**, no Pause/Quit and no assumed raw primary-icon activation. Host loss removes the integration; recreation reinstalls the menu. Tray failure never prevents hiding, syncing or authenticated launcher reopening.

Aggregate shared attention, not synchronization completion, selects the icon/title: normal work, deliberate pause and brief offline periods are green/no-intervention; actionable failures/conflicts are red with a distinct diamond/exclamation shape and status text. Titles omit paths/filenames. There is no notification delivery. Actual host-panel presentation and accessibility still require release smoke testing.

## Startup registration and installed-launcher prerequisite

Start-at-login is opt-in, session-only XDG autostart, never a pre-login/lingering service. The native adapter requires an active loaded `xdg-desktop-autostart.target` and a checked standard systemd XDG generator (respecting higher-priority masks/overrides). `graphical-session.target` alone is not consumer evidence, including Hyprland. Other/nonstandard managers remain unavailable rather than guessed supported. Real new-login execution remains unclaimed.

Only a profile-hashed, exactly marked owned regular 0600 `.desktop` entry is managed. Owned real non-group/world-writable XDG directories may be 0755; no chmod of user directories occurs. Foreign, symlink, hardlink, Nix-managed, unsafe/read-only or failing entries are not overwritten. Replacement/content and directory fsync failures report unavailable while intent remains saved; a matching visible entry is flushed/revalidated before later claiming success. Startup has no secret arguments. Exec uses Desktop Entry quoting/`%%`, not shell escaping. A private `gio launch` probe asserts exact special-character argv, including percent, whitespace, quotes, backticks, dollar and backslash.

**A stable executable name is not argv evidence.** The upstream outer launcher discards ordinary arguments. Prerequisite commit `82f6117` fixes/verifies forwarding in the maintained `Resources/main.js` Worker and extends runtime provenance, but does not prove the outer launcher or an installed Nix public wrapper. No environment-variable argv channel or runtime-verification bypass is introduced.

Until step 12 supplies a tested installed public wrapper, login intent is **unavailable/unapplied**. `installedLauncher()` only considers the standard Nix profile/system profile or `/usr/bin/nanosync-desktop`, never inner Bun, a development path or SpikeSetup. Its immutable/root-owned installation evidence is `share/nanosync/desktop-launcher.json` beside the resolved package prefix (`/usr/share/nanosync/...` for `/usr/bin`), a bounded regular non-group/world-writable file:

```json
{
  "version": 1,
  "argv": "verified-resources-main-worker-v1",
  "sdkCommit": "c9e637c4e8acc8d53fc4a1703346196b004a00d8",
  "launcherSha256": "<actual installed public wrapper SHA-256>"
}
```

The wrapper hash is checked. This marker is a release-test prerequisite/attestation, not cryptographic proof that arbitrary executable contents forward argv. It must only be emitted after the actual installed public-wrapper → verified Resources/main.js → Worker chain passes the private installed gate. Step 10 installs no such wrapper/evidence and makes no installed startup claim.

## Verification surfaces

- `apps/desktop/tests/lifecycle.test.ts`: veto/cleanup barriers, retry, startup matrix/argv/foreign entries/fsync failure, provenance/stale inherited session, closing/loss, tray owned-but-host-false/registration/health/recreation, private singleton auth/death/live uncertainty/profiles/aliases/root replacement, preference CAS and periodic probe backlog.
- `apps/desktop/tests/folders.test.ts`: real held desktop/external CLI remote work stopped/detached through Quit, selected-session closing and monitor loss, preserving intent/pauses and CLI ownership.
- Browser Folders/General tests: fresh native facts without resetting drafts, failed-read demotion, deferred pre-save poll exclusion, CLI revision conflicts and light/dark accessibility. Existing onboarding assertions now describe observed effects, not step-7 nonimplementation.
- `nix develop --command bun build/desktop/lifecycle-gate.ts`: actual maintained SDK, real helper/backend/singleton, private Xvfb and no-activation private bus/system-bus address. Proves hide/reopen without tray, new-window recreation, authenticated cross-process reopening, missing watcher, watcher-owned/host-false, actual fake-host registration/menu activation/title and distinct icon update, host loss, explicit Quit and keep-off Close with deferred cleanup. Zero owned fixture process groups must remain. Python dbus-next is test-only project Nix tooling; it is not a product daemon/dependency.
- SDK fatal/normal gates, workspace/tools/native types, both Bun suites, browser tests, binary/default Nix/stable desktop build remain independent gates. Installed login/logout, real compositor focus/keyboard behavior and host-panel presentation remain step 12, not claims derived from fixtures.
