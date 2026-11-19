# Desktop SDK security prerequisite — validated Linux profile

**Accepted for this bounded Linux SDK prerequisite, not a desktop release certification.** Independent review closed both privacy findings and accepted the maintained-source fatal fix. The parent independently reran `nix develop --command bun run --cwd apps/desktop security:gate`: packaged fatal exit **1**, normal Quit **0**, consolidated privacy/auth/navigation assertions passed, and no fixture process groups remained. Core and preload hashes matched the artifact proof below. No real credentials or host-visible windows were used. Onboarding remains a separate implementation step after the shared-backend checkpoint.

## Established fatal-exit cause and smallest source fix

Before the fix, the packaged fixture reported:

```text
SDK_SDKS_MAIN_PROC_NATIVE_TS_2650
[stopEventLoop] Initiating clean event loop exit
AssertionError: NATIVE_FATAL_EXIT_MUST_BE_PRESERVED
0 !== 1
```

Diagnosis distinguished the outer native launcher from its inner Bun/native process:

```sh
export HUTCH_HOME="$PWD/.cache/hutch"
nix develop --command bun build/desktop/native-gate.ts --inner-runtime
```

The direct diagnostic launches the **actual extracted packaged Bun** and `Resources/main.js`, with the launcher's cwd, argv0, library path and ICU setup. Before the fix it independently reproduced exit **0** after the same fatal handler. Thus the outer launcher's status propagation was not introducing zero.

The maintained source explains that result:

- `package/src/sdks/main/proc/native.ts`, upstream lines 2650–2658: the uncaught-exception handler called the wrapper's `stopEventLoop`, `waitForShutdownComplete(5000)`, then `forceExit(1)` separately.
- `package/src/core/main.zig`, `electrobun_core_run_main_thread` / `mainThreadExitCode`: once the native loop returns, the main thread calls `force_exit` using the pending graceful status or its default **0**.
- The fatal handler never published a pending status. The main thread could therefore terminate the **inner process** with zero before the worker reached its later `forceExit(1)`.
- The same core already supplies `quitGracefully(code, timeout)`, which stores the status **before** stopping the loop, retains the native wait, clears pending runtime callback payloads, and exits with the requested status. Existing `Utils.quitAfterApproval` and process-exit handling use that API.
- Linux `stopEventLoop` initiates native shutdown; the GTK loop sets its shutdown-complete flag before returning. The native launcher waits for its child and propagates nonzero child status.

Caller inspection covered the TS SDK, core, native-wrapper shutdown paths and native SDK wrappers. **No shared shutdown implementation or other caller was changed.** The new `sdk-fatal-shutdown.patch` only replaces the fatal handler's three low-level calls with:

```ts
core_.symbols.quitGracefully(1, 5000);
```

The fixed error-level log and non-native `process.exit(1)` fallback remain intact. It does not bypass cleanup, remove the wait, invoke vetoable normal-Quit approval for a fatal error, change cryptography, modify the C ABI, or require rebuilding the C++ wrapper. Source regression tests fail on the old raw-stop path and pass on the existing status-aware API.

After the fix, both actual process routes passed:

| Actual packaged route | Fatal exception | Normal Quit |
| --- | --- | --- |
| Native launcher → packaged Bun/native runtime | 1 | 0 |
| Direct packaged Bun/native runtime diagnostic | 1 | 0 |

Normal Quit additionally observes the SDK's `before-quit` approval hook. Both paths observe native event-loop shutdown. Each gate checks that its own process groups are gone before reporting PASS; cleanup never targets host windows or unrelated processes. This is not validation of future sync-owner lifecycle handling.

## Pinned inputs and reproducible source-build route

- Electrobun **2.0.6**, official commit **`c9e637c4e8acc8d53fc4a1703346196b004a00d8`**.
- Source archive: `https://codeload.github.com/blackboardsh/electrobun/tar.gz/c9e637c4e8acc8d53fc4a1703346196b004a00d8`.
- Source archive SHA-256: `ed22102b55e4d6b04c3b48ab548f3d3b07b84fd824adc3c097f37986def265ce`.
- Exact upstream Zig **0.17.0**, not the earlier 0.17.1 scratch compiler.
- Zig archive: `https://ziglang.org/download/0.17.0/zig-x86_64-linux-0.17.0.tar.xz`.
- Zig archive SHA-256: `1cbe9df9f27e6b78d14ccbca43b6703a404ef79ef1c463de901d7f088d4e2026` (official download index).
- Preload builder Bun **1.4.4**. The locked nixpkgs Bun is 1.4.2, so the desktop development shell overrides the maintained Bun derivation with official 1.4.4 archive SHA-256 `bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c`. The default CLI package remains unchanged.

`build/desktop/security.ts` verifies these build-time inputs in `.cache/desktop-sdk`, applies source patches, rebuilds both built-in preloads with Bun 1.4.4, and runs upstream core `build.zig` with `-Doptimize=ReleaseSmall -Dtarget=x86_64-linux-gnu`. It rejects a different compiler version and test-only registration exports. There is no binary patching or new cryptographic protocol.

Patches, in application order:

| File | SHA-256 |
| --- | --- |
| `build/desktop/patches/sdk-privacy.patch` | `8b103f3debeafbff112090229f8dc9490f51d4c4b3dc6c477c70877eabc88b56` |
| `build/desktop/patches/core-auth-first.patch` | `eb7928afb50b23be1b24728a2f88710646c77a19d42928638a7694db9688114f` |
| `build/desktop/patches/sdk-fatal-shutdown.patch` | `f9625b649c9d1ee060957d07da7283df94180886beb3d804c1c5fb8e047b661d` |

`patches/files.json` pins pristine and patched hashes for every modified file. The fatal patch intentionally starts from the privacy-patched `native.ts`; preparation verifies each transition and cache verification checks the final ordered result. Patch application uses an isolated source Git directory/worktree and verifies actual changed bytes, not just `git apply` exit status. The nested-parent-checkout regression remains mandatory in the explicit security gate.

Upstream LICENSE is retained in the source cache and copied to `Resources/ELECTROBUN-LICENSE`. No new source dependency or notice replacement was introduced by the fatal fix.

### Workflow enforcement

- `apps/desktop/tooling.sh` uses project-local `HUTCH_HOME`, serializes builds, and verifies the prepared patched SDK before prepare/build/run/dev/config.
- SDK aliases cover the upstream export map and select patched source rather than Hutch's stock projection.
- Pre-build verification checks pinned source/artifact hashes.
- Post-build staging installs rebuilt core/preloads, checks bundled SDK markers, and writes a protected-file manifest before compression.
- Post-package verification extracts the actual stable payload and verifies its protected files against that manifest and the prepared SDK.
- The run wrapper verifies the selected package again.
- Application bootstrap checks packaged hashes and the core actually mapped in `/proc/self/maps` before SDK initialization. It constrains cwd to the verified bin directory because upstream SDK library lookup otherwise tries cwd first.
- Hutch may recreate its stock projection without replacing the selected patched source. Drift is an error, not a plaintext/stock fallback.
- No runtime updater/download was added. Missing archives fail in offline mode. A changed patch set requires explicit removal/repreparation of this generated SDK cache; it is not silently rewritten as valid.

These mechanisms establish this tested prerequisite, not a signed release or protection against a compromised same-user process able to replace both application code and its state.

## Privacy changes and regressions retained

The privacy patch modifies `sdks/main/proc/native.ts`, `sdks/main/core/BrowserView.ts`, `browser/index.ts`, `preload/{index,webviewTag,wgpuTag}.ts`, and `shared/rpc.ts`.

Boundary logs retain severity but use fixed codes instead of exceptions, stacks, packet previews or input interpolation. RPC failures use fixed transport errors; product application handlers must still return allowlisted result envelopes. Dispatcher rejections are consumed.

Every wildcard/named notification listener is independently guarded, including configured global/named handlers. Pending notification work remains nonblocking; a later synchronous callback failure cannot orphan an earlier promise. Actual-source mixed-listener regressions cover that ordering and error reporting.

BrowserView serialization errors are fixed-code logs too. The native fixture exercises a response `toJSON` that throws a synthetic secret and verifies queue completion plus sanitized logging. Deferred optional renderer-handler invocation remains type-safe (`this.rpcHandler?.(msg)`). The fatal follow-up patch preserves all these changes.

There is **no production blanket console interceptor**. The built-in preload is rebuilt from patched source; late renderer initialization cannot cover its initial failure path. A fixture-only observer records console arguments without redaction while still invoking original console methods. For initialization-failure injection it runs before the **actual shipped preload**. This is necessary because upstream stable WebKit does not forward renderer console calls to process stdout. The observer does not provide product privacy.

The complete native gate now executes its final consolidated checks: no synthetic password/recovery sentinel in captured process/renderer/preload logs or failure replies; fixed failure diagnostics present; fatal status preserved; native shutdown observed. Previously those final checks were unreachable after exit 0.

## Framework transport, navigation and opening

Official `core/main.zig` initializes `plaintext_transport=false`. Browser raw receive support and `__electrobunPlaintextHostSocket` do not enable the server flag. The auth-first patch attaches a socket only after existing frame authentication, preventing a keyless connection from displacing an authorized channel. It does not change AES-256-GCM or solve connection-flood/resource exhaustion.

The native gate identifies the runtime's socket inodes through its own `/proc/<pid>/fd` and `/proc/<pid>/net/{tcp,tcp6}` records and asserts the framework listener binds **127.0.0.1**, not a wildcard address. Raw requests, wrong-key frames, malformed envelopes and plaintext-flag spoofing cannot dispatch or read protected results; an authorized channel continues receiving its encrypted result while the attacker connection remains open. Valid crypto RPC succeeds through real SDK/core/native views.

Electrobun does use framework loopback WebSocket transport. There is no claim of zero TCP listeners, and no new application control TCP server was added. Shared sync-owner control remains the separately implemented authenticated Unix-socket interface. Narrow application RPC is not a renderer-compromise sandbox: the trusted preload exposes internal capabilities.

SDK 2.0.6 drops constructor `navigationRules` before its native call. Current setup therefore creates `about:blank`, synchronously calls `setNavigationRules(['^*', 'views://main/index.html'])`, then loads packaged content. `allowedProtocols` is explicitly `{ views:true, appData:false }`. Native remote-navigation/popup probes against a synthetic loopback target pass without fetching remote content. This is scoped Linux WebKit evidence, not cross-platform certification.

`src/open-native.ts` avoids both upstream `Utils.openExternal` and `Utils.openPath` shell fallbacks. It uses a fixed, build-selected Nix-store `xdg-open` executable and argv, never a shell; discards child streams; maps failures to `OPEN_FAILED`; restricts administration HTTP(S) URLs; and checks absolute owned real folder paths. Future main callers must additionally resolve advertised capabilities or validate saved binding identity. No generic renderer execution/URL/path gateway is exposed. Unit fixtures do not open a real browser/file manager. Spike startup no longer automatically accesses a credential store.

## Reproduction and verification

Use the locked development shell for explicit native preparation/gates:

```sh
export HUTCH_HOME="$PWD/.cache/hutch"
nix develop --command bun run --cwd apps/desktop prepare:native
nix develop --command bun run --cwd apps/desktop typecheck:native
nix develop --command bun run --cwd apps/desktop security:gate
```

`security:gate` runs the complete packaged fixture twice, for fatal and normal Quit. Each run performs the five explicit actual-source/patch regressions, builds the stable fixture, validates/extracts its actual payload, and starts the real native launcher/core/SDK in isolation. No test registry exports or headless Chromium substitute is used.

Direct-process diagnosis/regression:

```sh
nix develop --command bun build/desktop/native-gate.ts --inner-runtime
nix develop --command bun build/desktop/native-gate.ts --inner-runtime --quit
```

Exact-core unit check, using only local caches/output:

```sh
root="$PWD"
cd .cache/desktop-sdk/patched/source/package/src/core
ZIG_GLOBAL_CACHE_DIR="$root/.cache/desktop-sdk/zig-global" \
  "$root/.cache/desktop-sdk/patched/zig/zig" build test \
  --cache-dir "$root/.cache/desktop-sdk/zig-test-cache" \
  --prefix "$root/.cache/desktop-sdk/zig-test-prefix" --summary all
```

Actual checks on this working tree:

| Check | Result |
| --- | --- |
| Full `bun test`, Bun 1.4.4 | **458 passed**, 0 failed |
| Desktop default artifact/opener/storage tests | **3 passed** |
| Explicit listener/shutdown/nested-patch regressions | **5 passed** |
| Upstream core unit tests with exact Zig 0.17.0 | **7 passed** |
| `bun run typecheck` | All workspaces and tools passed |
| `bun run --cwd apps/desktop typecheck:native` | Passed |
| Packaged native gate, launcher fatal/normal | **Passed**, exit 1 / 0; final privacy assertions executed |
| Direct packaged Bun/native fatal/normal | **Passed**, exit 1 / 0 |
| `nix flake check --no-build` | Passed |
| `nix build .#desktop-bun .#default --no-link` | Passed; default CLI package remains buildable |
| `bun run build:binary` | Passed |
| `git diff --check` | Passed |

Default tests/types were also run from a scratch copy with existing workspace dependencies linked, **no SDK cache**, and a PATH containing only Bun (no Git/Zig/display tools). All three desktop default tests and its default typecheck passed. The Git regression was moved to explicit `sdk-patches.integration.ts`; actual-source `.native.ts` files are also explicit gate inputs. Missing native preparation fails instead of silently skipping assertions. No root package/Bun lockfile changes or fake SDK declarations were added.

The optional codehygiene tool could not run because its environment lacks NumPy; no dependency was installed for it. Browser UI smoke, final desktop/Nix release packaging, real-session lifecycle and cross-platform validation remain separate work.

### Artifact proof from the latest passing packaged run

| Artifact | SHA-256 |
| --- | --- |
| exact Zig 0.17.0 executable | `7c61539af19fa4082c94848f1c2b57b89e76dc6cfd5bd4c57764c3caf8f82272` |
| rebuilt production `libElectrobunCore.so` | `0660514b85fbac5fa64c3490bc204150ce68a82a427c79ab1239ea4628677547` |
| rebuilt `preload-full.js` | `de08a1f90055546ca9c701880e64e26176f04dc1694ffd327693c04fcedbe69e` |
| rebuilt `preload-sandboxed.js` | `3220d78d5e6f711ee2116830a5b5dc85277fc2437d21bcdb97248992daed1064` |
| final patched `sdks/main/proc/native.ts` | `d1852dfa299fb074ed9f4cfe5a206a85ced86667cdbac316db1d3ab4af203393` |
| unchanged release `libNativeWrapper.so` | `035b553ec9c4c120698619ce74865ea03eb76dc6e93c4cc3ad6143a20bce897a` |
| packaged Bun executable | `10702245766b225e70bbf6235fd6b47214fd94b4760d00ffaed8ab0df57ac235` |
| stable fixture payload `2vy2s6lmjj8sx.tar.zst` | `4bf6e59c83cd9c054c4c799a004c06689913eef9406775ce2576e4a207a6f5e3` |

The fatal change is SDK-only, so the core/preload hashes stay unchanged. The gate verifies the core actually mapped from the extracted payload, not merely a source-cache file. Payload archive bytes can vary with upstream packaging metadata between builds; the table identifies this run, not a claim of fully reproducible release archive bytes. Signed/reproducible release packaging remains step 12.

Machine-local evidence:

- `/tmp/nanosync-sdk-security-nJesXA/fatal-inner-before.log`
- `/tmp/nanosync-sdk-security-nJesXA/packaged-native-gate-after.log`
- `/tmp/nanosync-sdk-security-nJesXA/fatal-inner-after.log`
- `/tmp/nanosync-sdk-security-nJesXA/quit-inner-after.log`
- `/tmp/nanosync-sdk-security-nJesXA/{full-tests-after,workspace-types-after,core-tests-after,flake-check-after,nix-build-after,cli-binary-after}.log`

## Worker argument forwarding prerequisite (before step 10)

The upstream native outer launcher constructs only `[bun, Resources/main.js]`, dropping ordinary application arguments. The upstream runtime then creates `new Worker(appEntrypointPath, {})`; a Bun 1.4.4 probe confirmed that workers do **not** inherit the parent's arguments. An inner-runtime wrapper alone therefore did not fix profile selection/login startup.

`sdk-launcher-argv.patch` changes the maintained TypeScript launcher source to pass `argv: process.argv.slice(2)` explicitly. Preparation rebuilds `Resources/main.js` with the pinned Bun, validates patch/source hashes, and includes the rebuilt runtime in source, actual-payload and runtime integrity checks. Core, native wrapper, cryptography and preload behavior are unchanged. The outer native launcher's argument loss is **not** fixed: production packaging must use and test the official inner-runtime route with a trusted public wrapper, or separately repair the maintained outer launcher. Development/Setup launcher existence is not startup availability proof.

| Added input/artifact | SHA-256 |
| --- | --- |
| `sdk-launcher-argv.patch` | `a1d581bea0211811aec2c772b4e1daf84d6e507ddc1ec898272adf323f4fd5cb` |
| patched `launcher/main.ts` | `1f26c1c6277f8314336c2717ba5c991ae5fe847d50de5773461029d2322f8005` |
| rebuilt `Resources/main.js` | `9cd2ae7a6c01a22483b35aaed292dc5fb360f0d493fe3809868ce0ef18bd6fbb` |

Parent reran all four actual packaged SDK gates: native outer launcher fatal/normal and inner runtime fatal/normal, exits 1/0, privacy/authorization/navigation checks intact, zero fixture process groups remaining. The two inner runs assert exact `--startup --client-dir` forwarding into the actual app Worker, including a spaced disposable profile path. Core remains `0660514b…547`, full preload `de08a1f9…69e`. Logs: `/tmp/nanosync-sdk-worker-{native,inner-fatal,inner-quit}.log`; SDK preparation/verification and nested-patch regression also passed. Native/tools TypeScript checks also passed. Independent bounded review found no concrete issue in the source/artifact chain; its in-memory rebuild differed only in generated source-path comments, so the hash above identifies the cached build, not a path-independent reproducibility claim. Scoped hygiene review retained existing density/style conventions. These are isolated SDK fixture proofs, **not** the final installed Nix wrapper, its upgrade/login execution, or real desktop-session acceptance.

## Isolation and remaining limits

Native runs use Nix-selected Xvfb `-displayfd` readiness with no TCP display listener, private HOME/XDG, a private DBus configuration with no activation service directories, and synthetic data only. No host keyboard injection, host-visible window or real keyring/default `~/.nanosync` access is used. Private synthetic transport keys stay in a 0600 scratch file, never logs; profiles and process groups are removed before PASS. All current tool invocations use project-scoped `HUTCH_HOME`.

Historical disclosure retained: an early unscoped `hutch electrobun --help` inspection unexpectedly reported downloading Cottontail into Hutch's default tool cache. No unrelated user cache cleanup was attempted. This is not represented as an entirely project-local historical investigation.

The scoped prerequisite passes, but parent review/independent rerun is still required. Toolkit native compatibility here is Linux x64, GTK/WebKit in an isolated X display; it is not ordinary desktop smoke, an installer test, keyring validation, real keyboard onboarding, macOS/Windows support, or validation of future desktop-owned sync teardown. No secrets may be accepted through unreviewed onboarding on the strength of this document alone.
