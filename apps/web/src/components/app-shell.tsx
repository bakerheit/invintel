import { Outlet, useLocation } from "react-router";
import { AppSidebar, navItems } from "@/components/app-sidebar";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { useCurrentOrg, useOrgs } from "@/lib/org";

/** Desk layout: sidebar, breadcrumb bar, page content. Rendered below OrgGate. */
export function AppShell() {
  const org = useCurrentOrg();
  const { data: orgs = [] } = useOrgs();
  const { pathname } = useLocation();
  const page = navItems(org.id).find((n) => (n.end ? pathname === n.to : pathname.startsWith(n.to)));

  return (
    <SidebarProvider>
      <AppSidebar org={org} orgs={orgs} />
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
