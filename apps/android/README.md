# Native Android client

Nanosync is a native Android 12+ synchronization dashboard for multiple servers
and existing vaults. It connects each vault to one supported shared local folder,
keeps all non-ignored files offline, and offers manual, paused and opt-in background
synchronization. It is not an editor or a server administration application.

The earlier local-only DocumentsProvider prototype has been replaced. Read the
[mobile architecture and limitations](../../docs/mobile.md) and
[implementation/acceptance tracking](../../docs/android-implementation.md).

## Build with Nix

From the repository root:

```sh
nix develop .#android-build
bun install --frozen-lockfile
bun run build:android
```

All Android build/test dependencies come from this project's flake; no workstation
profile changes or globally installed Android tools are required. The explicit
Android development shells accept Google's Android SDK license and use pinned Nix
SDK/tool binaries. The SDK is immutable: do not run `sdkmanager`
installations into it. The lightweight `android-build` shell includes JDK 21,
Gradle, Bun, API 37 and Build Tools 36.0.0. The full `android` shell additionally
includes the emulator and API 31/36/37 Google APIs x86-64 images for validation.

The build targets Android 17/API 37 with Android 12/API 31 as its minimum. Gradle
bundles the trusted browser-target synchronization engine automatically before
building. No Bun runtime or remote JavaScript is installed on the phone.

Debug application:
`apps/android/app/build/outputs/apk/debug/app-debug.apk`.
Instrumentation application:
`apps/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk`.

Install the debug application on an explicitly selected device:

```sh
adb -s YOUR_DEVICE_SERIAL install -r apps/android/app/build/outputs/apk/debug/app-debug.apk
```

Debug APKs are validation builds, not production releases. Different developer/CI
machines can use different debug signing keys and therefore cannot necessarily
update one another's installations. Uninstalling loses private credentials and
journals, but does not remove the selected shared folders; retain recovery keys.

## Signed release APK

Use your own long-lived release keystore, kept outside the checkout. Supply:

- `NANOSYNC_ANDROID_KEYSTORE` — absolute keystore filename.
- `NANOSYNC_ANDROID_KEYSTORE_PASSWORD`.
- `NANOSYNC_ANDROID_KEY_ALIAS`.
- `NANOSYNC_ANDROID_KEY_PASSWORD`.

Then run `gradle -p apps/android :app:assembleRelease`. Missing signing values fail
release signing rather than substituting a debug key. The signed APK is written
to `apps/android/app/build/outputs/apk/release/app-release.apk`. Back up the signing
key securely; future releases need the same key to update installed copies. No
production signing key or password belongs in Git or build logs.

## Connect and operate

1. Choose the global mobile-data default in the first-launch popup.
2. Add a server origin, owner password and device name. HTTPS is required unless
   **Settings → Allow unencrypted HTTP** is enabled globally. HTTPS certificate
   validation remains enabled. Path-prefixed reverse-proxy URLs are not supported;
   use a dedicated origin. HTTP exposes authentication credentials to the network.
3. Compare the displayed verification code with the server's pending request,
   then approve the exact device in `/admin` (when enabled) or with
   `nanosync server devices approve --device-id UUID --server-dir DIRECTORY`.
   Resume/check approval after interruption without creating a new identity.
4. Expand the server and choose **Connect existing vault**. Select a remote vault,
   grant Android **All files access**, choose a supported folder and enter its
   recovery key. Existing files participate in safe reconciliation.
5. Inspect initial synchronization on the vault page: progress shows the current
   download path and saved byte count, followed by application and verification.
   Background sync is a separate opt-in available immediately, including during
   the initial download, with notification permission requested explicitly.

The native adapter supports dedicated folders in the current user's primary
shared storage, outside protected `Android/` directories. The picker cannot grant
arbitrary filesystem access: cloud providers and secondary/removable volumes are
not supported by this adapter. A folder-picker grant alone does not replace the
explicit Android All files access permission. Other applications' access is
controlled by Android, not by a Nanosync allowlist.

All non-ignored shared files are plaintext. Use device encryption. `.nanosyncignore`
is local to each device, follows the same rules as the Linux client, and has no
editor-specific defaults. Excluded paths are not traversed or synchronized.

Pause stops both transfer directions. **Sync now** runs once without changing
pause/background preferences. Mobile-data settings clearly distinguish the global
default from a vault's inherit/allow/Wi-Fi-only choice; one-time manual exceptions
do not change either stored setting. Unknown VPN transport is conservatively
blocked under Wi-Fi-only; explicit Wi-Fi transport, including metered Wi-Fi, is
allowed. Local LAN servers do not require public Internet validation.

Conflicts preserve both versions and list affected paths; resolve them in your
external application. Disconnect/remove stops work and forgets private connection
state and unneeded keys while leaving shared files alone. This is not remote
revocation or secure erasure. If the server permanently deletes a vault, Nanosync
stops that connection with a terminal status, preserving its shared files, keys
and journal; it does not translate remote deletion into local file removal or
keep retrying it as a temporary outage. Disconnect it explicitly or connect a
different existing vault.

## Recovery and platform limits

- Never clear application data to solve an interrupted sync: that discards its
  recovery journal. Temporary failures retain pending work and completed chunks.
- If an external edit occurs before any pending remote application becomes visible,
  retry safely replans and merges. If it occurs after part of a remote revision
  was applied, the error identifies the affected path: **move that edited file
  outside the vault, retain the saved copy, then retry** to finish the pending
  revision. Reintroduce the saved content afterwards to synchronize it.
- If `.nanosyncignore` changes after a pending apply already made visible changes,
  restore its exact prior contents and retry to complete that apply before changing
  the rules again. A policy change before visible application safely replans on retry.
- File/directory type transitions stage incoming content first. Untracked or ignored
  directory children block removal instead of being deleted recursively.
- Keep free private and shared storage for chunks and staging. The optional plaintext
  chunk cache is bounded (64 MiB plus an in-flight chunk); active apply stages are
  pinned until checkpoint completion. Capacity errors never mean successful sync.
- Background work is best-effort under Android limits. A foreground service does
  not bypass data-sync time quotas, network restrictions, force-stop or process death.
  The UI distinguishes configured background sync from actual stopped/restricted work.
- This is the first networked Android client; journals from intermediate development
  builds are not a supported migration format. Shared files are not silently removed.

## Verify

Host-side tests and strict checks:

```sh
bun test
bun run typecheck
bun run typecheck:android
gradle -p apps/android :app:lintDebug
```

Create/boot a disposable emulator from the full Nix shell:

```sh
nix develop .#android
avdmanager create avd -n nanosync-api31 -k 'system-images;android-31;google_apis;x86_64' -d pixel_9
emulator -avd nanosync-api31 -no-window -no-audio -gpu software -no-snapshot -port 5558
# In another shell after boot:
export ANDROID_SERIAL=emulator-5558
bun run test:android:e2e
bun run test:android
```

For Android 17, use image package
`system-images;android-37.0;google_apis;x86_64` and a different AVD name/port.
AVDs are writable user data; the Nix SDK remains immutable. KVM must be available
for practical emulator testing.

`test:android:e2e` requires explicit device selection, installs debug/test APKs,
grants test permissions, toggles Wi-Fi/mobile data and screen state, starts a disposable real server, approves only its unique
test enrollment, and verifies Android/second-client convergence. It tests native
enrollment, recovery, connection, normal saves, paused manual sync, real Wi-Fi-only/cellular exceptions, screen-off
background sync/notification, actual JobService fallback, and non-destructive disconnect. It removes only its
UUID-named shared test folders and disposable host state, and restores recorded Wi-Fi/mobile-data enablement. **Use a disposable
emulator/device, not an installation containing valuable pending work.**

Plain `test:android` runs platform instrumentation; the two real-server fixture
cases are intentionally skipped there and run by `test:android:e2e`. Grant All files
access on the test installation before running folder tests; without it those
permission-dependent cases explicitly skip. Platform checks cover access guards,
FD ownership, staging/recovery, cancellation and scheduler ownership. Tests with
injected runtime failures complement rather than replace real-device execution.

GitHub Actions builds validation APKs and runs host/protocol/type/lint checks in
the lightweight Nix shell. Android platform/emulator acceptance commands above are
separate from that build job. See tracking for actual recorded results and the
remaining physical Pixel 9/Android 17 acceptance gate. Emulator tests do not prove
real-device battery/Doze behavior or a completed 50 GB transfer.

Bundled dependency licenses are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
and included in the APK assets.
