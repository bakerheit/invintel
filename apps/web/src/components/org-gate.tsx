import { useEffect } from "react";
import { Navigate, Outlet, useParams } from "react-router";
import { Skeleton } from "@/components/ui/skeleton";
import { setLastOrg } from "@/lib/last-org";
import { useOrgs } from "@/lib/org";

/** Makes sure the org in the URL is one you belong to. Everything below can call useCurrentOrg(). */
export function OrgGate() {
  const { orgId } = useParams();
  const orgs = useOrgs();
  const org = orgs.data?.find((o) => o.id === orgId);

  useEffect(() => {
    if (org) setLastOrg(org.id);
  }, [org]);

  if (orgs.isLoading) {
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
  if (orgs.error) return <p className="p-6 text-destructive">Couldn't load your organizations: {orgs.error.message}</p>;
  // Unknown or no-longer-yours org: let "/" pick one you do belong to.
  if (!org) return <Navigate to="/" replace />;
  return <Outlet />;
}
