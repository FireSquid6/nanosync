import {
  CHUNK_SIZE, MAX_IDEMPOTENCY_KEY_LENGTH, MAX_JSON_METADATA_BYTES, MAX_PAGE_SIZE, MAX_PARENTS,
  MAX_PRESENCE_QUERY, MAX_REFERENCES_PER_REVISION, OBJECT_FORMAT_VERSION, OBJECT_TYPES,
  PROTOCOL_VERSION, REVISION_FORMAT_VERSION, parseDeviceId, parsePrincipalId, parseVaultId,
} from "@nanosync/protocol";
import { BootstrapRepository, ObjectCatalogRepository, RevisionRepository } from "@nanosync/server-metadata";
import type { Filesystem } from "@nanosync/server-object-storage";
import { createServerConfig, type ServerConfig } from "./config.ts";
import { ApiError, errorResponse, json } from "./http.ts";
import { handleObjectRoute } from "./object-routes.ts";
import { ObjectService, type AuthorizationContext } from "./object-service.ts";
import { handleRevisionRoute } from "./revision-routes.ts";
import { RevisionService } from "./revision-service.ts";
import { BootstrapService } from "./bootstrap-service.ts";
import { readBootstrapComplete, readBootstrapInitialize } from "./bootstrap-routes.ts";
import { Argon2idPasswordHasher, type PasswordHasher } from "./password-hasher.ts";
import { AuthenticationService } from "./auth-service.ts";
import { handleAuthRoute } from "./auth-routes.ts";

export * from "./config.ts";
export * from "./http.ts";
export * from "./object-service.ts";
export * from "./revision-service.ts";
export * from "./bootstrap-service.ts";
export * from "./password-hasher.ts";
export * from "./auth-service.ts";
export * from "./maintenance.ts";

export interface RawAuthorizationContext { principalId: unknown; deviceId: unknown; vaultId: unknown; }
export type Authorize = (request: Request) => Promise<RawAuthorizationContext>;
export type AuthorizeBootstrap = (request: Request) => Promise<boolean>;
export interface ServerDependencies {
  filesystem: Filesystem;
  catalog: ObjectCatalogRepository;
  revisions: RevisionRepository;
  authorize?: Authorize;
  authentication?: AuthenticationService;
  bootstrap?: BootstrapRepository;
  authorizeBootstrap?: AuthorizeBootstrap;
  passwordHasher?: PasswordHasher;
  config?: ServerConfig;
  clock?: () => number;
}

export function createServerHandler(dependencies: ServerDependencies): (request: Request) => Promise<Response> {
  if (dependencies.authentication && dependencies.authorize) throw new TypeError("Configure concrete authentication or an injected test authorizer, not both");
  const config = dependencies.config ?? createServerConfig();
  const service = new ObjectService({ filesystem: dependencies.filesystem, catalog: dependencies.catalog, maximumObjectSize: config.maximumObjectSize, clock: dependencies.clock });
  const revisionService = new RevisionService({ filesystem: dependencies.filesystem, revisions: dependencies.revisions, clock: dependencies.clock });
  const bootstrapService = dependencies.bootstrap ? new BootstrapService(dependencies.bootstrap, dependencies.filesystem, dependencies.passwordHasher ?? new Argon2idPasswordHasher(), dependencies.clock) : null;
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
      if (pathname === "/v1/bootstrap/status") {
        if (request.method !== "GET") throw new ApiError(405, "MALFORMED_REQUEST", "Method is not supported for this route", { allow: "GET" });
        if (!bootstrapService) throw new ApiError(503, "UNAVAILABLE", "Bootstrap service is unavailable");
        return bootstrapService.status();
      }
      if (pathname.startsWith("/v1/auth/") || pathname.startsWith("/v1/admin/") || pathname === "/v1/recovery-wrap") {
        if (!dependencies.authentication) throw new ApiError(503, "UNAVAILABLE", "Authentication service is unavailable");
        return await handleAuthRoute(request, pathname, dependencies.authentication, dependencies.authorizeBootstrap);
      }
      if (pathname === "/v1/bootstrap/initialize") {
        if (request.method !== "POST") throw new ApiError(405, "MALFORMED_REQUEST", "Method is not supported for this route", { allow: "POST" });
        await bootstrapAuthorize(dependencies.authorizeBootstrap, request);
        if (!bootstrapService) throw new ApiError(503, "UNAVAILABLE", "Bootstrap service is unavailable");
        return await readBootstrapInitialize(request, bootstrapService);
      }
      if (pathname === "/v1/bootstrap/complete") {
        if (request.method !== "POST") throw new ApiError(405, "MALFORMED_REQUEST", "Method is not supported for this route", { allow: "POST" });
        await bootstrapAuthorize(dependencies.authorizeBootstrap, request);
        if (!bootstrapService) throw new ApiError(503, "UNAVAILABLE", "Bootstrap service is unavailable");
        return await readBootstrapComplete(request, bootstrapService);
      }
      const bootstrapObject = /^\/v1\/bootstrap\/objects\/([^/]+)\/([^/]+)$/.exec(pathname);
      if (bootstrapObject) {
        if (request.method !== "PUT") throw new ApiError(405, "MALFORMED_REQUEST", "Method is not supported for this route", { allow: "PUT" });
        await bootstrapAuthorize(dependencies.authorizeBootstrap, request);
        if (!bootstrapService) throw new ApiError(503, "UNAVAILABLE", "Bootstrap service is unavailable");
        return handleObjectRoute(request, `/v1/objects/${bootstrapObject[1]}/${bootstrapObject[2]}`, bootstrapService.context(), service);
      }
      if (pathname === "/v1/objects" || pathname.startsWith("/v1/objects/")) {
        const context = await authorizeRequest(dependencies, request);
        return await handleObjectRoute(request, pathname, context, service);
      }
      if (pathname === "/v1/head" || pathname.startsWith("/v1/head/") || pathname === "/v1/revisions" || pathname.startsWith("/v1/revisions/")) {
        const context = await authorizeRequest(dependencies, request);
        return await handleRevisionRoute(request, pathname, context, revisionService);
      }
      throw new ApiError(404, "NOT_FOUND", "Route not found");
    } catch (error) { return errorResponse(error); }
  };
}

async function authorizeRequest(dependencies: ServerDependencies, request: Request): Promise<AuthorizationContext> {
  if (dependencies.authentication) {
    const identity = dependencies.authentication.authorize(request);
    return { principalId: identity.principalId, deviceId: identity.deviceId, vaultId: identity.vaultId };
  }
  return authorize(dependencies.authorize, request);
}

async function bootstrapAuthorize(authorizer: AuthorizeBootstrap | undefined, request: Request): Promise<void> {
  if (typeof authorizer !== "function") throw new ApiError(401, "UNAUTHORIZED", "Bootstrap authorization is required");
  try { if (await authorizer(request) !== true) throw new Error(); }
  catch { throw new ApiError(401, "UNAUTHORIZED", "Bootstrap authorization is required"); }
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
