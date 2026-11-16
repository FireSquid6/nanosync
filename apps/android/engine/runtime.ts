import { missingRuntimeFeatures, nativeConveniences, randomUUID } from "./compatibility.ts";
import { decodeRecoverySecret, unwrapMasterKey, HttpRemote, SyncEngine } from "../../../packages/sync-core/src/index.ts";
import { Bridge, nativeFetch, type NativeHost } from "./bridge.ts";
import { Journal } from "./journal.ts";
import { Scanner } from "./scanner.ts";
import { Applier } from "./apply.ts";
export interface RunContext {
  server: { baseUrl: string; token: string; deviceId: string };
  vault: { id: string; vaultId: string; rootPath: string; masterKeyHex?: string; recoveryKey?: string; effectiveMobileAllowed?: boolean };
  allowHttp?: boolean; mobileOverride?: boolean;
}
function featureCheck() {
  const missing = missingRuntimeFeatures();
  if (missing.length) throw new Error(`WebView missing required APIs: ${missing.join(", ")}`);
}
function hex(bytes: Uint8Array) { return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join(""); }
/** Native owns generation cancellation, scoped filesystem/server access and root lock. */
export function install(host: NativeHost, target: { Nanosync?: unknown; NanosyncBridge?: unknown }) {
  const bridge = new Bridge(host); let running = false;
  target.NanosyncBridge = { complete: (id: string, result: Parameters<Bridge["complete"]>[1]) => bridge.complete(id, result) };
  const run = async (context: RunContext) => {
    if (running) { host.fail("engine already running"); return; }
    running = true; let key: Uint8Array | undefined, secret: Uint8Array | undefined;
    try {
      featureCheck();
      host.event(JSON.stringify({ type: "runtimeCapabilities", nativeConveniences }));
      const url = new URL(context.server.baseUrl);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && context.allowHttp)) throw new Error("insecure server requires explicit HTTP permission");
      if (context.vault.effectiveMobileAllowed === false && !context.mobileOverride) throw new Error("mobile network not allowed");
      const transport = nativeFetch(bridge, context.server.baseUrl);
      if (context.vault.recoveryKey) {
        const recoveryText = context.vault.recoveryKey; delete context.vault.recoveryKey;
        secret = await decodeRecoverySecret(recoveryText);
        const response = await transport(new Request(`${context.server.baseUrl.replace(/\/$/, "")}/v1/recovery-wrap`, { headers: { authorization: `Bearer ${context.server.token}`, "x-nanosync-vault-id": context.vault.vaultId } }));
        if (response.status !== 200) throw new Error("cannot fetch recovery wrap");
        const body = await response.json() as { recoveryWrap: unknown };
        key = await unwrapMasterKey(body.recoveryWrap, secret, context.vault.vaultId);
        host.finish(JSON.stringify({ masterKeyHex: hex(key) })); return;
      }
      const master = context.vault.masterKeyHex;
      delete context.vault.masterKeyHex;
      if (!master || !/^[a-fA-F0-9]{64}$/.test(master)) throw new Error("invalid vault master key");
      key = Uint8Array.from(master.match(/../g)!, pair => parseInt(pair, 16));
      const journal = new Journal(bridge), scanner = new Scanner(bridge, journal);
      await journal.prepareStorage();
      await scanner.refresh();
      const remote = new HttpRemote({ baseUrl: context.server.baseUrl, token: context.server.token, vaultId: context.vault.vaultId, fetch: transport, journal });
      const applier = new Applier(bridge, journal, scanner, remote);
      const engine = new SyncEngine({ vaultId: context.vault.vaultId, deviceId: context.server.deviceId, masterKey: key, local: journal, scanner, remote,
        randomUUID, now: () => new Date().toISOString(),
        apply: (manifest, sequence, borrowedKey) => applier.apply(manifest, sequence, borrowedKey),
        hydrate: async () => { throw new Error("Android hydration intents unsupported"); },
      });
      const result = await engine.syncOnce();
      host.finish(JSON.stringify({ ...result, conflicts: journal.state.conflicts, exclusionsActive: scanner.exclusionsActive, pendingUploads: 0, pendingDownloads: 0 }));
    } catch (error) { host.fail(error instanceof Error ? error.message : String(error)); }
    finally { key?.fill(0); secret?.fill(0); delete context.vault.recoveryKey; delete context.vault.masterKeyHex; running = false; }
  };
  target.Nanosync = { run }; return { run, bridge };
}
