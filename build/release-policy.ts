export function parseTag(tag: string) {
  const core = "(0|[1-9][0-9]*)";
  const identifiers = "[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*";
  const pattern = new RegExp(
    `^v${core}\\.${core}\\.${core}(?:-(${identifiers}))?(?:\\+${identifiers})?$`,
  );
  const match = pattern.exec(tag);
  const leadingZero = match?.[4]?.split(".").some(identifier => /^0[0-9]+$/.test(identifier));
  if (!match || match[0] !== tag || leadingZero) throw new Error(`Invalid SemVer tag: ${tag}`);
  return { version: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)], prerelease: !!match[4] };
}

export const assetNames = [
  "nanosync-linux-x64", "nanosync-linux-arm64",
  "nanosync-darwin-x64", "nanosync-darwin-arm64",
  "nanosync-android-debug.apk",
];
export const releaseAssetNames = assetNames.flatMap(name => [name, `${name}.sha256`]);

export interface Release {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
}

export function isLatestStable(tag: string, releases: Release[]): boolean {
  const candidate = parseTag(tag);
  if (candidate.prerelease) return false;
  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    let version;
    try { version = parseTag(release.tag_name); } catch { continue; }
    if (version.prerelease) continue;
    for (let index = 0; index < 3; index++) {
      if (version.version[index]! > candidate.version[index]!) return false;
      if (version.version[index]! < candidate.version[index]!) break;
    }
  }
  return true;
}

async function checksum(directory: string, name: string) {
  const bytes = await Bun.file(`${directory}/${name}`).arrayBuffer();
  const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  return `${hash}  ${name}\n`;
}

export async function writeChecksums(directory: string) {
  for (const name of assetNames) {
    await Bun.write(`${directory}/${name}.sha256`, await checksum(directory, name));
  }
}

export async function verifyAssets(directory: string) {
  const { readdir } = await import("node:fs/promises");
  const actual = (await readdir(directory)).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...releaseAssetNames].sort())) {
    throw new Error(`Expected exactly ten release assets, got: ${actual.join(", ")}`);
  }
  for (const name of assetNames) {
    if (await Bun.file(`${directory}/${name}.sha256`).text() !== await checksum(directory, name)) {
      throw new Error(`Invalid checksum: ${name}`);
    }
  }
}

const releaseNotes = [
  "Native Linux x64 and ARM64 Ubuntu standalone checks passed:",
  "isolated executable, server initialization, and embedded web UI.",
  "System libraries (including glibc) are still required.",
  "macOS executables are Bun build outputs; macOS runtime behavior is untested.",
  "The Android APK is a debug build signed with a non-production debug key,",
  "not a production mobile release.",
].join(" ");

async function gh(args: string[]): Promise<string> {
  const result = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "inherit" });
  const output = await new Response(result.stdout).text();
  if (await result.exited !== 0) throw new Error(`gh failed: ${args.join(" ")}`);
  return output;
}

export async function publishRelease(tag: string, directory: string, run = gh) {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const classification = parseTag(tag);
  await verifyAssets(directory);
  // Listing succeeds or fails explicitly; authentication errors must not masquerade as absence.
  const pages: Release[][] = JSON.parse(await run([
    "api", "--paginate", "--slurp", "repos/{owner}/{repo}/releases?per_page=100",
  ]));
  const releases = pages.flat();
  const existing = releases.find(release => release.tag_name === tag);
  const verifyRemote = async () => {
    const temporary = await mkdtemp(`${tmpdir()}/nanosync-release-`);
    try {
      const metadata = JSON.parse(await run(["release", "view", tag, "--json", "assets"]));
      const names = metadata.assets.map((asset: { name: string }) => asset.name).sort();
      if (JSON.stringify(names) !== JSON.stringify([...releaseAssetNames].sort())) {
        throw new Error("Remote release does not contain exactly the ten expected assets");
      }
      await run(["release", "download", tag, "--dir", temporary]);
      await verifyAssets(temporary);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  };
  if (existing && !existing.draft) {
    if (existing.prerelease !== classification.prerelease) {
      throw new Error("Existing public release has the wrong prerelease classification");
    }
    await verifyRemote();
    return; // A retry never rewrites a public release or its assets.
  }
  if (!existing) {
    await run(["release", "create", tag, "--draft", "--verify-tag", "--title", tag,
      "--notes", releaseNotes,
      ...(classification.prerelease ? ["--prerelease"] : []),
    ]);
  }
  // Only unpublished drafts may be repaired after an interrupted run.
  const draft = JSON.parse(await run(["release", "view", tag, "--json", "assets"]));
  for (const asset of draft.assets as { name: string }[]) {
    await run(["release", "delete-asset", tag, asset.name, "--yes"]);
  }
  await run(["release", "upload", tag, ...releaseAssetNames.map(name => `${directory}/${name}`)]);
  await verifyRemote();
  await run(["release", "edit", tag, "--draft=false",
    `--prerelease=${classification.prerelease}`, `--latest=${isLatestStable(tag, releases)}`,
    "--notes", releaseNotes]);
}

if (import.meta.main) {
  const [command, value] = Bun.argv.slice(2);
  if (!value) throw new Error("Usage: release-policy.ts tag|checksums|verify|publish <tag-or-directory>");
  switch (command) {
    case "tag": parseTag(value); break;
    case "checksums": await writeChecksums(value); break;
    case "verify": await verifyAssets(value); break;
    case "publish": await publishRelease(value, "release-assets"); break;
    default: throw new Error(`Unknown command: ${command}`);
  }
}
