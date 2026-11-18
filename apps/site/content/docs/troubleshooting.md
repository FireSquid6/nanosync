# Troubleshooting

Preserve the sync folder, private client state, server state, and recovery material before attempting a reset. A journal or lock error is not a reason to delete `.nanosync`, `.sync-owner`, or `~/.nanosync`. Those files protect identity and interrupted work.

## Enrollment is pending or interrupted

Exit 3 means the request is saved and awaits approval. Review the server's pending devices, compare verification codes, and approve the exact request UUID. Then repeat `client connections add` with the same URL, alias, and client directory. This resumes the identity rather than creating another request.

Interactive enrollment normally waits for approval; `--wait-ms 0` submits without polling. Ctrl-C and temporary outages retain a pending identity. `client connections view` shows local knowledge, not a freshly fetched server status. Retry add to observe approval and durably save credentials.

Denied or expired requests exit 4. Investigate why before explicitly requesting a replacement with `--fresh`. Do not add `--fresh` to every retry. A timeout before initial login created pending state may require entering the password again. Repeated login attempts can trigger rate limits or a persistent lockout; fix credentials and stop retry loops rather than hammering the endpoint.

## Connection refused or browser administration unavailable

Check that the server process is running and that the client URL matches its listener or public HTTPS proxy. The default listener is `127.0.0.1:7337`: another machine cannot reach it. Do not solve this by exposing raw HTTP publicly; follow [Server](server.md).

`/admin` returns 404 when `--web-ui` is absent. An enabled UI may have no advertised link unless `--external-origin` is configured. For remote administration, verify the exact HTTPS origin, exact observed trusted-proxy IP, proxy host routing, and preserved Origin/CSRF headers. `--acknowledge-exposure` does not permit nonloopback browser HTTP. A server restart invalidates browser sessions; log in again.

## Folder not found, not bound, or unexpectedly nonempty

Create the destination directory before `client vaults connect`. It must be separate from private server/client state and must not overlap another binding. Connecting an existing nonempty directory requires confirmation: its files will participate in sync, not merely be left beside downloaded files.

`client sync` selects the nearest binding at the current directory or an ancestor. Use an explicit `--path` to avoid syncing the wrong folder. Use the same `--client-dir` as enrollment and binding; a marker alone does not contain credentials or vault keys.

Inspect local configuration without exposing secrets:

```sh
nanosync client connections view
nanosync client vaults view
```

These examples use the default client directory. Add your actual `--client-dir DIRECTORY` if you used isolated state.

## Permission or unsupported-file errors

Private state directories must be owned real directories with mode 0700. Secret files must be owned regular 0600 files without symlinks or hard links. Check that you are running as the original operating-system user. Do not broadly relax permissions or recursively chmod a sync folder to repair private state.

Included symlinks, hard-linked files, special files, and unsafe names fail visibly. Move unsupported entries outside the sync tree or exclude appropriate local-only paths with [ignore rules](ignore-rules.md) before import. nanosync does not preserve ACLs, extended attributes, or all Unix permission bits.

## A lock blocks an operation

Stop the sync process holding that replica before another sync, disconnect, or removal. Server initialization, local vault creation, and offline reports require a stopped runtime. Device administration and vault view/rename/delete can run while serving. `--force` and `--yes` never bypass a live lock. Do not manually remove lock files while a process could still be running.

## Ignore rules stop sync

Invalid or unsafe `.nanosyncignore` files fail closed. Rule changes during apply may require restoring the original rules to finish recovery. Unignoring previously tracked paths and remotely renaming ignored entries into included paths can require deliberate reconciliation. Preserve local copies and restore the previous rule while investigating; see [Ignore rules](ignore-rules.md).

## Unauthorized, deleted vault, or integrity failure

A revoked credential cannot be repaired by retrying sync. Have the owner inspect device access; preserve local files and enroll deliberately if access should be restored. A missing vault key requires the correct recovery secret, not an owner-password reset.

`VAULT_DELETED` means the server vault was tombstoned. The client stops and keeps files and cached keys. Disconnect the obsolete binding; provision and connect a different vault only deliberately. Neither retrying nor supplying the recovery secret restores deleted server data.

For integrity failures or rollback warnings, stop and investigate the server's storage and backups. Do not suppress the warning by erasing local state or deleting suspect objects. Offline reports and bounded scans are described in [Administration](administration.md). There is no CLI history/restore command to repair a damaged vault automatically.

## Requesting help

Record the exact command with secrets removed, executable revision/build, error code, exit code, and whether the runtime was running. Default human-readable output, including errors, goes to stdout. With `--json`, successful results go to stdout and structured errors and diagnostics go to stderr. Redact passwords, recovery secrets, tokens, cookies, private state files, and personal paths before sharing diagnostics. Never upload your complete client state directory as a bug report.
