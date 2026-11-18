import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { stripVTControlCharacters } from 'node:util';

const cli = resolve('packages/cli/src/main.ts');
const terminalScript = `
import errno, json, os, pty, signal, subprocess, sys
master, slave = pty.openpty()
env = dict(os.environ, TERM='xterm', NO_COLOR='1')
env.pop('NANOSYNC_PASSWORD', None)
p = subprocess.Popen([sys.argv[1], sys.argv[2]] + json.loads(sys.argv[3]), stdin=slave, stdout=slave, stderr=subprocess.PIPE, env=env)
os.close(slave)
steps = json.loads(sys.argv[4])
transcript, pending, step = b'', b'', 0
def timeout(signum, frame):
  raise RuntimeError('terminal interaction stalled: ' + repr(transcript))
signal.signal(signal.SIGALRM, timeout)
signal.alarm(20)
try:
  while True:
    try: data = os.read(master, 65536)
    except OSError as error:
      if error.errno != errno.EIO: raise
      break
    if not data: break
    transcript += data
    pending += data
    if step < len(steps) and steps[step][0].encode() in pending:
      os.write(master, steps[step][1].encode() + b'\\r')
      pending = b''
      step += 1
  print(json.dumps({'code':p.wait(), 'terminal':transcript.decode(errors='replace'), 'stderr':p.stderr.read().decode(), 'steps':step}))
finally:
  signal.alarm(0)
  if p.poll() is None:
    p.kill()
    p.wait()
  os.close(master)
`;

async function terminal(args: string[], steps: string[][]) {
  const child = Bun.spawn(['python3', '-c', terminalScript, process.execPath, cli,
    JSON.stringify(args), JSON.stringify(steps)], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(code, stderr).toBe(0);
  return JSON.parse(stdout) as { code: number; terminal: string; stderr: string; steps: number };
}

async function json(args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args, '--json', '--non-interactive'], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(code, stderr).toBe(0);
  return JSON.parse(stdout).data;
}

test('human prompts use stdout, hide secrets, and require explicit selection even for one vault', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nanosync-human-terminal-'));
  try {
    const initialized = await terminal(['server', 'init'], [
      ['Server directory', directory], ['Owner password', 'human-terminal-secret'],
      ['Confirm owner password', 'human-terminal-secret'],
    ]);
    expect(initialized.code).toBe(0);
    expect(initialized.steps).toBe(3);
    expect(initialized.stderr).toBe('');
    expect(initialized.terminal).not.toContain('human-terminal-secret');
    expect(initialized.terminal).not.toMatch(/\x1b\[[\d;]*m/u);
    expect(initialized.terminal).toContain('\x1b[?25l');
    expect(initialized.terminal.lastIndexOf('\x1b[?25h')).toBeGreaterThan(initialized.terminal.lastIndexOf('\x1b[?25l'));
    expect(stripVTControlCharacters(initialized.terminal)).toContain('Server initialized.');
    const created = await json(['server', 'vaults', 'create', '--server-dir', directory,
      '--name', 'my-vault', '--recovery-output', join(directory, 'recovery')]);
    const args = ['server', 'vaults', 'delete', '--server-dir', directory, '--yes'];
    const rejected = await terminal(args, [['Choose a vault', ''], ['Type exact vault name', 'wrong-name']]);
    expect(rejected.steps).toBe(2);
    expect(rejected.code).toBe(2);
    expect(rejected.stderr).toBe('');
    expect(rejected.terminal).toContain(created.vaultId);
    expect(stripVTControlCharacters(rejected.terminal)).toContain('Error [INVALID_INPUT]');
    expect((await json(['server', 'vaults', 'view', '--server-dir', directory])).vaults).toHaveLength(1);
    const deleted = await terminal(args, [['Choose a vault', ''], ['Type exact vault name', 'my-vault']]);
    expect(deleted.code).toBe(0);
    expect(deleted.steps).toBe(2);
    expect(deleted.stderr).toBe('');
    expect(stripVTControlCharacters(deleted.terminal)).toContain('Vault deleted.');
    expect((await json(['server', 'vaults', 'view', '--server-dir', directory])).vaults).toHaveLength(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 30000);
