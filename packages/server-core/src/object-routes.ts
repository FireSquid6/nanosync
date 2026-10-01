import {
  MAX_PRESENCE_QUERY, ProtocolValidationError, parseObjectId, parseObjectType, parsePresenceRequest,
  type ObjectId, type ObjectType,
} from "@nanosync/protocol";
import { ApiError, readStrictJson } from "./http.ts";
import { ObjectService, type AuthorizationContext } from "./object-service.ts";

const PRESENCE_BODY_LIMIT = 128 * 1024;

export async function handleObjectRoute(
  request: Request,
  pathname: string,
  context: AuthorizationContext,
  service: ObjectService,
): Promise<Response> {
  if (pathname === "/v1/objects/presence") {
    if (request.method !== "POST") {
      throw new ApiError(405, "MALFORMED_REQUEST", "Method is not supported for this route", { allow: "POST" });
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
      throw new ApiError(400, "MALFORMED_REQUEST", "Content-Type must be application/json");
    }
    let parsed;
    try {
      parsed = parsePresenceRequest(await readStrictJson(request, PRESENCE_BODY_LIMIT));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof ProtocolValidationError) {
        const code = error.code === "UNSUPPORTED_VERSION"
          ? "UNSUPPORTED_PROTOCOL_VERSION"
          : error.code === "LIMIT_EXCEEDED" && error.path.endsWith("objectIds")
            ? "BODY_LIMIT_EXCEEDED"
            : "MALFORMED_REQUEST";
        throw new ApiError(code === "BODY_LIMIT_EXCEEDED" ? 413 : 400, code, "Presence request is invalid");
      }
      throw error;
    }
    if (parsed.objectIds.length > MAX_PRESENCE_QUERY) {
      throw new ApiError(413, "BODY_LIMIT_EXCEEDED", "Presence request exceeds the item limit");
    }
    return service.presence(context, parsed.objectType, parsed.objectIds);
  }
  const match = /^\/v1\/objects\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (!match) throw new ApiError(404, "NOT_FOUND", "Route not found");
  let objectType: ObjectType;
  let objectId: ObjectId;
  try {
    objectType = parseObjectType(match[1], "path.objectType");
    objectId = parseObjectId(match[2], "path.objectId");
  } catch {
    throw new ApiError(400, "MALFORMED_REQUEST", "Object route parameters are invalid");
  }
  if (request.method === "PUT") return service.put(request, context, objectType, objectId);
  if (request.method === "GET") return service.get(request, context, objectType, objectId);
  throw new ApiError(
    405,
    "MALFORMED_REQUEST",
    "Method is not supported for this route",
    { allow: "GET, PUT" },
  );
}
