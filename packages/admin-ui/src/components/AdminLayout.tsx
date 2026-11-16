import { useCallback } from "react";
import { Navigate, NavLink, Outlet, useLocation } from "react-router-dom";
import { Button } from "../paper/Button";
import { useAdmin } from "../state/AdminContext";
import { CreationProvider } from "../state/CreationContext";

export function AdminLayout() {
  const { authenticated } = useAdmin();
  const location = useLocation();
  if (!authenticated) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <CreationProvider><AuthenticatedLayout /></CreationProvider>;
}

function AuthenticatedLayout() {
  const { busy, refresh, logout, run } = useAdmin();
  const { pathname } = useLocation();
  const focusPage = useCallback((element: HTMLDivElement | null) => {
    element?.focus();
  }, [pathname]);
  const page = pathname === "/vaults" ? "Vaults" : pathname === "/activity" ? "Activity" : "Clients";
  return <>
    <title>{`${page} · Nanosync administration`}</title>
    <div className="admin-toolbar">
      <nav className="admin-navigation" aria-label="Administration">
        <NavLink to="/clients">Clients</NavLink>
        <NavLink to="/vaults">Vaults</NavLink>
        <NavLink to="/activity">Activity</NavLink>
      </nav>
      <div className="nv-actions">
        <Button disabled={busy} onClick={() => void run(refresh)}>Refresh</Button>
        <Button disabled={busy} onClick={() => void run(logout)}>Log out</Button>
      </div>
    </div>
    <div className="nv-stack admin-page" tabIndex={-1} ref={focusPage}>
      <Outlet />
    </div>
  </>;
}
