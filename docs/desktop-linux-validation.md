# Linux Electrobun validation spike (issue #18, step 2 only)

## Scope and result

Validated on 2026-11-18, EndeavourOS x86_64, Hyprland Wayland with XWayland
(`DISPLAY=:1`, `WAYLAND_DISPLAY=wayland-1`). This is community-distro evidence,
not an Ubuntu, pure-Wayland, NixOS, macOS, or Windows support claim. Official
Linux support starts at Ubuntu 24.04; other distributions are community supported.

The scoped toolkit gate has evidence for a real rendered window, native Linux
tray/menu and close/hide/reopen/Quit (dev bundle), packaged Bun SQLite using
**ClientLocal**, disposable Secret Service storage, folder picker cancellation,
and opening a disposable folder in the native file manager. Stable packaging,
installation, and startup were also exercised. Full stable-package lifecycle
regression remains pending; this is not the finished desktop client.

No syncing, onboarding, shared-state migration, ownership IPC, login startup,
notifications, settings, or updater is implemented. No keyboard-onboarding claim.

## Official API/version sources inspected

All source references are pinned to [Electrobun v2.0.6](https://github.com/blackboardsh/electrobun/tree/v2.0.6):

- `docs/src/content/docs/electrobun/apis/browser-window.mdx`: `requestClose`,
  `show`, `hide`, `isVisible`, and window events.
- `docs/src/content/docs/electrobun/apis/tray.mdx`: install the menu before
  interaction; Linux AppIndicator needs a menu. Tray images accept bundled URLs.
- `docs/src/content/docs/electrobun/apis/utils.mdx`: `openFileDialog` returns
  `string[]` (empty means cancelled), `openPath` returns success, `quit`.
- `docs/src/content/docs/electrobun/apis/cli/build-configuration.mdx`: Bun main
  process, native renderer, pinned Hutch config, generated project devkit.
- The generated official SDK's `proc/native.ts` confirms `will-close` must set
  `event.response = { allow: false }` to prevent destruction before hiding.
- npm `electrobun@2.0.6` is a bootstrap, **not** the SDK. Its official resolver
  pairs Hutch **0.29.0**; Hutch downloaded Cottontail **0.7.3** and the release's
  Bun **1.4.4**. Generated `build.json` confirms Bun/native renderer.

## Reproduce without global tool installation

From the repository root:

```sh
nix develop
bun install --frozen-lockfile
bun run typecheck
bun test apps/desktop/tests/storage.test.ts
bun run --cwd apps/desktop prepare:native
bun run --cwd apps/desktop typecheck:native
bash apps/desktop/tooling.sh build --env=dev
apps/desktop/build/dev-linux-x64/NanosyncSpike-dev/bin/launcher
```

`tooling.sh` downloads the official release's Linux x64 Hutch archive into
`.cache/desktop-toolchain`, checks SHA-256
`4aa3c5c7fa24898d8227b087dd393eb2a1463658f0d87e23a72cfe611af83b75`,
sets `ELECTROBUN_HUTCH_BINARY` and checkout-local `HUTCH_HOME=.cache/hutch`, and
never runs `init` or the global installer. Hutch release/runtime downloads and
`.hutch/devkit` are generated, ignored state. Network access is needed on first
prepare/build; an offline/reproducible desktop Nix derivation is **not** claimed.
The helper accepts only prepare/build/run/dev/config, not update/init.

The flake shell provides Bun/Node, archive/download tooling, GTK3, WebKitGTK4.1,
Ayatana AppIndicator, librsvg, libsecret's `secret-tool`, D-Bus/GLib and xdg-utils.
`nix develop --command ...` successfully resolved `secret-tool` and pkg-config
reported GTK **3.24.52**, WebKit **2.54.0**, Ayatana **0.5.92**, Bun **1.4.2**.
`nix develop --command bash apps/desktop/tooling.sh build --env=dev` also passed.
Actual UI smoke tests used the host graphical runtime and release-packaged Bun;
NixOS GPU/portal/runtime behavior is not inferred from shell evaluation.

### Typechecking boundary

A pristine frozen install plus root `bun run typecheck` works **without** the
ignored desktop devkit (tested by moving it out of the way). Baseline desktop
`typecheck` checks storage/selfcheck/RPC types/tests, not native/view/config
modules. `prepare:native` then `typecheck:native` checks those modules against
**real official generated SDK sources**, with no fake declarations. CI wanting
native SDK coverage must explicitly prepare it; baseline CI does not prove native
API compatibility. Electrobun's generated SDK is not yet a pinned offline input.

## Observed native evidence

Development bundle launched its own packaged Bun, not PATH Bun. Process log:

```text
SQLite PASS { sequence: 1, synchronous: 2 } Bun 1.4.4
Secret Service roundtrip + deletion PASS (no secret logged)
Native window created; tray visible: true
Close intercepted; hidden, process remains alive
Tray reopened window
Picker returned 0 selection(s); paths not logged
openPath accepted disposable directory
Explicit Quit
Tray.remove() called for id: 1
[stopEventLoop] Initiating clean event loop exit
```

- A screenshot of **only the test window** confirmed rendered heading and four
  buttons. Hyprland identified it as `NanosyncSpike-dev`, XWayland, mapped/visible.
- StatusNotifierWatcher registered the test's own
  `/org/ayatana/NotificationItem/electrobun_tray_1_0`. D-Bus introspection reported
  title `Nanosync validation — no sync running`, `Status=Active`, bundled SVG icon.
  `com.canonical.dbusmenu.GetLayout` returned exactly one item, **Open Nanosync**.
  Invoking that item's `Event(..., "clicked", ...)` reopened the hidden window;
  the native `isVisible()` assertions passed. No tray Quit/pause controls.
- The window button calls the real `requestClose()` path; `will-close` prevents
  destruction and hides. The process survived and reopened through its own menu.
  Explicit **window Quit** removed its tray and exited its process. This proves
  the basic API path, not real syncing or launcher/single-instance reopening.
- `Utils.openFileDialog` reached GTK's native chooser and returned cancellation.
  Successful folder selection is still pending; no selected user path is logged.
  `Utils.openPath` opened an empty generated `/tmp/nanosync-desktop-open-*` folder
  in Dolphin. Only that test file-manager window was closed during cleanup.
- The maintained **libsecret `secret-tool` adapter** stored a random disposable
  secret via stdin, looked it up with exact namespaced attributes
  (`application=org.nanosync.validation`, random `probe`), cleared it, and asserted
  lookup then failed. No existing secrets were enumerated, read, or altered.
  Assertions do not print secret values. No plaintext fallback. This validates
  the integration choice, not production credential-mode/migration behavior.
- `ClientLocal` was instantiated in a private temp directory, wrote an observed
  head, closed/reopened, verified persistence and FULL synchronous SQLite, then
  removed the directory. Its constructor also exercises migrations/WAL/schema
  integrity. This is an assert-based packaged selfcheck and a deterministic test;
  no sleep-based tests.

Nonfatal host/runtime diagnostics were GTK theme `border-spacing`, an initial
`GLXBadWindow`, deprecated libayatana-appindicator, unavailable tracker3 search,
and Electrobun's message that Linux application menus are unsupported. The
window rendered and the tested APIs worked despite these messages; the spike
uses webview buttons, not an application menu. Pure Wayland was not tested.

## Stable package and CLI Nix checks

```sh
bun run --cwd apps/desktop build
# CAUTION: this next command INSTALLS the test app into the current user's home:
apps/desktop/build/stable-linux-x64/NanosyncSpike/bin/launcher
# For console evidence on the installed app:
ELECTROBUN_CONSOLE=1 ~/.local/share/org.nanosync.validation/stable/app/bin/launcher
```

Stable build emitted `linux-x64-NanosyncSpike-Setup.tar.gz` and the self-extracting
bundle. The launcher extracted/installed under
`~/.local/share/org.nanosync.validation/stable`, created test-only application and
Desktop shortcuts, and launched a rendered native window. With
`ELECTROBUN_CONSOLE=1`, stable startup also logged packaged Bun **1.4.4**, successful
ClientLocal/credential checks and native tray creation. No `release.baseUrl` is
configured and no updater is called. Upstream still emits update-manifest/archive
build artifacts; those artifacts are not an enabled runtime updater.

Stable lifecycle was **not** fully verified: initial synthetic-key targeting was
unreliable; a later `xdotool windowclose` destroyed the X window directly (GTK
reported `unexpectedly destroyed`) rather than exercising Electrobun's graceful
close path. That is not evidence of graceful-close support or a toolkit defect.
The remaining own stable process was terminated for cleanup. Repeat the stable
lifecycle with real window controls before release. All generated test shortcuts,
installed namespaced app/cache, test file-manager windows, and disposable folders
were removed. Development Quit cleanup now explicitly removes the disposable
folder because native `Utils.quit()` did not reliably run Node's `exit` handler.

The CLI's all-workspace frozen/offline install requires the desktop dependency in
`build/nix/bun.nix`; regenerated using:

```sh
nix run --inputs-from . bun2nix -- -c ../../ -o build/nix/bun.nix
nix build --no-link
```

While desktop files were untracked (parent owns commits), equivalent verification
used a path-based `pkgs.callPackage ./build/nix/package.nix` expression with this
flake's pinned nixpkgs/bun2nix, so new files were included rather than silently
filtered by Git. The actual derivation, including **frozen offline Bun install**,
built successfully after the workspace change. The resulting CLI `--help` ran.
After staging all step-2 files, the parent also ran the normal `nix build --no-link`
successfully against the Git-visible flake source, and rebuilt the stable desktop
bundle. This is the existing CLI Nix package, **not** a desktop Nix package.

Checks: full Bun suite **336 passed / 0 failed**; pristine baseline and prepared
native typechecks passed; dev and stable builds passed; `git diff --check` passed.
Codehygiene passed touched implementation files except an intentional false
positive on the SDK's empty RPC schema type (`requests: {}; messages: {}`), retained.
Codehygiene 0.6.1 was advertised; installed 0.5.0 was used.

## Explicit pending work / boundaries

- Real stable graceful WM close, tray reopen, explicit Quit, and successful picker
  selection; broader Linux distro and pure-Wayland validation.
- Actual host tray presentation/direct activation and accessibility beyond the
  registered native menu/API evidence; physical visual interaction not claimed.
- Logout, locked/unavailable keyring, disabled/missing tray, opt-in login startup,
  background-disabled close, launcher reopening and crash/restart behavior.
  **The user's session/keyring was not locked or logged out.** Full-session cases
  belong to later lifecycle/release tests (step 10), not destructive spike probes.
- Production credential adapter error UX, CLI credential sharing/migration, secure
  ownership IPC, and all client behavior in later steps. This spike's RPC is only
  Electrobun's same-app window bridge, not the future CLI ownership interface.
- Reproducible/offline desktop Nix packaging and native CI SDK inputs.
- No blocker downloading/installing the required toolchain locally was encountered.
  The scoped dev integration is proven; the pending release cases above are not.
