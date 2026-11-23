import { createHash } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseVaultId } from "@nanosync/protocol";
import { privateDirectory, secureCreate, secureRead, syncPrivateDirectory } from "./security.ts";
import { CredentialStoreError, type CredentialStore } from "./credential-store.ts";

export const storeId = (root: string, id: string) => createHash("sha256").update(resolve(root)).update("\0").update(id).digest("hex");
const removalDirectory = (root: string) => join(privateDirectory(root), "credential-removals");
function removalPath(root: string, id: string): string {
  const directory = removalDirectory(root);
  if (existsSync(directory)) privateDirectory(directory);
  return join(directory, `${parseVaultId(id)}.json`);
}
export function removalPending(root: string, id: string): boolean { return existsSync(removalPath(root, id)); }
export function assertNotRemoving(root: string, id: string): void {
  if (removalPending(root, id)) throw new Error("credential removal incomplete; retry removing this server connection");
}
/** Caller holds the registry and every affected replica lock through both callbacks. */
export function credentialRemoval(root: string, id: string, store: CredentialStore) {
  const path = join(root, "servers", `${parseVaultId(id)}.json`), journal = removalPath(root, id);
  const replay = existsSync(journal);
  const state = JSON.stringify({ version: 1, serverId: id, credentialMode: "os" });
  if (replay && secureRead(journal).toString() !== state) throw new Error("invalid credential removal journal");
  if (existsSync(join(root, "credential-migrations", `${id}.json`))) throw new Error("credential migration incomplete; finish migration before removal");
  let os = replay;
  if (existsSync(path)) {
    const info = JSON.parse(secureRead(path, 2048).toString());
    if (info.serverId !== id || !(info.version === 1 && typeof info.token === "string" || info.version === 2 && info.credentialMode === "os"))
      throw new Error("invalid server registration");
    os = info.version === 2;
    if (replay && !os) throw new Error("server changed during credential removal");
  } else if (!replay) throw new Error("server registration missing");
  return {
    prepare() {
      if (!os) return;
      // Confirm access before any binding mutation. A replay may already have deleted the item.
      if (store.get(storeId(root, id)) === null && !replay) throw new CredentialStoreError();
      if (!replay) { privateDirectory(removalDirectory(root)); secureCreate(journal, state); }
    },
    commit() {
      if (os) {
        // A verified tombstone also proves an empty lookup is not a silent locked-store failure.
        store.set(storeId(root, id), state);
        if (store.get(storeId(root, id)) !== state) throw new CredentialStoreError();
        store.delete(storeId(root, id));
        if (store.get(storeId(root, id)) !== null) throw new CredentialStoreError();
      }
      const pending = join(root, 'desktop-pending', `${id}.json`);
      if (os && existsSync(pending)) {
        privateDirectory(join(root,'desktop-pending'));
        if (JSON.parse(secureRead(pending,8192).toString()).id !== id) throw new Error('invalid desktop enrollment identity');
        unlinkSync(pending); syncPrivateDirectory(join(root,'desktop-pending'));
      }
      if (existsSync(path)) { unlinkSync(path); syncPrivateDirectory(join(root, "servers")); }
      if (os) { unlinkSync(journal); syncPrivateDirectory(removalDirectory(root)); }
    },
  };
}
