# Desktop local operations — issue 18, step 9

These operations share the existing client root, journal and Linux filesystem engine.
They do not add a daemon, conflict database, remote administration, merge editor or
credential provider. Local files and remote data are preserved on removal. Removal
is not remote revocation and makes no forensic-erasure promise.

## Manual conflicts

Open **Conflicts** from the Folders rail. The persistent list reads open journal
lineage in a checked, readonly SQLite snapshot, with no journal constructor,
migration, sidecar creation or credential access. Journal recovery/corruption is
reported as unavailable, not zero conflicts. **Open containing folder** resolves
binding/conflict UUIDs in trusted main, checks the original root and every path
component, then invokes the existing argv-only native opener. The renderer cannot
supply a filesystem target, SQL or shell command.

Keep/edit the desired files, deliberately remove or rename unwanted conflict
copies, then sync. Both versions stay available until deliberate file changes.
Reading/opening is not acknowledgment. There is no acknowledge/mark-resolved API:
only successful applied-manifest reconciliation changes open lineage, including
reopening it after a restore.

CLI equivalents (normal client/global flags still apply):

```text
client conflicts view [--path DIRECTORY]
client open [--path DIRECTORY] [--conflict UUID]
```

Without `--path`, conflicts lists all local copies. `open` keeps CWD/ancestor
selection. List data is `{version:1,bindings:[{connectionId,root,conflicts:
[{id,entryId,path,sourceRevisionId}],issue:null|CODE}],instructions}`. An explicit
local listing may include filenames/paths; it is not a diagnostics export.
Unavailable native integration returns a local exit-2 error; headless sync and
file-backed operations still require neither a display nor a keyring.

## Ignore validation and coordinated save

The folder inspector's **Edit ignore rules** loads exact text plus its file
signature. Validate before Save; editing a validated draft invalidates its
validation. Reload explicitly discards a draft. A stale signature never silently
rebases the draft onto another editor's rules.

```text
client ignores view [--path DIRECTORY]
client ignores validate --file PROTECTED_FILE [--path DIRECTORY]
client ignores set [--path DIRECTORY] --file PROTECTED_FILE --expected-signature SIGNATURE
```

Protected input is an owned, no-follow, regular nlink-1 mode-0600 file, bounded to
64 KiB and decoded as fatal UTF-8; empty rules are valid. Rules are not accepted in
argv or environment variables. Validation is pure and does not need a bound root;
`--path` on validate does not change the grammar. Invalid input produces safe
code/line information, never reflected patterns. `view` returns
`{version:1,connectionId,text,fileSignature}`; `set` returns
`{version:1,connectionId,fileSignature}`. Signature is `absent` or lowercase SHA256
of decoded text. Invalid/stale/recovery-blocked saves are local exit-2 failures
using the existing JSON error envelope on stderr. Validation success is
`{valid:true}` inside the normal success envelope.

The parser is the existing exclusions-only DSL: blank lines/comments, `*`, `**`,
`?`, slash anchors and directory suffixes. Negation, backslashes, character classes,
unsafe path segments and `***` remain unsupported. No alternate glob library,
pattern builder or dialect expansion is introduced. Scanner/apply ignored-entry
identity checks and manual unignore/rename recovery remain authoritative.

A live owner performs save under its existing replica lock and retains origin,
instance, watcher, keys and continuous intent. A runtime admission gate blocks new
passes/readiness scans while waiting for the already admitted pass to finish.
Active pass checkpoints do not wait on that gate, avoiding self-deadlock. After
it settles, durable pending operations/transfers/apply/hydration/proposal/restore/
merge obligations or accepted/applied mismatch refuse a changed rule basis. Stop
awaits maintenance before DB close/key cleanup/unlock. Persistent global/folder
pauses are never toggled; concurrent user pause changes win. An idle/unowned save
does not start work or promote continuous intent and needs no credentials.

After pending-basis checks, the owner durably invalidates verified status before
any commit, including attempts that later fail after rename. An unowned edit
recovers its locked private WAL before checking historical root identity; passive
view never recovers a journal or creates sidecars. The desktop setter passes a
binding UUID selector, resolved inside initial registry coordination, not a path
obtained by a premature historical check. Rebinding that path cannot redirect an
old UUID request to a new copy. Owner IPC is awaited only after releasing the gate;
CLI string/path selection retains its existing semantics.

Save validates the original root, writes/fsyncs an exclusive same-root 0600 stage,
rechecks file signature and stage identity/content, atomically renames and fsyncs
the directory. Only exact root-local
`.nanosyncignore.<32 lowercase hex>.stage` names are reserved and checked for orphan
cleanup; nested/nonmatching names are not reserved. Unsafe orphans are preserved
and rejected, never followed, deleted or adopted. Existing `.nanosync-...` apply
and hydrate names are not blanket-excluded: their recovery verifier still owns
them. Root `.nanosync` and `.nanosyncignore` remain excluded from vault content.

POSIX rename is atomic but not a kernel compare-and-swap against arbitrary
noncooperating raw-file editors. The service serializes its writers and performs
a final checked signature comparison immediately before rename, without an await
in that commit interval. Do not claim an advisory lock constrains other editors.
A failure after rename but before directory fsync has an unknown durability
outcome: refresh, never automatically overwrite/retry with a new basis.

Authenticated control adds a strict `ignore-set` payload. It bounds decoded text
at 64 KiB and the explicitly identified edit envelope at 400 KiB (JSON escaping),
while ordinary requests retain their 16 KiB bound and progress frames their 2 KiB
bound. Replay IDs bind the entire validated payload, not just operation name.
An incompatible/unreachable owner is actionable; there is no local competing
writer fallback and no force ownership bypass.

## Inspection, explicit abandonment and removal recovery

**Inspect disconnect** in the folder inspector and **Connections / removal** in
the rail preview affected saved identities, root availability, live ownership and
content dirty state. A live-owned preview defers writable inventory until explicit
safe handoff; it never competes with its journal. Unowned inspection/full mutation
uses the existing full-content scanner. Hashing streams bounded chunks and yields
between them, rather than blocking the UI while hashing a 50-GB file. All dirty
facts are rechecked under ownership; a preview is not authorization to remove a
changed binding set. Explicit selection tokens bind the exact saved connections.

```text
client removals view [--path DIRECTORY | --server ALIAS_OR_ID]
client vaults disconnect [--path DIRECTORY] [--force] [--stop-owner]
client connections remove --server ALIAS_OR_ID [--force] [--stop-owner]
client removals resume --request-id UUID --confirm-removal
```

Existing disconnect success stays
`{connectionId,disconnected:true,filesPreserved:true}`; existing server removal stays
`{serverId,removed:true,remotelyRevoked:false}`. `removals view` returns
`{version:1,pending:null|RemovalIntent,inspection:null|{version:1,bindings:
[{connection,ownerPresent,rootAvailable,dirty:boolean|null}]}}`. Resume success is
`{version:1,completed:true,filesPreserved:true,remotelyRevoked:false}`. JSON envelopes,
stdout/stderr, remote exits and interruption remain unchanged. Local safety errors
are exit 2.

`--force` explicitly abandons synchronization journal/cache state, not files, rules,
conflict copies or remote data. Server removal without force refuses attached
bindings. `--yes` supplies neither force nor owner-stop consent nor replay
confirmation. A missing root cannot prove cleanliness; force selects the original
saved path and never creates it. Existing/replacement roots still require original
inode/device and marker identity, even with force. Foreign/copied markers and
symlinks are never overwritten. Stopping a live owner requires separate explicit
`--stop-owner`/desktop consent, outside registry gates, followed by all-lock
reacquisition/revalidation. A new contender winning the handoff means retry, not
steal. List and Quit never stop independent CLI owners.

One private `removal.json` holds a version-1 secret-free intent:

```text
{version,requestId,kind:'disconnect'|'server',serverId:null|UUID,force,
 phase:'removing-bindings'|'cleaning-credentials'|'credentials-complete',
 bindings:[{connection:originalConnection,
   rootIdentity:null|{device,inode},rootWasMissing}],credentialPaths:[relativePath]}
```

All ordered replica locks are acquired under registry serialization before intent
or destructive work. Server removal also uses the existing credential-operation
lease. The intent is published/fsynced before unlink; exact
`removal.json.<32 hex>.stage` leftovers are validated but never replay authority.
Legacy root recognition understands these records/stages; incompleteness is never
initialized as an empty root. Replay uses original intent identities, not nearest
marker/alias rediscovery. Missing markers/records are idempotent checkpoints only
under that intent. A journal visible after failed publication is not proof of
durability: replay flushes its checked file and containing directory before any
irreversible operation. Their directories are fsynced again on replay, even when an
entry is already absent after a prior unlink-to-fsync failure. Changed objects are
preserved and refused. No rollback/reset is offered after destructive cleanup.

Normal start/secret/enrollment/repair/migration operations cannot run through the
barrier. Nonsecret settings/listings and the removal summary remain available,
even after the original marker, connection record or server metadata is gone and
while the native provider is locked. Status retains intent binding identities with
removal attention rather than rescanning them as unbound/empty roots. The desktop
opens recovery directly and explicit resume uses request UUID, not missing aliases.

Provider cleanup reuses `credential-cleanup.json` and its exact original reference
inventory, atomically published from checked
`credential-cleanup.json.<32 lowercase hex>.stage` files. These private-root stages
are recognized/validated but never replay authority. Replay durably flushes the
checked cleanup journal and its directory before provider erasure; the outer
credentials-complete record is likewise flushed before inventory finalization. Existing private erase writes a marker, verifies readback, requires a
successful delete and verifies absence, handling missing-vs-locked ambiguity on
replay. Its inventory is retained until the outer intent durably records
`credentials-complete`; only then is cleanup journal finalization permitted. A
crash with every source metadata file already gone can still replay from original
refs. Standalone credential cleanup directs pending removals to their outer resume
instead of discarding that inventory. All server-associated key/pending references
are inventoried/validated; other servers' references are not touched. There is no
naive delete-false-means-missing path or second provider implementation.

## Verification scope

Focused tests use disposable roots, in-memory credential stores, actual journals,
real engine/HTTP fixtures, injected fsync failures and explicit promise barriers.
They cover removal phase/provider cutoffs, original identity replay with missing
metadata, locked provider retries, stale signatures, unsafe stages, active owner
maintenance, paused state, large-file chunk yielding, UI payload validation and
manual manifest-authoritative conflict resolution. Browser fixtures verify only
presentation, keyboard, themes, responsiveness and accessible confirmation; real
backend/engine evidence is separate. No actual keyring, user root, host window,
focus or global input is exercised. Installed-product native smoke/lifecycle,
notifications, diagnostics and release packaging remain later steps.
