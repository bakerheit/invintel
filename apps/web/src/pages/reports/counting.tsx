import type { CountDueStatus } from "@invintel/shared";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ClipboardCheck } from "lucide-react";
import { Link } from "react-router";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { formatCents, formatRelative } from "@/lib/format";
import { orgKey, useCurrentOrg } from "@/lib/org";
import { cn } from "@/lib/utils";

const DUE: Record<CountDueStatus, { label: string; className: string }> = {
  overdue: { label: "Overdue", className: "bg-destructive/10 text-destructive" },
  "never-counted": { label: "Never counted", className: "bg-warning-soft text-warning" },
  "due-soon": { label: "Due soon", className: "bg-accent text-accent-foreground" },
  ok: { label: "OK", className: "bg-success-soft text-success" },
};

export default function CountingReportPage() {
  const { id: orgId } = useCurrentOrg();
  const acc = useQuery({ queryKey: orgKey(orgId, "report-count-accuracy"), queryFn: () => api.countAccuracy(orgId) });
  const sched = useQuery({ queryKey: orgKey(orgId, "report-count-schedule"), queryFn: () => api.countSchedule(orgId) });
  const a = acc.data;
  const s = sched.data;

  return (
    <>
      <Link to={`/o/${orgId}/reports`} className={buttonVariants({ variant: "ghost", size: "sm" })}><ArrowLeft /> Reports</Link>
      <PageHeader title="Counting" description="How well counts match the system, and which places are due for the next one." />

      <Card>
        <CardHeader><CardTitle>Which places to count</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {!s ? <Skeleton className="h-32" /> : !s.rows.length ? <EmptyState icon={ClipboardCheck} title="No stock to count" description="Places with stock show up here." /> : (
            <>
              <p className="text-sm text-muted-foreground">
                Items are classed by value on hand: <strong>A</strong> ({s.classItems.A} items, {s.classShare.A}% of value) every {s.intervals.A} days, <strong>B</strong> ({s.classItems.B}, {s.classShare.B}%) every {s.intervals.B}, <strong>C</strong> ({s.classItems.C}, {s.classShare.C}%) every {s.intervals.C}.
                A place follows the most important class stored there.
              </p>
              <ul className="divide-y">
                {s.rows.map((x) => (
                  <li key={x.locationId} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                    <Badge variant="secondary" className={cn("w-16 justify-center", DUE[x.status].className)}>{DUE[x.status].label.split(" ")[0]}</Badge>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{x.locationPath} <span className="ml-1 rounded border px-1 text-xs font-normal text-muted-foreground">{x.abc}</span></p>
                      <p className="truncate text-xs text-muted-foreground">
                        {x.lastCountedAt ? `Last counted ${formatRelative(x.lastCountedAt)}` : "Never counted"} · every {x.intervalDays} days · {formatCents(x.stockValueCents)} here
                        {x.daysOverdue !== null && x.daysOverdue > 0 ? ` · ${x.daysOverdue} days overdue` : ""}
                      </p>
                    </div>
                    {x.openCountId ? <Badge variant="secondary">Counting now</Badge> : <Link to={`/o/${orgId}/counts?start=${x.locationId}`} className={buttonVariants({ variant: "outline", size: "sm" })}>Start count</Link>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Accuracy</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {!a ? <Skeleton className="h-32" /> : !a.postedCounts ? <EmptyState icon={ClipboardCheck} title="No posted counts yet" description="Accuracy is measured from counts an admin has posted." /> : (
            <>
              <p className="text-sm"><strong className="text-2xl tabular-nums">{a.accuracyPct}%</strong> of {a.linesCounted.toLocaleString()} counted lines matched the system, across {a.postedCounts} {a.postedCounts === 1 ? "count" : "counts"}.</p>
              <div className="flex items-end gap-2" role="img" aria-label="Accuracy by month">
                {a.byMonth.map((m) => (
                  <div key={m.month} className="flex flex-1 flex-col items-center gap-1 text-xs text-muted-foreground">
                    <div className="flex h-20 w-full items-end rounded bg-muted"><div className="w-full rounded bg-primary" style={{ height: `${m.accuracyPct ?? 0}%` }} title={m.accuracyPct === null ? "No counts" : `${m.accuracyPct}% of ${m.linesCounted} lines`} /></div>
                    <span>{m.month.slice(5)}</span>
                  </div>
                ))}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[36rem] text-sm">
                  <thead className="text-left text-xs text-muted-foreground"><tr><th className="p-2">Place</th><th className="p-2 text-right">Counts</th><th className="p-2 text-right">Matched</th><th className="p-2 text-right">Off by (units)</th><th className="p-2 text-right">Off by ($)</th></tr></thead>
                  <tbody className="divide-y">
                    {a.byLocation.map((l) => (
                      <tr key={l.locationId}><td className="p-2 font-medium">{l.locationPath}</td><td className="p-2 text-right tabular-nums">{l.counts}</td><td className="p-2 text-right tabular-nums">{l.accuracyPct}%</td><td className="p-2 text-right tabular-nums">{l.absVarianceUnits.toLocaleString()}</td><td className="p-2 text-right tabular-nums">{formatCents(l.absVarianceCents)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {a.worstItems.length > 0 && (
                <div>
                  <h3 className="mb-1 text-sm font-semibold">Items that miss the most</h3>
                  <ul className="divide-y text-sm">
                    {a.worstItems.map((i) => <li key={i.itemId} className="flex justify-between gap-3 py-1.5"><span className="truncate">{i.name} <span className="font-mono text-xs text-muted-foreground">{i.sku}</span></span><span className="shrink-0 tabular-nums text-muted-foreground">{i.linesMissed} of {i.linesCounted} counts, {formatCents(i.absVarianceCents)}</span></li>)}
                  </ul>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}
