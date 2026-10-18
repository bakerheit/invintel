import { ArrowLeft } from "lucide-react";
import { Link, Outlet, useLocation } from "react-router";
import { useCurrentOrg } from "@/lib/org";
import { useAuth } from "@/stores/auth";

/** Full-screen layout for the plant floor: no sidebar, big targets, always shows who and where. */
export function FloorLayout() {
  const org = useCurrentOrg();
  const user = useAuth((s) => s.user);
  const { pathname } = useLocation();
  const home = `/o/${org.id}/floor`;
  const atHome = pathname.replace(/\/$/, "") === home;

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="flex h-16 shrink-0 items-center gap-3 border-b px-3">
        <Link
          to={atHome ? `/o/${org.id}` : home}
          className="flex h-12 items-center gap-2 rounded-lg px-3 text-base font-medium hover:bg-muted"
        >
          <ArrowLeft className="size-5" />
          {atHome ? "Desk view" : "Back"}
        </Link>
        <div className="ml-auto min-w-0 text-right">
          <p className="truncate text-sm font-medium">{org.name}</p>
          <p className="truncate text-xs text-muted-foreground">{user?.name}</p>
        </div>
      </header>
      <main className="mx-auto w-full max-w-xl flex-1 space-y-6 p-4 pb-10">
        <Outlet />
      </main>
    </div>
  );
}
