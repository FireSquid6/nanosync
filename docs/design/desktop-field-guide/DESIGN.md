# Desktop interaction and layout specification

## Inherited language

Use the approved Field Guide website as the visual family. The desktop is an Operate surface: reduce the website's heading scale and whitespace to accommodate daily controls, while keeping its system-monospace stack, Gruvbox grounds, fine rules and straightforward reading order. The HTML prototype is the measured visual reference.

Font stack: `'DejaVu Sans Mono', 'Liberation Mono', Consolas, monospace`. Body 13px / 1.65; H1 25px; H2 16px; row names 14px; ordinary supporting UI 12px; design-only footer 11px. Use bold selectively for selected navigation, folder names and section headings. No external fonts or icon packages are needed. State shapes are authored CSS primitives with adjacent text.

## Palette

| Role | Light | Dark |
| --- | --- | --- |
| Ground | `#fbf1c7` | `#282828` |
| Body | `#3c3836` | `#ebdbb2` |
| Muted | `#665c54` | `#bdae93` |
| Rule | `#bdae93` | `#665c54` |
| Selected row / inset | `#f2e5bc` | `#32302f` |
| Headings | `#282828` | `#fbf1c7` |
| Accent | `#9d0006` | `#ff7365` (accessible red tint) |
| Focus | `#af3a03` | `#fe8019` |
| Success | `#427b58` | `#b8bb26` |
| Warning | `#8f3f00` | `#fabd2f` |

Text selection uses the rule color as background and heading color as foreground. Native controls inherit `color-scheme`. Links are underlined; focus is a 2px outline with 4px offset. Colors alone never communicate status.

## Desktop geometry

Reference window: 1280 × 900 CSS px. A 44px title/control bar spans the top. A 184px left navigation rail holds Folders, Conflicts, Connections and Settings; the explicit Quit action sits at its foot. Main padding is 33px top, 34px sides and 40px bottom.

The Folders page has a content heading and primary Connect folder action, a restrained actionable-message strip, and a two-column workspace. The folder list takes the available width; the inspector is 288px with 25px inset beyond its separating rule. Workspace gap is 28px. Current selection is a full-width neutral inset, not a raised card. Every row reveals name, local path, server/vault, status and progress or ownership.

At 1100px and below, reduce main padding to 24px sides and inspector width to 248px. At 800px and below, move the inspector below the list; this is a small-window fallback, not a mobile-client commitment. The prototype was checked for horizontal overflow at 1280px and 960px.

Setup uses the same rail, a compact five-step text progress line and a 620px reading/form column. Connections use a plain ruled table. Settings use General / Notifications / Diagnostics tabs and plain checkbox rows. Dialogs are reserved for consequential disconnect/removal/migration decisions and native-integration previews, not routine navigation.

## Status semantics

- Open circular marker + “Syncing”: work in progress, not failure.
- Two-bar marker + “Paused”: intentional pause, not failure.
- Filled circular marker + “Up to date”: the issue's strict observed-state definition, not just network reachability.
- Diamond + text: unresolved conflicts or actionable failure.
- Offline, credential lock and missing-root states state their specific recovery action.
- Last successful sync remains separate from current status.
- Errors/conflicts remain visible even when global pause is enabled. Removing global pause does not change individual pause choices.

Production overall/tray status must be derived from real binding states. A good tray status means **no intervention needed**, not “all files synchronized”; normal sync, deliberate pause and brief offline periods qualify. Red attention markers need a distinct shape/badge and status text. The tray offers reopening only.

## Safe behavior

Root disappearance preserves metadata and stops work; retry never implies recreation. Disconnect preserves both local and remote files and explicitly acknowledges pending sync state. Force-like connection removal remains subject to owner/lock checks. File-backed credentials require a decision, not automatic migration. Ignore rules belong to the local copy and validate via the existing engine before saving. No alert/report should include paths or secrets by default.

## Prototype-only affordances

The bottom preview selector, enrollment/ignore response selectors, theme demo button, simulated lifecycle titlebar and explanatory toasts are inspection aids. Native window decorations and exact theme-control placement remain integration choices. Replace sample-driven state with shared engine outcomes; preserve the UI's safety meanings rather than its JavaScript shortcuts.
