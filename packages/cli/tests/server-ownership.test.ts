import { createHash, randomBytes, randomUUID } from "node:crypto";
import { request } from "node:http";
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runServer } from '../src/server.ts';
import { provisionLocalVault } from '../src/local-provision.ts';
import { secureCreate } from '@nanosync/client-service';

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

test('separate metadata CLI processes leave an outstanding runtime upload intact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'metadata-upload-'));
  let running: Awaited<ReturnType<typeof runServer>> | undefined;
  let upload: import('node:http').ClientRequest | undefined;
  try {
    expect((await cli(root, ['server','init'])).code).toBe(0);
    const create = async (name: string) => {
      const result = await cli(root, ['server','vaults','create','--name',name,'--recovery-output',join(root,name)]);
      expect(result.code).toBe(0);
      return JSON.parse(result.stdout).data.vaultId as string;
    };
    const vaultId = await create('upload-vault'), other = await create('metadata-vault');
    running = await runServer({directory:root, port:7571});
    const enroll = async () => {
      const login = await fetch(new URL('/v1/auth/password', running!.url), {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({protocolVersion:1,password:'ownership-test-password'}), signal:AbortSignal.timeout(5000)});
      expect(login.status).toBe(200);
      const {sessionToken} = await login.json() as {sessionToken:string};
      const deviceId = randomUUID();
      const result = await fetch(new URL('/v1/auth/enrollments', running!.url), {method:'POST', headers:{'content-type':'application/json',authorization:`Bearer ${sessionToken}`}, body:JSON.stringify({protocolVersion:1,deviceId,displayName:deviceId,platform:'linux',clientVersion:'test',fingerprint:randomBytes(32).toString('base64url')}), signal:AbortSignal.timeout(5000)});
      expect(result.status).toBe(202);
      return {deviceId, sessionToken};
    };
    const uploader = await enroll();
    expect((await cli(root, ['server','devices','approve','--device-id',uploader.deviceId])).code).toBe(0);
    const pending = await enroll(), denied = await enroll();
    const objectId = 'ab'.repeat(32), bytes = Buffer.alloc(80 + 65536 + 16, 7);
    bytes.fill(0,0,80); bytes.write('NSOBJ001'); bytes.writeUInt16BE(1,8); bytes.writeUInt16BE(1,10); bytes[12] = 1;
    Buffer.from(vaultId.replaceAll('-',''),'hex').copy(bytes,16); Buffer.from(objectId,'hex').copy(bytes,32);
    bytes.writeBigUInt64BE(65536n,64); bytes.writeBigUInt64BE(65536n,72);
    const response = new Promise<{status:number; body:string}>((resolve, reject) => {
      upload = request(new URL(`/v1/objects/chunk/${objectId}`,running!.url), {method:'PUT',headers:{
        authorization:`Bearer ${uploader.sessionToken}`, 'x-nanosync-vault-id':vaultId,
        'content-length':String(bytes.length), 'x-nanosync-protocol-version':'1', 'x-nanosync-object-format-version':'1',
        'x-nanosync-ciphertext-sha256':createHash('sha256').update(bytes).digest('hex'), 'idempotency-key':'outstanding-upload',
      }}, res => { let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({status:res.statusCode!,body})); });
      upload.on('error', reject); upload.setTimeout(20000, () => upload!.destroy(new Error('upload timeout')));
      upload.write(bytes.subarray(0,4096));
    });
    // Attach a rejection handler even if an assertion fails before awaiting it.
    void response.catch(() => {});
    const staging = join(root,'objects','.nanosync-tmp');
    const deadline = Date.now() + 5000;
    while (!readdirSync(staging).length && Date.now() < deadline) await Bun.sleep(10);
    const staged = readdirSync(staging);
    expect(staged).toHaveLength(1);
    const path = join(staging,staged[0]!);
    const before = statSync(path);
    for (const args of [
      ['server','devices','view'],
      ['server','devices','approve','--device-id',pending.deviceId],
      ['server','devices','deny','--device-id',denied.deviceId],
      ['server','devices','revoke','--device-id',pending.deviceId,'--yes'],
      ['server','vaults','view'],
      ['server','vaults','rename','--vault',other,'--name','renamed'],
      ['server','vaults','delete','--vault',other,'--confirm-delete',other],
    ]) {
      const result = await cli(root,args);
      expect(result.stderr).not.toContain('Staging');
      expect(result.code).toBe(0);
      expect(readdirSync(staging)).toEqual(staged);
      expect(statSync(path).ino).toBe(before.ino);
    }
    expect((await cli(root,['server','vaults','create','--name','blocked','--recovery-output',join(root,'blocked')])).code).toBe(2);
    const scan = await cli(root,['server','admin','scan']);
    expect(scan.code).toBe(2);
    expect(scan.stderr).toMatch(/stop.*runtime/i);
    expect(readdirSync(staging)).toEqual(staged);
    expect(statSync(path).ino).toBe(before.ino);
    upload!.end(bytes.subarray(4096));
    const completed = await response;
    expect(completed.status).toBe(201);
    expect(JSON.parse(completed.body).status).toBe('stored');
    expect(readdirSync(staging)).toHaveLength(0);
    const downloaded = await fetch(new URL(`/v1/objects/chunk/${objectId}`,running.url), {headers:{authorization:`Bearer ${uploader.sessionToken}`,'x-nanosync-vault-id':vaultId},signal:AbortSignal.timeout(5000)});
    expect(downloaded.status).toBe(200);
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);
    await running.stop(); running = undefined;
    for (const report of ['storage','retention-dry-run','gc-dry-run','scan','diagnostics']) {
      expect((await cli(root,['server','admin',report])).code).toBe(0);
    }
  } finally { upload?.destroy(); await running?.stop(); rmSync(root,{recursive:true,force:true}); }
}, 30000);
