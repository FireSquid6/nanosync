import { randomUUID } from "node:crypto";
import { ClientLocal } from "@nanosync/client-local";
import { applyNewFiles, hydrateFile, LinuxScanner, LinuxWatcher, type ScanOptions } from "@nanosync/linux-client";
import { HttpRemote, SyncEngine, type RemoteOptions } from "@nanosync/sync-core";
import { parseDeviceId, parseVaultId } from "@nanosync/protocol";
import { acquireSyncLock } from "./sync-lock.ts";
import { privateDirectory } from "./security.ts";
import { setTimeout as delay } from "node:timers/promises";
import { resolve, sep } from "node:path";

// Linux ownership and foreground lifecycle stay in the CLI; orchestration is portable.
export interface SyncOptions {
  clientDirectory: string;
  syncDirectory: string;
  vaultId: string;
  deviceId: string;
  masterKey: Uint8Array;
  baseUrl: string;
  token: string;
  fetch?: RemoteOptions["fetch"];
  pollMs?: number;
  scan?: ScanOptions;
}

export class SyncRunner {
  private readonly local: ClientLocal;
  private readonly scanner: LinuxScanner;
  private readonly engine: SyncEngine;
  private readonly key: Uint8Array;
  private readonly vault: string;
  private readonly device: string;
  private readonly pollMs: number;
  private readonly unlock: () => void;
  private watcher?: LinuxWatcher;
  private active?: Promise<{ revisionId: string; sequence: number }>;
  private stopped = false;

  private constructor(options: SyncOptions, unlock: () => void) {
    this.unlock = unlock;
    this.vault = parseVaultId(options.vaultId);
    this.device = parseDeviceId(options.deviceId);
    if (!(options.masterKey instanceof Uint8Array) || options.masterKey.length !== 32) throw new Error("invalid vault key");
    this.pollMs = options.pollMs ?? 5_000;
    if (!Number.isSafeInteger(this.pollMs) || this.pollMs < 100 || this.pollMs > 3_600_000) throw new Error("invalid poll interval");
    this.local = new ClientLocal(options.clientDirectory, this.vault, this.device);
    this.key = Uint8Array.from(options.masterKey);
    try {
      this.scanner = new LinuxScanner(options.syncDirectory, this.local, options.scan);
      const remote = new HttpRemote({ baseUrl: options.baseUrl, token: options.token, vaultId: this.vault,
        fetch: options.fetch ?? fetch, journal: this.local });
      this.engine = new SyncEngine({ vaultId: this.vault, deviceId: this.device, masterKey: this.key,
        local: this.local, scanner: this.scanner, remote, randomUUID, now: () => new Date().toISOString(),
        apply: (manifest, sequence, key) => applyNewFiles(this.scanner.root, this.local, remote, manifest, sequence, key),
        hydrate: (manifest, revision, key, intent, path) => hydrateFile(this.scanner.root, this.local, remote, manifest, revision, key, intent.direction, path, intent),
      });
    } catch (error) {
      this.local.close();
      this.key.fill(0);
      throw error;
    }
  }

  static start(options: SyncOptions): SyncRunner {
    const root = privateDirectory(options.clientDirectory);
    const dataRoot = resolve(options.syncDirectory);
    if (dataRoot === root || dataRoot.startsWith(root + sep) || root.startsWith(dataRoot + sep)) {
      throw new Error("sync directory and private client directory must not overlap");
    }
    const unlock = acquireSyncLock(root);
    try { return new SyncRunner({ ...options, clientDirectory: root }, unlock); }
    catch (error) { unlock(); throw error; }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.watcher?.close();
      await this.active?.catch(() => {});
    } finally {
      try { this.local.close(); }
      finally { this.key.fill(0); this.unlock(); }
    }
  }

  syncOnce(): Promise<{ revisionId: string; sequence: number }> {
    if (this.stopped) return Promise.reject(new Error("sync runner stopped"));
    if (this.active) return this.active;
    const work = (async () => {
      const head = await this.engine.syncOnce();
      this.watcher?.refresh();
      return head;
    })();
    this.active = work;
    void work.finally(() => { if (this.active === work) this.active = undefined; }).catch(() => {});
    return work;
  }

  /** Foreground loop: watcher events are hints; periodic full passes catch missed notifications. */
  async watch(signal: AbortSignal, onSuccess: (head: { revisionId: string; sequence: number }) => void,
    onError: (error: unknown) => void): Promise<void> {
    let lastPoll = 0;
    while (!signal.aborted && !this.stopped) {
      const now = Date.now();
      let shouldSync = now - lastPoll >= this.pollMs;
      if (this.watcher) {
        try { shouldSync = this.watcher.ready(now) || shouldSync; }
        catch (error) { if (shouldSync) onError(error); }
      }
      if (shouldSync) {
        lastPoll = Date.now();
        try {
          const head = await this.syncOnce();
          if (!signal.aborted && !this.stopped) {
            if (!this.watcher) { this.watcher = new LinuxWatcher(this.scanner); this.watcher.start(); }
            onSuccess(head);
          }
        } catch (error) { onError(error); }
      }
      if (!signal.aborted && !this.stopped) {
        try { await delay(250, undefined, { signal }); }
        catch (error) { if (!signal.aborted) throw error; }
      }
    }
  }

}
