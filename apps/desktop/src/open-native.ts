import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';

declare const NANOSYNC_XDG_OPEN: string;
type OpenResult = { ok: true; code: 'OPENED' } | { ok: false; code: 'OPEN_FAILED' };
const failure: OpenResult = { ok: false, code: 'OPEN_FAILED' };
async function openTarget(target: string): Promise<OpenResult> {
  try {
    const child = Bun.spawn([NANOSYNC_XDG_OPEN, target], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    return await child.exited === 0 ? { ok: true, code: 'OPENED' } : failure;
  } catch {
    return failure;
  }
}

// Main must resolve this from a validated server capability, never a renderer-supplied URL.
export async function openAdministration(advertisedUrl: string): Promise<OpenResult> {
  try {
    const url = new URL(advertisedUrl);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.pathname !== '/admin' || url.search || url.hash ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) return failure;
    return openTarget(url.href);
  } catch {
    return failure;
  }
}

// Main must first revalidate the saved binding identity; this is not a renderer filesystem gateway.
export async function openCheckedFolder(checkedRoot: string): Promise<OpenResult> {
  try {
    if (!isAbsolute(checkedRoot) || checkedRoot.includes('\0')) return failure;
    const stat = lstatSync(checkedRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() ||
        realpathSync(checkedRoot) !== checkedRoot) return failure;
    return openTarget(checkedRoot);
  } catch {
    return failure;
  }
}
