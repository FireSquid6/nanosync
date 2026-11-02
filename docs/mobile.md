# Mobile filesystem clients

The mobile product is an offline-first file manager for the single encrypted
vault. Both Android and iOS must make the vault available from the system file
browser, including edits saved by other applications. This does **not** mean a
globally mounted POSIX directory: apps use platform document-provider APIs.

## Shared invariants

- Keep one complete, verified copy of the current vault in app-controlled
  storage. Never claim a revision has applied while any current file is absent.
- Stable manifest entry IDs, not paths, identify files across renames. Provider
  metadata must map IDs to parent/name and reject case-ambiguous or unsafe names.
- An external editor's save becomes a durable local change before sync is
  attempted. The editor may finish offline. A sync failure never discards that
  change; concurrent remote edits use the existing preserve-both conflict policy.
- Stage writes separately from the last complete file. Do not expose partially
  written content as a completed vault revision; recover or discard interrupted
  staging after process death, with clear status for blocked operations.
- The encrypted server is authoritative for revision order, not for plaintext
  storage. Mobile authentication and vault keys belong in OS-backed key storage.
  App-owned plaintext requires OS device encryption and normal app sandboxing;
  exports and copies opened in other apps escape Nanosync's lifecycle control.
- Foreground Sync now must work. Scheduled background sync is best-effort on
  both platforms; show last successful sync, pending changes and errors.
- Check storage before applying a revision and keep the last complete local
  revision when capacity is insufficient. Support bounded streaming for files
  up to the protocol's 50 GB limit, not whole-file memory buffers.

## Android

Expose a `DocumentsProvider` root backed by app-private durable files and a
local metadata index. The initial local-only provider source is in
`apps/android`. It demonstrates stable IDs, listing, creation, deletion,
renaming, and staged saves from external editors; it is **not** connected to
the vault or cryptography. The next Android slice must add write-intent crash
recovery, transactionally reconcile the index with files on launch, and test
real picker/editors. Only then connect a mobile storage adapter to the portable
protocol and sync engine and add enrollment and sync UI.

## iOS

Expose the vault as a File Provider domain in Files, backed by an app-group
container shared between the host app and File Provider extension. Keep the
complete offline copy in **app-owned durable storage**, not only in an
evictable system cache. Give the extension stable item identifiers, enumerate
from the local index, and coordinate materialization and edit commits with the
host app. Record external edits durably before returning success to the system;
do not depend on a background task starting immediately. The host app handles
enrollment, key access, status and explicit sync. Validate entitlement,
extension lifecycle, and external editor behavior on an actual iOS device
before choosing a shared UI/runtime strategy. This iOS extension does not
exist yet, and cannot be built or exercised on this Linux checkout.

## Integration gates

1. Real editor round-trip: create, open, edit, rename, move, delete through each
   platform's system file UI, including offline operation and process death.
2. Verified vault import and foreground sync on both platforms, with no loss of
   staged external edits or partial revisions.
3. Conflict, out-of-space, revocation, intermittent network and very large-file
   tests; then add best-effort background scheduling and polish the in-app UI.
