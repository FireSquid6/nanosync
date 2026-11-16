import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runServer } from '../src/server.ts';
import { provisionLocalVault } from '../src/local-provision.ts';
import { secureCreate } from '../src/security.ts';

async function cli(root: string, args: string[]) {
  const child = Bun.spawn(['timeout', '--kill-after=2s', '15s', process.execPath, resolve('packages/cli/src/main.ts'), ...args, '--server-dir', root, '--json', '--non-interactive'], {
    env: {...process.env, NANOSYNC_PASSWORD:'ownership-test-password'}, stdout:'pipe', stderr:'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return {code, stdout, stderr};
}

test('runtime excludes separate-process provisioning and duplicate runtimes without blocking metadata administration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'server-ownership-'));
  let running: Awaited<ReturnType<typeof runServer>> | undefined;
  try {
    expect((await cli(root, ['server','init'])).code).toBe(0);
    const output = join(root,'recovery');
    const create = ['server','vaults','create','--name','notes','--recovery-output',output];
    const first = await cli(root, create);
    expect(first.code).toBe(0);
    const id = JSON.parse(first.stdout).data.vaultId;
    const secret = readFileSync(output,'utf8');
    const receipts = () => readdirSync(join(root,'owner-creations')).map(name => readFileSync(join(root,'owner-creations',name),'utf8'));
    const before = receipts();
    running = await runServer({directory:root, port:7570});
    const forbidden = await cli(root, create);
    expect(forbidden.code).toBe(2);
    expect(forbidden.stderr).toMatch(/stop.*runtime/i);
    await expect(runServer({directory:root, port:7570})).rejects.toThrow(/runtime/i);
    expect((await cli(root, ['server','init'])).stderr).toMatch(/runtime/i);
    expect((await cli(root, ['server','devices','view'])).code).toBe(0);
    expect((await cli(root, ['server','vaults','rename','--vault',id,'--name','renamed'])).code).toBe(0);
    expect((await cli(root, ['server','vaults','delete','--vault',id,'--confirm-delete',id])).code).toBe(0);
    const objectFiles = () => readdirSync(join(root,'objects'), {recursive:true}).filter(name => statSync(join(root,'objects',String(name))).isFile());
    const deadline = Date.now() + 4000;
    while (objectFiles().length && Date.now() < deadline) await Bun.sleep(20);
    expect(objectFiles()).toHaveLength(0);
    // Even a delivered/complete replay cannot late-write after deletion/cleanup.
    expect((await cli(root, create)).code).toBe(2);
    expect(objectFiles()).toHaveLength(0);
    expect(receipts()).toEqual(before);
    expect(readFileSync(output,'utf8')).toBe(secret);
    await running.stop(); running = undefined;
    running = await runServer({directory:root, port:7570});
    await running.stop(); running = undefined;
  } finally { await running?.stop(); rmSync(root,{recursive:true,force:true}); }
}, 30000);

test('provisioning owns storage before recovery delivery and releases it on failure for safe retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'provision-ownership-'));
  let running: Awaited<ReturnType<typeof runServer>> | undefined;
  try {
    expect((await cli(root, ['server','init'])).code).toBe(0);
    expect((await cli(root, ['server','init'])).code).toBe(2); // failed reinitialization releases ownership
    const output = join(root,'recovery');
    await expect(provisionLocalVault(root, 'notes', async secret => {
      secureCreate(output, secret + '\n');
      await expect(runServer({directory:root,port:7570})).rejects.toThrow(/runtime/i);
      const competing = await cli(root, ['server','run','--port','7570']);
      expect(competing.code).toBe(2);
      expect(competing.stderr).toMatch(/runtime/i);
      expect((await cli(root, ['server','init'])).stderr).toMatch(/runtime/i);
      throw new Error('interrupted delivery');
    }, output)).rejects.toThrow('interrupted delivery');
    const secret = readFileSync(output,'utf8');
    // Startup failure must also release ownership.
    await expect(runServer({directory:root,port:-1})).rejects.toThrow();
    const occupied = Bun.serve({hostname:'127.0.0.1', port:0, fetch: () => new Response('occupied')});
    try { await expect(runServer({directory:root,port:occupied.port})).rejects.toThrow(); }
    finally { await occupied.stop(true); }
    running = await runServer({directory:root,port:7570});
    await Promise.all([running.stop(), running.stop()]); running = undefined;
    const retry = await cli(root, ['server','vaults','create','--name','notes','--recovery-output',output]);
    expect(retry.code).toBe(0);
    expect(readFileSync(output,'utf8')).toBe(secret);
  } finally { await running?.stop(); rmSync(root,{recursive:true,force:true}); }
}, 30000);
