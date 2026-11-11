import { createHash } from "node:crypto";
import { parseObjectFrameHeader, parsePersistedRevisionEnvelope, parseRecoveryWrap, parseVaultId } from "@nanosync/protocol";
import { VaultRepository } from "@nanosync/server-metadata";
import type { Filesystem } from "@nanosync/server-object-storage";
import { AuthenticationService } from "./auth-service.ts";
import { ApiError, json, readStrictJson } from "./http.ts";
import { objectKey } from "./object-service.ts";

export async function handleVaultRoute(request: Request, pathname: string, auth: AuthenticationService,
  repository: VaultRepository, storage: Filesystem, clock: () => number): Promise<Response> {
  const actor = auth.authorize(request);
  if (pathname === "/v1/vaults" && request.method === "GET") return json({ protocolVersion: 1, vaults: repository.list() });
  if (pathname === "/v1/vaults" && request.method === "POST") {
    const input = await readStrictJson(request, 16_384) as Record<string, unknown>;
    if (!input || Object.keys(input).sort().join() !== "frame,genesisRevision,name,recoveryWrap,vaultId")
      throw new ApiError(400, "MALFORMED_REQUEST", "Invalid vault creation request");
    try {
      const vaultId = parseVaultId(input.vaultId), genesis = parsePersistedRevisionEnvelope(input.genesisRevision);
      const wrap = parseRecoveryWrap(input.recoveryWrap);
      if (genesis.creatingDeviceId !== actor.deviceId || typeof input.frame !== "string" || input.frame.length > 12_000 ||
          !/^[A-Za-z0-9_-]+$/.test(input.frame)) throw new Error();
      const frame = Buffer.from(input.frame, "base64url");
      if (frame.toString("base64url") !== input.frame || frame.length > 8192) throw new Error();
      const header = parseObjectFrameHeader(frame.subarray(0, 80));
      const reference = genesis.references[0];
      const checksum = createHash("sha256").update(frame).digest("hex");
      if (!reference || genesis.references.length !== 1 || header.vaultId !== vaultId || header.objectType !== "manifest" ||
          header.objectId !== reference.objectId || header.completeLength !== frame.length || checksum !== reference.ciphertextChecksum)
        throw new Error();
      // Write immutable ciphertext first. A conflicting metadata transaction
      // can leave only an unreferenced object in this vault's namespace.
      await storage.putIfAbsent(objectKey("manifest", reference.objectId, vaultId), new ReadableStream({
        start(controller) { controller.enqueue(frame); controller.close(); },
      }), checksum);
      repository.create(vaultId, input.name as string, wrap, genesis,
        { objectId: reference.objectId, checksum, length: frame.length }, clock());
      return json({ protocolVersion: 1, vaultId, name: input.name, sequence: 1 }, 201);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof Error && /already in use|vault ID/.test(error.message)) throw new ApiError(409, "CONFLICT", error.message);
      throw new ApiError(400, "MALFORMED_REQUEST", "Invalid vault creation request");
    }
  }
  const rename = /^\/v1\/vaults\/([^/]+)\/rename$/.exec(pathname);
  if (rename && request.method === "POST") {
    const input = await readStrictJson(request, 512) as Record<string, unknown>;
    if (!input || Object.keys(input).join() !== "name") throw new ApiError(400, "MALFORMED_REQUEST", "Invalid vault name");
    try { repository.rename(parseVaultId(rename[1]), input.name as string); }
    catch (error) {
      if (error instanceof Error && /already in use/.test(error.message)) throw new ApiError(409, "CONFLICT", error.message);
      throw new ApiError(400, "MALFORMED_REQUEST", "Invalid vault name or ID");
    }
    return json({ protocolVersion: 1, vaultId: rename[1], name: input.name });
  }
  throw new ApiError(405, "MALFORMED_REQUEST", "Method is not supported");
}
