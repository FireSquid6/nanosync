import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const initializationScript = `
import errno, os, pty, subprocess, select, time, json, sys
master, slave = pty.openpty()
env = dict(os.environ)
env.pop('NANOSYNC_PASSWORD', None)
env['TERM'] = 'xterm'
p = subprocess.Popen([sys.argv[1], sys.argv[2], 'server', 'init', '--json'], stdin=slave, stderr=slave, stdout=subprocess.PIPE, env=env)
os.close(slave)
transcript = b''
steps = [(b'--server-dir', sys.argv[3]), (b'Owner password', 'terminal-secret-example'), (b'Confirm owner password', 'terminal-secret-example')]
step = 0
deadline = time.monotonic() + 15
try:
  while p.poll() is None and time.monotonic() < deadline:
    if select.select([master], [], [], .1)[0]:
      try: data = os.read(master, 65536)
      except OSError as error:
        if error.errno != errno.EIO: raise
        break
      if not data: break
      transcript += data
      if step < len(steps) and steps[step][0] in transcript:
        os.write(master, steps[step][1].encode() + b'\\r')
        step += 1
  try:
    p.wait(timeout=max(0, deadline - time.monotonic()))
  except subprocess.TimeoutExpired:
    p.kill()
    p.wait()
    raise RuntimeError('terminal prompt timed out: ' + repr(transcript))
  print(json.dumps({'code':p.returncode, 'stdout':p.stdout.read().decode(), 'terminal':transcript.decode(errors='replace'), 'steps':step}))
finally:
  os.close(master)
`;

const confirmationScript = `
import errno, os, pty, subprocess, select, time, json, sys
master, slave = pty.openpty()
p = subprocess.Popen([sys.argv[1],sys.argv[2]] + json.loads(sys.argv[3]), stdin=slave,stderr=slave,stdout=subprocess.PIPE,env=dict(os.environ,TERM='xterm'))
os.close(slave)
transcript = b''
deadline = time.monotonic() + 15
sent = False
try:
  while p.poll() is None and time.monotonic() < deadline:
    if select.select([master],[],[],.1)[0]:
      try: data = os.read(master,65536)
      except OSError as error:
        if error.errno != errno.EIO: raise
        break
      if not data: break
      transcript += data
      if not sent and sys.argv[4].encode() in transcript:
        os.write(master,sys.argv[5].encode() + b'\\r')
        sent = True
  try:
    p.wait(timeout=max(0, deadline - time.monotonic()))
  except subprocess.TimeoutExpired:
    p.kill()
    p.wait()
    raise RuntimeError('terminal confirmation timed out: ' + repr(transcript))
  print(json.dumps({'code':p.wait(),'stdout':p.stdout.read().decode(),'terminal':transcript.decode(errors='replace'),'sent':sent}))
finally:
  os.close(master)
`;

test('PTY harnesses wait for child exit after terminal closure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nanosync-pty-exit-'));
  const fixture = join(directory, 'close-terminal.py');
  writeFileSync(fixture, `
import os, sys, time
if sys.argv[1:3] == ['server', 'init']:
  for prompt in ['--server-dir', 'Owner password', 'Confirm owner password']:
    os.write(2, prompt.encode())
    sys.stdin.readline()
else:
  os.write(2, b'Confirm fixture')
  sys.stdin.readline()
os.close(0)
os.close(2)
time.sleep(.4)
print('{}')
sys.exit(2 if sys.argv[1:2] == ['confirm'] else 0)
`);
  try {
    for (const [script, args, code] of [
      [initializationScript, [directory], 0],
      [confirmationScript, [JSON.stringify(['confirm']), 'Confirm fixture', 'yes'], 2],
    ] as const) {
      const proc = Bun.spawn(['python3', '-c', script, Bun.which('python3')!, fixture, ...args], { stdout: 'pipe', stderr: 'pipe' });
      const stdout = await new Response(proc.stdout).text(), stderr = await new Response(proc.stderr).text();
      expect(await proc.exited, stderr).toBe(0);
      expect(JSON.parse(stdout).code).toBe(code);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 10000);

test('maintained terminal prompts collect missing server directory and hide owner password', async () => {
  const directory = mkdtempSync(join(tmpdir(),'nanosync-tty-'));

  try {
    const process = Bun.spawn(['python3','-c',initializationScript,Bun.which('bun')!,resolve('packages/cli/src/main.ts'),directory], {stdout:'pipe',stderr:'pipe'});
    const stdout = await new Response(process.stdout).text(), stderr = await new Response(process.stderr).text();
    expect(await process.exited, stderr).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.steps).toBe(3);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ok:true,code:'OK',data:{initialized:true}});
    expect(result.terminal).not.toContain('terminal-secret-example');
  } finally { rmSync(directory,{recursive:true,force:true}); }
},20000);

test('terminal recovery acknowledgement failure publishes nothing and deletion requires the typed name despite yes', async () => {
  const directory = mkdtempSync(join(tmpdir(),'nanosync-confirm-tty-'));
  const cli = resolve('packages/cli/src/main.ts');

  async function run(args: string[]) {
    const proc = Bun.spawn([process.execPath,cli,...args,'--server-dir',directory,'--json','--non-interactive'],{stdout:'pipe',stderr:'pipe',env:{...process.env,NANOSYNC_PASSWORD:'terminal-confirm-password'}});
    const stdout = await new Response(proc.stdout).text(), stderr = await new Response(proc.stderr).text();
    expect(await proc.exited,stderr).toBe(0); return JSON.parse(stdout).data;
  }
  async function terminal(args: string[], prompt: string, answer: string) {
    const proc = Bun.spawn(['python3','-c',confirmationScript,process.execPath,cli,JSON.stringify([...args,'--server-dir',directory,'--json']),prompt,answer],{stdout:'pipe',stderr:'pipe'});
    const stdout = await new Response(proc.stdout).text(), stderr = await new Response(proc.stderr).text();
    expect(await proc.exited,stderr).toBe(0); const result = JSON.parse(stdout); expect(result.sent).toBe(true); return result;
  }
  try {
    await run(['server','init']);
    const failed = await terminal(['server','vaults','create','--name','not-published'],'Retype vault recovery key','wrong-secret');
    expect(failed.code).toBe(2);
    expect(failed.terminal).toContain('unlocks this vault’s encryption key on new devices');
    expect(failed.terminal).toContain('not your owner password or a backup of your files');
    expect(failed.terminal).toContain('Anyone with this key and the encrypted vault data can decrypt your files');
    expect((await run(['server','vaults','view'])).vaults).toHaveLength(0);
    const created = await run(['server','vaults','create','--name','typed-vault','--recovery-output',join(directory,'recovery')]);
    const args = ['server','vaults','delete','--vault',created.vaultId,'--yes'];
    const wrong = await terminal(args,'Type exact vault name','wrong-name');
    expect(wrong.code).toBe(2);
    expect(wrong.terminal).toContain(directory);
    expect(wrong.terminal).toContain(created.vaultId);
    expect(wrong.terminal).toContain('typed-vault');
    expect((await run(['server','vaults','view'])).vaults).toHaveLength(1);
    expect((await terminal(args,'Type exact vault name','typed-vault')).code).toBe(0);
    expect((await run(['server','vaults','view'])).vaults).toHaveLength(0);
  } finally { rmSync(directory,{recursive:true,force:true}); }
},30000);
