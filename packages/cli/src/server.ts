import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { createServerConfig, startServer, AuthenticationService, PeriodicIntegrityScanner, ServerMaintenance } from "@nanosync/server-core";
import { AuthenticationRepository, BootstrapRepository, MaintenanceRepository, ObjectCatalogRepository, RevisionRepository, ServerMetadataDatabase } from "@nanosync/server-metadata";
import { LocalFilesystem } from "@nanosync/server-object-storage";
import { privateDirectory, provisionSecret, secureRead } from "./security.ts";

export interface RunServerOptions { directory: string; host?: string; port?: number; acknowledgeExposure?: boolean; scanIntervalMs?: number }
export async function runServer(options: RunServerOptions): Promise<{ stop(): Promise<void>; url: string }> {
  const directory = privateDirectory(options.directory);
  const config = createServerConfig({ hostname: options.host, port: options.port,
    acknowledgeInsecureNonLoopback: options.acknowledgeExposure, metadataDatabasePath: join(directory, "metadata.sqlite"), objectStoragePath: join(directory, "objects") });
  // The pepper is NEVER generated implicitly: losing it invalidates every bearer token.
  const pepper = secureRead(join(directory, "pepper.hex"), 64).toString("utf8");
  if (!/^[0-9a-f]{64}$/.test(pepper)) throw new Error("pepper.hex must contain exactly 32 bytes as lowercase hex");
  const bootstrapProof = provisionSecret(join(directory, "bootstrap.hex"));
  const database = new ServerMetadataDatabase(config.metadataDatabasePath);
  try {
    const filesystem = new LocalFilesystem(config.objectStoragePath, { maximumObjectSize: config.maximumObjectSize });
    await filesystem.existsBatch([]);
    const authentication = new AuthenticationService(new AuthenticationRepository(database), { pepper: Buffer.from(pepper, "hex") });
    const authorizeBootstrap = async (request: Request) => {
      const supplied = request.headers.get("x-nanosync-bootstrap-authorization");
      return !!supplied && supplied.length === bootstrapProof.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(bootstrapProof));
    };
    const maintenance = new ServerMaintenance(new MaintenanceRepository(database), filesystem);
    const scanner = new PeriodicIntegrityScanner(maintenance, { intervalMs: options.scanIntervalMs ?? 60_000, batchSize: 100,
      onBatch: counts => { if (counts.missing || counts.corrupt) console.error(`integrity failures: missing=${counts.missing}, corrupt=${counts.corrupt}`); },
      onError: () => console.error("integrity scan failed; investigate storage") });
    const server = startServer({ filesystem, catalog: new ObjectCatalogRepository(database), revisions: new RevisionRepository(database),
      bootstrap: new BootstrapRepository(database), authentication, authorizeBootstrap, config });
    scanner.start();
    return { url: server.url.href, stop: async () => { server.stop(true); await scanner.stop(); database.close(); } };
  } catch (error) { database.close(); throw error; }
}
