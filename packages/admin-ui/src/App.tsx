import { Navigate, Route, Routes } from "react-router-dom";
import { AdminLayout } from "./components/AdminLayout";
import { ActivityPage } from "./pages/ActivityPage";
import { ClientsPage } from "./pages/ClientsPage";
import { LoginPage } from "./pages/LoginPage";
import { VaultsPage } from "./pages/VaultsPage";
import { AdminProvider, useAdmin } from "./state/AdminContext";

export function App() {
  return <AdminProvider><AdminRoutes /></AdminProvider>;
}

function AdminRoutes() {
  const { error } = useAdmin();
  return (
    <main className="nv-root" data-nv-theme="light">
      <div className="admin nv-stack">
        <h1>Nanosync administration</h1>
        {error && <p role="alert">{error}</p>}
        <Routes>
          <Route path="login" element={<LoginPage />} />
          <Route element={<AdminLayout />}>
            <Route index element={<Navigate to="/clients" replace />} />
            <Route path="clients" element={<ClientsPage />} />
            <Route path="vaults" element={<VaultsPage />} />
            <Route path="activity" element={<ActivityPage />} />
          </Route>
          <Route path="*" element={<p>Page not found.</p>} />
        </Routes>
      </div>
    </main>
  );
}
