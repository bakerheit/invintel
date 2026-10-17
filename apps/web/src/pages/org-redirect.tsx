import { Navigate } from "react-router";
import { getLastOrg } from "@/lib/last-org";
import { useOrgs } from "@/lib/org";

/** "/" sends you to the org you were last in, else your first one, else to set one up. */
export default function OrgRedirect() {
  const { data, isLoading, error } = useOrgs();
  if (isLoading) return <p className="p-6 text-muted-foreground">Loading…</p>;
  if (error) return <p className="p-6 text-destructive">Couldn't load your organizations: {error.message}</p>;
  if (!data?.length) return <Navigate to="/orgs/new" replace />;
  const last = getLastOrg();
  const target = data.find((o) => o.id === last) ?? data[0]!;
  return <Navigate to={`/o/${target.id}`} replace />;
}
