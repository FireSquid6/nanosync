import { RemoteError } from "@nanosync/sync-core";
import { parseAuthToken } from "@nanosync/protocol";
export function baseUrl(url: string): string {
  const address = /^https?:\/\//.test(url) ? url :
    /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(url) ? `http://${url}` : `https://${url}`;
  const parsed = new URL(address);
  if (
    !/^(http:|https:)$/.test(parsed.protocol) || parsed.username || parsed.password ||
    parsed.search || parsed.hash
  ) {
    throw new Error("invalid server URL");
  }
  if (
    parsed.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
  ) {
    throw new Error("HTTP is permitted only for loopback; use HTTPS for remote servers");
  }
  return parsed.href.replace(/\/$/, "");
}
export async function api(url: string, path: string, init: RequestInit = {}, token?: string, bootstrapProof?: string): Promise<any> {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (bootstrapProof) headers.set("x-nanosync-bootstrap-authorization", bootstrapProof);
  if (init.body && !headers.has("content-type") && !(init.body instanceof Uint8Array)) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${baseUrl(url)}${path}`, { ...init, headers });
  const result = await response.json() as Record<string, any>;
  if (!response.ok) throw new RemoteError(response.status, String(result.code ?? "ERROR"), `server ${response.status}: ${String(result.code ?? "ERROR")}`);
  return result;
}
export async function login(url: string, password: string): Promise<string> {
  const result = await api(url, "/v1/auth/password", { method: "POST", body: JSON.stringify({ protocolVersion: 1, password }) });
  return parseAuthToken(result.sessionToken);
}
