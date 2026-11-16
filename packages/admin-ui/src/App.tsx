import { Outlet, useLoaderData } from "react-router-dom";
import { AdminProvider, useAdmin } from "./state/AdminContext";
import type { loadAdmin } from "./state/bootstrap";

export function App() {
  const initial = useLoaderData<typeof loadAdmin>();
  return <AdminProvider initial={initial}><AdminShell /></AdminProvider>;
}

function AdminShell() {
  const { error } = useAdmin();
  return (
    <main className="nv-root" data-nv-theme="light">
      <div className="admin nv-stack">
        <h1>Nanosync administration</h1>
        {error && <p role="alert">{error}</p>}
        <Outlet />
      </div>
    </main>
  );
}
