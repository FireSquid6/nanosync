import { expect, test } from "bun:test";
import { RemoteError } from "@nanosync/sync-core";
import { CommandError, exitCode, failureState, type SyncState } from "../src/index.ts";

test("stable status exit codes never treat incomplete or uncertain as success", () => {
  const cases: Record<SyncState, number> = {
    synchronized: 0, local_changes_pending: 4, uploading: 4, downloading: 4, syncing: 4,
    paused: 4, offline: 5, conflict_blocked: 8, auth_required: 3,
    capacity_incomplete: 7, integrity_failure: 6, remote_only: 4, unknown: 2,
  };
  for (const [state, code] of Object.entries(cases)) expect(exitCode(state as SyncState)).toBe(code);
});

test("error classification uses typed codes rather than error messages", () => {
  expect(failureState(new RemoteError(401, "UNAUTHORIZED", "whatever"))).toBe("auth_required");
  expect(failureState(new RemoteError(403, "FORBIDDEN", "whatever"))).toBe("auth_required");
  expect(failureState(new RemoteError(503, "UNAVAILABLE", "whatever"))).toBe("offline");
  expect(failureState(new RemoteError(409, "CONFLICT", "whatever"))).toBe("conflict_blocked");
  expect(failureState(new RemoteError(400, "CHECKSUM_MISMATCH", "whatever"))).toBe("integrity_failure");
  expect(failureState(new RemoteError(413, "OBJECT_LIMIT_EXCEEDED", "whatever"))).toBe("capacity_incomplete");
  expect(failureState(Object.assign(new Error("write failed"), { code: "ENOSPC" }))).toBe("capacity_incomplete");
  expect(failureState(new CommandError("anything", "conflict_blocked"))).toBe("conflict_blocked");
  expect(failureState(new Error("unauthorized offline ENOSPC checksum conflict"))).toBe("unknown");
});
