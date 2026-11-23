# Nanosync desktop UI (mock backend)

Issue [#18](https://github.com/FireSquid6/nanosync/issues/18), using the approved
[Field Guide handoff](https://github.com/FireSquid6/nanosync/tree/2efb4794de0384d9e9f7bf97efc3d72020fa6671/docs/design/desktop-field-guide).

**This is an interactive UI implementation, not a working sync client.** All
connections, enrollment, folders, credentials, transfers and native actions are
simulated. Do not enter real passwords or recovery keys. No sync files or CLI
state are read or modified. Mock state is separate from the real client.

## Develop and build

The app retains the official `bunx electrobun init --template=hello-world`
scaffold and its pinned Electrobun 2.0.7 / Hutch 0.30.0 toolchain. Electrobun 2
uses Hutch's generated devkit rather than the old npm runtime API. Do not replace
it with Electron APIs or downgrade Electrobun to install a runtime npm package.

From the repository root:

```sh
bun install --frozen-lockfile
# Bootstrap the pinned toolchain and build the app:
bun run build:electrobun
# If reinstalling app dependencies after bootstrap:
# cd apps/electrobun && hutch run install
bun run dev:electrobun
bun run build:electrobun
bun run typecheck:electrobun
```

The bootstrap downloads Hutch and its paired runtime/toolchain into user caches;
it is not a Nix-packaged desktop release. The repository's local `nix develop`
provides Bun/Node, and `nix develop .#checks` additionally provides Chromium for
browser checks. Native Linux runtime dependencies and packaging remain separate
validation work. macOS and Windows are not validated targets.

## End-to-end UI checks

```sh
CHROMIUM_PATH="$(command -v chromium)" bun run test:electrobun
```

Playwright starts a loopback-only test server, bundles the actual webview
TypeScript with Bun and loads the same HTML/CSS shipped in the app. Tests seed
mock outcomes deterministically; they do not use a live server or time-based
simulation. They exercise browser UI behavior, **not** Electrobun's native
window, credential store, filesystem picker, system browser, notifications,
launcher reopening, logout, or the CLI/desktop ownership protocol.

## Mock fixtures

`src/mainview/mock.ts` defines the sample records and versioned browser-storage
state (`nanosync.desktop.mock.v1`). Browser tests seed that state before page
load to exercise enrollment outcomes, credential modes and ownership without
adding preview selectors to the UI. Reloading preserves mock preferences,
pauses and pending enrollment. Clearing that storage key resets the demo.
Ignore validation uses the existing browser-safe `IgnoreMatcher` from
`packages/sync-core`, not a second implementation of its syntax.

## Implementation boundary

- Folder-centric navigation, setup, conflicts, connections and settings follow
  the approved design. Mock state supports repeatable interactive flows.
- The application identifies itself as a mock demo. Native actions must not
  imply that a real folder opened, credentials migrated, or synchronization ran.
- No server administration, remote-file browser, history/restore, built-in
  merge editor, system tray or self-updater is included.
- Local mock preferences and records are not durable engine state or shared CLI
  state. Passwords and recovery keys must never be persisted in mock storage.
- Passing browser tests does not fulfill issue #18's backend, packaging or real
  Linux desktop acceptance criteria. The issue should remain open for that work.
