import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const repository = resolve(import.meta.dir, '../..');
export const cache = join(repository, '.cache/desktop-sdk');
export const sdk = join(cache, 'patched');
const commit = 'c9e637c4e8acc8d53fc4a1703346196b004a00d8';
const sourceHash = 'ed22102b55e4d6b04c3b48ab548f3d3b07b84fd824adc3c097f37986def265ce';
const zigHash = '1cbe9df9f27e6b78d14ccbca43b6703a404ef79ef1c463de901d7f088d4e2026';
const patches = [
  'sdk-privacy.patch', 'core-auth-first.patch', 'sdk-fatal-shutdown.patch', 'sdk-launcher-argv.patch',
];
const patchHashes = [
  '8b103f3debeafbff112090229f8dc9490f51d4c4b3dc6c477c70877eabc88b56',
  'eb7928afb50b23be1b24728a2f88710646c77a19d42928638a7694db9688114f',
  'f9625b649c9d1ee060957d07da7283df94180886beb3d804c1c5fb8e047b661d',
  'a1d581bea0211811aec2c772b4e1daf84d6e507ddc1ec898272adf323f4fd5cb',
];
const patchFiles: Record<string, Record<string, { before: string; after: string }>> =
  JSON.parse(readFileSync(join(import.meta.dir, 'patches/files.json'), 'utf8'));
const coreFile = 'source/package/src/core/zig-out/lib/libElectrobunCore.so';
const api = 'source/package/src';
const generated = `${api}/preload/.generated/compiled.ts`;
interface Manifest {
  schema: 1;
  commit: string;
  sourceHash: string;
  zigHash: string;
  patchHashes: string[];
  files: Record<string, string>;
}
export const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const fileHash = (path: string) => digest(readFileSync(path));

export function verifyArtifacts(directory: string, files: Record<string, string>) {
  for (const [path, hash] of Object.entries(files)) {
    if (isAbsolute(path) || path.split('/').includes('..')) throw Error('SDK_ARTIFACT_PATH');
    if (fileHash(join(directory, path)) !== hash) throw Error(`SDK_ARTIFACT_CHANGED: ${path}`);
  }
}
function run(argv: string[], cwd = repository) {
  const result = Bun.spawnSync(argv, {
    cwd, stdout: 'inherit', stderr: 'inherit',
    env: { ...process.env, ZIG_GLOBAL_CACHE_DIR: join(cache, 'zig-global') },
  });
  if (result.exitCode !== 0) throw Error(`SDK_BUILD_FAILED: ${argv[0]}`);
}
export function applyVerifiedPatch(directory: string, patch: string, expected: Record<string, string>) {
  const git = ['git', `--git-dir=${join(directory, '.git')}`, `--work-tree=${directory}`];
  run([...git, 'init', '--quiet'], directory);
  run([...git, 'apply', '--check', patch], directory);
  run([...git, 'apply', patch], directory);
  verifyArtifacts(directory, expected);
}
function checkPatches() {
  for (const [index, patch] of patches.entries()) {
    if (fileHash(join(import.meta.dir, 'patches', patch)) !== patchHashes[index]) throw Error('SDK_PATCH_CHANGED');
  }
}
export function verifySdk(): Manifest {
  checkPatches();
  const manifest: Manifest = JSON.parse(readFileSync(join(sdk, 'manifest.json'), 'utf8'));
  if (manifest.schema !== 1 || manifest.commit !== commit || manifest.sourceHash !== sourceHash ||
      manifest.zigHash !== zigHash || JSON.stringify(manifest.patchHashes) !== JSON.stringify(patchHashes)) {
    throw Error('SDK_PROVENANCE_CHANGED');
  }
  verifyArtifacts(sdk, manifest.files);
  const finalSources: Record<string, string> = {};
  for (const patch of patches) {
    for (const [path, hashes] of Object.entries(patchFiles[patch]!)) finalSources[path] = hashes.after;
  }
  verifyArtifacts(join(sdk, 'source'), finalSources);
  return manifest;
}
function collect(directory: string, from: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(join(directory, from), { withFileTypes: true })) {
    const path = `${from}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(files, collect(directory, path));
    else if (entry.isFile()) files[path] = fileHash(join(directory, path));
    else throw Error('SDK_UNEXPECTED_FILE');
  }
  return files;
}
function download(url: string, path: string, hash: string) {
  if (!existsSync(path)) {
    if (process.env.DASH_RELEASE_OFFLINE === '1') throw Error('SDK_OFFLINE_ARCHIVE_MISSING');
    run(['curl', '--fail', '--location', '--output', `${path}.part`, url]);
    if (fileHash(`${path}.part`) !== hash) throw Error('SDK_DOWNLOAD_HASH');
    renameSync(`${path}.part`, path);
  }
  if (fileHash(path) !== hash) throw Error('SDK_DOWNLOAD_HASH');
}
export async function prepareSdk() {
  checkPatches();
  if (Bun.version !== '1.4.4') throw Error('SDK_BUN_VERSION');
  if (existsSync(sdk)) { verifySdk(); return; }
  mkdirSync(cache, { recursive: true });
  const sourceArchive = join(cache, 'source.tar.gz');
  const zigArchive = join(cache, 'zig.tar.xz');
  download(`https://codeload.github.com/blackboardsh/electrobun/tar.gz/${commit}`, sourceArchive, sourceHash);
  download('https://ziglang.org/download/0.17.0/zig-x86_64-linux-0.17.0.tar.xz', zigArchive, zigHash);
  const work = join(cache, 'work');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, 'source'), { recursive: true });
  mkdirSync(join(work, 'zig'));
  run(['tar', '-xzf', sourceArchive, '--strip-components=1', '-C', join(work, 'source')]);
  run(['tar', '-xJf', zigArchive, '--strip-components=1', '-C', join(work, 'zig')]);
  const zig = join(work, 'zig/zig');
  const version = Bun.spawnSync([zig, 'version']);
  if (version.exitCode || version.stdout.toString().trim() !== '0.17.0') throw Error('SDK_ZIG_VERSION');
  const core = join(work, api, 'core');
  if (fileHash(join(core, 'main.zig')) !== '85aaa611fc18649052bfe55e33dbf4d3c4a46321dcbc060e675a40346e4d4e39') {
    throw Error('SDK_SOURCE_CHANGED');
  }
  for (const patch of patches) {
    const path = join(import.meta.dir, 'patches', patch);
    const files = patchFiles[patch]!;
    verifyArtifacts(join(work, 'source'), Object.fromEntries(Object.entries(files).map(([file, hashes]) => [file, hashes.before])));
    applyVerifiedPatch(join(work, 'source'), path,
      Object.fromEntries(Object.entries(files).map(([file, hashes]) => [file, hashes.after])));
  }
  const launcher = await Bun.build({
    entrypoints: [join(work, api, 'launcher/main.ts')], target: 'bun', format: 'esm', minify: false,
  });
  if (!launcher.success) throw Error('SDK_LAUNCHER_BUILD');
  writeFileSync(join(work, 'launcher-main.js'), await launcher.outputs[0]!.text());
  for (const [name, entry] of [['full', 'index.ts'], ['sandboxed', 'index-sandboxed.ts']]) {
    const result = await Bun.build({ entrypoints: [join(work, api, 'preload', entry!)], target: 'browser', format: 'esm', minify: false });
    if (!result.success) throw Error('SDK_PRELOAD_BUILD');
    writeFileSync(join(work, `preload-${name}.js`), `(function(){${await result.outputs[0]!.text()}})();`);
  }
  mkdirSync(dirname(join(work, generated)), { recursive: true });
  writeFileSync(join(work, generated),
    `// Rebuilt from pinned patched sources; do not substitute stock preload.\n` +
    `export const preloadScript = ${JSON.stringify(readFileSync(join(work, 'preload-full.js'), 'utf8'))};\n` +
    `export const preloadScriptSandboxed = ${JSON.stringify(readFileSync(join(work, 'preload-sandboxed.js'), 'utf8'))};\n`);
  run([zig, 'build', '-Doptimize=ReleaseSmall', '-Dtarget=x86_64-linux-gnu',
    '--cache-dir', join(cache, 'zig-cache')], core);
  const symbols = Bun.spawnSync(['nm', '-D', join(work, coreFile)]);
  if (symbols.exitCode || /testInstallTransportWebview|testHostTransportPort/.test(symbols.stdout.toString())) {
    throw Error('SDK_TEST_EXPORTS');
  }
  const files: Record<string, string> = {};
  for (const directory of ['browser', 'preload', 'sdks', 'shared', 'config']) {
    Object.assign(files, collect(work, `${api}/${directory}`));
  }
  for (const path of [
    coreFile, 'launcher-main.js', `${api}/launcher/main.ts`, 'preload-full.js', 'preload-sandboxed.js',
    'source/LICENSE', 'source/package/package.json',
  ]) {
    files[path] = fileHash(join(work, path));
  }
  const manifest: Manifest = { schema: 1, commit, sourceHash, zigHash, patchHashes, files };
  writeFileSync(join(work, 'manifest.json'), JSON.stringify(manifest, null, 2));
  renameSync(work, sdk);
  verifySdk();
}

export function sdkDefines() {
  const manifest = verifySdk();
  return {
    NANOSYNC_SDK_CORE_HASH: JSON.stringify(manifest.files[coreFile]),
    NANOSYNC_SDK_PRELOAD_HASH: JSON.stringify(manifest.files['preload-full.js']),
    NANOSYNC_SDK_LAUNCHER_HASH: JSON.stringify(manifest.files['launcher-main.js']),
  };
}

export function sdkAliases() {
  const path = join(repository, '.cache/hutch/releases/electrobun/2.0.6/linux-x64/native-devkit.json');
  if (fileHash(path) !== 'df133b2aae6cc71f92f325aa2b34a139eb7c5f6bdf7d8422b95578bc345a3b3a') throw Error('SDK_MANIFEST_CHANGED');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const exports = manifest.layout.sdks.javascript.exports as Record<string, string>;
  return Object.fromEntries(Object.entries(exports).map(([specifier, target]) => [
    specifier === '.' ? 'electrobun' : `electrobun/${specifier.slice(2)}`,
    join(sdk, api, target.slice('api/'.length)),
  ]));
}

function bundleDirectory() {
  const build = process.env.ELECTROBUN_BUILD_DIR;
  if (!build || !resolve(build).startsWith(join(repository, 'apps/desktop/build/'))) throw Error('SDK_BUILD_DIRECTORY');
  const candidates = readdirSync(build).map(name => join(build, name)).filter(path => existsSync(join(path, 'bin/launcher')));
  if (candidates.length !== 1) throw Error('SDK_BUNDLE_AMBIGUOUS');
  return candidates[0]!;
}
export function stageBundle() {
  const manifest = verifySdk();
  const bundle = bundleDirectory();
  cpSync(join(sdk, coreFile), join(bundle, 'bin/libElectrobunCore.so'));
  cpSync(join(sdk, 'launcher-main.js'), join(bundle, 'Resources/main.js'));
  for (const name of ['full', 'sandboxed']) cpSync(join(sdk, `preload-${name}.js`), join(bundle, `Resources/preload-${name}.js`));
  cpSync(join(sdk, 'source/LICENSE'), join(bundle, 'Resources/ELECTROBUN-LICENSE'));
  const files: Record<string, string> = {};
  for (const path of ['bin/libElectrobunCore.so', 'Resources/main.js', 'Resources/preload-full.js', 'Resources/preload-sandboxed.js',
    'Resources/app/bun/index.js', 'Resources/app/views/main/index.js', 'Resources/ELECTROBUN-LICENSE']) {
    files[path] = fileHash(join(bundle, path));
  }
  const main = readFileSync(join(bundle, 'Resources/app/bun/index.js'), 'utf8');
  const view = readFileSync(join(bundle, 'Resources/app/views/main/index.js'), 'utf8');
  if (main.includes('messagePreview') || !main.includes('SDK_PRELOAD_INDEX_TS_34') ||
      !main.includes('SDK_RPC_DISPATCH_FAILED') || !main.includes('RPC_HANDLER_FAILED') ||
      !view.includes('SDK_RPC_DISPATCH_FAILED')) throw Error('SDK_BUNDLE_UNPATCHED');
  writeFileSync(join(bundle, 'Resources/desktop-sdk-security.json'), JSON.stringify({ ...manifest, files }, null, 2));
  verifyBundle(bundle);
}
export function verifyBundle(bundle: string) {
  const expected = verifySdk();
  const manifest: Manifest = JSON.parse(readFileSync(join(bundle, 'Resources/desktop-sdk-security.json'), 'utf8'));
  if (manifest.commit !== expected.commit || JSON.stringify(manifest.patchHashes) !== JSON.stringify(patchHashes) ||
      manifest.files['bin/libElectrobunCore.so'] !== expected.files[coreFile] ||
      manifest.files['Resources/main.js'] !== expected.files['launcher-main.js'] ||
      manifest.files['Resources/preload-full.js'] !== expected.files['preload-full.js'] ||
      manifest.files['Resources/preload-sandboxed.js'] !== expected.files['preload-sandboxed.js']) throw Error('SDK_BUNDLE_PROVENANCE');
  verifyArtifacts(bundle, manifest.files);
}
export function extractPackage(bundle: string, temporary: string) {
  const resources = join(bundle, 'Resources');
  const archives = readdirSync(resources).filter(name => name.endsWith('.tar.zst'));
  if (archives.length !== 1) throw Error('SDK_PACKAGE_ARCHIVE');
  mkdirSync(temporary, { recursive: true });
  const tar = join(temporary, 'bundle.tar');
  run([join(repository, '.cache/hutch/releases/electrobun/2.0.6/linux-x64/zig-zstd'),
    'decompress', '-i', join(resources, archives[0]!), '-o', tar, '--no-timing']);
  const listing = Bun.spawnSync(['tar', '-tf', tar]);
  if (listing.exitCode || listing.stdout.toString().split('\n').filter(Boolean).some(path =>
    isAbsolute(path) || path.split('/').includes('..'))) throw Error('SDK_PACKAGE_PATH');
  run(['tar', '-xf', tar, '-C', temporary, '--no-same-owner', '--no-same-permissions']);
  const roots = readdirSync(temporary).filter(name => name !== 'bundle.tar');
  if (roots.length !== 1) throw Error('SDK_PACKAGE_ROOT');
  const extracted = join(temporary, roots[0]!);
  verifyBundle(extracted);
  return extracted;
}
export function verifyPackage(bundle: string) {
  if (existsSync(join(bundle, 'Resources/desktop-sdk-security.json'))) { verifyBundle(bundle); return; }
  const temporary = mkdtempSync(join(tmpdir(), 'nanosync-sdk-package-'));
  try { extractPackage(bundle, temporary); }
  finally { rmSync(temporary, { recursive: true, force: true }); }
}
export function verifyBuildPackage() { verifyPackage(bundleDirectory()); }

if (import.meta.main) {
  switch (process.argv[2]) {
    case 'prepare': await prepareSdk(); break;
    case 'verify': verifySdk(); break;
    case 'stage': stageBundle(); break;
    case 'bundle': verifyBundle(resolve(process.argv[3]!)); break;
    case 'package': verifyPackage(resolve(process.argv[3]!)); break;
    default: throw Error('SDK_COMMAND');
  }
}
