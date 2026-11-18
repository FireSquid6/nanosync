# Ignore rules

Put a `.nanosyncignore` file in the sync root **before first import** to keep caches, virtual environments, and other local-only data out of the vault. This is a device-local control file, not `.gitignore` integration. It is never uploaded or downloaded, and rules from another device are never applied automatically.

For example, create this file with your editor:

```gitignore
# Local environments and caches
.venv/
__pycache__/
*.pyc
node_modules/
/build/
```

Use an owner-owned regular file with no group/other write access and a maximum size of 64 KiB. Unsafe files or invalid patterns fail the sync pass rather than silently disabling exclusions.

## Matching rules

Matching is case-sensitive. Blank lines and whole-line `#` comments are ignored.

| Pattern | Meaning |
| --- | --- |
| `.venv/` | A directory named `.venv` at any depth, including its descendants. |
| `*.pyc` | A matching file or directory basename at any depth. |
| `/build/` | Only the root-level `build` directory and descendants. |
| `project/cache/` | That directory relative to the sync root. A slash within the pattern anchors it. |
| `logs/**/debug.txt` | Matching paths beneath the root-level `logs` directory, across path segments. |

`*` and `?` match within one segment; `**` spans segments. A trailing `/` matches directories and their descendants, not a regular file with the same name. A pattern without `/` matches basenames at any depth. The root itself is never excluded.

Rules only exclude. Negation (`!`), bracket expressions, escaping, and per-directory ignore files are unsupported. You cannot exclude a parent and re-include one child. Existing `.gitignore` files do not control nanosync.

## Ignored means untouched, not deleted

Excluded directories are not opened or inventoried. Local edits under an ignored path are not uploaded or published as deletions. Remote additions, changes, and deletions there do not touch local files. This lets a device keep a local environment that should never participate in synchronization.

Ignoring previously tracked data leaves that device's shared manifest entries unchanged when it publishes other work. Another device without the rule can still modify or delete those entries. Ignoring data does not remove it from the server or reclaim storage, and is not a way to retract an accidentally uploaded secret.

Included symlinks, hard links, and special files still fail safely. Ignoring an entire local-only directory before import avoids examining unsupported files inside it; do not depend on silent skipping of unsupported included entries.

## Change rules deliberately

Stop watch mode before editing `.nanosyncignore`, then restart sync. Watch mode reloads rules on watcher events and periodic scans, but changing them during a scan or apply aborts the operation. If an interrupted apply is persisted, restore its original rules until recovery completes.

Removing a rule is not an automatic reconciliation. A newly included path may contain an old local copy, a local edit, or remote-only data; nanosync refuses to guess whether absence means deletion. Back up or move the local copy and reconcile deliberately before unignoring. Restore the old rule to continue syncing unrelated paths while you investigate.

A remote rename of a previously tracked ignored entry into an included path also fails before apply, rather than moving or overwriting the local copy. Preserve both local data and private client state when resolving these errors. Do not remove the binding marker or journal to force a fresh import of the same directory.
