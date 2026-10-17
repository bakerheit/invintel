import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router";
import { AuthLayout } from "@/components/auth-layout";
import { initialOrgChoice, OrgChoice } from "@/components/org-choice";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { setLastOrg } from "@/lib/last-org";
import { refreshOrgs, useOrgs } from "@/lib/org";
import { useAuth } from "@/stores/auth";

export default function NewOrgPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { data: orgs } = useOrgs();
  const [org, setOrg] = useState(initialOrgChoice);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const joined = org.mode === "create"
        ? await api.createOrg({ name: org.name })
        : await api.joinOrg({ joinCode: org.joinCode });
      await refreshOrgs(qc);
      setLastOrg(joined.id);
      navigate(`/o/${joined.id}`, { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setPending(false);
    }
  };

  const hasOrgs = !!orgs?.length;

  return (
    <AuthLayout
      title={hasOrgs ? "Add an organization" : "Set up your organization"}
      description={
        hasOrgs
          ? "Create another organization, or join one with a code."
          : `Welcome${user ? `, ${user.name}` : ""}. Create an organization or join one with a code to get started.`
      }
    >
      <form onSubmit={onSubmit} className="grid gap-4">
        <OrgChoice value={org} onChange={setOrg} idPrefix="neworg" />
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={pending}>
          {pending ? "Working…" : org.mode === "create" ? "Create organization" : "Join organization"}
        </Button>
        {hasOrgs ? (
          <Link to="/" className="text-center text-sm text-muted-foreground underline">Cancel</Link>
        ) : (
          <button type="button" onClick={() => void logout()} className="text-sm text-muted-foreground underline">
            Sign out
          </button>
        )}
      </form>
    </AuthLayout>
  );
}
