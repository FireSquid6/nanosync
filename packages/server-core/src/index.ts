import {
  CHUNK_SIZE, MAX_IDEMPOTENCY_KEY_LENGTH, MAX_JSON_METADATA_BYTES, MAX_PAGE_SIZE, MAX_PARENTS,
  MAX_PRESENCE_QUERY, MAX_REFERENCES_PER_REVISION, OBJECT_FORMAT_VERSION, OBJECT_TYPES,
  PROTOCOL_VERSION, REVISION_FORMAT_VERSION, parseDeviceId, parsePrincipalId, parseVaultId,
} from "@nanosync/protocol";
import { ObjectCatalogRepository } from "@nanosync/server-metadata";
import type { Filesystem } from "@nanosync/server-object-storage";
import { createServerConfig, type ServerConfig } from "./config.ts";
import { ApiError, errorResponse, json } from "./http.ts";
import { handleObjectRoute } from "./object-routes.ts";
import { ObjectService, type AuthorizationContext } from "./object-service.ts";

export * from "./config.ts";
export * from "./http.ts";
export * from "./object-service.ts";

export interface RawAuthorizationContext { principalId: unknown; deviceId: unknown; vaultId: unknown; }
export type Authorize = (request: Request) => Promise<RawAuthorizationContext>;
export interface ServerDependencies {
  filesystem: Filesystem;
  catalog: ObjectCatalogRepository;
  authorize: Authorize;
  config?: ServerConfig;
  clock?: () => number;
}

export function createServerHandler(dependencies: ServerDependencies): (request: Request) => Promise<Response> {
  const config = dependencies.config ?? createServerConfig();
  const service = new ObjectService({ filesystem: dependencies.filesystem, catalog: dependencies.catalog, maximumObjectSize: config.maximumObjectSize, clock: dependencies.clock });
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url); const pathname = url.pathname;
      if (pathname === "/v1/capabilities") {
        if (request.method !== "GET") throw new ApiError(405, "MALFORMED_REQUEST", "Method is not supported for this route", { allow: "GET" });
        return json({
          protocolVersions: [PROTOCOL_VERSION], revisionFormatVersions: [REVISION_FORMAT_VERSION], objectFormatVersions: [OBJECT_FORMAT_VERSION], objectTypes: [...OBJECT_TYPES],
          limits: {
            maximumObjectCiphertextBytes: config.maximumObjectSize, maximumReferencesPerRevision: MAX_REFERENCES_PER_REVISION,
            maximumParents: MAX_PARENTS, maximumPresenceQuery: MAX_PRESENCE_QUERY, maximumPageSize: MAX_PAGE_SIZE,
            maximumJsonMetadataBytes: MAX_JSON_METADATA_BYTES, maximumIdempotencyKeyLength: MAX_IDEMPOTENCY_KEY_LENGTH, chunkSizeBytes: CHUNK_SIZE,
          },
        });
      }
      if (pathname === "/v1/health") {
        if (request.method !== "GET") throw new ApiError(405, "MALFORMED_REQUEST", "Method is not supported for this route", { allow: "GET" });
        try { dependencies.catalog.ping(); await dependencies.filesystem.existsBatch([]); }
        catch { throw new ApiError(503, "UNAVAILABLE", "Service is not ready"); }
        return json({ protocolVersion: PROTOCOL_VERSION, status: "ok" });
      }
      if (pathname === "/v1/objects" || pathname.startsWith("/v1/objects/")) {
        const context = await authorize(dependencies.authorize, request);
        return await handleObjectRoute(request, pathname, context, service);
      }
      throw new ApiError(404, "NOT_FOUND", "Route not found");
    } catch (error) { return errorResponse(error); }
  };
}

async function authorize(authorizer: Authorize | undefined, request: Request): Promise<AuthorizationContext> {
  if (typeof authorizer !== "function") throw new ApiError(401, "UNAUTHORIZED", "Authorization is required");
  try {
    const raw = await authorizer(request);
    return {
      principalId: parsePrincipalId(raw?.principalId, "authorization.principalId"),
      deviceId: parseDeviceId(raw?.deviceId, "authorization.deviceId"),
      vaultId: parseVaultId(raw?.vaultId, "authorization.vaultId"),
    };
  } catch { throw new ApiError(401, "UNAUTHORIZED", "Authorization is required"); }
}

export function startServer(dependencies: ServerDependencies): ReturnType<typeof Bun.serve> {
  const config = dependencies.config ?? createServerConfig();
  return Bun.serve({ hostname: config.hostname, port: config.port, fetch: createServerHandler({ ...dependencies, config }) });
}
