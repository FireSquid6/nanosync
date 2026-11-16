# Embedded owner administration

`bun run build:frontend` bundles this React frontend using Bun's **browser**
target and generates `generated/assets.ts`. The generated map is checked in so
source server runs work immediately after install; regenerate after UI changes.
`bun run build:binary` always regenerates and embeds it. All runtime assets are
served by the existing server only with `server run --web-ui`; no CDN or extra
frontend service is used. See `PAPER-UI-NOTICE.md` for copied source provenance.

HTML/API/error responses are no-store. Content-hashed JS/CSS have immutable
caching, exact allowlisting, nosniff and a restrictive CSP. Unknown paths have no
SPA fallback. Browser sessions/CSRF tokens are memory-only; native password fields
are cleared after submit. No file browsing or recovery retrieval exists.

Creation uses the portable sync-core encryption format. Save the recovery secret,
acknowledge it, then save the encrypted receipt before publishing. Reenter the
saved secret to verify unwrap, manifest decryption and reference MAC before every
publish/retry. Only the encrypted request is retained in localStorage; it contains
no plaintext key or secret. Refresh and lost responses resume the same request.
Do not delete that receipt after a lost response until retry succeeds. There is
no automatic silent restart of an interrupted creation. Logout clears displayed
secret material but deliberately retains an acknowledged encrypted receipt.

Run `bun run test:browser` for Playwright against real temporary servers, with
Chromium at `/home/firesquid/.nix-profile/bin/chromium` or `CHROMIUM_PATH`. Missing
Chromium is a test failure, never a skip. To exercise the standalone executable:
`NANOSYNC_TEST_BINARY="$PWD/dist/nanosync" bun run test:browser`.
