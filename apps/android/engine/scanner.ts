import { randomUUID } from "./compatibility.ts";
import { encryptFileChunks, IgnoreMatcher, manifestPaths, parseManifest, type ManifestEntry, type ManifestV1, type ScanPlan, type SyncScanner, type EncryptedObject } from "../../../packages/sync-core/src/index.ts";
import { Bridge, fromBase64 } from "./bridge.ts";
import { Journal, type Metadata } from "./journal.ts";
export function sameMetadata(a: Pick<Metadata, "size" | "modified" | "fileKey">, b: Pick<Metadata, "size" | "modified" | "fileKey">): boolean {
  return a.size === b.size && a.modified === b.modified && (!a.fileKey || !b.fileKey || a.fileKey === b.fileKey);
}
export function safeInventory(input: Metadata[]): Metadata[] {
  if (!Array.isArray(input)) throw new Error("incomplete inventory");
  const seen = new Set<string>();
  for (const entry of input) {
    if (typeof entry.path !== "string" || entry.path.startsWith("/") || entry.path.includes("\\") || entry.path.split("/").some(p => p === "." || p === "..") || seen.has(entry.path) || entry.symlink) throw new Error("unsafe inventory");
    if (entry.path && entry.path.split("/").some(p => !p)) throw new Error("unsafe inventory path");
    seen.add(entry.path);
  }
  if (!input.some(e => e.path === "" && e.directory)) throw new Error("inventory root missing");
  return input;
}
export class Scanner implements SyncScanner {
  private inventory: Metadata[] = [];
  matcher = new IgnoreMatcher("");
  exclusionsActive = false;
  private ignoreText = "";
  constructor(readonly bridge: Bridge, readonly journal: Journal) {}
  async refresh() {
    const root = await this.bridge.call<Metadata | { missing: true }>("stat", { path: "" });
    if ("missing" in root || !root.directory || root.symlink) throw new Error("vault root inaccessible");
    const children = await this.bridge.call<Metadata[]>("listDirectory", { path: "" });
    const ignore = children.find(e => e.path === ".nanosyncignore");
    let text = "";
    if (ignore) {
      if (ignore.directory || ignore.symlink || ignore.size > 65536) throw new Error("invalid ignore file");
      const read = await this.bridge.call<{ dataBase64: string; size: number; modified: number }>("read", { path: ignore.path, offset: 0, length: 65536 });
      if (!sameMetadata(ignore, read)) throw new Error("ignore changed during scan");
      const bytes = fromBase64(read.dataBase64); if (bytes.length !== ignore.size) throw new Error("incomplete ignore file");
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    this.matcher = new IgnoreMatcher(text); this.exclusionsActive = !!text.trim(); this.ignoreText = text;
    const inventory: Metadata[] = [{ ...root, path: "" }];
    const walk = async (parent: string, items: Metadata[]) => {
      for (const item of items) {
        const parentPath = item.path.includes("/") ? item.path.slice(0, item.path.lastIndexOf("/")) : "";
        if (!item.path || parentPath !== parent) throw new Error("incomplete or invalid directory inventory");
        // Do not inspect, open or descend excluded entries (including symlinks).
        if (this.matcher.ignores(item.path, item.directory)) continue;
        if (item.symlink) throw new Error(`unsafe filesystem entry: ${item.path}`);
        inventory.push(item);
        if (item.directory) await walk(item.path, await this.bridge.call<Metadata[]>("listDirectory", { path: item.path }));
      }
    };
    await walk("", children);
    this.inventory = safeInventory(inventory);
  }
  snapshot() { return this.inventory.filter(e => !this.matcher.ignores(e.path, e.directory)); }
  policySignature() { return this.ignoreText; }
  async verifyPolicy(expected: string) {
    const meta = await this.bridge.call<Metadata | { missing: true }>("stat", { path: ".nanosyncignore" });
    let text = "";
    if (!("missing" in meta)) {
      if (meta.directory || meta.symlink || meta.size > 65536) throw new Error("invalid ignore file");
      const read = await this.bridge.call<{ dataBase64: string; size: number; modified: number }>("read", { path: ".nanosyncignore", offset: 0, length: 65536 });
      const bytes = fromBase64(read.dataBase64);
      if (!sameMetadata(meta, read) || bytes.length !== meta.size) throw new Error("ignore policy changed during read; retry sync");
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    if (text !== expected) throw new Error("ignore policy changed during apply; retry sync before applying");
  }
  async digest(meta: Metadata): Promise<string> {
    const result = await this.bridge.call<{ sha256: string; size: number; modified: number; fileKey?: string }>("digest", { path: meta.path });
    if (!sameMetadata(meta, result) || !/^[a-f0-9]{64}$/.test(result.sha256)) throw new Error(`file changed during scan: ${meta.path}`);
    return result.sha256;
  }
  private source(meta: Metadata): ReadableStream<Uint8Array> {
    let offset = 0;
    return new ReadableStream({ pull: async controller => {
      if (offset === meta.size) { controller.close(); return; }
      const read = await this.bridge.call<{ dataBase64: string; size: number; modified: number }>("read", { path: meta.path, offset, length: Math.min(4194304, meta.size - offset) });
      const bytes = fromBase64(read.dataBase64);
      if (!sameMetadata(meta, read) || !bytes.length || bytes.length > meta.size - offset) throw new Error(`unstable source: ${meta.path}`);
      offset += bytes.length; controller.enqueue(bytes);
    } });
  }
  async plan(prior: ManifestV1, revisionId: string, deviceId: string, key: Uint8Array, hints?: ManifestV1): Promise<ScanPlan> {
    await this.refresh();
    const oldPaths = manifestPaths(prior), hintsPaths = hints ? manifestPaths(hints) : new Map<string, ManifestEntry>();
    const old = [...oldPaths].filter(([, e]) => e.kind !== "tombstone"), used = new Set<string>();
    const entries: ManifestEntry[] = [], paths = new Map<string, string>(), sources = new Map<string, { meta: Metadata; sha: string }>();
    const root = prior.entries.find(e => e.parentId === null)!;
    const included = this.inventory.filter(e => !this.matcher.ignores(e.path, e.directory)).sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path));
    for (const meta of included) {
      const kind = meta.directory ? "directory" : "file", sha = meta.directory ? undefined : await this.digest(meta);
      let match: ManifestEntry | undefined;
      if (!meta.path) match = root;
      if (!match && meta.fileKey) {
        const candidates = old.filter(([, e]) => e.kind === kind && !used.has(e.id) && this.journal.entry(e.id)?.metadata?.fileKey === meta.fileKey);
        if (candidates.length === 1) match = candidates[0]![1];
      }
      if (!match) { const e = oldPaths.get(meta.path); if (e?.kind === kind && !used.has(e.id)) match = e; }
      if (!match && sha) {
        const candidates = old.filter(([p, e]) => e.kind === "file" && e.sha256 === sha && !used.has(e.id) && !this.inventory.some(m => m.path === p));
        if (candidates.length === 1 && included.filter(m => !m.directory && m.size === meta.size).length >= 1) {
          // Disallow ambiguous duplicate digest renames on the new side as well.
          let count = 0; for (const other of included.filter(m => !m.directory && m.size === meta.size)) if (await this.digest(other) === sha) count++;
          if (count === 1) match = candidates[0]![1];
        }
      }
      const hinted = hintsPaths.get(meta.path);
      const id = match?.id ?? (hinted?.kind === kind && !used.has(hinted.id) ? hinted.id : randomUUID());
      used.add(id); paths.set(meta.path, id);
      const parentPath = meta.path.includes("/") ? meta.path.slice(0, meta.path.lastIndexOf("/")) : "";
      const entry: ManifestEntry = { id, parentId: meta.path ? paths.get(parentPath)! : null, name: meta.path.split("/").pop()!, kind };
      if (match?.conflict) entry.conflict = match.conflict;
      if (!meta.directory) {
        const chunks: { objectId: string; length: number }[] = [];
        for await (const object of encryptFileChunks(this.source(meta), key, prior.vaultId)) chunks.push({ objectId: object.reference.objectId, length: Math.min(4194304, meta.size - chunks.length * 4194304) });
        if (await this.digest(meta) !== sha) throw new Error("file content changed while chunking");
        Object.assign(entry, { size: meta.size, sha256: sha, executable: match?.executable ?? false, chunks }); sources.set(id, { meta, sha: sha! });
      }
      entries.push(entry);
    }
    const suppressed: string[] = [];
    for (const [path, e] of oldPaths) {
      if (used.has(e.id)) continue;
      if (this.matcher.ignores(path, e.kind === "directory")) { entries.push(structuredClone(e)); suppressed.push(path); }
      else if (e.kind === "tombstone") entries.push(structuredClone(e));
      else entries.push({ id: e.id, parentId: e.parentId, name: e.name, kind: "tombstone", deletedKind: e.kind });
    }
    // Tombstones cannot remain under deleted directories or occupy a live name.
    const liveDirectories = new Set(entries.filter(e => e.kind === "directory").map(e => e.id));
    const byOldId = new Map(prior.entries.map(e => [e.id, e]));
    const occupied = new Set(entries.filter(e => e.kind !== "tombstone" && e.parentId !== null).map(e => `${e.parentId}/${e.name.toLowerCase()}`));
    for (const tombstone of entries.filter(e => e.kind === "tombstone").sort((a, b) => a.id.localeCompare(b.id))) {
      let parentId = tombstone.parentId!;
      while (!liveDirectories.has(parentId)) parentId = byOldId.get(parentId)?.parentId ?? root.id;
      const relocated = parentId !== tombstone.parentId; tombstone.parentId = parentId;
      if (relocated || occupied.has(`${parentId}/${tombstone.name.toLowerCase()}`)) {
        let chosen: string | undefined;
        for (let attempt = 0; attempt < 32; attempt++) {
          const suffix = ` (deleted ${tombstone.id}${attempt ? `-${attempt}` : ""})`; let stem = "";
          for (const char of tombstone.name) if (new TextEncoder().encode(stem + char + suffix).length <= 255) stem += char;
          const candidate = `${stem.replace(/[. ]+$/u, "") || "entry"}${suffix}`;
          if (!occupied.has(`${parentId}/${candidate.toLowerCase()}`)) { chosen = candidate; break; }
        }
        if (!chosen) throw new Error("tombstone archival name collision limit exceeded");
        tombstone.name = chosen;
      }
      occupied.add(`${parentId}/${tombstone.name.toLowerCase()}`);
    }
    const manifest = parseManifest({ ...prior, revisionId, parents: [prior.revisionId], creatingDeviceId: deviceId, entries });
    const scanner = this, plannedInventory = structuredClone(this.inventory), ignoreText = this.ignoreText;
    return { manifest, suppressed, commit: async () => {
      await this.refresh();
      if (ignoreText !== this.ignoreText || plannedInventory.length !== this.inventory.length) throw new Error("local tree or ignore policy changed before scan commit");
      const current = new Map(this.inventory.map(meta => [meta.path, meta]));
      for (const before of plannedInventory) {
        const after = current.get(before.path);
        if (!after || before.directory !== after.directory || (before.directory ? !!before.fileKey && before.fileKey !== after.fileKey : !sameMetadata(before, after))) throw new Error(`local tree changed before scan commit: ${before.path}`);
      }
      for (const source of sources.values()) if (await this.digest(source.meta) !== source.sha) throw new Error(`local content changed before scan commit: ${source.meta.path}`);
      await this.verifyPolicy(ignoreText);
      this.journal.commitEntries(manifest, this.inventory);
    },
      async *chunks(known = new Set<string>()): AsyncGenerator<EncryptedObject> {
        const yielded = new Set<string>();
        for (const entry of manifest.entries) {
          const source = sources.get(entry.id); if (!source) continue;
          if (await scanner.digest(source.meta) !== source.sha) throw new Error("source changed before publication");
          let index = 0;
          for await (const object of encryptFileChunks(scanner.source(source.meta), key, prior.vaultId)) {
            if (entry.chunks?.[index++]?.objectId !== object.reference.objectId) throw new Error("source chunks changed");
            if (!known.has(object.reference.objectId) && !yielded.has(object.reference.objectId)) { yielded.add(object.reference.objectId); yield object; }
          }
          if (index !== entry.chunks!.length || await scanner.digest(source.meta) !== source.sha) throw new Error("source changed during publication");
        }
      },
    };
  }
}
