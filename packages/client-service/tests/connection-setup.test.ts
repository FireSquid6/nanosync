import { expect, test, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectionSetup } from '../src/connection-setup.ts';
import { CredentialStoreError } from '../src/credential-store.ts';

test('pending metadata never unlocks the credential store', () => {
  const root = mkdtempSync(join(tmpdir(), 'setup-'));
  const locked = () => { throw new CredentialStoreError(); };
  try { expect(new ConnectionSetup(root, {credentialStore:{get:locked,set:locked,delete:locked}}).pending()).toEqual([]); }
  finally { rmSync(root, {recursive:true,force:true}); }
});

import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { initializeServerOwner, approveLocalDevice, runServer } from '../../cli/src/server.ts';
import { enrollServer } from '../../cli/src/vault-client.ts';
import { key, server as registration, saveKey } from '../src/credentials.ts';
import { parsePersistedRevisionEnvelope, OWNER_GENESIS_AUTHOR_ID } from '@nanosync/protocol';
import { encryptManifest, referenceSetMac, generateRecoverySecret, displayRecoverySecret, wrapMasterKey } from '@nanosync/sync-core';
import type { CredentialStore } from '../src/credential-store.ts';

async function fixture(run: (ctx: {root:string;client:string;url:string;setup:ConnectionSetup;store:CredentialStore;values:Map<string,string>;serverRoot:string}) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(),'setup-real-')), serverRoot = join(root,'server'), client = join(root,'client');
  mkdirSync(serverRoot,{mode:0o700}); mkdirSync(client,{mode:0o700});
  writeFileSync(join(serverRoot,'pepper.hex'),randomBytes(32).toString('hex'),{mode:0o600});
  await initializeServerOwner(serverRoot,'correct horse battery staple');
  const reservation = Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});
  const port = reservation.port!; await reservation.stop(true);
  const running = await runServer({directory:serverRoot,port,webUi:true,externalOrigin:`http://127.0.0.1:${port}`});
  const values = new Map<string,string>();
  const store: CredentialStore = {get:id=>values.get(id)??null,set:(id,value)=>{values.set(id,value);},delete:id=>{values.delete(id);}};
  try { await run({root,client,url:running.url.replace(/\/$/,''),setup:new ConnectionSetup(client,{credentialStore:store}),store,values,serverRoot}); }
  finally { await running.stop(); rmSync(root,{recursive:true,force:true}); }
}
const request = (url:string) => ({url,alias:'home',deviceName:'desktop',password:'correct horse battery staple'});
async function owner(url:string) {
  const origin = new URL(url).origin;
  const response = await fetch(`${origin}/admin/api/session`,{method:'POST',headers:{origin,'x-nanosync-csrf':'login','content-type':'application/json'},body:JSON.stringify({password:'correct horse battery staple'})});
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!, {csrfToken} = await response.json() as any;
  return async (path:string,value:unknown) => {
    const result = await fetch(`${origin}/admin/api${path}`,{method:'POST',headers:{origin,cookie,'x-nanosync-csrf':csrfToken,'content-type':'application/json'},body:JSON.stringify(value)});
    expect(result.status).toBe(200); return result.json();
  };
}
async function createVault(url:string,name = 'notes') {
  const post = await owner(url), vaultId = randomUUID(), revisionId = randomUUID(), master = randomBytes(32), recovery = generateRecoverySecret();
  try {
    const secret = await displayRecoverySecret(recovery);
    const encrypted = await encryptManifest({version:1,vaultId,revisionId,parents:[],creatingDeviceId:OWNER_GENESIS_AUTHOR_ID,entries:[{id:randomUUID(),parentId:null,name:'',kind:'directory'}]},master);
    const genesis = parsePersistedRevisionEnvelope({protocolVersion:1,revisionFormatVersion:1,vaultId,revisionId,parents:[],creatingDeviceId:OWNER_GENESIS_AUTHOR_ID,createdAt:new Date().toISOString(),encryptedManifestObjectId:encrypted.reference.objectId,references:[encrypted.reference],referenceSetMac:'0'.repeat(64)});
    genesis.referenceSetMac = await referenceSetMac(genesis,master) as typeof genesis.referenceSetMac;
    await post('/vaults',{vaultId,name,recoveryWrap:await wrapMasterKey(master,recovery,vaultId),genesisRevision:genesis,frame:Buffer.from(encrypted.frame).toString('base64url')});
    return {vaultId,secret,hex:master.toString('hex')};
  } finally {master.fill(0);recovery.fill(0);}
}
function diskText(path:string): string {
  return readdirSync(path,{withFileTypes:true}).map(item=>item.isDirectory()?diskText(join(path,item.name)):readFileSync(join(path,item.name),'utf8')).join('\n');
}

test('real approval survives restart, shares OS credentials with CLI and binds without transferring files', async () => fixture(async ({root,client,url,setup,store,values,serverRoot}) => {
  const pending = await setup.enroll(request(url)); expect(pending.status).toBe('pending');
  expect(pending.adminUrl).toBe(`${url}/admin`);
  const metadata = JSON.parse(readFileSync(join(client,'desktop-pending',`${pending.id}.json`),'utf8'));
  expect(metadata.token).toBeUndefined();
  const token = JSON.parse([...values.values()][0]!).token;
  expect(diskText(client)).not.toContain(token);
  const restarted = new ConnectionSetup(client,{credentialStore:store});
  expect(restarted.pending()).toEqual([pending]);
  await expect(enrollServer(client,url,undefined,'desktop',0,{alias:'home'})).rejects.toThrow('resume this request in the desktop');
  approveLocalDevice(serverRoot,metadata.deviceId);
  expect((await restarted.check(pending.id)).status).toBe('approved');
  expect(registration(client,pending.id,store).token).toBe(token);
  expect(values.size).toBe(1);
  const {vaultId,secret,hex} = await createVault(url);
  expect(await restarted.vaults(pending.id)).toEqual([{id:vaultId,name:'notes',needsRecoveryKey:true}]);
  await expect(restarted.connect({serverId:pending.id,vaultId,path:'relative-folder',confirmNonempty:false})).rejects.toMatchObject({code:'FOLDER_UNAVAILABLE'});
  expect(existsSync(join(client,'connections'))).toBe(false);
  const folder = join(root,'folder'); mkdirSync(folder); writeFileSync(join(folder,'local.txt'),'unchanged');
  await expect(restarted.connect({serverId:pending.id,vaultId,path:folder,confirmNonempty:false})).rejects.toMatchObject({code:'RECOVERY_KEY_REQUIRED'});
  await expect(restarted.connect({serverId:pending.id,vaultId,path:folder,recoveryKey:'wrong',confirmNonempty:false})).rejects.toMatchObject({code:'INVALID_RECOVERY_KEY'});
  await expect(restarted.connect({serverId:pending.id,vaultId,path:folder,recoveryKey:secret,confirmNonempty:false})).rejects.toMatchObject({code:'NONEMPTY_CONFIRMATION_REQUIRED'});
  const connected = await restarted.connect({serverId:pending.id,vaultId,path:folder,confirmNonempty:true});
  expect(connected.id).toBeString();
  expect(readdirSync(folder).sort()).toEqual(['.nanosync','local.txt']);
  expect(readFileSync(join(folder,'local.txt'),'utf8')).toBe('unchanged');
  expect(existsSync(join(client,'replicas'))).toBe(false);
  expect(Buffer.from(key(client,pending.id,vaultId,store)!).toString('hex')).toBe(hex);
  expect(diskText(client)).not.toContain(hex); expect(diskText(client)).not.toContain(secret);
  expect(diskText(client)).not.toContain('correct horse battery staple');
  await expect(restarted.connect({serverId:pending.id,vaultId,path:folder,confirmNonempty:true})).rejects.toMatchObject({code:'OVERLAPPING_ROOT'});
  const other = join(root,'other'); mkdirSync(other);
  await restarted.connect({serverId:pending.id,vaultId,path:other,confirmNonempty:false});
  expect(await restarted.vaults(pending.id)).toEqual([{id:vaultId,name:'notes',needsRecoveryKey:false}]);
}));

import { secureCreate, privateDirectory } from '../src/security.ts';
import { removeServerConnection } from '../src/connections.ts';

test('approved metadata is cleaned and removed registrations cannot be resurrected', async () => fixture(async ({client,url,setup,store,serverRoot}) => {
  const pending = await setup.enroll(request(url));
  const p = JSON.parse(readFileSync(join(client,'desktop-pending',`${pending.id}.json`),'utf8'));
  approveLocalDevice(serverRoot,p.deviceId);
  expect((await setup.check(pending.id)).status).toBe('approved');
  expect(setup.pending()).toEqual([]);
  expect(readdirSync(join(client,'desktop-pending'))).toEqual([]);
  expect(await new ConnectionSetup(client,{credentialStore:store}).check(pending.id)).toMatchObject({id:pending.id,status:'approved',deviceName:'desktop'});
  expect(await setup.enroll({...request(url),password:undefined})).toMatchObject({id:pending.id,status:'approved'});
  // Simulate a crash after registration publication but before pending cleanup.
  secureCreate(join(client,'desktop-pending',`${pending.id}.json`),JSON.stringify(p));
  removeServerConnection(client,pending.id,false,store);
  expect(readdirSync(join(client,'desktop-pending'))).toEqual([]);
  await expect(setup.check(pending.id)).rejects.toMatchObject({code:'NOT_FOUND'});
}));

test('denied identity is retained; only explicit fresh replaces it without orphaning OS secrets', async () => fixture(async ({client,url,setup,values}) => {
  const p = await setup.enroll(request(url));
  const metadata = JSON.parse(readFileSync(join(client,'desktop-pending',`${p.id}.json`),'utf8'));
  await expect(setup.enroll({...request(url),fresh:true})).rejects.toMatchObject({code:'ENROLLMENT_CONFLICT'});
  const post = await owner(url); await post(`/devices/${metadata.deviceId}/deny`,{});
  expect((await setup.check(p.id)).status).toBe('denied');
  expect((await setup.enroll({...request(url),password:undefined})).id).toBe(p.id);
  await expect(setup.enroll({...request(url),fresh:true,password:undefined})).rejects.toMatchObject({code:'PASSWORD_REQUIRED'});
  const fresh = await setup.enroll({...request(url),fresh:true});
  expect(fresh.status).toBe('pending'); expect(fresh.id).not.toBe(p.id); expect(values.size).toBe(1);
  expect(setup.pending()).toHaveLength(1);
}));

test('wrong initial password keeps identity and requests password reentry, then resumes', async () => fixture(async ({client,url,setup,values}) => {
  await expect(setup.enroll({...request(url),password:'incorrect'})).rejects.toMatchObject({code:'AUTHENTICATION_FAILED'});
  const before = setup.pending()[0]!; expect(before.status).toBe('error'); expect(values.size).toBe(0);
  await expect(setup.check(before.id)).rejects.toMatchObject({code:'PASSWORD_REQUIRED'});
  const after = await setup.enroll(request(url)); expect(after.id).toBe(before.id); expect(after.status).toBe('pending');
  expect(diskText(client)).not.toContain('incorrect');
}));

test('locked OS store is fail-closed and pending identity resumes after unlock', async () => fixture(async ({client,url,store}) => {
  let locked = true;
  const check = () => {if (locked) throw new CredentialStoreError();};
  const guarded: CredentialStore = {get:id=>{check();return store.get(id);},set:(id,v)=>{check();store.set(id,v);},delete:id=>{check();store.delete(id);}};
  const setup = new ConnectionSetup(client,{credentialStore:guarded});
  await expect(setup.enroll(request(url))).rejects.toMatchObject({code:'CREDENTIAL_STORE_LOCKED'});
  const pending = setup.pending()[0]!; expect(pending.status).toBe('error');
  locked = false;
  expect(await setup.enroll(request(url))).toMatchObject({id:pending.id,status:'pending'});
}));

test('legacy enrollment is preserved and blocks desktop by URL or alias', async () => fixture(async ({client,url,setup}) => {
  await enrollServer(client,url,'correct horse battery staple','legacy',0,{alias:'old'});
  const before = diskText(join(client,'pending'));
  expect(setup.pending()[0]).toMatchObject({status:'error'});
  await expect(setup.enroll({...request(url),alias:'different'})).rejects.toMatchObject({code:'ENROLLMENT_CONFLICT'});
  await expect(setup.enroll({...request('https://other.example'),alias:'old'})).rejects.toMatchObject({code:'ENROLLMENT_CONFLICT'});
  expect(diskText(join(client,'pending'))).toBe(before);
}));

test('lost enrollment response retains token and identity; restart recovers without duplicate submission', async () => fixture(async ({client,url,store,values}) => {
  let posts = 0;
  const proxy = Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req) {
    const path = new URL(req.url).pathname;
    const result = await fetch(`${url}${path}`,{method:req.method,headers:req.headers,body:req.method==='POST'?await req.text():undefined,redirect:'error'});
    if (path === '/v1/auth/enrollments' && ++posts === 1) {await result.arrayBuffer();return new Response('upstream response lost',{status:503});}
    return result;
  }});
  try {
    const setup = new ConnectionSetup(client,{credentialStore:store});
    const first = await setup.enroll(request(proxy.url.href)); expect(first.status).toBe('error'); expect(values.size).toBe(1);
    expect(first.error).not.toContain('upstream response lost');
    const second = await new ConnectionSetup(client,{credentialStore:store}).check(first.id);
    expect(second).toMatchObject({id:first.id,status:'pending'}); expect(posts).toBe(1); expect(values.size).toBe(1);
  } finally {await proxy.stop(true);}
}));


test('server-expired request is retained until explicit fresh and OS secret is replaced once', async () => {
  let now = Date.now();
  const clock = spyOn(Date,'now').mockImplementation(()=>now);
  try {
    await fixture(async ({url,setup,values}) => {
      const pending = await setup.enroll(request(url));
      now += 86400001;
      expect(await setup.check(pending.id)).toMatchObject({id:pending.id,status:'expired'});
      expect(setup.pending()).toHaveLength(1);
      expect(await setup.enroll({...request(url),fresh:true})).toMatchObject({status:'pending'});
      expect(values.size).toBe(1);
    });
  } finally {clock.mockRestore();}
});

test('connection removal while network is waiting prevents any new binding or missing-root creation', async () => fixture(async ({root,client,url,store,serverRoot}) => {
  let release!:()=>void, entered!:()=>void;
  const waiting = new Promise<void>(resolve=>{entered=resolve;}), gate = new Promise<void>(resolve=>{release=resolve;});
  let block = false;
  const proxy = Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req) {
    const path = new URL(req.url).pathname;
    const result = await fetch(`${url}${path}`,{method:req.method,headers:req.headers,body:req.method==='POST'?await req.text():undefined});
    if (block && path === '/v1/vaults') {entered();await gate;}
    return result;
  }});
  try {
    const setup = new ConnectionSetup(client,{credentialStore:store});
    const pending = await setup.enroll(request(proxy.url.href));
    const p = JSON.parse(readFileSync(join(client,'desktop-pending',`${pending.id}.json`),'utf8'));
    approveLocalDevice(serverRoot,p.deviceId); await setup.check(pending.id);
    const vault = await createVault(url);
    const info = registration(client,pending.id,store);
    saveKey(client,info,vault.vaultId,Buffer.from(vault.hex,'hex'),store);
    const folder = join(root,'folder');mkdirSync(folder);
    await expect(setup.connect({serverId:pending.id,vaultId:vault.vaultId,path:join(root,'missing'),confirmNonempty:false})).rejects.toMatchObject({code:'FOLDER_UNAVAILABLE'});
    expect(existsSync(join(root,'missing'))).toBe(false);
    block = true;
    const connecting = setup.connect({serverId:pending.id,vaultId:vault.vaultId,path:folder,confirmNonempty:false});
    await waiting;
    removeServerConnection(client,pending.id,false,store);
    release();
    await expect(connecting).rejects.toMatchObject({code:'NOT_FOUND'});
    expect(readdirSync(folder)).toEqual([]);
    expect(existsSync(join(client,'connections'))).toBe(false);
  } finally {release();await proxy.stop(true);}
}));

test('multiple servers and vaults remain distinct and nested roots are rejected', async () => fixture(async ({root,client,url,setup,store,serverRoot}) => {
  const first = await setup.enroll(request(url));
  approveLocalDevice(serverRoot,JSON.parse(readFileSync(join(client,'desktop-pending',`${first.id}.json`),'utf8')).deviceId);
  await setup.check(first.id);
  const one = await createVault(url), two = await createVault(url,'pictures');
  expect((await setup.vaults(first.id)).map(v=>v.id).sort()).toEqual([one.vaultId,two.vaultId].sort());
  await fixture(async ({url:secondUrl,serverRoot:secondServer}) => {
    const second = await setup.enroll({...request(secondUrl),alias:'work',deviceName:'work desktop'});
    approveLocalDevice(secondServer,JSON.parse(readFileSync(join(client,'desktop-pending',`${second.id}.json`),'utf8')).deviceId);
    await setup.check(second.id);
    const three = await createVault(secondUrl);
    expect(await setup.vaults(second.id)).toEqual([{id:three.vaultId,name:'notes',needsRecoveryKey:true}]);
    for (const [index,serverId,vault] of [[0,first.id,one],[1,first.id,two],[2,second.id,three]] as const) {
      const folder = join(root,`copy-${index}`);mkdirSync(folder);
      await setup.connect({serverId,vaultId:vault.vaultId,path:folder,recoveryKey:vault.secret,confirmNonempty:false});
      expect(Buffer.from(key(client,serverId,vault.vaultId,store)!).toString('hex')).toBe(vault.hex);
    }
    const nested = join(root,'copy-0','nested');mkdirSync(nested);
    await expect(setup.connect({serverId:first.id,vaultId:one.vaultId,path:nested,confirmNonempty:false})).rejects.toMatchObject({code:'OVERLAPPING_ROOT'});
  });
}));

test('OS readback failure never submits an enrollment and can replay the staged credential', async () => fixture(async ({client,url,store,values}) => {
  let failReadback = true, written = false, submissions = 0;
  const guarded: CredentialStore = {...store,get:id=>written&&failReadback?null:store.get(id),set:(id,value)=>{store.set(id,value);written=true;}};
  const proxy = Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/v1/auth/enrollments') submissions++;
    return fetch(`${url}${path}`,{method:req.method,headers:req.headers,body:req.method==='POST'?await req.text():undefined});
  }});
  try {
    const setup = new ConnectionSetup(client,{credentialStore:guarded});
    await expect(setup.enroll(request(proxy.url.href))).rejects.toMatchObject({code:'CREDENTIAL_STORE_LOCKED'});
    expect(submissions).toBe(0); expect(values.size).toBe(1);
    const p = setup.pending()[0]!;
    failReadback = false;
    expect(await setup.check(p.id)).toMatchObject({id:p.id,status:'pending'});
    expect(submissions).toBe(1); expect(values.size).toBe(1);
  } finally {await proxy.stop(true);}
}));

test('CLI blocked login cannot publish a competing identity after desktop reserves URL or alias', async () => {
  for (const collision of ['url','alias']) await fixture(async ({client,url,store}) => {
    let entered!:()=>void, release!:()=>void;
    const waiting = new Promise<void>(resolve=>{entered=resolve;}), gate = new Promise<void>(resolve=>{release=resolve;});
    let logins = 0;
    const proxy = Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req) {
      const path = new URL(req.url).pathname;
      const result = await fetch(`${url}${path}`,{method:req.method,headers:req.headers,body:req.method==='POST'?await req.text():undefined});
      if (path === '/v1/auth/password' && ++logins === 1) {entered();await gate;}
      return result;
    }});
    try {
      const cli = enrollServer(client,proxy.url.href,'correct horse battery staple','cli',0,{alias:'home'}).then(()=>null,error=>error);
      await waiting;
      const setup = new ConnectionSetup(client,{credentialStore:store});
      const pending = await setup.enroll({...request(collision==='url'?proxy.url.href:url),deviceName:'desktop'});
      expect(pending.status).toBe('pending');
      release();
      expect(await cli).toMatchObject({code:'ENROLLMENT_CONFLICT'});
      expect(readdirSync(join(client,'pending'))).toEqual([]);
      expect(setup.pending()).toHaveLength(1);
    } finally {release();await proxy.stop(true);}
  });
});

test('CLI approval commit rechecks registration collisions after network waits', async () => fixture(async ({client,url,serverRoot}) => {
  let entered!:()=>void, release!:()=>void;
  const waiting = new Promise<void>(resolve=>{entered=resolve;}), gate = new Promise<void>(resolve=>{release=resolve;});
  let block = false;
  const proxy = Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req) {
    const path = new URL(req.url).pathname;
    const result = await fetch(`${url}${path}`,{method:req.method,headers:req.headers,body:req.method==='POST'?await req.text():undefined});
    if (block && path === '/v1/auth/enrollments') {entered();await gate;}
    return result;
  }});
  try {
    await enrollServer(client,proxy.url.href,'correct horse battery staple','cli',0,{alias:'home'});
    const pendingFile = join(client,'pending',readdirSync(join(client,'pending'))[0]!);
    const p = JSON.parse(readFileSync(pendingFile,'utf8'));
    approveLocalDevice(serverRoot,p.deviceId);
    block = true;
    const approval = enrollServer(client,proxy.url.href,undefined,'cli',0,{alias:'home'}).then(()=>null,error=>error);
    await waiting;
    const id = randomUUID();
    secureCreate(join(privateDirectory(join(client,'servers')),`${id}.json`),JSON.stringify({version:1,serverId:id,deviceId:randomUUID(),baseUrl:proxy.url.href.replace(/\/$/,''),name:'home',token:'fixture-credential'}));
    release();
    expect(await approval).toMatchObject({code:'ENROLLMENT_CONFLICT'});
    expect(readdirSync(join(client,'servers'))).toEqual([`${id}.json`]);
    expect(existsSync(pendingFile)).toBe(true);
  } finally {release();await proxy.stop(true);}
}));

import { symlinkSync, unlinkSync } from 'node:fs';
import { desktopPendingIdentities } from '../src/enrollment.ts';

test('orphan atomic-write stages are ignored without reading or following them; unknown names fail closed', async () => fixture(async ({client,url,setup,store}) => {
  const pending = await setup.enroll(request(url));
  const stage = join(client,'desktop-pending',`${pending.id}.json.${'a'.repeat(32)}.stage`);
  symlinkSync('/nonexistent-must-not-be-read',stage);
  const restarted = new ConnectionSetup(client,{credentialStore:store});
  expect(restarted.pending()).toEqual([pending]);
  expect(desktopPendingIdentities(client)).toEqual([{url,alias:'home'}]);
  expect(await restarted.check(pending.id)).toMatchObject({id:pending.id,status:'pending'});
  const unknown = join(client,'desktop-pending','unexpected.stage');
  secureCreate(unknown,'{}');
  expect(()=>restarted.pending()).toThrow('Invalid desktop pending state');
  expect(()=>desktopPendingIdentities(client)).toThrow('Invalid desktop pending state');
  unlinkSync(unknown);
}));

test('canonical URL byte limit rejects Unicode expansion before reserving an identity', async () => {
  const root = mkdtempSync(join(tmpdir(),'setup-url-limit-'));
  try {
    const setup = new ConnectionSetup(root);
    await expect(setup.enroll(request(`https://example.com/${'é'.repeat(400)}`))).rejects.toMatchObject({code:'INVALID_SERVER_URL'});
    expect(readdirSync(root)).toEqual([]);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('oversized advertised admin URL is omitted without breaking pending resume', async () => fixture(async ({client,url,store}) => {
  const proxy = Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req) {
    const path = new URL(req.url).pathname;
    const result = await fetch(`${url}${path}`,{method:req.method,headers:req.headers,body:req.method==='POST'?await req.text():undefined});
    if (path === '/v1/capabilities') {
      const value = await result.json() as any;
      value.webAdministration = {enabled:true,url:`https://${'a.'.repeat(1100)}example.com/admin`};
      return Response.json(value);
    }
    return result;
  }});
  try {
    const setup = new ConnectionSetup(client,{credentialStore:store});
    const pending = await setup.enroll(request(proxy.url.href));
    expect(pending).toMatchObject({status:'pending',adminUrl:null});
    expect(await new ConnectionSetup(client,{credentialStore:store}).check(pending.id)).toMatchObject({id:pending.id,status:'pending',adminUrl:null});
  } finally {await proxy.stop(true);}
}));
