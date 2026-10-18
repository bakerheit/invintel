import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router";
import "./index.css";
import { AppShell } from "./components/app-shell";
import { FloorLayout } from "./components/floor/floor-layout";
import { OrgGate } from "./components/org-gate";
import { ConfirmProvider } from "./components/confirm";
import { Toaster } from "./components/ui/sonner";
import { TooltipProvider } from "./components/ui/tooltip";
import { queryClient } from "./lib/query";
import { ThemeProvider } from "./lib/theme";
import ActivityPage from "./pages/activity";
import AuditPage from "./pages/audit";
import LabelsPage from "./pages/labels";
import FloorHome from "./pages/floor/home";
import LookupPage from "./pages/floor/lookup";
import MovePage from "./pages/floor/move";
import ProductionFloorPage from "./pages/floor/production";
import ProductionPage from "./pages/production";
import QualityFloorPage from "./pages/floor/quality";
import QualityPage from "./pages/quality";
import ReceivePage from "./pages/floor/receive";
import InventoryPage from "./pages/inventory";
import ItemDetailPage from "./pages/item-detail";
import OverviewPage from "./pages/overview";
import LocationsPage from "./pages/locations";
import LoginPage from "./pages/login";
import NewOrgPage from "./pages/new-org";
import OrgRedirect from "./pages/org-redirect";
import CountsPage from "./pages/counts";
import CountFloorPage from "./pages/floor/count";
import ReportsHome from "./pages/reports";
import AgingReportPage from "./pages/reports/aging";
import CountingReportPage from "./pages/reports/counting";
import ApprovalsPage from "./pages/approvals";
import DowntimeReportPage from "./pages/reports/downtime";
import TraceReportPage from "./pages/reports/trace";
import DowntimeFloorPage from "./pages/floor/downtime";
import AlertsPage from "./pages/alerts";
import PurchasingPage from "./pages/purchasing";
import RegisterPage from "./pages/register";
import SettingsPage from "./pages/settings";
import { useAuth } from "./stores/auth";

function RequireAuth() {
  const { user, status } = useAuth();
  const location = useLocation();
  if (status === "loading") {
    return <div className="flex min-h-svh items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  }
  if (!user) return <Navigate to="/login" state={{ from: location.pathname + location.search }} replace />;
  return <Outlet />;
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ConfirmProvider>
            <BrowserRouter>{children}</BrowserRouter>
            <Toaster closeButton />
          </ConfirmProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

void useAuth.getState().init();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Providers>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route element={<RequireAuth />}>
          <Route path="/" element={<OrgRedirect />} />
          <Route path="/orgs/new" element={<NewOrgPage />} />
          <Route path="/o/:orgId" element={<OrgGate />}>
            <Route element={<AppShell />}>
              <Route index element={<OverviewPage />} />
              <Route path="inventory" element={<InventoryPage />} />
              <Route path="inventory/:itemId" element={<ItemDetailPage />} />
              <Route path="counts" element={<CountsPage />} />
              <Route path="alerts" element={<AlertsPage />} />
              <Route path="approvals" element={<ApprovalsPage />} />
              <Route path="reports" element={<ReportsHome />} />
              <Route path="reports/aging" element={<AgingReportPage />} />
              <Route path="reports/counting" element={<CountingReportPage />} />
              <Route path="reports/downtime" element={<DowntimeReportPage />} />
              <Route path="reports/trace" element={<TraceReportPage />} />
              <Route path="purchasing" element={<PurchasingPage />} />
              <Route path="activity" element={<ActivityPage />} />
              <Route path="audit" element={<AuditPage />} />
              <Route path="locations" element={<LocationsPage />} />
              <Route path="labels" element={<LabelsPage />} />
              <Route path="production" element={<ProductionPage />} />
              <Route path="quality" element={<QualityPage />} />
              <Route path="settings" element={<SettingsPage />} />
            </Route>
            <Route path="floor" element={<FloorLayout />}>
              <Route index element={<FloorHome />} />
              <Route path="receive" element={<ReceivePage />} />
              <Route path="move" element={<MovePage />} />
              <Route path="production" element={<ProductionFloorPage />} />
              <Route path="quality" element={<QualityFloorPage />} />
              <Route path="count" element={<CountFloorPage />} />
              <Route path="downtime" element={<DowntimeFloorPage />} />
              <Route path="lookup" element={<LookupPage />} />
            </Route>
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Providers>
  </StrictMode>,
);
