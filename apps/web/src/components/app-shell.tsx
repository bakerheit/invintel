import { useEffect } from "react";
import { Navigate, Outlet, useLocation, useParams } from "react-router";
import { AppSidebar, navItems } from "@/components/app-sidebar";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { setLastOrg } from "@/lib/last-org";
import { useOrgs } from "@/lib/org";

function ShellSkeleton() {
  return (
    <div className="flex min-h-svh">
      <div className="hidden w-64 shrink-0 space-y-4 p-4 md:block">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
      <div className="flex-1 space-y-6 p-8">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );
}

export function AppShell() {
  const { orgId } = useParams();
  const { pathname } = useLocation();
  const orgs = useOrgs();
  const org = orgs.data?.find((o) => o.id === orgId);

  useEffect(() => {
    if (org) setLastOrg(org.id);
  }, [org]);

  if (orgs.isLoading) return <ShellSkeleton />;
  if (orgs.error) return <p className="p-6 text-destructive">Couldn't load your organizations: {orgs.error.message}</p>;
  // Unknown or no-longer-yours org: let "/" pick one you do belong to.
  if (!org) return <Navigate to="/" replace />;

  const page = navItems(org.id).find((n) => (n.end ? pathname === n.to : pathname.startsWith(n.to)));

  return (
    <SidebarProvider>
      <AppSidebar org={org} orgs={orgs.data!} />
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 rounded-t-xl border-b bg-background/80 px-4 backdrop-blur">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 h-4 data-vertical:self-center" />
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">{org.name}</span>
            {page && (
              <>
                <span className="text-muted-foreground/50">/</span>
                <span className="font-medium">{page.label}</span>
              </>
            )}
          </div>
        </header>
        <div className="mx-auto w-full max-w-6xl flex-1 space-y-6 p-4 md:p-8">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
