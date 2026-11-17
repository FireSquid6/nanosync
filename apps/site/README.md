# nanosync public website

Next.js App Router application. Run from the repository root after `bun install`:

```sh
bun run dev:site
bun run build:site
bun run --cwd apps/site start
```

The public site runs independently of the embedded `/admin` frontend. No site process,
external assets, or public-site availability is required by a nanosync server.
Next.js prerenders the current content; the app remains a normal server-capable
Next.js application, not a static export. Hosting and managed servers are out of scope.

## Documentation

`content/docs/*.md` is the authoritative user documentation. Keep contributor and
internal protocol material in the repository READMEs and `docs/`, linking rather than
duplicating user guides. Add topics to `lib/docs.ts` to register their order and title.
Use a single H1, fenced code blocks with language names, and relative Markdown links
such as `[Installation](installation.md)`; the renderer converts guide links to real
`/docs/installation` routes. Raw HTML is not enabled. Search indexes these current guides
locally in the browser; no third-party search service or account is required.

There are no historical docs or version selectors. Verify instructions against the
current CLI, especially recovery material, destructive actions, and network exposure.

## Shared design and checks

`packages/ui-theme` provides the palette, typography, and light/dark/system control for
both website and embedded admin. Preferences stay local to each origin. System mode
uses CSS media queries and follows OS changes; blocked storage does not prevent use.

```sh
bun run typecheck
bun test apps/site/lib/search.test.ts
bun run build:site
CHROMIUM_PATH=/path/to/chromium bun run test:site
```

The browser suite runs the production build on loopback port 3100. It checks routing,
search, navigation, copying, themes, accessibility, and overflow at 390/700/701/1440px.
Screenshots are captured under `apps/site/test-results/`. Use the same Chromium path
with `bun run test:browser` for the embedded administration workflows.
