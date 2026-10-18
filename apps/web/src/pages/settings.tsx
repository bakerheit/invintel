import type { OrgMember, OrgModules, OrgSummary } from "@invintel/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, LogOut, MoreHorizontal, Plus, RefreshCw, ShieldCheck, ShieldOff, UserMinus } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm";
import { PageHeader } from "@/components/page-header";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArchiveCard } from "@/components/archive-card";
import { ApiKeysCard, WebhooksCard } from "@/components/integrations";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useAuth } from "@/stores/auth";
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

function FeaturesForm({ org }: { org: OrgSummary }) {
  const qc = useQueryClient();
  const set = useMutation({
    mutationFn: (m: Partial<OrgModules>) => api.setModules(org.id, m),
    onSuccess: () => qc.invalidateQueries({ queryKey: orgsKey }),
    onError: (e: Error) => toast.error(e.message),
  });
  const rows = [
    ["purchasing", "Purchasing", "Suppliers, purchase orders and reorder suggestions."],
    ["production", "Production", "Work centers, bills of materials and work orders, with their Floor mode tile."],
  ] as const;
  return (
    <div className="space-y-3">
      {rows.map(([key, label, hint]) => (
        <label key={key} className="flex items-start gap-3 rounded-lg border p-3">
          <input type="checkbox" className="mt-1 size-4" checked={org.modules[key]} disabled={set.isPending} onChange={(e) => set.mutate({ [key]: e.target.checked })} />
          <span>
            <span className="block text-sm font-medium">{label}</span>
            <span className="block text-sm text-muted-foreground">{hint}</span>
          </span>
        </label>
      ))}
      <p className="text-xs text-muted-foreground">Switching one off only hides it. Nothing is deleted, and turning it back on brings everything back.</p>
    </div>
  );
}

function ApprovalRulesForm({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const rules = useQuery({ queryKey: orgKey(orgId, "approval-rules"), queryFn: () => api.approvalRules(orgId) });
  const [draft, setDraft] = useState<Record<string, { on: boolean; dollars: string; appliesTo: "members" | "everyone" }> | null>(null);
  const kinds = [
    ["adjustment", "Stock adjustments", "A change to stock worth at least this much waits for another admin."],
    ["purchase_order", "Purchase orders", "Placing an order worth at least this much waits for another admin."],
  ] as const;
  const state = draft ?? Object.fromEntries(kinds.map(([k]) => {
    const r = rules.data?.rules.find((x) => x.kind === k);
    return [k, { on: !!r, dollars: r ? String(r.thresholdCents / 100) : "100", appliesTo: r?.appliesTo ?? (k === "adjustment" ? "members" : "everyone") }];
  }));
  const save = useMutation({
    mutationFn: () => api.saveApprovalRules(orgId, kinds.flatMap(([k]) => (state[k]!.on ? [{ kind: k, thresholdCents: Math.round(Number(state[k]!.dollars || 0) * 100), appliesTo: state[k]!.appliesTo }] : []))),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: orgKey(orgId, "approval-rules") }); setDraft(null); toast.success("Approval rules saved"); },
    onError: (e: Error) => toast.error(e.message),
  });
  const set = (k: string, patch: Partial<{ on: boolean; dollars: string; appliesTo: "members" | "everyone" }>) => setDraft({ ...state, [k]: { ...state[k]!, ...patch } });
  return (
    <div className="space-y-3">
      {kinds.map(([k, label, hint]) => (
        <div key={k} className="space-y-2 rounded-lg border p-3">
          <label className="flex items-start gap-3">
            <input type="checkbox" className="mt-1 size-4" checked={state[k]!.on} onChange={(e) => set(k, { on: e.target.checked })} />
            <span><span className="block text-sm font-medium">{label}</span><span className="block text-sm text-muted-foreground">{hint}</span></span>
          </label>
          {state[k]!.on && (
            <div className="flex flex-wrap items-center gap-2 pl-7 text-sm">
              <span>From $</span>
              <Input aria-label={`${label} threshold in dollars`} className="h-8 w-28" type="number" min={0} step="0.01" value={state[k]!.dollars} onChange={(e) => set(k, { dollars: e.target.value })} />
              <span>for</span>
              <select aria-label={`${label} applies to`} className="h-8 rounded-md border bg-background px-2" value={state[k]!.appliesTo} onChange={(e) => set(k, { appliesTo: e.target.value as "members" | "everyone" })}>
                <option value="members">members only</option>
                <option value="everyone">everyone, admins too</option>
              </select>
            </div>
          )}
        </div>
      ))}
      <div className="flex items-center gap-3">
        <Button onClick={() => save.mutate()} disabled={!draft || save.isPending}>Save rules</Button>
        <p className="text-xs text-muted-foreground">The person who asked can't approve their own request, unless they are the only admin.</p>
      </div>
    </div>
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

function MemberMenu({ org, member, me }: { org: OrgSummary; member: OrgMember; me: string }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const self = member.userId === me;
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: orgKey(org.id, "members") }), qc.invalidateQueries({ queryKey: orgsKey })]);
  const setRole = useMutation({
    mutationFn: (role: "admin" | "member") => api.setMemberRole(org.id, member.userId, role),
    onSuccess: async (_d, role) => {
      await refresh();
      toast.success(`${member.name} is now ${role === "admin" ? "an admin" : "a member"}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: () => api.removeMember(org.id, member.userId),
    onSuccess: async () => {
      if (self) {
        await qc.invalidateQueries({ queryKey: orgsKey });
        navigate("/", { replace: true });
        return;
      }
      await refresh();
      toast.success(`${member.name} was removed`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Mirrors the API: only the owner changes roles; admins remove members; the owner can't be touched.
  const canRole = org.role === "owner" && member.role !== "owner";
  const canRemove = member.role !== "owner" && (self || ROLE_RANK_OF[org.role] > ROLE_RANK_OF[member.role]);
  if (!canRole && !canRemove) return null;

  const confirmRemove = async () => {
    const ok = await confirm(
      self
        ? { title: `Leave ${org.name}?`, description: "You'll lose access to its inventory. An admin can invite you back with the join code.", confirmLabel: "Leave", destructive: true }
        : { title: `Remove ${member.name}?`, description: "They lose access straight away. What they recorded stays in the history.", confirmLabel: "Remove", destructive: true },
    );
    if (ok) remove.mutate();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={`Actions for ${member.name}`} />}>
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {canRole && (member.role === "member" ? (
          <DropdownMenuItem onClick={() => setRole.mutate("admin")}><ShieldCheck /> Make admin</DropdownMenuItem>
        ) : (
          <DropdownMenuItem onClick={() => setRole.mutate("member")}><ShieldOff /> Make member</DropdownMenuItem>
        ))}
        {canRole && canRemove && <DropdownMenuSeparator />}
        {canRemove && (
          <DropdownMenuItem variant="destructive" onClick={() => void confirmRemove()}>
            {self ? <LogOut /> : <UserMinus />} {self ? "Leave organization" : "Remove from organization"}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const ROLE_RANK_OF = { member: 1, admin: 2, owner: 3 } as const;

const ROLE_STYLE = {
  owner: "bg-accent text-accent-foreground",
  admin: "bg-accent text-accent-foreground",
  member: "bg-secondary text-secondary-foreground",
} as const;

export default function SettingsPage() {
  const org = useCurrentOrg();
  const admin = isAdmin(org.role);
  const me = useAuth((s) => s.user?.id ?? "");
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

        {admin && (
          <Section title="Features" description="Show only what your team uses. Inventory, locations and the audit log are always on.">
            <FeaturesForm org={org} />
          </Section>
        )}

        {admin && (
          <Section title="Approvals" description="Ask for a second person's OK on the actions that matter. Off until you switch a rule on.">
            <ApprovalRulesForm orgId={org.id} />
          </Section>
        )}

        {admin && (
          <Section title="Your data" description="Download everything this organization has as one file, or bring a file back. Nothing is held hostage.">
            <ArchiveCard orgId={org.id} isOwner={org.role === "owner"} />
          </Section>
        )}

        {admin && (
          <Section title="API keys" description="Let other software read your inventory or post receipts, adjustments and moves. A key works for this organization only and can never delete, import or manage people.">
            <ApiKeysCard orgId={org.id} />
          </Section>
        )}

        {admin && (
          <Section title="Webhooks" description="Have Invintel tell another system when something happens: an item is created, stock changes, a purchase order arrives. Each message is signed so the receiver can check it.">
            <WebhooksCard orgId={org.id} />
          </Section>
        )}

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
                  <MemberMenu org={org} member={m} me={me} />
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
