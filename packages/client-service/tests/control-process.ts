import { fileURLToPath } from 'node:url';
import type { SyncOwner } from '../src/index.ts';

export function controlProcess(root: string, files: string, owner: SyncOwner, mode = 'host', runtime?: string | null) {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./fixtures/control-process.ts', import.meta.url)),
    root, files, owner.origin, owner.instanceId, mode], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      env: runtime === undefined ? process.env : { ...process.env, XDG_RUNTIME_DIR: runtime ?? '' } });
  const reader = child.stdout.getReader();
  let buffer = '';
  return {
    child,
    command(line: string) { child.stdin.write(`${line}\n`); child.stdin.flush(); },
    async next(): Promise<Record<string, unknown>> {
      while (!buffer.includes('\n')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`control subprocess exited: ${await new Response(child.stderr).text()}`);
        buffer += new TextDecoder().decode(chunk.value);
      }
      const end = buffer.indexOf('\n'), line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      return JSON.parse(line);
    },
    async close() {
      if (child.exitCode === null) { child.stdin.write('close\n'); child.stdin.end(); }
      await child.exited;
      reader.releaseLock();
    },
  };
}
