# Paper UI source provenance

Copied from https://github.com/FireSquid6/paper-ui at revision
`f6cd7e07c88aa780618717a388c3762fd406bef1` (FireSquid6).

Unmodified source copies: `src/paper/Button.tsx`, `TextField.tsx`, and
`classNames.ts`, from `packages/ui/src` upstream.
`src/paper/Dialog.tsx` is adapted to inherit the shared document theme rather
than forcing a separate theme on its portal. It retains maintained
`@radix-ui/react-dialog` for focus, keyboard and modal accessibility.
`src/paper/styles.css` is a local Field Guide replacement retaining the `nv-*`
class names, with Gruvbox tokens from `@nanosync/ui-theme`. No published Paper UI
package is used.

The upstream checkout at that revision contains no LICENSE file or copyright
header in these sources. No upstream notices have been removed; this records
provenance, not a new license grant. Review licensing before redistribution.
