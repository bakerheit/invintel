import { useEffect } from "react";
import { Navigate, NavLink, Outlet, useNavigate, useParams } from "react-router";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { setLastOrg } from "@/lib/last-org";
import { useOrgs } from "@/lib/org";
import { cn } from "@/lib/utils";
import { useAuth } from "@/stores/auth";

const NEW_ORG = "__new__";

const navClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
    isActive ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
  );

export function AppShell() {
  const { orgId } = useParams();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const orgs = useOrgs();
  const org = orgs.data?.find((o) => o.id === orgId);

  useEffect(() => {
    if (org) setLastOrg(org.id);
  }, [org]);

  if (orgs.isLoading) return <p className="p-6 text-muted-foreground">Loading…</p>;
  if (orgs.error) return <p className="p-6 text-destructive">Couldn't load your organizations: {orgs.error.message}</p>;
  // Unknown or no-longer-yours org: let "/" pick one you do belong to.
  if (!org) return <Navigate to="/" replace />;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-4">
          <span className="text-xl font-semibold">Invintel</span>
          <Select
            value={org.id}
            items={[
              ...orgs.data!.map((o) => ({ value: o.id, label: o.name })),
              { value: NEW_ORG, label: "Create or join another…" },
            ]}
            onValueChange={(v) => v && navigate(v === NEW_ORG ? "/orgs/new" : `/o/${v}`)}
          >
            <SelectTrigger className="w-52" aria-label="Organization">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {orgs.data!.map((o) => (
                <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>
              ))}
              <SelectSeparator />
              <SelectItem value={NEW_ORG}>Create or join another…</SelectItem>
            </SelectContent>
          </Select>
          <nav className="flex items-center gap-1" aria-label="Main">
            <NavLink to={`/o/${org.id}`} end className={navClass}>Inventory</NavLink>
            <NavLink to={`/o/${org.id}/locations`} className={navClass}>Locations</NavLink>
            <NavLink to={`/o/${org.id}/settings`} className={navClass}>Settings</NavLink>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">{user?.name}</span>
          <Button variant="outline" onClick={() => void logout()}>Sign out</Button>
        </div>
      </header>
      <Outlet />
    </div>
  );
}
