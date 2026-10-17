import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router";
import "./index.css";
import { AppShell } from "./components/app-shell";
import { queryClient } from "./lib/query";
import InventoryPage from "./pages/inventory";
import LocationsPage from "./pages/locations";
import LoginPage from "./pages/login";
import NewOrgPage from "./pages/new-org";
import OrgRedirect from "./pages/org-redirect";
import RegisterPage from "./pages/register";
import SettingsPage from "./pages/settings";
import { useAuth } from "./stores/auth";

function RequireAuth() {
  const { user, status } = useAuth();
  const location = useLocation();
  if (status === "loading") return <p className="p-6 text-muted-foreground">Loading…</p>;
  if (!user) return <Navigate to="/login" state={{ from: location.pathname + location.search }} replace />;
  return <Outlet />;
}

void useAuth.getState().init();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route element={<RequireAuth />}>
            <Route path="/" element={<OrgRedirect />} />
            <Route path="/orgs/new" element={<NewOrgPage />} />
            <Route path="/o/:orgId" element={<AppShell />}>
              <Route index element={<InventoryPage />} />
              <Route path="locations" element={<LocationsPage />} />
              <Route path="settings" element={<SettingsPage />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
