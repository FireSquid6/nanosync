import { Outlet, useLoaderData } from "react-router-dom";
import { ThemeControl } from "@nanosync/ui-theme/ThemeControl";
import { AdminProvider, useAdmin } from "./state/AdminContext";
import type { loadAdmin } from "./state/bootstrap";

export function App() {
  const initial = useLoaderData<typeof loadAdmin>();
  return <AdminProvider initial={initial}><AdminShell /></AdminProvider>;
}

function AdminShell() {
  const { error } = useAdmin();
  return (
    <main className="nv-root">
      <div className="admin">
        <header className="admin-header">
          <h1>Nanosync administration</h1>
          <ThemeControl />
        </header>
        <div className="admin-content nv-stack">
          {error && <p role="alert">{error}</p>}
          <Outlet />
        </div>
      </div>
    </main>
  );
}
