# Opt-in server administration UI and explicit client/server CLI

## Problem Statement

The vault owner currently has to understand a mixed command surface to operate a server, enroll an approved device, provision vaults, and connect local directories. Enrollment prompts for basic inputs but provides limited guidance for approval, waiting, interruption, and retry. Server operators must use a terminal to manage allowed clients, and the distinction between stored server credentials and local directory bindings is unclear.

The owner needs a small, explicitly enabled browser administration surface and a predictable CLI that makes execution location explicit. Both interactive users and scripts must be able to complete the same operations safely, especially where credentials, unsynced changes, and permanent deletion are concerned.

## Solution

Organize all commands under `nanosync server` or `nanosync client`. Server commands operate locally against a server directory. Client commands manage named server connections, bind remote vaults to local directories, and synchronize them. Use a maintained prompting library for guided workflows and complete flag-based alternatives for automation.

Offer a browser administration UI at `/admin` only when the operator starts the server with `--web-ui`. Owner-password login allows client approval, denial, revocation, vault administration, and a recent administrative activity trail. Use copied Paper UI source components. Keep browser sessions separate from sync-device credentials, and keep files and existing recovery secrets out of the UI.

No compatibility with existing command names or stored state is required. This is a breaking redesign, not a migration project.

## User Stories

1. As a server operator, I want all server-local commands under `nanosync server`, so that I know where an operation executes.
2. As an approved-device user, I want all local client operations under `nanosync client`, so that server and client responsibilities are explicit.
3. As an interactive server operator, I want to select a server directory when I omit it, so that I do not need to memorize flags.
4. As an automation author, I want missing required inputs to fail without prompting, so that scripts do not hang.
5. As an interactive user, I want maintained input, password, selection, and confirmation prompts, so that workflows are consistent and accessible.
6. As an automation author, I want flags for non-secret inputs, so that every workflow can run unattended.
7. As a vault owner, I want secret input through hidden prompts, environment variables, or protected files, so that secrets do not appear in process arguments.
8. As an automation author, I want stable JSON output and actionable error codes, so that scripts can interpret results reliably.
9. As an interactive user, I want readable progress and next steps, so that I understand what the command is doing.
10. As an approved-device user, I want to add a named server connection, so that I can enroll without manually managing credentials.
11. As an approved-device user, I want a unique local server alias separate from my device name, so that I can select servers without confusing administrator-visible identities.
12. As an approved-device user, I want my hostname offered as the device name, so that enrollment requires less typing.
13. As an enrolling user, I want an unambiguous verification code shared with the approval surface, so that the owner can identify my request.
14. As an enrolling user, I want the exact server-local approval command always displayed, so that enrollment works without a web UI.
15. As an enrolling user, I want an administration link only when the server enables the UI, so that I am not directed to an unavailable page.
16. As an enrolling user, I want visible waiting status until approval or a terminal outcome, so that I do not have to repeatedly restart enrollment.
17. As an automation author, I want configurable enrollment waiting, including submit-and-exit, so that enrollment fits scripted orchestration.
18. As an enrolling user, I want Ctrl-C and lost responses to preserve resumable state, so that retry does not create duplicate identities.
19. As an enrolling user, I want temporary network failures retried with bounded backoff, so that a brief outage does not lose my request.
20. As an enrolling user, I want denial and expiration explained before explicitly requesting fresh enrollment, so that rejected requests are not silently recreated.
21. As an approved-device user, I want independent pending enrollment per server, so that one abandoned request does not block another connection.
22. As an approved-device user, I want an existing connection shown instead of re-enrollment, so that credentials are not rotated accidentally.
23. As an approved-device user, I want successful enrollment to suggest vault connection without starting it automatically, so that authorization and synchronization remain separate decisions.
24. As an approved-device user, I want to view stored server connections and enrollment states without exposing credentials, so that I can understand local configuration safely.
25. As an approved-device user, I want removal refused while vaults remain attached, so that I do not accidentally abandon synchronization state.
26. As an approved-device user, I want forced connection removal to disconnect attached vaults while preserving files, so that I can intentionally forget a server.
27. As an approved-device user, I want local removal distinguished from remote revocation, so that I know whether server access remains authorized.
28. As an approved-device user, I want to select a stored server and available remote vault interactively, so that I can connect without knowing identifiers.
29. As an approved-device user, I want the destination to default to CWD, so that connecting a directory is convenient.
30. As a vault owner, I want recovery-secret entry only when the local key is missing, so that ordinary reconnection does not require unnecessary secret handling.
31. As an approved-device user, I want nonempty-directory confirmation, so that I understand existing files will participate in synchronization.
32. As an approved-device user, I want connecting a vault to avoid file transfer, so that I decide when synchronization begins.
33. As an approved-device user, I want multiple nonoverlapping directories bound to the same vault with independent sync state, so that each replica remains safe.
34. As an approved-device user, I want to view vault bindings with server, vault, and directory identities, so that I can inspect configuration.
35. As an approved-device user, I want disconnect to preserve local files and remote data, so that removing a binding is not data deletion.
36. As an approved-device user, I want abandonment of unsynced work to require explicit force, so that pending synchronization state is not discarded accidentally.
37. As an approved-device user, I want destructive local operations to respect active sync locks even with force, so that they cannot corrupt a running sync.
38. As an approved-device user, I want sync to discover the vault from CWD or an ancestor, so that I can synchronize from inside a bound directory.
39. As an approved-device user, I want an explicit path selector and foreground watch mode, so that I can target another directory or synchronize continuously.
40. As a server operator, I want browser administration disabled unless explicitly enabled, so that it does not silently expand my server's attack surface.
41. As a server operator, I want the UI served by the existing server, so that I do not deploy a separate frontend service.
42. As a vault owner, I want owner-password browser login with expiry and logout, so that I can administer without enrolling my browser as a sync device.
43. As a vault owner, I want secure transport, cookies, and CSRF defenses, so that browser administration is protected from common web attacks.
44. As a vault owner, I want pending requests to show metadata and verification codes, so that approval is based on more than a device name.
45. As a vault owner, I want to approve or deny requests in either the browser or server CLI, so that I can choose my administration surface.
46. As a vault owner, I want active and revoked clients listed and access revocation confirmed, so that I can manage allowed devices deliberately.
47. As a vault owner, I want revocation described as access removal rather than erasure, so that I understand retained client data and keys remain usable locally.
48. As a server operator, I want server-local vault list, create, rename, and delete commands, so that provisioning belongs to server administration.
49. As a vault owner, I want the same vault administration in the browser, so that routine operations do not require SSH.
50. As a vault owner, I want newly created recovery material displayed only in its explicit delivery workflow with acknowledgement, so that I can back it up without exposing it elsewhere.
51. As an automation author, I want protected recovery-secret file output for vault creation, so that scripted provisioning remains recoverable.
52. As a vault owner, I want browser vault creation to encrypt locally before submission, so that ordinary server persistence contains only encrypted material.
53. As a vault owner, I want creation retries to avoid duplicate or unrecoverable vaults, so that interruptions do not lose my recovery material.
54. As a vault owner, I want permanent deletion to clearly warn about history, encrypted objects, recovery wraps, backups, and possible unsynced clients, so that I understand the consequences.
55. As a vault owner, I want deliberate deletion confirmation that general force/yes flags cannot bypass, so that automation shortcuts cannot erase a vault accidentally.
56. As a vault owner, I want deletion allowed without client consent, so that offline devices cannot block server administration.
57. As a vault owner, I want deletion to immediately block server access and safely reclaim storage, so that racing sync cannot resurrect the vault.
58. As an approved-device user, I want a deleted-vault error to stop sync while preserving my files, so that server deletion never becomes mass local erasure.
59. As a vault owner, I want a recent administrative activity list with timestamps and action origin, so that I can understand changes without exposing file names or secrets.
60. As a browser user, I want accessible Paper UI controls and responsive layouts, so that administration works with keyboard navigation and on mobile screens.

## Implementation Decisions

### Architecture and domain boundaries

- Use the existing Bun/TypeScript runtime, portable protocol/cryptography/sync core, transactional SQLite metadata, and abstract object storage. Preserve immutable encrypted objects and compare-and-swap revision publication for normal synchronization.
- A server connection stores a canonical URL, unique local alias, device identity, credential, and enrollment state. A connected vault binds one remote vault to one local directory with independent synchronization state. Do not confuse this vocabulary with the existing internal directory-binding type named Connection.
- Separate server-local administration, owner browser administration, and approved-device synchronization authority. Browser owner authority is not a sync-device identity.
- Intentionally supersede prior CLI-only administration and remote-client vault provisioning decisions. Server-local creation handles plaintext key material transiently on the server machine; this accepted exception must be reflected in security documentation. Do not persist plaintext vault keys on the server as part of provisioning.
- Owner-password browser administration intentionally makes knowledge of that password sufficient to approve clients. Password authentication and per-vault recovery/decryption remain distinct.
- Existing device-credential self-revocation and last-administrator safeguards remain applicable to device-admin routes. Do not treat browser/local owner actions as device self-revocation.
- Update architecture, security, operational, protocol, decision, and CLI documentation to reflect the intentional changes. Preserve unrelated encryption and sync invariants.
- No legacy command aliases, legacy bootstrap workflow, state migration, or compatibility preservation is required. Avoid unrelated format or cryptographic changes merely because compatibility is unnecessary.

### CLI structure and prompting

- Server commands comprise init, run, devices view/approve/deny/revoke, vaults view/create/rename/delete, and an admin group for existing reports/maintenance. All operate locally against a server directory supplied by flag or interactive prompt.
- Client commands comprise connections add/remove/view, vaults connect/disconnect/view, and sync. Vault creation and renaming are not client operations.
- Use a maintained prompting library, recommended `@inquirer/prompts`; do not build custom terminal prompt or password handling.
- Support explicit non-secret flags for all selections. `--non-interactive` and non-terminal execution never prompt. Missing required information fails actionably rather than guessing or hanging.
- Secrets use hidden prompts, environment variables, or protected files, never literal argument values. `--json` provides stable machine-readable output; progress belongs outside machine-readable result output. Define and document stable result/error codes and exit statuses, including pending approval.
- `--yes` is limited to ordinary confirmations. It cannot authorize abandoning unsynced work, vault deletion, or bypassing sync locks.

### Connection enrollment and removal

- Connections add collects URL, local alias, password, and device display name, defaulting the latter to hostname. Persist pending state before the first potentially lossy enrollment submission and keep pending state independent per server.
- Display a request-bound verification code consistently in the enrolling CLI, browser pending list, and server-local approval workflow. Approval uses an exact identity, never a display name alone; the code aids comparison and is not authentication material.
- Always display a runnable server-local approval command. Omit the server-directory argument when unknown so the server command prompts rather than inventing a directory.
- Extend public server capability discovery with actual web-administration availability. Only show an administration link when enabled. Links contain no credentials and use the configured trustworthy external origin where necessary.
- Interactive enrollment waits until approved, denied, expired, or interrupted. Show progress, retry temporary outages with bounded backoff, and support `--wait-ms`, including zero and finite waits for scripts.
- Preserve requests on Ctrl-C and lost responses. Resume idempotently without unnecessary password entry. Denied/expired requests require explicit fresh enrollment. Show existing connections rather than silently re-enrolling.
- Durably save approved credentials before clearing pending state. Finish with guidance to client vaults connect, not automatic binding/sync.
- Connections view lists saved connections and enrollment state without secrets. Normal removal refuses attached vaults. Forced removal disconnects them and forgets credentials, preserving local files and remote data and performing no remote revocation. Warn that pending synchronization state is discarded. Never bypass active sync locks.

### Vault binding and synchronization

- Vaults connect selects a server, lists available remote vaults, selects a vault and destination (default CWD), and requests a recovery secret only if the vault key is absent locally.
- Confirm that existing files in a nonempty destination will participate in synchronization. Binding itself transfers nothing.
- Permit multiple directory replicas of one remote vault with independent journals; forbid overlapping sync roots and preserve existing filesystem/path safety checks.
- Vaults view lists local bindings with server alias, vault identity, and directory. Disconnect preserves files and remote data, requiring `--force` to abandon unsynced state. Neither force nor yes bypasses active sync locks.
- Client sync defaults to the nearest valid binding at CWD or an ancestor. Support `--path` and foreground `--watch`. Keep background service installation out of scope.

### Web administration and sessions

- Enable only with `nanosync server run --web-ui`, serving the UI at `/admin` on the existing listener. No separate frontend deployment is required.
- When disabled, UI assets/routes and browser authentication/administration endpoints are unavailable. Existing device APIs retain their separate authentication requirements.
- Require HTTPS for non-loopback browser access, typically via external TLS termination. Define explicit external-origin/trusted-proxy configuration; spoofed forwarding headers must not establish transport security or authorization.
- Use separate administration-only sessions with HttpOnly, SameSite cookies, Secure under HTTPS, CSRF protection, explicit logout, 30-minute idle expiry, and 12-hour absolute expiry. Do not persist browser sessions across restarts or use persistent browser cookies.
- Rate-limit password login and deletion password reauthentication. Browser cookies must not authorize sync/object access, and sync/enrollment credentials must not become browser session credentials.
- Copy needed React component source and scoped styles from FireSquid6/paper-ui on GitHub. Record the upstream revision and preserve applicable notices. Use its native/Radix accessibility foundations and maintained dependencies, not a published Paper UI package or hand-built dialog/focus behavior.

### Client and vault administration

- Pending-client views show display name, platform, client version, request time, identity, and verification code. Support approval and denial, plus active/revoked lists and confirmed revocation.
- Explain that revocation prevents future access but does not erase downloaded ciphertext, plaintext, or keys. Retain existing limits and authentication safeguards unless an explicit change is necessary for the new authority model.
- Server-local CLI and browser provide vault list/create/rename/delete. Do not expose file browsing or recovery-secret retrieval.
- Server-local creation delivers a newly generated recovery secret with explicit acknowledgement or to a protected output file for automation. Keep transient secrets out of normal logs/results.
- Browser creation generates the vault key, recovery secret, and initial encrypted content in-browser and submits only encrypted material. Display the secret only in the creation workflow; require acknowledgement before completion, and do not store plaintext key material in browser storage.
- Reuse portable cryptographic/protocol primitives instead of creating an alternative browser encryption format. A compromised server can deliver malicious browser code; resistance to this is not promised.
- Creation must be retry/crash safe, including lost responses and recovery acknowledgement. Never silently create a vault whose recovery material was not safely delivered. Browser refresh/retry must recover to a safe, explicit state without persisting plaintext browser keys.

### Permanent deletion

- Deletion permanently removes vault metadata, history, encrypted objects, and recovery wrap. Explain that recovery secrets alone cannot restore deleted server data without a server backup.
- Warn prominently that offline/connected clients may have unsynced work. Do not require their consent or reliable online-state detection.
- Browser deletion requires exact vault-name entry plus owner-password reauthentication. Interactive CLI deletion shows server directory, name, and UUID and requires exact name entry. Scripted deletion requires `--vault <uuid>` and `--confirm-delete <same-uuid>`. General `--yes` and `--force` do not substitute.
- Atomically transition the vault to unavailable/deleted, then safely reclaim encrypted objects. Introduce durable deletion state and restart-safe cleanup as needed in metadata/storage; deleted identifiers cannot be reused to recreate the vault. Publication, upload, and cleanup races must not resurrect it or damage other vaults.
- Normal retention protections for live vaults remain unchanged. Explicit confirmed deletion intentionally overrides retention for the deleted vault.
- Provide a stable deleted-vault outcome distinguishable from transient failure. Clients stop syncing that binding, preserve files and cached keys, and explain disconnect/reconnection options. Never translate vault deletion into deletion of local files or endless outage retries.

### Recent activity and schema/API changes

- Extend the existing audit trail for successful approval/denial, revocation, and vault create/rename/delete, recording timestamp, target, actor where available, and browser versus server-local origin. Add a read-only recent-activity browser view without secrets or file names; this is not a reporting dashboard.
- Extend metadata and protocol validation for browser sessions, pending-request denial, durable deletion/cleanup, and action provenance as required. Reuse existing repositories, transaction boundaries, and strict request validation rather than independent browser-only business logic.
- Preserve existing server-wide device authorization and per-vault isolation. Vault lists/recovery-wrap access needed by approved clients remain available, but provisioning mutations belong to local/browser owner administration.

## Testing Decisions

- The user confirmed the primary seam: exercise end-to-end CLI workflows against a real temporary server, and browser workflows against the same server. Assert observable outcomes, returned authorization errors, file preservation, and durable results, not component state or private helper calls.
- Prefer existing seams: Bun CLI integration tests already initialize temporary server/client directories, invoke the CLI, run real servers, enroll/approve devices, create multiple vaults, and synchronize two replicas. Extend these patterns for the new command tree rather than testing every helper independently.
- Existing connection tests cover binding discovery and overlap safety; existing sync tests cover replica convergence and locks. Extend them through public CLI workflows for CWD discovery, repeated vault bindings, forced removal/disconnection, and retained files.
- Existing multi-vault and enrollment tests inject lost responses and verify retry safety. Extend that prior art for per-server pending requests, interruption, approval/denial/expiry, existing-connection behavior, and vault-creation acknowledgement failures.
- Test interactive prompting through the process/terminal boundary using the maintained library and a suitable terminal test harness. Test noninteractive missing inputs, supplied flags, secret-file/environment input, JSON output, exit statuses, and absence of secret leaks. Avoid asserting incidental prompt implementation details.
- Add browser integration tests, preferably with Playwright, against the real nanosync server for opt-in routing, login/logout, expiry, request approval/denial, revocation, vault creation/rename/deletion, and activity. Cover mobile layouts, keyboard interaction, accessible names, and destructive confirmation focus behavior.
- Extend existing server-handler authentication tests for focused security cases that are expensive or unreliable through a browser: cookie attributes, CSRF rejection, session authority separation, deterministic idle/absolute expiry, rate limits, trusted-origin/proxy policy, and disabled browser endpoints. Reuse existing injected-clock/request-handler seams rather than introducing another service layer solely for tests.
- Verify plaintext recovery/key material is absent from server submissions for browser creation and absent from ordinary output, logs, browser storage, and persisted server provisioning state. Explicit recovery delivery is the only user-visible exception.
- Test permanent deletion with concurrent publication/upload, restart during cleanup, and multiple vaults. Assert immediate access rejection, no resurrection, eventual safe reclamation, unrelated-vault preservation, and retained client plaintext. Test that yes/force cannot bypass confirmations.
- Retain existing sync, cryptographic, storage, and protocol regression suites. Runtime tests remain the authority for success; a UI snapshot alone does not demonstrate correct administration.

## Out of Scope

- Backward-compatible command aliases, stored-state migration, or legacy bootstrap user workflows.
- Multiple owners/accounts, sharing, role editing, or a general administrator-permission system.
- File browsing, plaintext previews, recovery-secret retrieval, or key/history restoration controls in the web UI.
- Separate frontend hosting, built-in TLS, automatic background services, local IPC, or client status/history/conflict/eviction commands.
- Remote client CLI vault creation/renaming/deletion; use server-local commands or the browser.
- Remote revocation as a side effect of local connection removal, or data erasure as a side effect of revocation/disconnection/deletion.
- Client approval of vault deletion, guaranteed knowledge of unsynced remote work, or preserving deleted-vault history under normal retention rules.
- Protection against malicious browser code served by a compromised server, general audit analytics, or unrelated cryptographic/protocol redesign.

## Further Notes

- The confirmed household/small-team, single-owner model remains unchanged. The vault owner and server operator will usually be the same person.
- The guiding destructive-operation distinction is explicit: remove/disconnect changes local configuration, revoke changes future server authorization, and delete destroys server-side vault data. None silently erases client plaintext.
- Detailed endpoint names, schema layout, verification-code presentation, retry intervals, and JSON error/exit vocabulary may be selected during implementation, provided the observable requirements and security boundaries above are preserved and documented.
- This issue is ready for implementation planning without further product interviewing. Publishing it does not itself implement or deploy the feature.
