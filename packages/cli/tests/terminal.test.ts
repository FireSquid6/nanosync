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
