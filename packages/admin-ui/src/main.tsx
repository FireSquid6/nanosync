import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { createAdminRouter } from "./router";
import "./paper/styles.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <RouterProvider router={createAdminRouter()} />,
);
