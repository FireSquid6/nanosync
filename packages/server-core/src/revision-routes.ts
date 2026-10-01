import {
  ProtocolValidationError, parseAdvanceHeadRequest, parseRevisionId,
  type RevisionId,
} from "@nanosync/protocol";
import { ApiError, readStrictJson } from "./http.ts";
import type { AuthorizationContext } from "./object-service.ts";
import { RevisionService } from "./revision-service.ts";

export async function handleRevisionRoute(
  request: Request,
  pathname: string,
  context: AuthorizationContext,
  service: RevisionService,
): Promise<Response> {
  if (pathname === "/v1/head") {
    if (request.method !== "GET") throw method("GET");
    return service.head(context);
  }
  if (pathname === "/v1/head/advance") {
    if (request.method !== "POST") throw method("POST");
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
      throw new ApiError(400, "MALFORMED_REQUEST", "Content-Type must be application/json");
    }
    try {
      const parsed = parseAdvanceHeadRequest(await readStrictJson(request, RevisionService.maximumBodyBytes));
      return await service.advance(context, parsed);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof ProtocolValidationError) {
        const code = error.code === "UNSUPPORTED_VERSION"
          ? (error.path.endsWith("protocolVersion") ? "UNSUPPORTED_PROTOCOL_VERSION" : "UNSUPPORTED_FORMAT_VERSION")
          : error.code === "LIMIT_EXCEEDED" && error.path.endsWith("references") ? "REFERENCE_LIMIT_EXCEEDED" : "MALFORMED_REQUEST";
        throw new ApiError(code === "REFERENCE_LIMIT_EXCEEDED" ? 413 : 400, code, "Advance-head request is invalid");
      }
      throw error;
    }
  }
  const match = /^\/v1\/revisions\/([^/]+)$/.exec(pathname);
  if (match) {
    if (request.method !== "GET") throw method("GET");
    let revisionId: RevisionId;
    try {
      revisionId = parseRevisionId(match[1], "path.revisionId");
    } catch {
      throw new ApiError(400, "MALFORMED_REQUEST", "Revision route parameter is invalid");
    }
    return service.revision(context, revisionId);
  }
  throw new ApiError(404, "NOT_FOUND", "Route not found");
}

function method(allow: string): ApiError {
  return new ApiError(405, "MALFORMED_REQUEST", "Method is not supported for this route", { allow });
}
