import { createBrowserRouter, Navigate } from "react-router-dom";
import { App } from "./App";
import { AdminLayout } from "./components/AdminLayout";
import { ActivityPage } from "./pages/ActivityPage";
import { ClientsPage } from "./pages/ClientsPage";
import { LoginPage } from "./pages/LoginPage";
import { VaultsPage } from "./pages/VaultsPage";
import { loadAdmin } from "./state/bootstrap";

export function createAdminRouter() {
  return createBrowserRouter([
    {
      path: "/",
      loader: loadAdmin,
      // Startup is loaded once; explicit login/refresh handlers own subsequent data updates.
      shouldRevalidate: () => false,
      element: <App />,
      hydrateFallbackElement: <p>Loading…</p>,
      children: [
        { path: "login", element: <LoginPage /> },
        {
          element: <AdminLayout />,
          children: [
            { index: true, element: <Navigate to="/clients" replace /> },
            { path: "clients", element: <ClientsPage /> },
            { path: "vaults", element: <VaultsPage /> },
            { path: "activity", element: <ActivityPage /> },
          ],
        },
        { path: "*", element: <p>Page not found.</p> },
      ],
    },
  ], { basename: "/admin" });
}
