import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

declare const NANOSYNC_SDK_CORE_HASH: string;
declare const NANOSYNC_SDK_PRELOAD_HASH: string;
declare const NANOSYNC_SDK_LAUNCHER_HASH: string;
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

export function verifyPackagedRuntime() {
  const bundle = resolve(dirname(process.argv0), '..');
  const manifest = JSON.parse(readFileSync(join(bundle, 'Resources/desktop-sdk-security.json'), 'utf8'));
  if (manifest.commit !== 'c9e637c4e8acc8d53fc4a1703346196b004a00d8' ||
      manifest.files['bin/libElectrobunCore.so'] !== NANOSYNC_SDK_CORE_HASH ||
      manifest.files['Resources/preload-full.js'] !== NANOSYNC_SDK_PRELOAD_HASH ||
      manifest.files['Resources/main.js'] !== NANOSYNC_SDK_LAUNCHER_HASH) throw Error('SDK_RUNTIME_PROVENANCE');
  for (const [path, expected] of Object.entries(manifest.files)) {
    if (isAbsolute(path) || path.split('/').includes('..')) throw Error('SDK_RUNTIME_PATH');
    const target = join(bundle, path);
    if (!lstatSync(target).isFile() || hash(target) !== expected) throw Error('SDK_RUNTIME_ARTIFACT');
  }
  const core = realpathSync(join(bundle, 'bin/libElectrobunCore.so'));
  const loaded = readFileSync('/proc/self/maps', 'utf8').split('\n')
    .filter(line => line.includes('/libElectrobunCore.so'))
    .map(line => line.slice(line.indexOf('/')));
  if (!loaded.length || loaded.some(path => realpathSync(path) !== core)) throw Error('SDK_RUNTIME_LOADED_CORE');
  // The upstream SDK tries cwd before argv0 for native libraries; constrain both to the verified bundle.
  process.chdir(join(bundle, 'bin'));
  return { bundle, coreHash: hash(core), preloadHash: NANOSYNC_SDK_PRELOAD_HASH, loadedCore: core };
}
