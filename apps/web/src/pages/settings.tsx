import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Plus, RefreshCw } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm";
import { PageHeader } from "@/components/page-header";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { formatJoinCode, isAdmin, orgKey, orgsKey, useCurrentOrg } from "@/lib/org";
import { cn } from "@/lib/utils";

/** Label and explanation on the left, the controls on the right. Stacks on small screens. */
function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="grid gap-4 py-6 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] md:gap-10">
      <div className="space-y-1">
        <h2 className="font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div>{children}</div>
    </section>
  );
}

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";

function RenameForm({ orgId, name }: { orgId: string; name: string }) {
  const qc = useQueryClient();
  const rename = useMutation({
    mutationFn: (value: string) => api.renameOrg(orgId, { name: value }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: orgsKey });
      toast.success("Organization renamed");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    rename.mutate(String(new FormData(e.currentTarget).get("name")));
  };
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <div className="grid flex-1 gap-1.5">
        <Label htmlFor="org-name">Organization name</Label>
        <Input id="org-name" name="name" defaultValue={name} key={name} required maxLength={100} />
      </div>
      <Button type="submit" disabled={rename.isPending}>Save</Button>
    </form>
  );
}

function JoinCodeCard({ orgId, joinCode }: { orgId: string; joinCode: string }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [copied, setCopied] = useState(false);
  const rotate = useMutation({
    mutationFn: () => api.rotateJoinCode(orgId),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: orgsKey });
      toast.success("New join code generated");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(formatJoinCode(joinCode));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy. Select the code and copy it by hand.");
    }
  };
  const regenerate = async () => {
    const ok = await confirm({
      title: "Generate a new join code?",
      description: "The current code stops working straight away. People already in the organization aren't affected.",
      confirmLabel: "Generate new code",
    });
    if (ok) rotate.mutate();
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex h-11 flex-1 items-center gap-3 rounded-lg border bg-muted/40 px-4 sm:flex-none">
          <KeyRound className="size-4 text-muted-foreground" />
          <code aria-label="Join code" className="font-mono text-lg font-semibold tracking-[0.2em]">
            {formatJoinCode(joinCode)}
          </code>
        </div>
        <Button variant="outline" size="lg" className="h-11" onClick={() => void copy()}>
          {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
        </Button>
        <Button variant="ghost" size="lg" className="h-11" disabled={rotate.isPending} onClick={() => void regenerate()}>
          <RefreshCw /> Generate new
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        New people choose "Join with a code" when they register, or use "Create or join another" if they already have an account.
      </p>
    </div>
  );
}

const ROLE_STYLE = {
  owner: "bg-accent text-accent-foreground",
  admin: "bg-accent text-accent-foreground",
  member: "bg-secondary text-secondary-foreground",
} as const;

export default function SettingsPage() {
  const org = useCurrentOrg();
  const admin = isAdmin(org.role);
  const members = useQuery({ queryKey: orgKey(org.id, "members"), queryFn: () => api.listMembers(org.id) });

  return (
    <>
      <PageHeader title="Settings" description={`Manage ${org.name} and the people in it.`} />
      <div className="divide-y">
        <Section title="General" description="The name your team sees in the sidebar.">
          {admin ? (
            <RenameForm orgId={org.id} name={org.name} />
          ) : (
            <div className="space-y-1">
              <p className="font-medium">{org.name}</p>
              <p className="text-sm text-muted-foreground">Only admins can rename the organization.</p>
            </div>
          )}
        </Section>

        <Section title="Invite people" description="Share this code. Anyone who has it can join as a member.">
          {admin && org.joinCode ? (
            <JoinCodeCard orgId={org.id} joinCode={org.joinCode} />
          ) : (
            <p className="text-sm text-muted-foreground">Ask an admin for this organization's join code.</p>
          )}
        </Section>

        <Section title="Members" description={`${org.memberCount} ${org.memberCount === 1 ? "person has" : "people have"} access.`}>
          <Card className="gap-0 py-0">
            <CardContent className="divide-y p-0">
              {members.isLoading &&
                [0, 1].map((i) => (
                  <div key={i} className="flex items-center gap-3 p-4">
                    <Skeleton className="size-9 rounded-full" />
                    <div className="space-y-2">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-3 w-44" />
                    </div>
                  </div>
                ))}
              {members.data?.map((m) => (
                <div key={m.userId} className="flex items-center gap-3 p-4">
                  <Avatar className="size-9">
                    <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
                      {initials(m.name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{m.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{m.email}</p>
                  </div>
                  <Badge variant="secondary" className={cn("capitalize", ROLE_STYLE[m.role])}>{m.role}</Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        </Section>

        <Section title="Other organizations" description="Start another organization, or join one you've been invited to.">
          <Link to="/orgs/new" className={buttonVariants({ variant: "outline" })}>
            <Plus /> Create or join another
          </Link>
        </Section>
      </div>
    </>
  );
}
