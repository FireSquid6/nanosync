# Issue #18 — design coverage

Source: https://github.com/FireSquid6/nanosync/issues/18 . This matrix distinguishes a designed screen from a working native capability. **None of the native integration acceptance criteria is certified by this HTML prototype.**

| Requirement family | Design location | Implementation / validation still required |
| --- | --- | --- |
| Client-only, terminal-free daily use | Folders, Connections, setup flow | Electrobun shell and actual shared client service; no embedded server administration |
| Client CLI parity | Connections add/view/remove; binding connect/view/disconnect; Sync now and background sync | Audit exact CLI flags, error codes and operations at implementation time; desktop additions need matching CLI commands |
| Multiple servers/vaults/local copies | Folders list and inspector; vault/local path setup | Engine-owned identities and real nonoverlap checks |
| Shared desktop/CLI state | Owner row and shared-state explanations | Authenticated local IPC; credential/settings/state interoperability; one active writer |
| Existing CLI owner visible; Quit preserves CLI sync | Folder owner and Quit confirmation | Real owner detection and coordinated stop/handoff; no force bypass of active locks |
| Enrollment server URL/authentication/device name | Setup step 1 | Discovery/authentication; never retain account password |
| Verification code + pending/retry/denied/expired/error | Setup step 2 and response preview | Persist exact pending identity before submission and resume across interruption/restart |
| External approval / administration unavailable | Setup step 2 capability toggle | Advertised trustworthy URL only; system browser, not embedded admin |
| Vault/recovery key/local folder | Setup step 3 | Native folder picker, secure key entry, actual key validation; request recovery only when required |
| Nonempty destination acknowledgment | Setup step 3 | Real inventory and safe reconciliation; no inferred remote deletions |
| Connect without transfers, explicit Start | Setup step 5, Finish without syncing / Start syncing | Durable connected-not-started state; equivalent CLI semantics |
| Startup opt-in, tray optional, background default on | Setup step 4; Settings General | OS integration and settings persistence |
| Close vs. Quit, user-login-only startup, logout stop | General explanations and lifecycle previews | Native window/process/session behavior; startup shown/hidden branch testing |
| Tray status + reopen only | General tray preview | Native status icon, green/red with non-color badge, direct activate vs. menu-only fallback, actual unavailable backend |
| Folder statuses, progress, last success | Folders and Preview state selector | Strict Up-to-date predicate, transfer progress/recovery; state derived from engine, not sample text |
| Individual/global pauses are separate | Folders toolbar + inspector | Durable settings; safe stopping boundary in both directions; shared CLI behavior |
| OS credential store locked/unavailable | Locked preview and unlock explanation | Native secure-store adapters; no silent plaintext fallback |
| Protected-file headless mode | Connections migration preview | Keep existing CLI state usable; explicit atomic migration UX, secure recovery and cleanup |
| Preserved conflicts with manual resolution | Conflicts | Real conflict journal/list and CLI-equivalent acknowledgment; preserve both versions |
| Device-local ignore editor | Inspector → Edit ignore rules | Existing parser and tracked-entry semantics; coordinate saving with owner safely |
| Safe disconnect, pending work acknowledgment | Disconnect dialog | Real pending inventory, active-owner/lock coordination, no data erasure |
| Safe connection removal | Connections → Details → Remove connection | Affected binding inspection, explicit forced-state abandonment and owner gates; never remote revocation |
| Missing root stops without mass deletion | Select Media → Retry folder | Engine root identity and recovery; no automatic recreation |
| Notification global/category controls, privacy defaults | Settings Notifications | Actual notification delivery, deduplication, persistent actionable details; no routine success/outage alerts |
| Diagnostics explicit and redacted | Settings Diagnostics | Shared CLI export; actual report generation/redaction. Current download is explicitly synthetic |
| No server administration, history/restore, eviction, updater | Absent from app; admin external only | Preserve exclusions in implementation |
| Linux-first Electrobun, Bun/SQLite | Design assumes desktop Linux, not proven runtime | Real Linux tray/lifecycle/keyboard onboarding smoke test; SQLite/runtime dependencies/package testing |
| Cross-platform foundations and packages | Not represented as UI | Nix/package-manager distribution, no silent self-update; later macOS/Windows validation before support claims |
| Deterministic automated recovery/concurrency tests | Browser tests cover UI guards only | Shared-state, ownership, journal/apply restart, pauses, enrollment, missing root and credential errors using deterministic engine tests |

## Non-prescriptive proposals

The information architecture, inspector placement, wording, sample identities and precise conflict/migration acknowledgment controls are design proposals. Secure credential migration and exact manual-conflict resolution are explicitly open technical work in issue #18. The design illustrates those decision points without claiming a new backend protocol.
