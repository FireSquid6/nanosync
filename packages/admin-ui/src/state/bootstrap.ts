import { ApiError, request, type Activity, type Device, type Vault } from "../api";

export type AdminData = {
  devices: Device[];
  pending: Device[];
  vaults: Vault[];
  activity: Activity[];
};
export type AdminBootstrap = AdminData & { csrf: string; error: string };

export async function loadAdminData(token: string): Promise<AdminData> {
  const [devices, vaults, activity] = await Promise.all([
    request<{ devices: Device[]; enrollments: Device[] }>("devices", "GET", undefined, token),
    request<{ vaults: Vault[] }>("vaults", "GET", undefined, token),
    request<{ activity: Activity[] }>("activity", "GET", undefined, token),
  ]);
  return {
    devices: devices.devices,
    pending: devices.enrollments,
    vaults: vaults.vaults,
    activity: activity.activity,
  };
}

/** The router completes startup before mounting session-dependent UI. */
export async function loadAdmin(): Promise<AdminBootstrap> {
  try {
    const session = await request<{ csrfToken: string }>("session");
    return { ...await loadAdminData(session.csrfToken), csrf: session.csrfToken, error: "" };
  } catch (error) {
    return {
      csrf: "",
      error: error instanceof ApiError && error.status === 401
        ? ""
        : error instanceof Error ? error.message : "Operation failed",
      devices: [],
      pending: [],
      vaults: [],
      activity: [],
    };
  }
}
