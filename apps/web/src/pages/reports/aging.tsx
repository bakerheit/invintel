import type { AgingBucket } from "@invintel/shared";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Download } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { formatCents } from "@/lib/format";
import { orgKey, useCurrentOrg, useLocations } from "@/lib/org";
import { cn } from "@/lib/utils";
import { Hourglass } from "lucide-react";

const ALL = "__all__";

export default function AgingReportPage() {
  const { id: orgId } = useCurrentOrg();
  const { data: locations = [] } = useLocations(orgId);
  const [locationId, setLocationId] = useState(ALL);
  const loc = locationId === ALL ? undefined : locationId;
  const report = useQuery({ queryKey: orgKey(orgId, "report-aging", loc ?? "all"), queryFn: () => api.agingReport(orgId, loc) });
  const r = report.data;
  const maxValue = Math.max(1, ...(r?.buckets.map((b) => b.valueCents) ?? [0]));
  const tone = (b: AgingBucket) => (b.fromDays > 180 ? "bg-destructive" : b.fromDays > 90 ? "bg-warning" : "bg-primary");

  return (
    <>
      <Link to={`/o/${orgId}/reports`} className={buttonVariants({ variant: "ghost", size: "sm" })}><ArrowLeft /> Reports</Link>
      <PageHeader
        title="Stock aging"
        description="Days since stock last moved at each place. Moving, receiving, counting or adjusting all count as movement."
        actions={
          <>
            <Select value={locationId} onValueChange={(v) => v && setLocationId(v)} items={[{ value: ALL, label: "All locations" }, ...locations.map((l) => ({ value: l.id, label: l.path }))]}>
              <SelectTrigger aria-label="Location" className="w-52"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={ALL}>All locations</SelectItem>{locations.map((l) => <SelectItem key={l.id} value={l.id}>{l.path}</SelectItem>)}</SelectContent>
            </Select>
            <a href={api.agingCsvUrl(orgId, loc)} download className={buttonVariants({ variant: "outline" })}><Download /> CSV</a>
          </>
        }
      />
      {!r ? <Skeleton className="h-64 rounded-xl" /> : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Card className="gap-0 p-4"><div className="text-sm text-muted-foreground">Stock value</div><div className="mt-1 text-2xl font-semibold tabular-nums">{formatCents(r.totalValueCents)}</div></Card>
            <Card className="gap-0 p-4"><div className="text-sm text-muted-foreground">Idle over 180 days</div><div className={cn("mt-1 text-2xl font-semibold tabular-nums", r.idleValueCents > 0 && "text-warning")}>{formatCents(r.idleValueCents)}</div><div className="mt-1 text-xs text-muted-foreground">{r.totalValueCents ? `${Math.round((r.idleValueCents / r.totalValueCents) * 100)}% of stock value` : ""}</div></Card>
            <Card className="gap-0 p-4"><div className="text-sm text-muted-foreground">Lines of stock</div><div className="mt-1 text-2xl font-semibold tabular-nums">{r.rows.length.toLocaleString()}</div></Card>
          </div>
          <Card>
            <CardHeader><CardTitle>By age</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {r.buckets.map((b) => (
                <div key={b.label} className="space-y-1">
                  <div className="flex items-baseline justify-between text-sm"><span>{b.label} <span className="text-xs text-muted-foreground">· {b.rows} {b.rows === 1 ? "line" : "lines"}</span></span><span className="tabular-nums">{formatCents(b.valueCents)}</span></div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${b.label}: ${formatCents(b.valueCents)}`}><div className={cn("h-full rounded-full", tone(b))} style={{ width: `${(b.valueCents / maxValue) * 100}%` }} /></div>
                </div>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Oldest first</CardTitle></CardHeader>
            <CardContent>
              {!r.rows.length ? <EmptyState icon={Hourglass} title="No stock" description="There's nothing on hand to age." /> : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[40rem] text-sm">
                    <thead className="text-left text-xs text-muted-foreground"><tr><th className="p-2">Item</th><th className="p-2">Where</th><th className="p-2 text-right">Qty</th><th className="p-2 text-right">Value</th><th className="p-2 text-right">Days</th></tr></thead>
                    <tbody className="divide-y">
                      {r.rows.slice(0, 200).map((x) => (
                        <tr key={`${x.itemId}:${x.locationId}`}>
                          <td className="p-2"><div className="font-medium">{x.name}</div><div className="font-mono text-xs text-muted-foreground">{x.sku}</div></td>
                          <td className="p-2 text-muted-foreground">{x.locationPath}</td>
                          <td className="p-2 text-right tabular-nums">{x.quantity.toLocaleString()}</td>
                          <td className="p-2 text-right tabular-nums">{formatCents(x.valueCents)}</td>
                          <td className="p-2 text-right tabular-nums"><span className={cn(x.daysSince > 180 && "font-semibold text-destructive", x.daysSince > 90 && x.daysSince <= 180 && "text-warning")}>{x.daysSince}</span>{x.onActiveBom && <Badge variant="secondary" className="ml-2" title="Used by an active BOM">in a BOM</Badge>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {r.rows.length > 200 && <p className="p-2 text-xs text-muted-foreground">Showing the oldest 200 of {r.rows.length}. The CSV has all of them.</p>}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
