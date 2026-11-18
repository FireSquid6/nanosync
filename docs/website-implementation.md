# Website implementation evidence

## Delivered

- Next.js App Router site in `apps/site`, independent of the embedded admin listener.
- Field Guide home, eight authoritative Markdown user guides, and pricing/dashboard
  placeholder routes. No managed-server backend or versioned documentation.
- Local full-text search (Fuse), highlighted code, copy controls, heading anchors,
  direct routes, previous/next links, and keyboard-accessible mobile navigation.
- Shared `packages/ui-theme` palette and light/dark/system control; all embedded admin
  screens and Radix dialogs restyled without changing operational workflows.
- Contributor-oriented READMEs retained; user guides are maintained in one place.

## Verification

Run in `nix develop` (Bun 1.4.2, Node from the existing pinned nixpkgs input).
Chromium was supplied through `CHROMIUM_PATH=/usr/bin/google-chrome`.

- `bun run typecheck`: all workspaces and build/browser tooling passed.
- `bun test apps/site/lib/search.test.ts`: passed.
- `bun test --timeout 30000`: 307 passed, zero failures. The initial default-timeout
  run hit Bun's five-second watchdog in the existing 65-revision interrupted-merge
  test; its focused rerun and the complete suite passed with the longer watchdog.
  No sync tests or server logic were changed to hide the failure.
- `bun run build:site` and `bun run test:site`: production build and 12 browser tests
  passed, including guide links, search, clipboard, history, themes, disabled storage,
  mobile keyboard/focus, accessibility checks, and overflow at 390/700/701/1440px.
- `bun run build:binary`, `bash build/test-standalone.sh`: passed; embedded assets
  still work without adjacent files or a public website process.
- `NANOSYNC_TEST_BINARY="$PWD/dist/nanosync" bun run test:browser`: seven passed,
  including existing secret/receipt/enrollment/destructive-action safeguards and new
  theme, responsive, accessibility, and dialog checks.
- `bash build/test-install.sh`: fixture tests passed (not a live release download).
- Demo walkthrough checked against the built executable in disposable state: init,
  local vault creation, enrollment/code comparison, approval, two folders on one
  client, publish/receive, and byte equality. Protected secret files replaced hidden
  prompts; existing PTY tests cover terminal interactions.
- `build/nix/bun.nix` regenerated from `bun.lock` with the pinned bun2nix input.

Screenshots are produced in `apps/site/test-results/` (home/docs, both themes and
all four widths) and `test-results/` (admin pages at 390/1440px and a dark dialog).
Home/docs geometry and admin screenshots were visually inspected against the handoff.
Real documentation and the additional header links necessarily differ from fixtures.
The mockup dark red was lightened from `#fb4934` to `#ff6655` to meet WCAG AA text
contrast, including on the code-block background.

## Limits and findings

Deployment, live HTTPS infrastructure, managed hosting, and live release availability
were not tested. A complete Nix package build was not run; dev-shell/tool generation,
normal binary builds, and standalone/browser checks were run.

The system-installed Bun 1.3.3 fails SQLite close operations in the pre-existing CLI
journey; use the repository dev shell. No server behavior was changed for this.
The independent read-only review found that offline `admin scan` cannot advance past
its first 100 entries. Both user and engineering docs now state that limitation rather
than promising complete CLI restore verification.
