import { ClientError } from '@nanosync/client-service';

/** Explicit local integration only; ordinary headless sync never calls this adapter. */
export async function openFolder(checkedRoot: string): Promise<void> {
  const executable =
    process.platform === 'linux' && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
      ? Bun.which('xdg-open', { PATH: process.env.PATH })
      : null;
  if (!executable)
    throw new ClientError(
      'NATIVE_INTEGRATION_UNAVAILABLE',
      'Folder opening requires a Linux desktop session and xdg-open. Sync remains usable headlessly.',
    );
  try {
    const child = Bun.spawn([executable, checkedRoot], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    if ((await child.exited) !== 0) throw new Error('Open failed');
  } catch {
    throw new ClientError(
      'OPEN_FAILED',
      'The system file manager could not open the checked folder.',
    );
  }
}
