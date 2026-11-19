# First sync

Try nanosync with disposable folders on one Linux machine before connecting personal files. This exercise keeps the server on loopback, isolates client state from `~/.nanosync`, and binds two independent folders to one demo vault. It requires the executable from [Installation](installation.md).

## 1. Initialize and provision

In terminal A, create a private demo directory under your home directory:

```sh
umask 077
DEMO=$(mktemp -d "$HOME/nanosync-demo.XXXXXX")
printf 'Demo directory: %s\n' "$DEMO"
nanosync server init --server-dir "$DEMO/server"
nanosync server vaults create --server-dir "$DEMO/server" --name demo
```

Set an owner password at the hidden prompts. Vault creation displays a recovery secret and asks you to retype it to acknowledge its backup. Save it privately, outside the sync folders; it cannot be retrieved later. Do not record this terminal in shared logs.

Local vault creation requires a stopped runtime. Now start it:

```sh
nanosync server run --server-dir "$DEMO/server" --host 127.0.0.1 --port 7337 \
  --web-ui --external-origin http://127.0.0.1:7337
```

Leave this terminal running. Browser administration is available at `http://127.0.0.1:7337/admin`, using the owner password. This HTTP setup is for the same machine only, not a public deployment.

## 2. Enroll and approve a client

In terminal B, enter the exact demo directory printed in terminal A:

```sh
umask 077
printf 'Demo directory from terminal A: '
read -r DEMO
test -d "$DEMO/server" || exit 1
nanosync client connections add --credential-mode protected-file --client-dir "$DEMO/client" \
  --url http://127.0.0.1:7337 --alias demo --device-name demo-linux --wait-ms 0
```

Enter the owner password. The command submits a request, prints its UUID and verification code, and normally exits **3**, meaning pending approval, not failure to save the request.

Review the request on this same server:

```sh
nanosync server devices view --server-dir "$DEMO/server"
```

Compare the verification code with the client's printed code. Device names are labels, not proof of identity. Enter the exact matching request UUID:

```sh
printf 'Verified pending device UUID: '
read -r DEVICE_ID
nanosync server devices approve --server-dir "$DEMO/server" --device-id "$DEVICE_ID"
nanosync client connections add --client-dir "$DEMO/client" \
  --url http://127.0.0.1:7337 --alias demo --wait-ms 0
```

The repeated add resumes the saved request and stores approved credentials; it does not need a new password. You could instead approve the matching request in `/admin`.

## 3. Bind two empty demo folders

Still in terminal B:

```sh
mkdir "$DEMO/first" "$DEMO/second"
nanosync client vaults connect --client-dir "$DEMO/client" \
  --server demo --vault demo --path "$DEMO/first"
nanosync client vaults connect --client-dir "$DEMO/client" \
  --server demo --vault demo --path "$DEMO/second"
```

Supply the vault recovery secret when asked. It is needed only when this client lacks the vault key. Approval grants server access; the recovery secret separately unlocks encrypted data. Binding transfers no files. The folders must not overlap, and neither may contain server or client private state.

## 4. Publish and receive a file

```sh
printf 'Hello from nanosync\n' > "$DEMO/first/hello.txt"
nanosync client sync --client-dir "$DEMO/client" --path "$DEMO/first"
nanosync client sync --client-dir "$DEMO/client" --path "$DEMO/second"
cmp "$DEMO/first/hello.txt" "$DEMO/second/hello.txt"
```

`cmp` produces no output when the contents match. To keep the second folder syncing in the foreground:

```sh
nanosync client sync --client-dir "$DEMO/client" --path "$DEMO/second" --watch
```

Stop watch mode with Ctrl-C. Only one sync process may own a particular replica at a time. For a second physical device, enroll it independently against the server's HTTPS address, approve its own request, and provide the recovery secret securely.

## Finish safely

Stop watch mode and the server in terminal A with Ctrl-C. The demo directory remains available for inspection; this guide deliberately does not delete state or secrets automatically. Keep the private directory until you have finished testing, then remove only this disposable demo using your usual file-management tools.

For real folders, create [ignore rules](ignore-rules.md) before first import, take an independent backup, and understand that existing local files participate in synchronization. See [Server](server.md) before enabling remote access.

## Inspect or pause synchronization

Use `nanosync client status [--path /your/folder]` to inspect observed heads,
conflicts, pending recovery, ownership and the last successful pass. Status does
not transfer files or unlock credentials. A completed pass with conflicts is not
“up to date”; observations become stale when their owner stops.

`nanosync client pause --all` pauses every binding in this client root.
`nanosync client pause --path /your/folder` pauses only that binding. Resume with
the corresponding `client resume` command. Global resume never clears a folder's
individual pause. Each command requires exactly one target. Intent survives a
restart; a current filesystem operation or bounded transfer can finish before the
owner reports paused. A watch remains available for resume; one-shot sync returns
an actionable local error while paused.

If a folder disappears, restore its original path and marker before retrying with
`client sync`. Do not create an empty replacement or delete the private journal:
Nanosync preserves pending recovery and will not recreate the root or interpret
its absence as mass deletion. A deliberate move/copy requires explicit repair.
