import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { decodeCanonicalBase64Url, enrollmentVerificationCode, parseDeviceId, parseVaultId, parsePasswordAuthenticationRequest,
  parsePasswordAuthenticationResponse, parseEnrollmentResponse, parseEnrollmentStatusResponse, parseCapabilityResponse, parseRecoveryWrapResponse } from '@nanosync/protocol';
import { decodeRecoverySecret, unwrapMasterKey } from '@nanosync/sync-core';
import { privateDirectory, secureCreate, secureRead, secureReplace, syncPrivateDirectory } from './security.ts';
import { defaultCredentialStore, type CredentialStore } from './credential-store.ts';
import { approveEnrollment, discardEnrollmentToken, enrollmentToken, key, listServerMetadata, saveKey, server, type ServerRegistration } from './credentials.ts';
import { connectRegisteredVault, withConnectionRegistry } from './connections.ts';
import { baseUrl } from './url.ts';
import { desktopPendingStage, enrollmentRequest } from './enrollment.ts';
import { setupRequest, SetupHttpError } from './setup-network.ts';
import { CliError } from './errors.ts';

function fail(code: string, message: string): never { throw new CliError(code,message); }
function inputId(value: string): string { try { return parseDeviceId(value); } catch { return fail('INVALID_INPUT','Select a valid connection or vault ID.'); } }
function canonicalUrl(value: string): string { try { const url = baseUrl(value); if (Buffer.byteLength(url) > 2048) throw new Error(); return url; } catch { return fail('INVALID_SERVER_URL','Use a valid HTTPS server URL (HTTP is allowed only for loopback).'); } }

export interface EnrollmentSummary {
  id: string; url: string; alias: string; deviceName: string;
  status: 'pending'|'approved'|'denied'|'expired'|'error';
  verificationCode: string; adminUrl: string|null; error: string|null;
}
export interface VaultSummary { id: string; name: string; needsRecoveryKey: boolean }
interface Pending extends EnrollmentSummary { version: 1; deviceId: string; fingerprint: string; expiresAtMs: number }
function text(value: string) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 128 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) fail('INVALID_INPUT','Invalid alias or device name.');
  return value;
}
const directory = (root: string) => privateDirectory(join(privateDirectory(root), 'desktop-pending'));
const file = (root: string, id: string) => join(directory(root), `${parseDeviceId(id)}.json`);
function summary(p: EnrollmentSummary): EnrollmentSummary {
  return {id:p.id,url:p.url,alias:p.alias,deviceName:p.deviceName,status:p.status,verificationCode:p.verificationCode,adminUrl:p.adminUrl,error:p.error};
}
/** Reads only public legacy fields; never converts or unlocks legacy credentials. */
export function legacyPendingSummaries(root: string): EnrollmentSummary[] {
  const path = join(root, 'pending');
  if (!existsSync(path)) return [];
  return readdirSync(privateDirectory(path)).map(name => {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error('Invalid legacy pending state.');
    const p = JSON.parse(secureRead(join(path,name),4096).toString());
    return {id:parseDeviceId(p.serverId),url:baseUrl(p.url),alias:text(p.alias),deviceName:text(p.name),status:'error',
      verificationCode:'',adminUrl:null,error:'Protected-file enrollment requires migration; resume it in the CLI, then explicitly migrate credentials.'};
  });
}
export class ConnectionSetup {
  private readonly store: CredentialStore;
  constructor(private readonly root: string, options: {credentialStore?: CredentialStore} = {}) { this.store = options.credentialStore ?? defaultCredentialStore; }
  private requests(): Pending[] {
    return readdirSync(directory(this.root)).filter(name => !desktopPendingStage.test(name)).map(name => {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) throw new Error('Invalid desktop pending state.');
      const p = JSON.parse(secureRead(join(directory(this.root),name),8192).toString()) as Pending;
      if (p.version !== 1 || file(this.root,p.id) !== join(directory(this.root),name) || baseUrl(p.url) !== p.url ||
          Object.keys(p).sort().join() !== 'adminUrl,alias,deviceId,deviceName,error,expiresAtMs,fingerprint,id,status,url,verificationCode,version' ||
          !Number.isSafeInteger(p.expiresAtMs) || p.expiresAtMs < 0 || !['pending','approved','denied','expired','error'].includes(p.status) ||
          p.error !== null && (typeof p.error !== 'string' || Buffer.byteLength(p.error) > 512)) throw new Error('Invalid desktop pending state.');
      parseDeviceId(p.deviceId); decodeCanonicalBase64Url(p.fingerprint,32); text(p.alias); text(p.deviceName);
      if (p.verificationCode !== enrollmentVerificationCode(p.deviceId,p.fingerprint)) throw new Error('Invalid desktop verification identity.');
      if (p.adminUrl !== null) this.adminUrl(p.adminUrl);
      return p;
    });
  }
  pending(): EnrollmentSummary[] {
    const approved = new Set(listServerMetadata(this.root).map(item => item.serverId));
    return [...this.requests().filter(p => !approved.has(p.id)).map(summary), ...legacyPendingSummaries(this.root)];
  }
  private approvedSummary(id: string): EnrollmentSummary | undefined {
    const saved = listServerMetadata(this.root).find(item => item.serverId === id && item.credentialMode === 'os');
    if (!saved) return undefined;
    return {id:saved.serverId,url:saved.baseUrl,alias:saved.name,deviceName:saved.deviceName ?? saved.name,status:'approved',verificationCode:'',adminUrl:null,error:null};
  }
  private cleanup(p: Pending): void {
    withConnectionRegistry(this.root, () => {
      if (!this.approvedSummary(p.id)) fail('NOT_FOUND','Server connection was removed.');
      if (existsSync(file(this.root,p.id))) { unlinkSync(file(this.root,p.id)); syncPrivateDirectory(directory(this.root)); }
    });
  }
  private adminUrl(url: string): string {
    const parsed = new URL(url);
    if (Buffer.byteLength(url) > 2048 || Buffer.byteLength(baseUrl(url)) > 2048) throw new Error('Administration URL is too long.');
    if (parsed.pathname !== '/admin') throw new Error('Invalid administration URL.');
    return url;
  }
  private update(p: Pending): void {
    withConnectionRegistry(this.root, () => {
      const current = this.requests().find(item => item.id === p.id);
      if (!current || current.deviceId !== p.deviceId) throw new Error('Enrollment changed; select it again.');
      secureReplace(file(this.root,p.id),JSON.stringify(p));
    });
  }
  async enroll(input: {url:string;alias:string;deviceName:string;password?:string;fresh?:boolean}): Promise<EnrollmentSummary> {
    const url = canonicalUrl(input.url), alias = text(input.alias), deviceName = text(input.deviceName);
    const existing = listServerMetadata(this.root).find(item => item.baseUrl === url || item.name === alias);
    if (existing) {
      if (existing.baseUrl !== url || existing.name !== alias || (existing.deviceName ?? existing.name) !== deviceName || input.fresh) fail('ENROLLMENT_CONFLICT','Connection identity differs; select the existing connection.');
      if (existing.credentialMode !== 'os') fail('CREDENTIALS_REQUIRED','Protected-file credentials require explicit migration.');
      return this.approvedSummary(existing.serverId)!;
    }
    let p = withConnectionRegistry(this.root, () => {
      if (legacyPendingSummaries(this.root).some(item => item.url === url || item.alias === alias)) fail('ENROLLMENT_CONFLICT','Protected-file enrollment exists; resume in CLI, then explicitly migrate credentials.');
      let found = this.requests().find(item => item.url === url || item.alias === alias);
      if (found) {
        if (found.url !== url || found.alias !== alias || found.deviceName !== deviceName) fail('ENROLLMENT_CONFLICT','Pending identity differs; resume with its original URL, alias and device name.');
        if (input.fresh) {
          if (!['denied','expired'].includes(found.status)) fail('ENROLLMENT_CONFLICT','Only denied or expired requests may be replaced with fresh.');
          if (!input.password) fail('PASSWORD_REQUIRED','Owner password required for a fresh enrollment.');
          discardEnrollmentToken(this.root,found.id,this.store);
          unlinkSync(file(this.root,found.id)); syncPrivateDirectory(directory(this.root));
          found = undefined;
        } else return found;
      }
      if (listServerMetadata(this.root).some(item => item.baseUrl === url || item.name === alias)) fail('ENROLLMENT_CONFLICT','Connection already exists; select it instead.');
      if (!input.password) fail('PASSWORD_REQUIRED','Owner password required for a new enrollment.');
      const deviceId = randomUUID(), fingerprint = randomBytes(32).toString('base64url');
      const created: Pending = {version:1,id:randomUUID(),url,alias,deviceName,deviceId,fingerprint,status:'pending',
        verificationCode:enrollmentVerificationCode(deviceId,fingerprint),adminUrl:null,error:null,expiresAtMs:Date.now()+86400000};
      secureCreate(file(this.root,created.id),JSON.stringify(created));
      return created;
    });
    try {
      let token = withConnectionRegistry(this.root, () => enrollmentToken(this.root,p.id,this.store));
      if (!token) {
        if (!input.password) fail('PASSWORD_REQUIRED','Owner password required; submit this same request again with the password.');
        const result = parsePasswordAuthenticationResponse(await setupRequest(url,'/v1/auth/password',{method:'POST',body:JSON.stringify(parsePasswordAuthenticationRequest({protocolVersion:1,password:input.password}))}));
        token = withConnectionRegistry(this.root, () => enrollmentToken(this.root,p.id,this.store,result.sessionToken))!;
        this.update(p);
      }
      return await this.exchange(p,token);
    } catch (error) {
      p = {...p,status:'error',error:error instanceof CliError && error.code === 'PASSWORD_REQUIRED' ? 'Owner password required; submit this same request again with the password.' : error instanceof SetupHttpError && error.status === 401 ? 'Owner authentication failed; verify the password and submit this same request again.' : 'Enrollment could not complete; unlock the OS credential store, check the network and retry the same request.'}; this.update(p);
      if (error instanceof CliError) throw error;
      if (error instanceof SetupHttpError && error.status === 401) fail('AUTHENTICATION_FAILED','Owner authentication failed; verify the password.');
      return summary(p);
    }
  }
  async check(id: string): Promise<EnrollmentSummary> {
    const p = this.requests().find(item => item.id === inputId(id));
    if (!p) {
      const approved = this.approvedSummary(id);
      if (approved) return approved;
      fail('NOT_FOUND','Enrollment not found; legacy requests must be resumed in CLI.');
    }
    try {
      const token = withConnectionRegistry(this.root, () => enrollmentToken(this.root,p.id,this.store));
      if (!token) {
        p.error = 'Owner password required; submit this same request again with the password.'; p.status = 'error'; this.update(p);
        fail('PASSWORD_REQUIRED',p.error);
      }
      return await this.exchange(p,token);
    } catch (error) {
      p.error = error instanceof CliError && error.code === 'PASSWORD_REQUIRED' ? 'Owner password required; submit this same request again with the password.' : 'Unable to check enrollment; unlock the OS credential store, check the network and retry.'; p.status = 'error'; this.update(p);
      if (error instanceof CliError) throw error;
      return summary(p);
    }
  }
  private async exchange(p: Pending, token: string): Promise<EnrollmentSummary> {
    if (listServerMetadata(this.root).some(item => item.serverId === p.id)) {
      withConnectionRegistry(this.root, () => approveEnrollment(this.root,{version:1,serverId:p.id,baseUrl:p.url,deviceId:p.deviceId,name:p.alias,token,deviceName:p.deviceName},this.store));
      p.status = 'approved'; p.error = null; this.cleanup(p); return summary(p);
    }
    if (['denied','expired'].includes(p.status)) return summary(p);
    let status: 'pending'|'approved'|'denied'|'expired';
    try {
      // Submit is idempotent and recovers an enrollment whose response was lost.
      {
        let response;
        try { response = parseEnrollmentStatusResponse(await setupRequest(p.url,'/v1/auth/enrollments/status',{},token)); }
        catch (error) {
          if (!(error instanceof SetupHttpError && error.status === 401)) throw error;
          if (Date.now() >= p.expiresAtMs) { p.status = 'expired'; p.error = null; this.update(p); return summary(p); }
          response = parseEnrollmentResponse(await setupRequest(p.url,'/v1/auth/enrollments',{method:'POST',body:JSON.stringify(enrollmentRequest(p.deviceId,p.deviceName,p.fingerprint))},token));
        }
        if (response.deviceId !== p.deviceId) throw new Error();
        status = response.status;
      }
    } catch (error) { if (error instanceof SetupHttpError && error.status === 401) status = 'expired'; else throw error; }
    if (status === 'approved') withConnectionRegistry(this.root, () => approveEnrollment(this.root,{version:1,serverId:p.id,baseUrl:p.url,deviceId:p.deviceId,name:p.alias,token,deviceName:p.deviceName},this.store));
    p.status = status; p.error = null;
    if (status === 'approved') { this.cleanup(p); return summary(p); }
    this.update(p);
    // Capability outages cannot undo a successful approval or terminal status.
    try { const web = parseCapabilityResponse(await setupRequest(p.url,'/v1/capabilities')).webAdministration; p.adminUrl = web.enabled && web.url ? this.adminUrl(web.url) : null; this.update(p); } catch { /* Optional administration link is not required for enrollment. */ }
    return summary(p);
  }
  private approved(id: string): ServerRegistration {
    inputId(id);
    const metadata = listServerMetadata(this.root).find(item => item.serverId === id);
    if (!metadata) fail('NOT_FOUND','Server connection not found; select an existing approved connection.');
    if (metadata.credentialMode !== 'os') fail('CREDENTIALS_REQUIRED','Select an approved OS connection; protected-file credentials require explicit migration.');
    return server(this.root,id,this.store);
  }
  private unchanged(info: ServerRegistration) {
    if (JSON.stringify(this.approved(info.serverId)) !== JSON.stringify(info)) throw new Error('Server connection changed; select it again.');
  }
  private async membership(info: ServerRegistration): Promise<{id:string;name:string}[]> {
    const result = await setupRequest(info.baseUrl,'/v1/vaults',{},info.token);
    if (result?.protocolVersion !== 1 || !Array.isArray(result.vaults) || result.vaults.length > 4096) throw new Error('Invalid vault list; retry or upgrade the server.');
    const seen = new Set<string>();
    return result.vaults.map((v: any) => {
      const id = parseVaultId(v.vaultId), name = text(v.name);
      if (seen.has(id)) throw new Error('Invalid vault list.');
      seen.add(id); return {id,name};
    });
  }
  async vaults(serverId: string): Promise<VaultSummary[]> {
    const info = this.approved(serverId), vaults = await this.membership(info);
    this.unchanged(info);
    return vaults.map(v => { const master = key(this.root,serverId,v.id,this.store); try { return {...v,needsRecoveryKey:!master}; } finally { master?.fill(0); } });
  }
  async connect(input: {serverId:string;vaultId:string;path:string;recoveryKey?:string;confirmNonempty:boolean}): Promise<{id:string}> {
    const info = this.approved(input.serverId), vaultId = inputId(input.vaultId);
    if (typeof input.confirmNonempty !== 'boolean' || typeof input.path !== 'string' || !input.path || input.path.includes('\0') || input.path.length > 4096) fail('INVALID_INPUT','Choose a valid existing folder and explicitly acknowledge nonempty folders.');
    if (!isAbsolute(input.path)) fail('FOLDER_UNAVAILABLE','Choose an absolute path to an existing owned folder.');
    let master = key(this.root,info.serverId,vaultId,this.store);
    try {
      if (!master) {
        if (!input.recoveryKey) fail('RECOVERY_KEY_REQUIRED','Recovery key required for this vault.');
        const wrap = parseRecoveryWrapResponse(await setupRequest(info.baseUrl,'/v1/recovery-wrap',{headers:{'x-nanosync-vault-id':vaultId}},info.token));
        let recovery: Uint8Array;
        try { recovery = await decodeRecoverySecret(input.recoveryKey); }
        catch { return fail('INVALID_RECOVERY_KEY','Invalid recovery key; check its spelling.'); }
        try { master = await unwrapMasterKey(wrap.recoveryWrap,recovery,vaultId); }
        catch { fail('INVALID_RECOVERY_KEY','Unable to unlock vault; verify the recovery key and selected vault.'); }
        finally { recovery.fill(0); }
      }
      if (!(await this.membership(info)).some(v => v.id === vaultId)) fail('NOT_FOUND','Vault is no longer available; refresh the vault list.');
      this.unchanged(info);
      saveKey(this.root,info,vaultId,master,this.store,true);
      this.unchanged(info);
      try {
        const connection = connectRegisteredVault(this.root,input.path,info.serverId,vaultId,info.deviceId,input.confirmNonempty,() => this.unchanged(info));
        return {id:connection.connectionId};
      } catch (error) {
        if (error instanceof CliError) throw error;
        const message = error instanceof Error ? error.message : '';
        if (message.includes('destination contains files')) fail('NONEMPTY_CONFIRMATION_REQUIRED','Confirm that existing files participate in synchronization.');
        if (/overlap|nested|marker|already be bound/.test(message)) fail('OVERLAPPING_ROOT','Choose a separate, unbound folder that does not overlap another sync root.');
        return fail('FOLDER_UNAVAILABLE','Choose an existing owned folder without symlinks.');
      }
    } finally { master?.fill(0); }
  }
}
