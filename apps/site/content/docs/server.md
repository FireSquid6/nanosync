# Run a server

The nanosync executable includes the HTTP API, metadata database, object storage, background integrity scanning, and optional browser administration. It does not terminate TLS. Start with loopback; put an HTTPS reverse proxy in front for remote use.

## Initialize private storage

Run as the user that will own the server process. Keep its storage outside every sync root:

```sh
umask 077
nanosync server init --server-dir "$HOME/nanosync-server"
nanosync server vaults create --server-dir "$HOME/nanosync-server" --name documents
```

Choose an owner password, then save and acknowledge the vault recovery secret. Local creation temporarily handles plaintext keys on the operator machine. Recovery secrets cannot be retrieved later.

Start in the foreground:

```sh
nanosync server run --server-dir "$HOME/nanosync-server"
```

The defaults are `127.0.0.1:7337`. Stop cleanly with SIGTERM or Ctrl-C. Browser administration is off by default. To enable it locally, restart with:

```sh
nanosync server run --server-dir "$HOME/nanosync-server" --web-ui \
  --external-origin http://127.0.0.1:7337
```

Visit `http://127.0.0.1:7337/admin` and log in with the owner password. The UI is embedded; no frontend service or adjacent asset directory is needed. Without `--web-ui`, `/admin` assets and APIs return 404. Without a configured external origin, enrollment can discover an enabled UI but does not invent an administration link.

## HTTPS reverse proxy

For a TLS terminator on the same host, configure its HTTPS virtual host first, then run:

```sh
nanosync server run --server-dir "$HOME/nanosync-server" \
  --host 127.0.0.1 --port 8787 --web-ui \
  --external-origin https://sync.example.com --trusted-proxy 127.0.0.1
```

Replace `sync.example.com` with your actual hostname. The origin is exactly scheme, host, and optional port: no path or trailing slash. Configure the proxy to:

- Accept only the intended public hostname and route all paths to `http://127.0.0.1:8787`.
- Preserve the browser `Origin` and `X-Nanosync-CSRF` headers. Serve administration assets on the same HTTPS origin.
- Disable shared caching for `/admin` HTML and API responses.
- Allow streaming sync uploads with suitable body-size and timeout limits.
- Avoid logging Authorization, cookies, passwords, or request bodies.

`--trusted-proxy` is an exact IP address of the backend's observed socket peer, not a hostname, subnet, or value taken from a forwarding header. `Forwarded` and `X-Forwarded-*` do not establish trust. The configured HTTPS origin is authoritative for requests from this trusted peer, so the proxy must restrict host/origin routing. Restrict backend access: untrusted processes sharing a trusted source IP are not separated by this setting.

For a proxy on another machine, bind an appropriate backend address, firewall it so only that proxy can reach it, use the exact observed proxy IP, and add `--acknowledge-exposure` for nonloopback binding. This flag acknowledges exposed HTTP sync transport; it does **not** add TLS or permit nonloopback browser HTTP. A VPN alone does not relax the browser HTTPS requirement. Do not publicly expose the backend listener.

Clients should enroll using the public HTTPS URL, not the backend address. Test enrollment and browser login through that URL before placing real data on the service.

## Process and storage ownership

Run only one serving runtime against a server directory. Initialization, local vault creation, and offline administrative reports share its exclusive ownership gate. Stop the runtime before those operations. Device administration and vault view/rename/delete are metadata-only and remain available while it serves; use the browser to create vaults without stopping it.

A lock error is not permission to remove `.sync-owner`. Shut down the owning process and retry. Definitively dead process owners are recovered automatically. Keep the same server directory and operating-system user when restarting. If supervising with your own service manager, supply absolute executable/state paths and allow graceful shutdown before restart.

Back up the entire stopped server state consistently, not just `metadata.sqlite` or the executable. See [Administration](administration.md) for maintenance and recovery limits, and [Security](security.md) for the trust boundary.
