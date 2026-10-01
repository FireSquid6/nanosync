import { PROTOCOL_VERSION } from "@nanosync/protocol";
import type { AuthenticationService } from "./auth-service.ts";
import type { ServerMaintenance } from "./maintenance.ts";
import { ApiError, json } from "./http.ts";

/** Reports contain aggregates only; no credentials, object IDs or vault metadata. */
export function adminMaintenanceRoutes(
  authentication: AuthenticationService,
  maintenance: ServerMaintenance,
  clock: () => number,
) {
  let scanning = false;
  let cursor = "";
  return async (request: Request, pathname: string, search: string): Promise<Response> => {
    const scan = pathname === "/v1/admin/integrity/scan";
    if (request.method !== (scan ? "POST" : "GET")) {
      throw new ApiError(
        405,
        "MALFORMED_REQUEST",
        "Method is not supported for this route",
        { allow: scan ? "POST" : "GET" },
      );
    }
    authentication.requireAdmin(request);
    if (search) throw new ApiError(400, "MALFORMED_REQUEST", "Query parameters are not supported");
    if (request.body) throw new ApiError(400, "MALFORMED_REQUEST", "Maintenance requests do not accept a body");
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new ApiError(503, "UNAVAILABLE", "Maintenance clock is unavailable");
    }
    const headers = { "cache-control": "no-store" };
    if (pathname === "/v1/admin/storage") {
      return json({ protocolVersion: PROTOCOL_VERSION, ...maintenance.storageStatus() }, 200, headers);
    }
    if (pathname === "/v1/admin/retention/dry-run") {
      try {
        return json({ protocolVersion: PROTOCOL_VERSION, ...maintenance.retentionDryRun(now) }, 200, headers);
      } catch (error) {
        if (error instanceof RangeError) {
          throw new ApiError(503, "UNAVAILABLE", "Retention report exceeds revision limit");
        }
        throw error;
      }
    }
    if (pathname === "/v1/admin/gc/dry-run") {
      return json({ protocolVersion: PROTOCOL_VERSION, ...maintenance.gcDryRun(now) }, 200, headers);
    }
    if (pathname === "/v1/admin/diagnostics") {
      try {
        return json({
          protocolVersion: PROTOCOL_VERSION,
          storage: maintenance.storageStatus(),
          retention: maintenance.retentionDryRun(now),
          gc: maintenance.gcDryRun(now),
        }, 200, headers);
      } catch (error) {
        if (error instanceof RangeError) {
          throw new ApiError(503, "UNAVAILABLE", "Retention report exceeds revision limit");
        }
        throw error;
      }
    }
    if (scan) {
      if (scanning) throw new ApiError(409, "CONFLICT", "Integrity scan is already running");
      scanning = true;
      try {
        // One bounded catalog page, never a full scan in a live HTTP request.
        const batch = await maintenance.scanBatch(now, cursor, 100);
        cursor = batch.done ? "" : batch.cursor;
        return json({ protocolVersion: PROTOCOL_VERSION, limit: 100, done: batch.done, counts: batch.counts }, 200, headers);
      } finally {
        scanning = false;
      }
    }
    throw new ApiError(404, "NOT_FOUND", "Route not found");
  };
}
