import Link from 'next/link';
import { SyncDemo } from '../components/SyncDemo';

const replacements = [
  "Obsidian Sync",
  "Syncthing",
  "Free File Sync",
  "Dropbox",
  "Nextcloud",
  "Your ad-hoc rsync scripts",
];

export default function Home() {
  return <main id="main" className="home-main"><article>
    <h1>Uncomplicate file sync </h1>
    <p className="intro">nanosync synchronizes ordinary folders through a server you run yourself.</p>
    <p>A Linux command-line client, encrypted vaults, and files you can open with the tools you already use.</p>
    <p className="home-actions"><Link href="/docs/installation">Get started →</Link><Link href="/docs">Read the docs</Link></p>
    <SyncDemo />
    <h2>Nanosync replaces:</h2>
    <ul>
      {replacements.map((r) => (
        <li key={r}>{r}</li>
      ))}
    </ul>
    <h2>Features:</h2>
    <p>Checked features are implemented.</p>
    <ul className="feature-checklist">
      <li><label><input type="checkbox" checked disabled /> Two-way sync</label></li>
      <li><label><input type="checkbox" checked disabled /> End-to-end encryption</label></li>
      <li><label><input type="checkbox" checked disabled /> Self-hostable</label></li>
      <li><label><input type="checkbox" checked disabled /> CLI</label></li>
      <li><label><input type="checkbox" checked disabled /> Android 12+ app (debug validation build; no iOS app)</label></li>
      <li><label><input type="checkbox" disabled /> Desktop App</label></li>
    </ul>

    <h2>A small place to start</h2>
    <p>Run the server on your machine. Connect a folder on another. Work with your files as usual.</p>
    <ul><li>Your own server.</li><li>Ordinary local files.</li><li>A command-line workflow.</li></ul>
    <h2>Install from the checkout</h2>
    <p>Linux x86-64: use the local Nix flake if you use Nix, or build with Bun.</p>
    <pre tabIndex={0}><code>{'# in the nanosync checkout, with Nix flakes enabled\nnix profile install .#nanosync\n\n# or build from source with Bun\nbun install\nbun run build:binary\n./dist/nanosync --help'}</code></pre>
    <p className="note">No release assets are published yet. The installation guide includes future CLI installer and manual-download commands, gated on publication. Planned macOS CLI binaries have untested runtime behavior. Android APKs are debug-signed validation builds, not production releases; no iOS build is available.</p>
    <p><Link href="/docs/installation">Installation notes →</Link></p>
  </article></main>;
}
