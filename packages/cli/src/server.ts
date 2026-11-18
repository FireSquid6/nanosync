import { adminAssets } from '../../admin-ui/generated/assets.ts';
import { parseDeviceId } from "@nanosync/protocol";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { join } from "node:path";
import { OwnerMetadataOperations, OwnerOperations, type AdminAssets, createServerConfig, startServer, AuthenticationService, PeriodicIntegrityScanner, ServerMaintenance, Argon2idPasswordHasher } from "@nanosync/server-core";
import { AuthenticationRepository, BootstrapRepository, MaintenanceRepository, ObjectCatalogRepository, RevisionRepository, ServerMetadataDatabase, VaultRepository } from "@nanosync/server-metadata";
import { LocalFilesystem } from "@nanosync/server-object-storage";
import { privateDirectory, provisionSecret, secureRead } from '@nanosync/client-service';
import { acquireServerStorage } from './server-ownership.ts';
import { output } from './output.ts';

export interface RunServerOptions { webUi?: boolean; externalOrigin?: string; trustedProxyAddresses?: string[]; adminAssets?: AdminAssets; directory: string; host?: string; port?: number; acknowledgeExposure?: boolean; scanIntervalMs?: number }
export async function initializeServerOwner(directory: string, password: string): Promise<void> {
  if (!password || Buffer.byteLength(password) > 1024) throw new Error("password must be 1..1024 bytes");
  const root = privateDirectory(directory), release = acquireServerStorage(root);
  const bytes = new TextEncoder().encode(password);
  try {
    provisionSecret(join(root, 'pepper.hex'));
    const database = new ServerMetadataDatabase(join(root, "metadata.sqlite"));
    try {
      const verifier = await new Argon2idPasswordHasher().hash(bytes);
      new BootstrapRepository(database).initializeOwner(randomUUID(), verifier, Date.now());
    } finally { database.close(); }
  } finally { bytes.fill(0); release(); }
}
/** The server's private metadata directory is the administrative authority. */
export function approveLocalDevice(directory: string, deviceId: string): string {
  const db = new ServerMetadataDatabase(join(privateDirectory(directory), "metadata.sqlite"));
  try {
    new AuthenticationRepository(db).approve({origin:"server-local", actorId:null}, parseDeviceId(deviceId), Date.now());
    return deviceId;
  } finally { db.close(); }
}
export async function localAdminReport(directory: string, name: string): Promise<unknown> {
  const root = privateDirectory(directory);
  secureRead(join(root, "pepper.hex"), 64);
  // Reports initialize/recover storage (scan also reads ciphertext), so require
  // the same exclusive ownership as every other offline storage accessor.
  const release = acquireServerStorage(root);
  try {
    const db = new ServerMetadataDatabase(join(root, "metadata.sqlite"));
    try {
      const storage = new LocalFilesystem(join(root, "objects"));
      await storage.existsBatch([]);
      const maintenance = new ServerMaintenance(new MaintenanceRepository(db), storage);
      if (name === "storage") return maintenance.storageStatus();
      if (name === "retention-dry-run") return maintenance.retentionDryRun(Date.now());
      if (name === "gc-dry-run") return maintenance.gcDryRun(Date.now());
      if (name === "scan") return await maintenance.scanBatch(Date.now());
      return { storage: maintenance.storageStatus(), retention: maintenance.retentionDryRun(Date.now()), gc: maintenance.gcDryRun(Date.now()) };
    } finally { db.close(); }
  } finally { release(); }
}
export async function runServer(options: RunServerOptions): Promise<{ stop(): Promise<void>; url: string }> {
  const directory = privateDirectory(options.directory);
  const release = acquireServerStorage(directory);
  try {
    const running = await startOwnedServer(options, directory);
    let stopping: Promise<void> | undefined;
    return {
      url: running.url,
      stop: () => stopping ??= (async () => {
        try { await running.stop(); } finally { release(); }
      })(),
    };
  } catch (error) { release(); throw error; }
}

async function startOwnedServer(options: RunServerOptions, directory: string): Promise<{ stop(): Promise<void>; url: string }> {
  const config = createServerConfig({
    webUi: options.webUi,
    externalOrigin: options.externalOrigin,
    trustedProxyAddresses: options.trustedProxyAddresses,
    hostname: options.host,
    port: options.port,
    acknowledgeInsecureNonLoopback: options.acknowledgeExposure,
    metadataDatabasePath: join(directory, "metadata.sqlite"),
    objectStoragePath: join(directory, "objects"),
  });
  // The pepper is NEVER generated implicitly: losing it invalidates every bearer token.
  const pepper = secureRead(join(directory, "pepper.hex"), 64).toString("utf8");
  if (!/^[0-9a-f]{64}$/.test(pepper)) throw new Error("pepper.hex must contain exactly 32 bytes as lowercase hex");
  const bootstrapProof = provisionSecret(join(directory, "bootstrap.hex"));
  const database = new ServerMetadataDatabase(config.metadataDatabasePath);
  try {
    const filesystem = new LocalFilesystem(config.objectStoragePath, { maximumObjectSize: config.maximumObjectSize });
    await filesystem.existsBatch([]);
    const authentication = new AuthenticationService(
      new AuthenticationRepository(database),
      { pepper: Buffer.from(pepper, "hex") },
    );
    const authorizeBootstrap = async (request: Request) => {
      const supplied = request.headers.get("x-nanosync-bootstrap-authorization");
      return !!supplied && supplied.length === bootstrapProof.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(bootstrapProof));
    };
    const maintenance = new ServerMaintenance(new MaintenanceRepository(database), filesystem);
    const scanner = new PeriodicIntegrityScanner(maintenance, {
      intervalMs: options.scanIntervalMs ?? 60_000,
      batchSize: 100,
      onBatch: counts => {
        if (counts.missing || counts.corrupt) {
          output().warning(`integrity failures: missing=${counts.missing}, corrupt=${counts.corrupt}`);
        }
      },
      onError: () => output().warning("integrity scan failed; investigate storage"),
    });
    const server = startServer({
      owner: new OwnerOperations(database, filesystem),
      adminAssets: options.adminAssets ?? adminAssets,
      filesystem,
      catalog: new ObjectCatalogRepository(database),
      revisions: new RevisionRepository(database),
       bootstrap: new BootstrapRepository(database),
       vaults: new VaultRepository(database),
      authentication,
      maintenance,
      authorizeBootstrap,
      config,
    });
    // Cleanup is mandatory even when an integrity scan fails. Each pass is single-flight.
    let cleanupFlight: Promise<void> | undefined;
    const cleanup = () => {
      if (!cleanupFlight) cleanupFlight = maintenance.cleanupDeleted()
        .catch(() => output().warning("vault deletion cleanup failed; will retry"))
        .finally(() => { cleanupFlight = undefined; });
    };
    cleanup();
    const cleanupTimer = setInterval(cleanup, 1_000);
    scanner.start();
    return {
      url: server.url.href,
      stop: async () => {
        clearInterval(cleanupTimer);
        try {
          await server.stop(true);
          await cleanupFlight;
          await scanner.stop();
        } finally { database.close(); }
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

export const localOwner = { origin: "server-local", actorId: null } as const;
export async function withLocalOwner<T>(directory: string, operation: (owner: OwnerMetadataOperations) => T | Promise<T>): Promise<T> {
  const root = privateDirectory(directory);
  // Administration must not silently initialize a mistyped server directory.
  secureRead(join(root, "pepper.hex"), 64);
  const db = new ServerMetadataDatabase(join(root, "metadata.sqlite"));
  try {
    return await operation(new OwnerMetadataOperations(db));
  } finally { db.close(); }
}
