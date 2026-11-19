# Desktop notifications — issue 18, step 11

Notifications are a desktop native effect, not a daemon or a headless CLI delivery promise. Shared settings and persistent actionable status remain available without a display, desktop process or unlocked credential store. Disabling alerts does not hide conflicts/errors or clear their durable state.

## Intent and compatibility

Settings v3 preserves independent global/folder pauses, lifecycle choices and accepting-owner continuous intent, adding exactly:

```ts
notifications: {
  enabled: true,
  conflicts: true,
  revokedAccess: true,
  persistentFailures: true,
  includeNamesAndPaths: false,
}
```

These defaults follow the pinned Field Guide prototype; names/paths are opt-in. Global/category choices are independent. Reads normalize older supported settings in memory without writing; explicit preference saves, accepted continuous intent or new shared runner admission persist the new schema. Runner admission holds the real credential registry and publishes the settings-v3 barrier before observation-v2 writes; a later old executable cannot start a writer by reading an unchanged v1/v2 settings record. Updates reread under the existing settings lock, CAS the monotonic revision and atomically fsync replacement. A notification-only CLI patch does not require unrelated lifecycle choices. Supplying any lifecycle flag still requires its complete trio.

New sync discovery metadata is version 3; request protocol remains version 1. Version-2 or unadvertised live owners are not proof of support for settings v3/observation v2. Shared runner creation and schema upgrades refuse older owners before writing new state. Stop them explicitly and retry; no lock stealing, implicit stop or owner-origin change. Direct exclusive attachment failures retain the established live-lock refusal. Old binaries cannot honor new schemas and must not run concurrently during upgrade.

## Incident policy

- Conflict identity is binding + conflict entry ID + source revision, from the actual checked conflict journal. Applied manifest reconciliation remains resolution authority. Viewing, opening, acknowledging a native alert or deleting a notification never resolves a conflict.
- Access uses actual `UNAUTHORIZED` / `FORBIDDEN` observations. The category is the Field Guide's revoked-access choice, but text says access is **unavailable**, not that the client proved device revocation. `VAULT_DELETED` is not relabeled revocation.
- An unresolved failure episode has a stable UUID/onset, last confirmed failure time/code and confirmation UUID, in observation v2. Retry, phase/progress/code changes, pause and owner restart retain it. Only a completed successfully verified/reconciled pass clears it, independently of remaining conflicts. Confirmed blocked starts for unavailable credentials or an unavailable folder also record the episode without opening a writable journal, probing a credential provider again, or recreating the root. Existing v1 observations have unknown onset; new failures do not invent/backdate history.
- Persistent failures require two actual failure observations spanning **300,000 ms**. This fixed conservative implementation policy was not specified as a duration by the requirements. UI time passing cannot age a stale one-shot error into an alert. Each desktop evaluator must observe a new failure confirmation after its initial snapshot before sending an overdue persistent alert. Quick recovery after restart sends none. Negative elapsed time is clamped; a forward wall-clock jump may age a continuing confirmed episode. Tests inject time; no correctness sleeps.
- Brief outages and normal successful sync never notify. Confirmed persistent failure still becomes visible attention/tray state with alerts off. Access and persistent failure do not double-alert for the same currently access-denied episode.

The trusted main process evaluates real shared status, including CLI-owned folders, even when its window is hidden. No renderer polling or second writable journal is used. Recovery/removal barriers and failed/unknown observations suppress delivery without clearing attention or inferring resolution.

## Dedup and batching

At most one native submission per category is made for all newly eligible incidents in a reconciliation pass, not one popup per file. A 1000-conflict set is one submission. Already claimed members are filtered independently, so resolving members or changing counts/heads cannot itself retrigger an alert. The native helper retains at most three active notifications, replacing the previous notification of a category when genuinely new incidents appear.

`notification-delivery.json` is checked private 0600 state, serialized by a process-identity lock in `notification-delivery-lock`. It stores only binding/category/incident identity, attempted/accepted/dismissed disposition, a per-submission attempt UUID and an opaque native ID. Late native receipts for an already pruned incident are ignored; an old popup cannot dismiss a newly reopened attempt of the same lineage. It contains no body, filename/path, URL, content, credential value/reference or credential hash. Its stages and lock are recognized by current-layout credential inspection without choosing/initializing a credential mode.

The attempted claim is atomically written/fsynced **before** native submission. A crash between that claim and delivery can lose one alert; a lost reply/restart does not replay it. This is at-most-one application submission, not exactly-once display. The in-app incident remains visible. Service-unavailable-before-claim does not claim. An uncertain native failure after claim does not authorize retrying it. State corruption/unsafe substitution/full ledger is actionable and never reset/replayed automatically. Before claiming, checked authoritative conflict reconciliation, failure resolution/new episode and completed binding removal prune only resolved/removed identities. Unknown, read-failed, suppressed and disabled-category observations do not authorize pruning. The same lineage genuinely reopened after observed resolution can alert again. The 1 MB bound never evicts live entries or silently resets/replays state; an oversized active set fails actionably.

Native acceptance means the maintained library received a positive notification-server ID, not that a compositor displayed it. Only `NotificationClosed` reason **2** records explicit user dismissal. Expiry (1), application close (3), unknown/undefined (4), process exit and missing reply are not dismissal. Dismissal never changes sync state.

## Linux native boundary and audit

Pinned Electrobun 2.0.6 `Utils.showNotification` is deliberately **not called**: its Linux `nativeWrapper.cpp` constructs `notify-send` text and invokes `system()` on a detached thread. The existing SDK privacy/shutdown/argv/source/artifact protection chain is unchanged.

The project's pinned nixpkgs supplies maintained libnotify **0.8.8**. Inspected `tools/notify-send.c` and actual `notify-send --help`: print-id/actions/wait exist, but wait termination does not expose the explicit closed reason. Therefore a wait exit code is insufficient for the required dismissal contract.

The adapter instead runs one build-selected Nix Python/PyGObject helper with maintained libnotify introspection (`Notify-0.7`). libnotify owns GDBus/protocol parsing; the app does not implement D-Bus wire framing. Its `Notification.props.id`, `add_action`, `closed` signal and `get_closed_reason` provide accepted ID, action and exact close reason. The helper is not one `notify-send --wait` child per incident. Helper requests/replies are bounded, serialized and watchdog-protected; only three fixed category slots exist. GDBus owner changes invalidate/disconnect all handles and callbacks in both helper and trusted main. Numeric IDs never survive an owner epoch; CloseNotification targets the recorded unique service owner, never a restarted service's reused ID. Quit/session-loss drains or kills/reaps the helper through the accepted lifecycle coordinator, before releasing instance ownership. A stuck native service is not an unbounded shutdown wait.

No shell, command string, PATH-selected executable, SDK notification fallback or arbitrary renderer native API is used. Python runs isolated (`-I`) with only required session/library environment keys, not passwords/recovery environment variables. Data crosses stdin JSON, not options/argv. Each queued batch rereads current global/category/privacy intent after every awaited native call; withdrawn choices abandon/rebuild it before claiming or sending, without poisoning unsent dedup keys. Bodies default to fixed generic text, omitting local names/paths, URLs, aliases/device names and all remote text. Explicit names/path display includes only bounded checked local root text, strips controls/bidi and escapes native body markup. Secrets/content are never included, even opt-in. Titles and action IDs are fixed.

Runtime service availability and advertised action capability are separate safe metadata from saved intent. The only action is **Open Nanosync**, invoking the actual step-10 lifecycle reopen coordinator; no path/browser/shell action is accepted. Missing action support uses launcher reopening and remains honestly unsupported. Tray presence is not required.

## Verification boundaries

Focused service, CLI, backend and browser tests use fake clocks, temporary roots, memory credential providers and explicit barriers. `build/desktop/notifications-gate.ts` uses actual libnotify/PyGObject against a synthetic notification service in an activation-free private D-Bus, disposable Xvfb/HOME/XDG and known fixture process groups. It exercises accepted IDs, actual Open Nanosync callbacks, explicit dismissal versus expiry, unavailable service, markup/data handling, missing action support and helper shutdown. It does not target a host notification daemon, keyring, panel, login/startup configuration or user files.

The standalone native notification fixture is not evidence of installed compositor display, lock-screen privacy, real panel interaction or release-package integration. SDK/lifecycle packaged gates and the stable product build remain separate checks. Real installed-session/keyboard/panel/keyring/Wayland and large-hardware validation remain step 12. Paper UI provenance warning remains, not a license grant.
