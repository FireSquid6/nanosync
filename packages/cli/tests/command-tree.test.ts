import { expect, test, spyOn } from 'bun:test';
import { main } from '../src/main.ts';

test('explicit command tree rejects legacy aliases and never guesses a server directory in scripts', async () => {
  const err = spyOn(console, 'error').mockImplementation(() => {});
  try {
    for (const legacy of ['bootstrap', 'enroll', 'setup', 'sync', 'devices', 'approve', 'revoke', 'vault', 'admin']) {
      expect(await main([legacy, '--non-interactive', '--json'])).toBe(2);
    }
    expect(await main(['server', 'devices', 'view', '--non-interactive', '--json'])).toBe(2);
    expect(JSON.parse(String(err.mock.lastCall?.[0]))).toMatchObject({ ok: false, code: 'INPUT_REQUIRED', exitCode: 2 });
  } finally { err.mockRestore(); }
});

import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runServer } from '../src/server.ts';

test('scripted CLI enrollment resumes lost submission, keeps aliases separate and delivers owner vault recovery safely', async () => {
  const base = mkdtempSync(join(tmpdir(), 'nanosync-tree-'));
  const serverDir = join(base, 'server'), clientDir = join(base, 'client'), files = join(base, 'files');
  mkdirSync(serverDir, {mode:0o700}); mkdirSync(clientDir, {mode:0o700}); mkdirSync(files, {mode:0o700});
  const prior = process.env.NANOSYNC_PASSWORD;
  process.env.NANOSYNC_PASSWORD = 'owner-command-tree-password';
  const out = spyOn(console, 'log').mockImplementation(() => {}), err = spyOn(console, 'error').mockImplementation(() => {});
  const native = globalThis.fetch;
  let running: Awaited<ReturnType<typeof runServer>> | undefined;
  const invoke = (args: string[]) => main([...args, '--non-interactive', '--json']);
  const result = () => JSON.parse(String(out.mock.lastCall?.[0]));
  try {
    expect(await invoke(['server', 'init', '--server-dir', serverDir])).toBe(0);
    running = await runServer({directory:serverDir, port:7559});
    const add = ['client','connections','add','--credential-mode','protected-file','--url',running.url,'--alias','home','--device-name','desktop','--client-dir',clientDir,'--wait-ms','0'];
    let lost = false;
    globalThis.fetch = (async (input, init) => {
      const response = await native(input, init);
      if (!lost && String(input).endsWith('/v1/auth/enrollments') && init?.method === 'POST') { lost = true; throw new TypeError('lost response'); }
      return response;
    }) as typeof fetch;
    expect(await invoke(add)).toBe(3);
    const id = result().data.deviceId;
    expect(err.mock.calls.flat().join('\n')).toContain(`nanosync server devices approve --device-id ${id}`);
    expect(err.mock.calls.flat().join('\n')).toContain('Verification code:');
    expect(err.mock.calls.flat().join('\n')).not.toContain('Administration:');
    globalThis.fetch = native;
    delete process.env.NANOSYNC_PASSWORD;
    expect(await invoke(add)).toBe(3); // no password needed after ambiguous submission
    expect(result().data.deviceId).toBe(id);
    expect(await invoke(['server','devices','approve','--server-dir',serverDir,'--device-id',id])).toBe(0);
    expect(await invoke(add)).toBe(0);
    expect(result().data).toMatchObject({alias:'home', status:'approved', deviceId:id});
    expect(await invoke(add)).toBe(0); // safe existing summary, never rotates identity
    expect(result().data.deviceId).toBe(id);
    expect(await invoke(['client','connections','view','--client-dir',clientDir])).toBe(0);
    expect(result().data.pending).toHaveLength(0);
    expect(JSON.stringify(result())).not.toContain('token');
    // Local provisioning requires exclusive offline storage ownership; device
    // approval above remains available while the runtime is active.
    await running.stop(); running = undefined;
    const recovery = join(base,'recovery.txt');
    expect(await invoke(['server','vaults','create','--server-dir',serverDir,'--name','notes','--recovery-output',recovery])).toBe(0);
    const vault = result().data.vaultId;
    // Lost stdout/retry uses the original recovery output and encrypted receipt.
    expect(await invoke(['server','vaults','create','--server-dir',serverDir,'--name','notes','--recovery-output',recovery])).toBe(0);
    expect(result().data.vaultId).toBe(vault);
    expect(existsSync(recovery)).toBe(true);
    expect(out.mock.calls.flat().join('\n')).not.toContain(readFileSync(recovery,'utf8').trim());
    running = await runServer({directory:serverDir, port:7559});
    expect(await invoke(['client','vaults','connect','--client-dir',clientDir,'--server','home','--vault',vault,'--path',files,'--recovery-file',recovery])).toBe(0);
    const replica = join(base,'replica'); mkdirSync(replica,{mode:0o700});
    expect(await invoke(['client','vaults','connect','--client-dir',clientDir,'--server','home','--vault',vault,'--path',replica])).toBe(0);
    const replicaId = result().data.connectionId;
    expect(await invoke(['client','vaults','view','--client-dir',clientDir])).toBe(0);
    expect(result().data.bindings).toHaveLength(2);
    expect(result().data.bindings.every((b:any) => b.serverAlias === 'home' && b.vaultId === vault)).toBe(true);
    expect(new Set(result().data.bindings.map((b:any) => b.connectionId)).size).toBe(2);
    expect(existsSync(join(clientDir,'replicas',replicaId,'local.sqlite'))).toBe(false);
    expect(await invoke(['client','sync','--client-dir',clientDir,'--path',replica])).toBe(0);
    expect(existsSync(join(clientDir,'replicas',replicaId,'local.sqlite'))).toBe(true);
    expect(await invoke(['client','connections','remove','--client-dir',clientDir,'--server','home'])).toBe(2);
    expect(await invoke(['client','sync','--client-dir',clientDir,'--path',files])).toBe(0);
    expect(await invoke(['server','vaults','delete','--server-dir',serverDir,'--vault',vault,'--yes'])).toBe(2);
    expect(await invoke(['server','vaults','delete','--server-dir',serverDir,'--vault',vault,'--confirm-delete',vault])).toBe(0);
    expect(await invoke(['client','sync','--client-dir',clientDir,'--path',files])).toBe(5);
    expect(JSON.parse(String(err.mock.lastCall?.[0])).code).toBe('VAULT_DELETED');
    expect(await invoke(['client','connections','remove','--client-dir',clientDir,'--server','home','--force'])).toBe(0);
    expect(existsSync(files)).toBe(true);
    expect(existsSync(join(files,'.nanosync'))).toBe(false);
  } finally {
    globalThis.fetch = native; await running?.stop();
    if (prior === undefined) delete process.env.NANOSYNC_PASSWORD; else process.env.NANOSYNC_PASSWORD = prior;
    out.mockRestore(); err.mockRestore(); rmSync(base,{recursive:true,force:true});
  }
});

test('independent pending requests retain denial until explicit fresh, and interruption resumes the same identity', async () => {
  const base = mkdtempSync(join(tmpdir(),'nanosync-pending-'));
  const clientDir = join(base,'client'), a = join(base,'a'), b = join(base,'b');
  for (const dir of [clientDir,a,b]) mkdirSync(dir,{mode:0o700});
  const prior = process.env.NANOSYNC_PASSWORD; process.env.NANOSYNC_PASSWORD = 'owner-pending-password';
  const out = spyOn(console,'log').mockImplementation(() => {}), err = spyOn(console,'error').mockImplementation(() => {});
  const running: Awaited<ReturnType<typeof runServer>>[] = [];
  const invoke = (args: string[]) => main([...args,'--json','--non-interactive']);
  const result = () => JSON.parse(String(out.mock.lastCall?.[0])).data;
  try {
    for (const dir of [a,b]) expect(await invoke(['server','init','--server-dir',dir])).toBe(0);
    running.push(await runServer({directory:a,port:7560,webUi:true,externalOrigin:'http://127.0.0.1:7560'}));
    running.push(await runServer({directory:b,port:7561}));
    const add = (i:number, alias:string, wait = '0') => ['client','connections','add','--credential-mode','protected-file','--url',running[i]!.url,'--alias',alias,'--wait-ms',wait,'--client-dir',clientDir];
    expect(await invoke(add(0,'one'))).toBe(3); const first = result().deviceId;
    expect(err.mock.calls.flat().join('\n')).toContain('Administration: http://127.0.0.1:7560/admin');
    expect(await invoke(add(1,'two'))).toBe(3); const second = result().deviceId;
    expect(second).not.toBe(first);
    expect(await invoke(['server','devices','deny','--server-dir',a,'--device-id',first])).toBe(0);
    expect(await invoke(add(0,'one'))).toBe(4);
    expect(await invoke(['client','connections','view','--client-dir',clientDir])).toBe(0);
    expect(result().pending.find((p:any) => p.alias === 'one').status).toBe('denied');
    expect(await invoke(add(0,'one'))).toBe(4);
    expect(result().deviceId).toBe(first);
    expect(await invoke([...add(0,'one'),'--fresh'])).toBe(3);
    expect(result().deviceId).not.toBe(first);
    delete process.env.NANOSYNC_PASSWORD;
    const waiting = invoke(add(1,'two','10000'));
    setTimeout(() => process.emit('SIGINT'),100);
    expect(await waiting).toBe(130);
    expect(await invoke(add(1,'two'))).toBe(3);
    expect(result().deviceId).toBe(second);
  } finally {
    for (const server of running) await server.stop();
    if (prior === undefined) delete process.env.NANOSYNC_PASSWORD; else process.env.NANOSYNC_PASSWORD = prior;
    out.mockRestore(); err.mockRestore(); rmSync(base,{recursive:true,force:true});
  }
});
