import { ProtocolValidationError, parseBootstrapCompleteRequest, parseBootstrapInitializeRequest } from "@nanosync/protocol";
import { ApiError, readStrictJson } from "./http.ts";
import { BootstrapService } from "./bootstrap-service.ts";

export async function readBootstrapInitialize(request: Request, service: BootstrapService): Promise<Response> {
  requireJson(request);
  try { return await service.initialize(parseBootstrapInitializeRequest(await readStrictJson(request, BootstrapService.maximumBodyBytes))); }
  catch (error) { throw parseError(error); }
}
export async function readBootstrapComplete(request: Request, service: BootstrapService): Promise<Response> {
  requireJson(request);
  try { return await service.complete(parseBootstrapCompleteRequest(await readStrictJson(request, BootstrapService.maximumBodyBytes))); }
  catch (error) { throw parseError(error); }
}
function requireJson(request: Request): void {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) throw new ApiError(400, "MALFORMED_REQUEST", "Content-Type must be application/json");
}
function parseError(error: unknown): unknown {
  if (error instanceof ProtocolValidationError) {
    const code = error.code === "UNSUPPORTED_VERSION"
      ? (error.path === "request.protocolVersion" ? "UNSUPPORTED_PROTOCOL_VERSION" : "UNSUPPORTED_FORMAT_VERSION")
      : error.code === "LIMIT_EXCEEDED" ? "BODY_LIMIT_EXCEEDED" : "MALFORMED_REQUEST";
    return new ApiError(code === "BODY_LIMIT_EXCEEDED" ? 413 : 400, code, "Bootstrap request is invalid");
  }
  return error;
}
