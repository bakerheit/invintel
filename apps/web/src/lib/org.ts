import type { OrgRole, OrgSummary } from "@invintel/shared";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { api } from "@/lib/api";

export const orgsKey = ["orgs"] as const;
export const orgKey = (orgId: string, ...rest: string[]) => ["orgs", orgId, ...rest] as const;

export const useOrgs = () => useQuery({ queryKey: orgsKey, queryFn: api.listOrgs });

/** The organization in the URL. Only call this below the /o/:orgId route. */
export function useCurrentOrg(): OrgSummary {
  const { orgId } = useParams();
  const { data } = useOrgs();
  const org = data?.find((o) => o.id === orgId);
  if (!org) throw new Error("useCurrentOrg called outside a known organization");
  return org;
}

export const isAdmin = (role: OrgRole) => role === "owner" || role === "admin";

export const useLocations = (orgId: string) =>
  useQuery({ queryKey: orgKey(orgId, "locations"), queryFn: () => api.listLocations(orgId) });

export const formatJoinCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

/** Reload the org list and wait for it, so a route that needs the new org doesn't bounce off stale data. */
export const refreshOrgs = (qc: QueryClient) =>
  qc.fetchQuery({ queryKey: orgsKey, queryFn: api.listOrgs, staleTime: 0 });

/** Stock changes touch items, location totals and history, so refetch everything for the org. */
export const invalidateOrg = (qc: QueryClient, orgId: string) =>
  qc.invalidateQueries({ queryKey: orgKey(orgId) });
