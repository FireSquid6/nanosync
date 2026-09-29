import { MAX_JSON_METADATA_BYTES, MAX_BOOTSTRAP_PASSWORD_BYTES, PROTOCOL_VERSION, type BootstrapCompleteRequest, type BootstrapInitializeRequest } from "@nanosync/protocol";
import { BootstrapRepository, BootstrapRepositoryError } from "@nanosync/server-metadata";
import type { Filesystem } from "@nanosync/server-object-storage";
import { ApiError, json } from "./http.ts";
import type { PasswordHasher } from "./password-hasher.ts";
import { verifyReferenceStorage } from "./revision-service.ts";
import type { AuthorizationContext } from "./object-service.ts";

export class BootstrapService {
  constructor(private readonly repository: BootstrapRepository, private readonly filesystem: Filesystem, private readonly hasher: PasswordHasher, private readonly clock: () => number = Date.now) {}
  status(): Response { return json({ protocolVersion: PROTOCOL_VERSION, status: this.repository.status() }); }
  context(): AuthorizationContext {
    const state = this.repository.state();
    if (!state || state.lifecycle !== "initialized") throw new ApiError(403, "FORBIDDEN", "Bootstrap mutation is unavailable");
    return { principalId: state.principal_id, deviceId: state.initial_device_id, vaultId: state.vault_id };
  }
  async initialize(input: BootstrapInitializeRequest): Promise<Response> {
    if (this.repository.status() !== "uninitialized") throw new ApiError(409, "CONFLICT", "Bootstrap is already initialized");
    const password = new TextEncoder().encode(input.password);
    if (password.byteLength < 1 || password.byteLength > MAX_BOOTSTRAP_PASSWORD_BYTES) throw new ApiError(400, "MALFORMED_REQUEST", "Bootstrap request is invalid");
    try {
      const verifier = await this.hasher.hash(password);
      this.repository.initialize(input, verifier, this.clock());
    } catch (error) { this.map(error); }
    finally { password.fill(0); }
    return json({ protocolVersion: PROTOCOL_VERSION, status: "initializedWithoutHead" }, 201);
  }
  async complete(input: BootstrapCompleteRequest): Promise<Response> {
    const state = this.repository.state();
    if (!state || state.lifecycle !== "initialized") throw new ApiError(403, "FORBIDDEN", "Bootstrap mutation is unavailable");
    if (input.vaultId !== state.vault_id || input.genesisRevision.creatingDeviceId !== state.initial_device_id) throw new ApiError(409, "CONFLICT", "Genesis revision is invalid");
    const missing = new Set(this.repository.missingCatalogReferences(input.vaultId, input.genesisRevision));
    const candidates = input.genesisRevision.references.filter((ref) => !missing.has(ref.objectId));
    for (const id of await verifyReferenceStorage(this.filesystem, candidates)) missing.add(id);
    if (missing.size) return json({ protocolVersion: PROTOCOL_VERSION, status: "missingObjects", objectIds: [...missing].sort() });
    try { this.repository.complete(input.vaultId, input.genesisRevision, this.clock()); }
    catch (error) { this.map(error); }
    return json({ protocolVersion: PROTOCOL_VERSION, status: "accepted", revisionId: input.genesisRevision.revisionId, sequence: 1 });
  }
  private map(error: unknown): never {
    if (error instanceof BootstrapRepositoryError && error.code === "CONFLICT") throw new ApiError(409, "CONFLICT", "Bootstrap mutation conflicts with server state");
    throw error;
  }
  static readonly maximumBodyBytes = MAX_JSON_METADATA_BYTES;
}
