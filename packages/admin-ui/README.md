# Embedded owner administration

`bun run build:frontend` bundles this React frontend using Bun's **browser**
target and generates `generated/assets.ts`. The generated map is checked in so
source server runs work immediately after install; regenerate after UI changes.
`bun run build:binary` always regenerates and embeds it. All runtime assets are
served by the existing server only with `server run --web-ui`; no CDN or extra
frontend service is used. See `PAPER-UI-NOTICE.md` for copied source provenance.

The Field Guide skin uses local monospace fonts and shared Gruvbox variables
from `@nanosync/ui-theme/styles.css`. Its `ThemeControl` offers light, dark and
system preferences on both login and authenticated pages; dialogs inherit the
same document theme. Theme assets are bundled locally, with no remote fonts,
stylesheets or runtime requests. The existing Paper UI control class names and
Radix dialog accessibility behavior are retained.

The React Router pages are `/admin/clients` (pending and allowed clients),
`/admin/vaults` (vault management), and `/admin/activity` (recent actions).
`/admin` opens Clients; protected deep links return to their destination after
`/admin/login`. Links, browser history, and refresh work on each page.

`src/main.tsx` only mounts the app. `src/router.tsx` defines routes and runs the
initial session/data loader before `src/App.tsx` mounts its providers and shell.
`src/pages/` contains page views, `src/components/` contains the shared layout,
confirmations and recovery forms, and `src/state/` owns session/data and
vault-creation state. Subsequent data changes happen in explicit event handlers;
encrypted receipts use a lazy state initializer. Page titles are declarative and
navigation focus uses a callback ref. Session and vault-creation behavior remain
event-driven; the shared theme control synchronizes the document theme.
`src/api.ts` handles HTTP transport and shared response types. Creation state
survives page navigation; logout clears unpublished plaintext secret material,
while acknowledged encrypted receipts remain resumable.

HTML/API/error responses are no-store. Content-hashed JS/CSS have immutable
caching, exact allowlisting, nosniff and a restrictive CSP. Only the explicit page
routes receive the HTML shell; unknown paths have no SPA fallback. Browser
sessions/CSRF tokens are memory-only; native password fields are cleared after
submit. No file browsing or recovery retrieval exists.

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
