import type { Alert, AlertSettings } from "@invintel/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, Check, Clock, Copy, RotateCcw } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { isAdmin, orgKey, useCurrentOrg } from "@/lib/org";
import { cn } from "@/lib/utils";

function AlertRow({ a }: { a: Alert }) {
  const { id: orgId } = useCurrentOrg();
  const qc = useQueryClient();
  const act = useMutation({
    mutationFn: (v: "acknowledge" | "reopen" | { snooze: number }) => api.alertAction(orgId, v, a.key),
    onSuccess: () => qc.invalidateQueries({ queryKey: orgKey(orgId, "alerts") }),
    onError: (e: Error) => { toast.error(e.message); void qc.invalidateQueries({ queryKey: orgKey(orgId, "alerts") }); },
  });
  return (
    <li className="flex flex-wrap items-start gap-3 py-3 text-sm">
      <span className={cn("mt-1 size-2.5 shrink-0 rounded-full", a.severity === "critical" ? "bg-destructive" : "bg-warning")} aria-label={a.severity} />
      <div className="min-w-0 flex-1">
        <Link to={a.link} className="-my-1 inline-block py-1 font-medium hover:underline">{a.title}</Link>
        <p className="text-xs text-muted-foreground">{a.detail}</p>
        {a.state === "acknowledged" && <p className="mt-0.5 text-xs text-muted-foreground">Acknowledged by {a.by} {a.at ? formatRelative(a.at) : ""}. It stays here until the problem is fixed.</p>}
        {a.state === "snoozed" && <p className="mt-0.5 text-xs text-muted-foreground">Snoozed by {a.by} until {a.snoozedUntil?.slice(0, 10)}.</p>}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {a.state === "open" ? (
          <>
            <Button size="sm" variant="outline" onClick={() => act.mutate("acknowledge")} disabled={act.isPending}><Check /> Got it</Button>
            <Button size="sm" variant="ghost" onClick={() => act.mutate({ snooze: 1 })} disabled={act.isPending}><Clock /> 1 day</Button>
            <Button size="sm" variant="ghost" onClick={() => act.mutate({ snooze: 7 })} disabled={act.isPending}>7 days</Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => act.mutate("reopen")} disabled={act.isPending}><RotateCcw /> Reopen</Button>
        )}
      </div>
    </li>
  );
}

function Settings({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const s = useQuery({ queryKey: orgKey(orgId, "alert-settings"), queryFn: () => api.alertSettings(orgId) });
  const [draft, setDraft] = useState<{ days?: string; mins?: string }>({});
  const save = useMutation({
    mutationFn: () => api.saveAlertSettings(orgId, { daysOfSupply: Number(draft.days ?? s.data!.daysOfSupply), machineDownMinutes: Number(draft.mins ?? s.data!.machineDownMinutes) } as AlertSettings),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: orgKey(orgId) }); setDraft({}); toast.success("Alert settings saved"); },
    onError: (e: Error) => toast.error(e.message),
  });
  if (!s.data) return null;
  return (
    <Card>
      <CardHeader><CardTitle>Settings</CardTitle></CardHeader>
      <CardContent className="flex flex-wrap items-end gap-4">
        <div className="grid gap-1.5"><label htmlFor="al-days" className="text-sm font-medium">Warn when stock lasts fewer than (days)</label><Input id="al-days" type="number" min={1} max={90} className="w-28" value={draft.days ?? String(s.data.daysOfSupply)} onChange={(e) => setDraft({ ...draft, days: e.target.value })} /></div>
        <div className="grid gap-1.5"><label htmlFor="al-mins" className="text-sm font-medium">Flag a machine down for (minutes)</label><Input id="al-mins" type="number" min={5} max={1440} className="w-28" value={draft.mins ?? String(s.data.machineDownMinutes)} onChange={(e) => setDraft({ ...draft, mins: e.target.value })} /></div>
        <Button onClick={() => save.mutate()} disabled={(draft.days === undefined && draft.mins === undefined) || save.isPending}>Save</Button>
      </CardContent>
    </Card>
  );
}

export default function AlertsPage() {
  const { id: orgId, role } = useCurrentOrg();
  const res = useQuery({ queryKey: orgKey(orgId, "alerts"), queryFn: () => api.alerts(orgId), refetchInterval: 30_000 });
  const digest = useQuery({ queryKey: orgKey(orgId, "alerts", "digest"), queryFn: () => api.alertDigest(orgId) });
  const open = (res.data?.alerts ?? []).filter((a) => a.state === "open");
  const quiet = (res.data?.alerts ?? []).filter((a) => a.state !== "open");
  const copy = async () => {
    try { await navigator.clipboard.writeText(digest.data?.text ?? ""); toast.success("Digest copied"); } catch { toast.error("Couldn't copy. Select the text and copy it by hand."); }
  };

  return (
    <>
      <PageHeader title="Alerts" description="What needs someone's attention right now: stock, orders, counts and machines. Say you've got it, or snooze it." />
      <Card>
        <CardHeader><CardTitle>Open {res.data && res.data.open.total > 0 && <Badge variant="secondary" className="ml-2">{res.data.open.total}</Badge>}</CardTitle></CardHeader>
        <CardContent>
          {res.isLoading ? <Skeleton className="h-24" /> : !open.length ? <EmptyState icon={BellRing} title="All quiet" description="Nothing needs attention. Alerts appear here when stock runs low, an order is late, a count is overdue or a machine is down." /> : <ul className="divide-y">{open.map((a) => <AlertRow key={a.key} a={a} />)}</ul>}
        </CardContent>
      </Card>
      {quiet.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Acknowledged and snoozed</CardTitle></CardHeader>
          <CardContent><ul className="divide-y">{quiet.map((a) => <AlertRow key={a.key} a={a} />)}</ul></CardContent>
        </Card>
      )}
      <Card>
        <CardHeader><div className="flex items-center justify-between gap-2"><CardTitle>Daily digest preview</CardTitle><Button size="sm" variant="outline" onClick={() => void copy()}><Copy /> Copy</Button></div></CardHeader>
        <CardContent>
          <p className="mb-2 text-xs text-muted-foreground">This is what a daily email or chat message would say. Nothing is sent yet: sending needs an email or chat account, which isn't connected. Copy it into whatever you use.</p>
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-3 text-sm">{digest.data?.text ?? "Loading..."}</pre>
        </CardContent>
      </Card>
      {isAdmin(role) && <Settings orgId={orgId} />}
    </>
  );
}
