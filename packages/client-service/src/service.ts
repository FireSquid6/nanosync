import { Database } from "bun:sqlite";
import { existsSync, lstatSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseRevisionId, parseVaultId } from "@nanosync/protocol";
import { records, discoverConnection, withConnectionRegistry, type Connection } from "./connections.ts";
import { listServerMetadata, server, key, migrateCredentials } from "./credentials.ts";
import type { CredentialStore } from "./credential-store.ts";
import { privateDirectory, secureRead, secureCreate, secureReplace } from "./security.ts";
import { SyncRunner, type SyncOptions } from "./sync-runner.ts";
import { inspectSyncOwner } from "./sync-lock.ts";
import { publishControl, ownerEndpoint, requestOwner, type OwnerStatus, type SyncOwner } from "./sync-control.ts";
import { CliError } from "./errors.ts";

export interface ServerSummary { id: string; name: string; url: string; credentialMode: "protected-file" | "os"; migrationPending?: boolean }
export interface FolderSummary {
  id: string; name: string; serverId: string; serverName: string; vaultId: string; path: string;
  status: "Not checked" | "Syncing" | "Up to date" | "Folder unavailable" | "Credentials required" | "Conflicts" | "Failed";
  owner: SyncOwner | null; progress: string | null; error: string | null;
  lastSync: string | null; sequence: number | null; conflicts: number;
}
export interface ClientSnapshot { servers: ServerSummary[]; folders: FolderSummary[] }
type Head = { revisionId: string; sequence: number };
interface Session { runner: SyncRunner; control: ReturnType<typeof publishControl>; status: OwnerStatus; job?: Promise<Head> }
export interface ServiceOptions {
  owner: SyncOwner;
  onChange?: (snapshot: ClientSnapshot) => void;
  onProgress?: (message: string) => void;
  credentialStore?: CredentialStore;
  runnerOptions?: Pick<SyncOptions, "fetch" | "pollMs" | "scan">;
}

function savedSync(root: string): { lastSync: string | null; sequence: number | null } {
  const path = join(root, "last-sync.json");
  if (!existsSync(path)) return { lastSync: null, sequence: null };
  const value = JSON.parse(secureRead(path).toString("utf8"));
  if (typeof value.lastSync !== "string" || !Number.isFinite(Date.parse(value.lastSync)) ||
    !Number.isSafeInteger(value.sequence) || value.sequence < 0) throw new Error("Invalid saved sync status");
  return { lastSync: value.lastSync, sequence: value.sequence };
}
function localSummary(root: string, binding: Connection): { conflicts: number; pending: number } {
  const path = join(root, "local.sqlite");
  if (!existsSync(path)) return { conflicts: 0, pending: 0 };
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (!existsSync(file)) continue;
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid!() || stat.mode & 0o177)
      throw new Error("Unsafe local database");
  }
  const db = new Database(path, { readonly: true, strict: true });
  try {
    const identity = db.query("SELECT vault,device FROM identity WHERE singleton=1").get() as { vault: string; device: string } | null;
    if (identity?.vault !== binding.vaultId || identity.device !== binding.deviceId) throw new Error("Conflicting local identity");
    const conflicts = (db.query("SELECT count(*) AS n FROM conflicts WHERE state='open'").get() as { n: number }).n;
    const pending = (db.query("SELECT (SELECT count(*) FROM operations WHERE state!='done') + (SELECT count(*) FROM transfers WHERE state!='done') AS n").get() as { n: number }).n;
    return { conflicts, pending };
  } finally { db.close(); }
}
function rootAvailable(binding: Connection): boolean {
  try { const stat = lstatSync(binding.root); return stat.isDirectory() && !stat.isSymbolicLink(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function safeFailure(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  if (code === "VAULT_DELETED") return "Vault deleted. Local files are preserved; disconnect and reconnect deliberately.";
  if (code === "UNAUTHORIZED" || code === "FORBIDDEN") return "Access denied. Check device approval and credentials.";
  return "Synchronization failed. Check the server, credential store and local folder, then retry.";
}

/** Shared by CLI and native desktop. Secrets never appear in snapshots or control responses. */
export class ClientService {
  readonly root: string;
  private sessions = new Map<string, Session>();
  private starting = new Map<string, Promise<Session>>();
  private closed = false;
  private stopping?: Promise<void>;
  constructor(root: string, private options: ServiceOptions = { owner: "CLI" }) { this.root = privateDirectory(resolve(root)); }
  private replica(binding: Connection) { return join(this.root, "replicas", binding.connectionId); }
  private binding(id: string): Connection {
    parseVaultId(id);
    const value = records(this.root).find(binding => binding.connectionId === id);
    if (!value) throw new CliError("NOT_FOUND", "Folder binding no longer exists");
    return value;
  }
  private emit() {
    if (!this.closed && this.options.onChange) void this.snapshot().then(value => {
      if (!this.closed) this.options.onChange?.(value);
    }).catch(() => {});
  }
  async snapshot(): Promise<ClientSnapshot> {
    const metadata = listServerMetadata(this.root);
    const servers = metadata.map(s => ({ id: s.serverId, name: s.name, url: s.baseUrl, credentialMode: s.credentialMode, ...(s.migrationPending ? { migrationPending: true } : {}) }));
    const folders = await Promise.all(records(this.root).map(async binding => {
      const registration = servers.find(s => s.id === binding.serverId);
      const root = this.replica(binding);
      const summary: FolderSummary = {
        id: binding.connectionId, name: basename(binding.root), serverId: binding.serverId,
        serverName: registration?.name ?? "Connection unavailable", vaultId: binding.vaultId, path: binding.root,
        status: "Not checked", owner: null, progress: null, error: null, lastSync: null, sequence: null, conflicts: 0,
      };
      try {
        Object.assign(summary, savedSync(root));
        const local = localSummary(root, binding);
        summary.conflicts = local.conflicts;
        if (local.conflicts) summary.status = "Conflicts";
        const ours = this.sessions.get(binding.connectionId);
        const endpoint = ours ? null : ownerEndpoint(root);
        if (ours) Object.assign(summary, ours.status);
        else if (endpoint) {
          summary.owner = endpoint.owner;
          const status = await requestOwner<OwnerStatus>(endpoint, "status");
          if (!status || !["Desktop", "CLI"].includes(status.owner) || !["Not checked", "Syncing", "Up to date", "Conflicts", "Failed"].includes(status.status) ||
            ![status.progress, status.error].every(value => value === null || typeof value === "string" && value.length <= 4096) ||
            !(status.lastSync === null || typeof status.lastSync === "string" && Number.isFinite(Date.parse(status.lastSync))) ||
            !(status.sequence === null || Number.isSafeInteger(status.sequence) && status.sequence >= 0) ||
            !Number.isSafeInteger(status.conflicts) || status.conflicts < 0)
            throw new Error("Invalid owner status");
          const { owner, status: state, progress, error, lastSync, sequence, conflicts } = status;
          Object.assign(summary, { owner, status: state, progress, error, lastSync, sequence, conflicts });
        } else if (inspectSyncOwner(root)) {
          summary.error = "An older sync process owns this folder. Stop it before requesting sync here.";
        }
        if (!rootAvailable(binding)) { summary.status = "Folder unavailable"; summary.error = "Restore the folder before syncing. No contents were treated as deletions."; }
        else if (!registration || this.options.owner === "Desktop" && (registration.credentialMode !== "os" || registration.migrationPending)) {
          summary.status = "Credentials required";
          summary.error = "Choose OS credential migration in Connections. Protected-file CLI credentials have not been changed.";
        }
      } catch {
        summary.status = "Failed";
        summary.error = "Cannot safely read this folder's synchronization state. No synchronization was started.";
      }
      return summary;
    }));
    return { servers, folders };
  }
  private session(binding: Connection): Promise<Session> {
    const current = this.sessions.get(binding.connectionId);
    if (current) return Promise.resolve(current);
    const pending = this.starting.get(binding.connectionId);
    if (pending) return pending;
    const creating = this.createSession(binding);
    this.starting.set(binding.connectionId, creating);
    void creating.finally(() => this.starting.delete(binding.connectionId)).catch(() => {});
    return creating;
  }
  private async createSession(binding: Connection): Promise<Session> {
    if (this.closed) throw new Error("Client service stopped");
    const info = server(this.root, binding.serverId, this.options.credentialStore);
    if (info.deviceId !== binding.deviceId) throw new CliError("CONFLICT", "Binding device differs from connection");
    const master = key(this.root, binding.serverId, binding.vaultId, this.options.credentialStore);
    if (!master) throw new CliError("INPUT_REQUIRED", "Vault key is missing; reconnect to unlock");
    let session: Session;
    let runner: SyncRunner;
    try {
      runner = withConnectionRegistry(this.root, () => {
        if (this.closed || discoverConnection(this.root, binding.root).connectionId !== binding.connectionId)
          throw new CliError("CONFLICT", "Binding changed or client stopped");
        // Revalidate registration while serialized with removal/migration.
        const selected = listServerMetadata(this.root).find(s => s.serverId === binding.serverId);
        if (!selected || selected.deviceId !== info.deviceId || selected.baseUrl !== info.baseUrl)
          throw new CliError("CONFLICT", "Connection changed; refresh before syncing");
        privateDirectory(join(this.root, "replicas"));
        return SyncRunner.start({ ...this.options.runnerOptions,
          clientDirectory: privateDirectory(this.replica(binding)), syncDirectory: binding.root,
          vaultId: binding.vaultId, deviceId: binding.deviceId, masterKey: master, baseUrl: info.baseUrl, token: info.token,
          onProgress: message => {
            if (session) { session.status.status = "Syncing"; session.status.progress = message; this.emit(); }
            this.options.onProgress?.(message);
          },
        });
      });
    } finally { master.fill(0); }
    try {
      const status: OwnerStatus = { owner: this.options.owner, status: "Not checked", progress: null, error: null, ...savedSync(this.replica(binding)), conflicts: 0 };
      const control = publishControl(this.replica(binding), this.options.owner, {
        status: () => ({ ...session.status }),
        sync: () => this.perform(binding, session),
      });
      session = { runner, control, status };
      this.sessions.set(binding.connectionId, session);
      return session;
    } catch (error) { await runner.stop(); throw error; }
  }
  private completed(binding: Connection, session: Session, head: Head): void {
    const local = localSummary(this.replica(binding), binding);
    session.status.conflicts = local.conflicts;
    session.status.status = local.conflicts ? "Conflicts" : local.pending ? "Not checked" : "Up to date";
    session.status.progress = null;
    session.status.lastSync = new Date().toISOString(); session.status.sequence = head.sequence;
    const path = join(this.replica(binding), "last-sync.json");
    const text = JSON.stringify({ lastSync: session.status.lastSync, sequence: head.sequence });
    if (existsSync(path)) secureReplace(path, text); else secureCreate(path, text);
  }
  private perform(binding: Connection, session: Session): Promise<Head> {
    if (this.closed) return Promise.reject(new Error("Client service stopped"));
    if (session.job) return session.job;
    session.status.status = "Syncing"; session.status.error = null;
    const job = (async () => {
      try {
        const head = await session.runner.syncOnce();
        this.completed(binding, session, head);
        return head;
      } catch (error) {
        session.status.status = "Failed"; session.status.error = safeFailure(error); session.status.progress = null;
        throw error;
      } finally { session.job = undefined; this.emit(); }
    })();
    session.job = job;
    this.emit();
    return job;
  }
  private async forward(endpoint: NonNullable<ReturnType<typeof ownerEndpoint>>): Promise<Head> {
    const head = await requestOwner<Head>(endpoint, "sync");
    if (!head || !Number.isSafeInteger(head.sequence) || head.sequence < 0) throw new Error("Invalid owner result");
    return { revisionId: parseRevisionId(head.revisionId), sequence: head.sequence };
  }
  async sync(id: string): Promise<Head> {
    if (this.closed) throw new Error("Client service stopped");
    const binding = this.binding(id);
    const registration = listServerMetadata(this.root).find(s => s.serverId === binding.serverId);
    if (this.options.owner === "Desktop" && (registration?.credentialMode !== "os" || registration.migrationPending))
      throw new CliError("CREDENTIALS_REQUIRED", "Explicit OS credential migration is required before desktop sync");
    const ours = this.sessions.get(id);
    if (ours) return this.perform(binding, ours);
    const endpoint = ownerEndpoint(this.replica(binding));
    if (endpoint) return this.forward(endpoint);
    try { return await this.perform(binding, await this.session(binding)); }
    catch (error) {
      // Another process may win between discovery and lock acquisition. Forward, never compete.
      const winner = ownerEndpoint(this.replica(binding));
      if (winner && !this.sessions.has(id)) return this.forward(winner);
      throw error;
    }
  }
  async watch(id: string, signal: AbortSignal, onSuccess: (head: Head) => void, onError: (error: unknown) => void): Promise<void> {
    const binding = this.binding(id);
    if (ownerEndpoint(this.replica(binding)) && !this.sessions.has(id))
      throw new CliError("CONFLICT", "An existing process owns this folder; request a one-shot sync or stop that owner before starting --watch");
    const session = await this.session(binding);
    await session.runner.watch(signal, head => {
      this.completed(binding, session, head);
      onSuccess(head); this.emit();
    }, error => { session.status.status = "Failed"; session.status.error = safeFailure(error); onError(error); this.emit(); });
  }
  async migrate(id: string): Promise<void> {
    parseVaultId(id);
    for (const binding of records(this.root).filter(b => b.serverId === id)) {
      if (inspectSyncOwner(this.replica(binding))) throw new CliError("CONFLICT", "Stop the active sync owner before migrating credentials");
    }
    migrateCredentials(this.root, id, this.options.credentialStore);
    this.emit();
  }
  stop(): Promise<void> {
    if (!this.stopping) {
      const attempt = this.stopAll();
      this.stopping = attempt;
      void attempt.catch(() => { if (this.stopping === attempt) this.stopping = undefined; });
    }
    return this.stopping;
  }
  private async stopAll(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.starting.values());
    const sessions = [...this.sessions.entries()];
    const results = await Promise.allSettled(sessions.map(async ([id, session]) => {
      // Close control first so no new jobs can start while draining the runner.
      try { await session.control.stop(); }
      finally { await session.runner.stop(); }
      this.sessions.delete(id);
    }));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
  }
}
