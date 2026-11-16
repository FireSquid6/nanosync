# Native Android implementation and verification

Tracking specification: [#6](https://github.com/FireSquid6/nanosync/issues/6).

This document tracks implementation gates, not claims that the application is
already complete. Individual milestones must only be closed when their
acceptance checks have evidence.

## Milestones

| Step | Issue | Deliverable | Verification gate |
| --- | --- | --- | --- |
| 1 | [#7](https://github.com/FireSquid6/nanosync/issues/7) | Nix toolchain and platform feasibility | Actual Android build; supported folder-access and lifecycle approach; device/emulator access recorded |
| 2 | [#8](https://github.com/FireSquid6/nanosync/issues/8) | Enrollment, protocol, cryptography | Real-server enrollment/recovery and existing-format interoperability |
| 3 | [#9](https://github.com/FireSquid6/nanosync/issues/9) | Durable shared-folder synchronization | Two-client convergence, safe import/conflicts, ignore rules, interrupted-work recovery |
| 4 | [#10](https://github.com/FireSquid6/nanosync/issues/10) | Native onboarding and dashboard | Observable connection flows, status, controls and non-destructive disconnect |
| 5 | [#11](https://github.com/FireSquid6/nanosync/issues/11) | Background execution and network policy | Independent vault progress; pause/manual semantics; lifecycle and policy checks |
| 6 | [#12](https://github.com/FireSquid6/nanosync/issues/12) | End-to-end testing and independent review | Build/regressions, Android instrumentation, reviewed fixes and explicit real-device gates |
| 7 | [#13](https://github.com/FireSquid6/nanosync/issues/13) | Documentation and delivery | Accurate operational docs, reproducible APK delivery and implementation PR |

Step 1 gates the integration architecture. Steps 2 and 3 provide working
synchronization for step 4. Step 5 integrates platform execution. Steps 6 and 7
must distinguish verified behavior from unavailable device acceptance.

## Recorded verification

- Pinned Nix full Android and lightweight build-only shells both evaluated and
  provided working JDK 21, Gradle 9.8.2, Bun and Android tools. Compile/target API 37,
  minimum API 31. Existing Linux binary outputs/pins were preserved.
- Debug application/test APK assembly and Android lint passed without a lint baseline.
- Android 12/API 31 and Android 17/API 37 emulators each passed 33 platform tests;
  two host-fixture cases intentionally skip in this plain instrumentation run.
- Those two cases separately passed on **both** emulators against a disposable real
  server and a second existing client: recovery crypto, native password enrollment
  and administrator approval, vault listing/connection, download, normal external
  saves, paused manual upload, real Wi-Fi-only blocking and one-time cellular
  exceptions without preference mutation, screen-off foreground synchronization/notification,
  actual bounded JobService fallback, file-preserving disconnect, and replica
  convergence. This is not a static dashboard or a mock server demonstration.
- Host suite: **270 passed, 0 failed** across 29 files; workspace and Android
  runtime/test/harness strict typechecks passed. Linux installer fixtures passed.
- Host regression tests cover protocol/crypto, portable-engine adapter extraction,
  real-server Android/CLI interoperability, initial imports, rename identity,
  concurrent edits, ignores, interrupted chunk/apply recovery, type transitions,
  bounded durable cache cleanup and legacy WebView transport behavior.
- Independent reviewers inspected portable extraction, native dashboard/storage,
  native bridge/filesystem safety, and scheduling/ownership. Concrete P1/P2 findings
  were fixed and rechecked, including file-descriptor ownership, IO-drained
  cancellation, authenticated stage cleanup, ignore-policy drift, service/job
  ownership, fair queues, approval recovery and durable disconnect cleanup.
- Release assembly with a **disposable verification key** passed APK Signature
  Scheme v2 verification. Assembly without signing credentials failed closed. No
  production signing key was generated or committed. Third-party notices ship in
  the APK assets.
- Linux Nix package build passed after regenerating its offline dependency map for
  the Android workspace. The Android CI job builds validation APKs and runs host,
  type and lint checks; emulator tests remain separate reproducible commands.

Exact final command results are also recorded in the implementation PR. See the [Android guide](../apps/android/README.md) for reproduction commands.

### Remaining acceptance gates (not claimed complete)

- Physical **Pixel 9 / Android 17** testing: no physical device was connected.
- Real-device battery/Doze behavior and actual reboot/unlock recovery. Receiver
  registration, lease ownership and the real OS-dispatched fallback job are tested;
  that is not the same as a completed real-device reboot acceptance run.
- A completed 50 GB Android transfer/resume and device-scale capacity/performance
  run. Existing bounded/chunked and interrupted-transfer fixtures are not proof of
  completing a 50 GB transfer.
- Production release-key provisioning and any actual distribution release.

Keep the parent specification and final acceptance milestone open while those
required device gates remain. Do not replace them with a claim that emulator or
small-file success covers every device condition.

## Product invariants

- Native Android 12+; required acceptance device: Pixel 9 on Android 17.
- Multiple server connections, with collapsible server groups and existing-vault
  connection actions; no mobile server administration or vault creation.
- One supported shared folder per connected vault; no overlapping roots or
  second authoritative private copy. Android controls other applications' access.
- Full verified offline availability for non-ignored entries, using the existing
  device-local `.nanosyncignore` semantics, without editor-specific rules.
- Durable recovery, stable file identity, encrypted protocol interoperability,
  preserve-both conflicts, and no deletions inferred from unavailable folders.
- Per-vault background enablement and pause; manual synchronization never changes
  these preferences. A failed vault never prevents unrelated vault progress.
- Global mobile-data default, prompted during onboarding; per-vault explicit
  inherit/allow/Wi-Fi-only options. Manual exceptions do not mutate preferences.
- HTTPS by default, with easily discoverable global HTTP opt-in. HTTPS certificate
  validation remains enabled regardless of that option.
- Disconnect/remove stops work and removes unneeded private state and secrets,
  while leaving shared files untouched.

## Verification seam

Prefer the application interacting with a real server, a second existing client,
and shared folders edited using a simple external editor. Assert externally
visible files, convergence, status, settings and notifications. Reuse existing
protocol/crypto/merge and CLI integration test contracts; Android instrumentation
covers permissions, folder access, foreground execution and lifecycle behavior.

Do not claim uninterrupted background execution: Android can restrict or stop it.
Do not claim the device acceptance gate passed merely because an APK builds or
an emulator test passes. No special editor integration is required.
