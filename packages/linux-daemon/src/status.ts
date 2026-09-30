import { IntegrityError, RemoteError } from "@nanosync/sync-core";

export type SyncState = "synchronized" | "local_changes_pending" | "uploading" | "downloading" | "syncing" | "paused" |
  "offline" | "conflict_blocked" | "auth_required" | "capacity_incomplete" | "integrity_failure" | "remote_only" | "unknown";
export type FailureState = Extract<SyncState, "offline" | "conflict_blocked" | "auth_required" | "capacity_incomplete" | "integrity_failure">;

export class CommandError extends Error {
  constructor(message: string, readonly state: FailureState | "unknown") { super(message); this.name = "CommandError"; }
}

export function failureState(error: unknown): FailureState | "unknown" {
  if (error instanceof CommandError) return error.state;
  if (error instanceof IntegrityError) return "integrity_failure";
  if (error instanceof RemoteError) {
    if (error.status === 401 || error.status === 403 || error.code === "UNAUTHORIZED" || error.code === "FORBIDDEN") return "auth_required";
    if (error.code === "UNAVAILABLE" || error.status === 503) return "offline";
    if (error.code === "CONFLICT" || error.code === "STALE_HEAD") return "conflict_blocked";
    if (error.code === "CHECKSUM_MISMATCH" || error.code === "LENGTH_MISMATCH") return "integrity_failure";
    if (error.code === "OBJECT_LIMIT_EXCEEDED" || error.code === "REFERENCE_LIMIT_EXCEEDED") return "capacity_incomplete";
  }
  if (error instanceof TypeError) return "offline";
  if (error && typeof error === "object" && "code" in error) {
    if (error.code === "ENOSPC" || error.code === "EDQUOT") return "capacity_incomplete";
    if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "EAI_AGAIN"].includes(String(error.code))) return "offline";
  }
  return "unknown";
}

export function exitCode(state: SyncState): number {
  switch (state) {
    case "synchronized": return 0;
    case "auth_required": return 3;
    case "offline": return 5;
    case "integrity_failure": return 6;
    case "capacity_incomplete": return 7;
    case "conflict_blocked": return 8;
    case "unknown": return 2;
    default: return 4;
  }
}
