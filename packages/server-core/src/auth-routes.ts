import {
  INITIAL_DEVICE_AUTHORIZATION_HEADER, MAX_INITIAL_DEVICE_AUTHORIZATION_BYTES, ProtocolValidationError, parseDeviceActionRequest, parseDeviceId,
  parseEnrollmentCreateRequest, parsePasswordAuthenticationRequest,
} from "@nanosync/protocol";
import { AuthenticationService, bearer, mapAuthRepositoryError } from "./auth-service.ts";
import { ApiError, readStrictJson } from "./http.ts";
import type { AuthorizeBootstrap } from "./index.ts";

export async function handleAuthRoute(request: Request, pathname: string, service: AuthenticationService, authorizeBootstrap?: AuthorizeBootstrap): Promise<Response> {
  try {
    if (pathname === "/v1/auth/password") {
      method(request, "POST"); requireJson(request);
      const input = parsePasswordAuthenticationRequest(await readStrictJson(request, 2048));
      return await service.login(input.password);
    }
    if (pathname === "/v1/auth/enrollments") {
      method(request, "POST"); const token = bearer(request); requireJson(request);
      const input = parseEnrollmentCreateRequest(await readStrictJson(request, 2048));
      const initialAuthorizationVerified = service.initialAuthorizationRequired(token, input.deviceId) ? await authorizeInitialDevice(authorizeBootstrap, request) : false;
      return service.createEnrollment(token, input, initialAuthorizationVerified);
    }
    if (pathname === "/v1/auth/enrollments/status") { method(request, "GET"); return service.enrollmentStatus(bearer(request)); }
    if (pathname === "/v1/admin/enrollments") { method(request, "GET"); return service.pending(request); }
    if (pathname === "/v1/admin/devices") { method(request, "GET"); return service.devices(request); }
    if (pathname === "/v1/recovery-wrap") { method(request, "GET"); return service.recovery(request); }
    let match = /^\/v1\/admin\/enrollments\/([^/]+)\/approve$/.exec(pathname);
    if (match) { method(request, "POST"); service.requireAdmin(request); requireJson(request); parseDeviceActionRequest(await readStrictJson(request, 128)); return service.approve(request, parseDeviceId(match[1], "deviceId")); }
    match = /^\/v1\/admin\/devices\/([^/]+)\/revoke$/.exec(pathname);
    if (match) { method(request, "POST"); service.requireAdmin(request); requireJson(request); parseDeviceActionRequest(await readStrictJson(request, 128)); return service.revoke(request, parseDeviceId(match[1], "deviceId")); }
    throw new ApiError(404, "NOT_FOUND", "Route not found");
  } catch (error) {
    if (error instanceof ProtocolValidationError) throw new ApiError(400, error.code === "UNSUPPORTED_VERSION" ? "UNSUPPORTED_PROTOCOL_VERSION" : "MALFORMED_REQUEST", "Authentication request is invalid");
    mapAuthRepositoryError(error);
  }
}
function requireJson(request: Request): void { if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) throw new ApiError(400, "MALFORMED_REQUEST", "Content-Type must be application/json"); }
function method(request: Request, expected: string): void { if (request.method !== expected) throw new ApiError(405, "MALFORMED_REQUEST", "Method is not supported for this route", { allow: expected }); }
async function authorizeInitialDevice(authorizer: AuthorizeBootstrap | undefined, request: Request): Promise<true> {
  const proof = request.headers.get(INITIAL_DEVICE_AUTHORIZATION_HEADER);
  if (!proof || proof.length > MAX_INITIAL_DEVICE_AUTHORIZATION_BYTES || !/^[\x21-\x7e]+$/.test(proof) || proof.includes(",") || typeof authorizer !== "function") throw new ApiError(401, "UNAUTHORIZED", "Initial device authorization is required");
  const headers = new Headers(request.headers); headers.delete("authorization"); headers.delete("content-length");
  const authorizationRequest = new Request(request.url, { method: request.method, headers });
  try { if (await authorizer(authorizationRequest) !== true) throw new Error(); }
  catch { throw new ApiError(401, "UNAUTHORIZED", "Initial device authorization is required"); }
  return true;
}
