import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('maintained terminal prompts collect missing server directory and hide owner password', async () => {
  const directory = mkdtempSync(join(tmpdir(),'nanosync-tty-'));
  const script = `
import os, pty, subprocess, select, time, json, sys
master, slave = pty.openpty()
env = dict(os.environ)
env.pop('NANOSYNC_PASSWORD', None)
env['TERM'] = 'xterm'
p = subprocess.Popen([sys.argv[1], sys.argv[2], 'server', 'init', '--json'], stdin=slave, stderr=slave, stdout=subprocess.PIPE, env=env)
os.close(slave)
transcript = b''
steps = [(b'--server-dir', sys.argv[3]), (b'Owner password', 'terminal-secret-example'), (b'Confirm owner password', 'terminal-secret-example')]
step = 0
deadline = time.time() + 15
try:
  while p.poll() is None and time.time() < deadline:
    if select.select([master], [], [], .1)[0]:
      try: data = os.read(master, 65536)
      except OSError: break
      transcript += data
      if step < len(steps) and steps[step][0] in transcript:
        os.write(master, steps[step][1].encode() + b'\\r')
        step += 1
  if p.poll() is None:
    p.kill()
    raise RuntimeError('terminal prompt timed out: ' + repr(transcript))
  print(json.dumps({'code':p.returncode, 'stdout':p.stdout.read().decode(), 'terminal':transcript.decode(errors='replace'), 'steps':step}))
finally:
  os.close(master)
`;
  try {
    const process = Bun.spawn(['python3','-c',script,Bun.which('bun')!,resolve('packages/cli/src/main.ts'),directory], {stdout:'pipe',stderr:'pipe'});
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
  const script = `
import os, pty, subprocess, select, time, json, sys
master, slave = pty.openpty()
p = subprocess.Popen([sys.argv[1],sys.argv[2]] + json.loads(sys.argv[3]), stdin=slave,stderr=slave,stdout=subprocess.PIPE,env=dict(os.environ,TERM='xterm'))
os.close(slave)
transcript = b''
deadline = time.time() + 15
sent = False
try:
  while p.poll() is None and time.time() < deadline:
    if select.select([master],[],[],.1)[0]:
      try: transcript += os.read(master,65536)
      except OSError: break
      if not sent and sys.argv[4].encode() in transcript:
        os.write(master,sys.argv[5].encode() + b'\\r')
        sent = True
  if p.poll() is None:
    p.kill()
    raise RuntimeError('terminal confirmation timed out: ' + repr(transcript))
  print(json.dumps({'code':p.wait(),'stdout':p.stdout.read().decode(),'terminal':transcript.decode(errors='replace'),'sent':sent}))
finally:
  os.close(master)
`;
  async function run(args: string[]) {
    const proc = Bun.spawn([process.execPath,cli,...args,'--server-dir',directory,'--json','--non-interactive'],{stdout:'pipe',stderr:'pipe',env:{...process.env,NANOSYNC_PASSWORD:'terminal-confirm-password'}});
    const stdout = await new Response(proc.stdout).text(), stderr = await new Response(proc.stderr).text();
    expect(await proc.exited,stderr).toBe(0); return JSON.parse(stdout).data;
  }
  async function terminal(args: string[], prompt: string, answer: string) {
    const proc = Bun.spawn(['python3','-c',script,process.execPath,cli,JSON.stringify([...args,'--server-dir',directory,'--json']),prompt,answer],{stdout:'pipe',stderr:'pipe'});
    const stdout = await new Response(proc.stdout).text(), stderr = await new Response(proc.stderr).text();
    expect(await proc.exited,stderr).toBe(0); const result = JSON.parse(stdout); expect(result.sent).toBe(true); return result;
  }
  try {
    await run(['server','init']);
    const failed = await terminal(['server','vaults','create','--name','not-published'],'Retype recovery secret','wrong-secret');
    expect(failed.code).toBe(2);
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
