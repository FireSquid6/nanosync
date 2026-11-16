import { createContext, useContext, useState, type ReactNode } from "react";
import { ApiError, request, type Activity, type Device, type Vault } from "../api";
import { loadAdminData, type AdminBootstrap } from "./bootstrap";

type AdminState = {
  authenticated: boolean;
  busy: boolean;
  error: string;
  clearError: () => void;
  devices: Device[];
  pending: Device[];
  vaults: Vault[];
  activity: Activity[];
  api: <T = unknown>(path: string, method?: string, body?: unknown) => Promise<T>;
  run: (work: () => Promise<void>) => Promise<void>;
  refresh: () => Promise<void>;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
};
const AdminContext = createContext<AdminState | null>(null);

export function AdminProvider({ children, initial }: { children: ReactNode; initial: AdminBootstrap }) {
  const [csrf, setCsrf] = useState(initial.csrf);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initial.error);
  const [devices, setDevices] = useState(initial.devices);
  const [pending, setPending] = useState(initial.pending);
  const [vaults, setVaults] = useState(initial.vaults);
  const [activity, setActivity] = useState(initial.activity);

  async function api<T = unknown>(path: string, method = "GET", body?: unknown, token = csrf) {
    try {
      return await request<T>(path, method, body, token);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setCsrf("");
      throw error;
    }
  }
  async function refresh(token = csrf) {
    try {
      const data = await loadAdminData(token);
      setDevices(data.devices);
      setPending(data.pending);
      setVaults(data.vaults);
      setActivity(data.activity);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setCsrf("");
      throw error;
    }
  }
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Operation failed");
    } finally {
      setBusy(false);
    }
  }
  async function login(password: string) {
    const session = await api<{ csrfToken: string }>("session", "POST", { password });
    await refresh(session.csrfToken);
    setCsrf(session.csrfToken);
  }
  async function logout() {
    await api("session", "DELETE");
    setCsrf("");
    setDevices([]);
    setPending([]);
    setVaults([]);
    setActivity([]);
  }
  return (
    <AdminContext.Provider value={{ authenticated: !!csrf, busy, error, clearError: () => setError(""), devices, pending, vaults, activity, api, run, refresh, login, logout }}>
      {children}
    </AdminContext.Provider>
  );
}

export function useAdmin() {
  const value = useContext(AdminContext);
  if (!value) throw new Error("Administration state is unavailable");
  return value;
}
