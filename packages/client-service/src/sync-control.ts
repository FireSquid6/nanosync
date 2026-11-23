import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { privateDirectory, secureCreate, secureRead, secureReplace } from "./security.ts";
import { inspectSyncOwner } from "./sync-lock.ts";

export type SyncOwner = "Desktop" | "CLI";
export interface OwnerStatus {
  owner: SyncOwner;
  status: "Not checked" | "Syncing" | "Up to date" | "Conflicts" | "Failed";
  progress: string | null;
  error: string | null;
  lastSync: string | null;
  sequence: number | null;
  conflicts: number;
}
interface Endpoint {
  version: 1;
  pid: number;
  starttime: string;
  port: number;
  capability: string;
  owner: SyncOwner;
}
const filename = "sync-control.json";

/** Called only after the runner acquires the existing replica ownership lock. */
export function publishControl(root: string, owner: SyncOwner, handlers: {
  status(): OwnerStatus;
  sync(): Promise<{ revisionId: string; sequence: number }>;
}) {
  privateDirectory(root);
  const identity = inspectSyncOwner(root);
  if (identity?.pid !== process.pid) throw new Error("Sync control requires the replica ownership lock");
  const capability = randomBytes(32).toString("hex");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: 128,
    async fetch(request) {
      const supplied = Buffer.from(request.headers.get("authorization") ?? "");
      const expected = Buffer.from(`Bearer ${capability}`);
      if (request.headers.has("origin") || supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (request.method !== "POST" || new URL(request.url).pathname !== "/")
        return new Response("Not found", { status: 404 });
      try {
        const body: unknown = await request.json();
        if (!body || typeof body !== "object" || Object.keys(body).length !== 1 || !("operation" in body))
          return new Response("Invalid request", { status: 400 });
        if (body.operation === "status") return Response.json(handlers.status());
        if (body.operation === "sync") return Response.json(await handlers.sync());
        return new Response("Invalid operation", { status: 400 });
      } catch {
        // Never serialize engine errors: upstream responses can contain credentials or paths.
        return Response.json({ error: "The active owner could not complete synchronization." }, { status: 409 });
      }
    },
  });
  const endpoint: Endpoint = { version: 1, ...identity, port: server.port!, capability, owner };
  const path = join(root, filename);
  try {
    if (existsSync(path)) secureReplace(path, JSON.stringify(endpoint));
    else secureCreate(path, JSON.stringify(endpoint));
  } catch (error) { void server.stop(true); throw error; }
  return {
    async stop() {
      // An old owner's cleanup must never delete a replacement owner's endpoint.
      try {
        if (existsSync(path) && secureRead(path).toString("utf8") === JSON.stringify(endpoint)) unlinkSync(path);
      } finally { await server.stop(true); }
    },
  };
}

export function ownerEndpoint(root: string): (Endpoint & { root: string }) | null {
  const path = join(root, filename);
  if (!existsSync(path)) return null;
  const value = JSON.parse(secureRead(path).toString("utf8")) as Endpoint;
  if (value.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid < 1 ||
    !/^\d+$/.test(value.starttime) || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535 ||
    !/^[a-f0-9]{64}$/.test(value.capability) || !["Desktop", "CLI"].includes(value.owner))
    throw new Error("Invalid sync owner endpoint");
  const owner = inspectSyncOwner(root);
  return owner?.pid === value.pid && owner.starttime === value.starttime ? { ...value, root } : null;
}

export async function requestOwner<T>(endpoint: Endpoint & { root: string }, operation: "status" | "sync", signal?: AbortSignal): Promise<T> {
  const verify = () => {
    const current = ownerEndpoint(endpoint.root);
    if (!current || current.pid !== endpoint.pid || current.starttime !== endpoint.starttime ||
      current.port !== endpoint.port || current.capability !== endpoint.capability)
      throw new Error("Sync owner changed; refresh and retry. No competing sync was started.");
  };
  verify();
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${endpoint.capability}`, "Content-Type": "application/json" },
    body: JSON.stringify({ operation }),
    signal: signal ?? (operation === "status" ? AbortSignal.timeout(5_000) : undefined),
    redirect: "error",
  });
  if (!response.ok) throw new Error("The active sync owner is unavailable or rejected the request. No competing sync was started.");
  const value = await response.json() as T;
  verify();
  return value;
}
