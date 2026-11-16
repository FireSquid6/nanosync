import { timingSafeEqual, randomUUID } from "node:crypto";
import { join } from "node:path";
import { createServerConfig, startServer, AuthenticationService, PeriodicIntegrityScanner, ServerMaintenance, Argon2idPasswordHasher } from "@nanosync/server-core";
import { AuthenticationRepository, BootstrapRepository, MaintenanceRepository, ObjectCatalogRepository, RevisionRepository, ServerMetadataDatabase, VaultRepository } from "@nanosync/server-metadata";
import { LocalFilesystem } from "@nanosync/server-object-storage";
import { privateDirectory, provisionSecret, secureRead } from "./security.ts";

export interface RunServerOptions { directory: string; host?: string; port?: number; acknowledgeExposure?: boolean; scanIntervalMs?: number }
export async function initializeServerOwner(directory: string, password: string): Promise<void> {
  if (!password || Buffer.byteLength(password) > 1024) throw new Error("password must be 1..1024 bytes");
  const root = privateDirectory(directory), bytes = new TextEncoder().encode(password);
  const database = new ServerMetadataDatabase(join(root, "metadata.sqlite"));
  try {
    const verifier = await new Argon2idPasswordHasher().hash(bytes);
    new BootstrapRepository(database).initializeOwner(randomUUID(), verifier, Date.now());
  } finally { bytes.fill(0); database.close(); }
}
/** The server's private metadata directory is the administrative authority. */
export function approveLocalDevice(directory: string, name: string): string {
  const root = privateDirectory(directory), db = new ServerMetadataDatabase(join(root, "metadata.sqlite"));
  try {
    const auth = new AuthenticationRepository(db);
    const matches = auth.listPending(Date.now()).filter(item => item.displayName === name);
    if (matches.length !== 1) throw new Error("pending device name is unavailable or ambiguous");
    auth.approve(null, matches[0]!.deviceId, Date.now());
    return matches[0]!.deviceId;
  } finally { db.close(); }
}
export function localDevices(directory: string) {
  const db = new ServerMetadataDatabase(join(privateDirectory(directory), "metadata.sqlite"));
  try { return new AuthenticationRepository(db).listDevices(); } finally { db.close(); }
}
export function revokeLocalDevice(directory: string, name: string): string {
  const root = privateDirectory(directory), db = new ServerMetadataDatabase(join(root, "metadata.sqlite"));
  try {
    const auth = new AuthenticationRepository(db);
    const matches = auth.listDevices().filter(item => item.state === "active" && (item.displayName === name || item.deviceId === name));
    if (matches.length !== 1) throw new Error("active device name is unavailable or ambiguous");
    auth.revoke(null, matches[0]!.deviceId, Date.now());
    return matches[0]!.deviceId;
  } finally { db.close(); }
}
export async function localAdminReport(directory: string, name: string): Promise<unknown> {
  const root = privateDirectory(directory), db = new ServerMetadataDatabase(join(root, "metadata.sqlite"));
  try {
    const maintenance = new ServerMaintenance(new MaintenanceRepository(db), new LocalFilesystem(join(root, "objects")));
    if (name === "storage") return maintenance.storageStatus();
    if (name === "retention-dry-run") return maintenance.retentionDryRun(Date.now());
    if (name === "gc-dry-run") return maintenance.gcDryRun(Date.now());
    if (name === "scan") return maintenance.scanBatch(Date.now());
    return { storage: maintenance.storageStatus(), retention: maintenance.retentionDryRun(Date.now()), gc: maintenance.gcDryRun(Date.now()) };
  } finally { db.close(); }
}
export async function runServer(options: RunServerOptions): Promise<{ stop(): Promise<void>; url: string }> {
  const directory = privateDirectory(options.directory);
  const config = createServerConfig({
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
          console.error(`integrity failures: missing=${counts.missing}, corrupt=${counts.corrupt}`);
        }
      },
      onError: () => console.error("integrity scan failed; investigate storage"),
    });
    const server = startServer({
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
        .catch(() => console.error("vault deletion cleanup failed; will retry"))
        .finally(() => { cleanupFlight = undefined; });
    };
    cleanup();
    const cleanupTimer = setInterval(cleanup, 1_000);
    scanner.start();
    return {
      url: server.url.href,
      stop: async () => {
        clearInterval(cleanupTimer);
        server.stop(true);
        await cleanupFlight;
        await scanner.stop();
        database.close();
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
