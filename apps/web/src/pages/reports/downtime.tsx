import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, PowerOff } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { isAdmin, orgKey, useCurrentOrg } from "@/lib/org";
import { cn } from "@/lib/utils";

const hm = (min: number) => (min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`);

function Settings({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const s = useQuery({ queryKey: orgKey(orgId, "downtime-settings"), queryFn: () => api.downtimeSettings(orgId) });
  const [reasons, setReasons] = useState<string | null>(null);
  const [hours, setHours] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.saveDowntimeSettings(orgId, {
      reasons: (reasons ?? s.data!.reasons.join("\n")).split("\n").map((x) => x.trim()).filter(Boolean),
      scheduledHoursPerDay: Number(hours ?? s.data!.scheduledHoursPerDay),
    }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: orgKey(orgId) }); setReasons(null); setHours(null); toast.success("Downtime settings saved"); },
    onError: (e: Error) => toast.error(e.message),
  });
  if (!s.data) return null;
  return (
    <Card>
      <CardHeader><CardTitle>Settings</CardTitle></CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <label htmlFor="dt-reasons" className="text-sm font-medium">Reasons on the floor (one per line)</label>
          <textarea id="dt-reasons" rows={7} className="rounded-md border bg-background p-2 text-sm" value={reasons ?? s.data.reasons.join("\n")} onChange={(e) => setReasons(e.target.value)} />
        </div>
        <div className="grid content-start gap-1.5">
          <label htmlFor="dt-hours" className="text-sm font-medium">Scheduled hours per day</label>
          <Input id="dt-hours" type="number" min={1} max={24} step="0.5" value={hours ?? String(s.data.scheduledHoursPerDay)} onChange={(e) => setHours(e.target.value)} className="w-32" />
          <p className="text-xs text-muted-foreground">Availability is (scheduled hours - logged downtime) / scheduled hours, for every day in the window.</p>
          <Button className="mt-2 w-fit" onClick={() => save.mutate()} disabled={(reasons === null && hours === null) || save.isPending}>Save</Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function DowntimeReportPage() {
  const { id: orgId, role } = useCurrentOrg();
  const [days, setDays] = useState(7);
  const sum = useQuery({ queryKey: orgKey(orgId, "downtime-summary", String(days)), queryFn: () => api.downtimeSummary(orgId, days) });
  const events = useQuery({ queryKey: orgKey(orgId, "downtime-events"), queryFn: () => api.downtimeEvents(orgId) });
  const s = sum.data;
  const maxReason = Math.max(1, ...(s?.byReason.map((r) => r.minutes) ?? [0]));

  return (
    <>
      <Link to={`/o/${orgId}/reports`} className={buttonVariants({ variant: "ghost", size: "sm" })}><ArrowLeft /> Reports</Link>
      <PageHeader
        title="Downtime and availability"
        description="Operators log it from Floor mode > Downtime. Availability is a rough figure: it ignores speed and quality."
        actions={
          <div className="flex gap-1" role="group" aria-label="Window">
            {[7, 30, 90].map((d) => <Button key={d} size="sm" variant={days === d ? "default" : "outline"} onClick={() => setDays(d)}>{d} days</Button>)}
          </div>
        }
      />
      {!s ? <Skeleton className="h-64 rounded-xl" /> : !s.rows.length ? (
        <EmptyState icon={PowerOff} title="No machines yet" description="Add work centers under Production, then operators can log downtime." />
      ) : (
        <>
          <Card>
            <CardHeader><CardTitle>By machine</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full min-w-[34rem] text-sm">
                <thead className="text-left text-xs text-muted-foreground"><tr><th className="p-2">Machine</th><th className="p-2 text-right">Availability</th><th className="p-2 text-right">Down</th><th className="p-2 text-right">Stops</th><th className="p-2">Biggest reason</th></tr></thead>
                <tbody className="divide-y">
                  {s.rows.map((r) => (
                    <tr key={r.workCenterId}>
                      <td className="p-2 font-medium">{r.name} {r.downNow && <Badge variant="secondary" className="ml-1 bg-destructive/10 text-destructive">Down now: {r.downNow.reason}</Badge>}</td>
                      <td className={cn("p-2 text-right tabular-nums font-semibold", r.availabilityPct < 85 && "text-warning", r.availabilityPct < 70 && "text-destructive")}>{r.availabilityPct}%</td>
                      <td className="p-2 text-right tabular-nums">{hm(r.downMinutes)}</td>
                      <td className="p-2 text-right tabular-nums">{r.events}</td>
                      <td className="p-2 text-muted-foreground">{r.topReason ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Where the time went</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {!s.byReason.length ? <p className="text-sm text-muted-foreground">No downtime logged in the last {days} days.</p> : s.byReason.map((r) => (
                <div key={r.reason} className="space-y-1">
                  <div className="flex items-baseline justify-between text-sm"><span>{r.reason} <span className="text-xs text-muted-foreground">· {r.events} {r.events === 1 ? "stop" : "stops"}</span></span><span className="tabular-nums">{hm(r.minutes)}</span></div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${(r.minutes / maxReason) * 100}%` }} /></div>
                </div>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Latest stops</CardTitle></CardHeader>
            <CardContent>
              <ul className="divide-y text-sm">
                {(events.data ?? []).slice(0, 15).map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span><span className="font-medium">{e.workCenterName}</span> · {e.reason}{e.note ? ` (${e.note})` : ""}</span>
                    <span className="text-xs text-muted-foreground">{hm(e.minutes)}{e.endedAt ? "" : " and counting"} · {formatRelative(e.startedAt)} · {e.startedBy}</span>
                  </li>
                ))}
                {!events.data?.length && <li className="py-2 text-muted-foreground">Nothing logged yet.</li>}
              </ul>
            </CardContent>
          </Card>
        </>
      )}
      {isAdmin(role) && <Settings orgId={orgId} />}
    </>
  );
}
