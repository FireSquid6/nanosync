export type Device = {
  deviceId: string;
  displayName: string;
  platform: string;
  clientVersion: string;
  state: string;
  verificationCode?: string;
  requestedAtMs: number;
};
export type Vault = { vaultId: string; name: string };
export type Activity = {
  sequence: number;
  action: string;
  origin: string;
  targetId: string;
  occurredAtMs: number;
};

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
  token = "",
): Promise<T> {
  const response = await fetch("/admin/api/" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Nanosync-CSRF": token || "login",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw new ApiError(result.message ?? `Request failed (${response.status})`, response.status);
  return result as T;
}
