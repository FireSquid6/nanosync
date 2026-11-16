import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ApiError, request, type Activity, type Device, type Vault } from "../api";

type AdminState = {
  ready: boolean;
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

export function AdminProvider({ children }: { children: ReactNode }) {
  const [csrf, setCsrf] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [devices, setDevices] = useState<Device[]>([]);
  const [pending, setPending] = useState<Device[]>([]);
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);

  async function api<T = unknown>(path: string, method = "GET", body?: unknown, token = csrf) {
    try {
      return await request<T>(path, method, body, token);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setCsrf("");
      throw error;
    }
  }
  async function refresh(token = csrf) {
    const [d, v, a] = await Promise.all([
      api<{ devices: Device[]; enrollments: Device[] }>("devices", "GET", undefined, token),
      api<{ vaults: Vault[] }>("vaults", "GET", undefined, token),
      api<{ activity: Activity[] }>("activity", "GET", undefined, token),
    ]);
    setDevices(d.devices);
    setPending(d.enrollments);
    setVaults(v.vaults);
    setActivity(a.activity);
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
  useEffect(() => {
    void run(async () => {
      try {
        const session = await api<{ csrfToken: string }>("session");
        await refresh(session.csrfToken);
        setCsrf(session.csrfToken);
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 401)) throw error;
      } finally {
        setReady(true);
      }
    });
  }, []);

  return (
    <AdminContext.Provider value={{ ready, authenticated: !!csrf, busy, error, clearError: () => setError(""), devices, pending, vaults, activity, api, run, refresh, login, logout }}>
      {children}
    </AdminContext.Provider>
  );
}

export function useAdmin() {
  const value = useContext(AdminContext);
  if (!value) throw new Error("Administration state is unavailable");
  return value;
}
