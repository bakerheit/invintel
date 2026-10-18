import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Download } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { formatCents } from "@/lib/format";
import { orgKey, useCurrentOrg } from "@/lib/org";
import { cn } from "@/lib/utils";
import { Trash2 } from "lucide-react";

const selectClass =
  "h-9 rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";
const WINDOWS = [7, 30, 90, 180] as const;
const SOURCE_LABEL = { usage: "Material used", output: "Output scrapped", hold: "Quality hold" } as const;

const shortDay = (label: string) => new Date(`${label}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export default function ScrapReportPage() {
  const { id: orgId } = useCurrentOrg();
  const [days, setDays] = useState<number>(30);
  const [centerId, setCenterId] = useState("");
  const centers = useQuery({ queryKey: orgKey(orgId, "production", "centers"), queryFn: () => api.workCenters(orgId) });
  const wc = centerId || undefined;
  const report = useQuery({ queryKey: orgKey(orgId, "report-scrap", String(days), wc ?? "all"), queryFn: () => api.scrapReport(orgId, days, wc) });
  const r = report.data;
  const maxReason = Math.max(1, ...(r?.byReason.map((x) => x.valueCents) ?? [0]));
  const maxTrend = Math.max(1, ...(r?.trend.map((x) => x.valueCents) ?? [0]));

  return (
    <>
      <Link to={`/o/${orgId}/reports`} className={buttonVariants({ variant: "ghost", size: "sm" })}><ArrowLeft /> Reports</Link>
      <PageHeader
        title="Scrap and yield trends"
        description="What was scrapped, why, where and how much it cost, and how the yield is moving. Reasons come from the floor; admins edit the list under Quality > Reason lists."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label="Window" className={selectClass} value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {WINDOWS.map((d) => <option key={d} value={d}>Last {d} days</option>)}
            </select>
            <select aria-label="Work center" className={selectClass} value={centerId} onChange={(e) => setCenterId(e.target.value)}>
              <option value="">All work centers</option>
              {centers.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <a href={api.scrapCsvUrl(orgId, days, wc)} download className={buttonVariants({ variant: "outline" })}><Download /> CSV</a>
          </div>
        }
      />
      {!r ? <Skeleton className="h-64 rounded-xl" /> : r.totals.lines === 0 && r.totals.goodOutput === 0 ? (
        <EmptyState icon={Trash2} title="Nothing scrapped in this window" description="Scrap reported on the floor (usage, output) and scrap decided from a quality hold shows up here." />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Card className="gap-0 p-4"><div className="text-sm text-muted-foreground">Scrap value</div><div className="mt-1 text-2xl font-semibold tabular-nums">{formatCents(r.totals.valueCents)}</div><div className="mt-1 text-xs text-muted-foreground">{r.totals.lines} scrap {r.totals.lines === 1 ? "entry" : "entries"}</div></Card>
            <Card className="gap-0 p-4"><div className="text-sm text-muted-foreground">Yield</div><div className="mt-1 text-2xl font-semibold tabular-nums">{r.totals.yieldPct === null ? "n/a" : `${r.totals.yieldPct}%`}</div><div className="mt-1 text-xs text-muted-foreground">{r.totals.goodOutput.toLocaleString()} good, {r.totals.scrappedOutput.toLocaleString()} scrapped output</div></Card>
            <Card className="gap-0 p-4"><div className="text-sm text-muted-foreground">Biggest reason</div><div className="mt-1 truncate text-2xl font-semibold">{r.byReason[0]?.reason ?? "n/a"}</div><div className="mt-1 text-xs text-muted-foreground">{r.byReason[0] ? formatCents(r.byReason[0].valueCents) : ""}</div></Card>
            <Card className="gap-0 p-4"><div className="text-sm text-muted-foreground">With no reason</div><div className={cn("mt-1 text-2xl font-semibold tabular-nums", r.totals.noReasonValueCents > 0 && "text-warning")}>{formatCents(r.totals.noReasonValueCents)}</div><div className="mt-1 text-xs text-muted-foreground">{r.totals.valueCents ? `${Math.round((r.totals.noReasonValueCents / r.totals.valueCents) * 100)}% of scrap value` : ""}</div></Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle>By reason</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {r.byReason.map((x) => (
                  <div key={x.reason} className="space-y-1">
                    <div className="flex items-baseline justify-between text-sm"><span>{x.reason} <span className="text-xs text-muted-foreground">· {x.lines} {x.lines === 1 ? "entry" : "entries"}</span></span><span className="tabular-nums">{formatCents(x.valueCents)}</span></div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${x.reason}: ${formatCents(x.valueCents)}`}><div className={cn("h-full rounded-full", x.reason === "No reason given" ? "bg-warning" : "bg-primary")} style={{ width: `${(x.valueCents / maxReason) * 100}%` }} /></div>
                  </div>
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Trend ({r.bucket === "day" ? "per day" : "per week, from Monday"})</CardTitle></CardHeader>
              <CardContent>
                <div className="flex h-36 items-end gap-1" role="img" aria-label="Scrap value over time">
                  {r.trend.map((p) => <div key={p.label} title={`${shortDay(p.label)}: ${formatCents(p.valueCents)}${p.yieldPct === null ? "" : `, yield ${p.yieldPct}%`}`} className="min-w-1 max-w-16 flex-1 rounded-t bg-primary" style={{ height: `${Math.max(2, (p.valueCents / maxTrend) * 100)}%` }} />)}
                </div>
                <div className="mt-2 flex justify-between text-xs text-muted-foreground"><span>{r.trend[0] ? shortDay(r.trend[0].label) : ""}</span><span>{r.trend.length > 1 ? shortDay(r.trend[r.trend.length - 1]!.label) : ""}</span></div>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-xs"><thead className="text-left text-muted-foreground"><tr><th className="py-1">{r.bucket === "day" ? "Day" : "Week"}</th><th className="py-1 text-right">Scrap</th><th className="py-1 text-right">Yield</th></tr></thead>
                    <tbody>{[...r.trend].reverse().slice(0, 8).map((p) => <tr key={p.label} className="border-t"><td className="py-1">{shortDay(p.label)}</td><td className="py-1 text-right tabular-nums">{formatCents(p.valueCents)}</td><td className="py-1 text-right tabular-nums">{p.yieldPct === null ? "n/a" : `${p.yieldPct}%`}</td></tr>)}</tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader><CardTitle>By work center</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full text-sm"><thead className="text-left text-xs text-muted-foreground"><tr><th className="py-1">Work center</th><th className="py-1 text-right">Scrap value</th><th className="py-1 text-right">Entries</th><th className="py-1 text-right">Good output</th><th className="py-1 text-right">Scrapped output</th><th className="py-1 text-right">Yield</th></tr></thead>
                <tbody className="divide-y">{r.byWorkCenter.map((c) => (
                  <tr key={c.workCenterId ?? "none"}><td className="py-2 font-medium">{c.name}</td><td className="py-2 text-right tabular-nums">{formatCents(c.valueCents)}</td><td className="py-2 text-right tabular-nums">{c.scrapLines}</td><td className="py-2 text-right tabular-nums">{c.goodOutput.toLocaleString()}</td><td className="py-2 text-right tabular-nums">{c.scrappedOutput.toLocaleString()}</td><td className="py-2 text-right tabular-nums">{c.yieldPct === null ? "n/a" : `${c.yieldPct}%`}</td></tr>
                ))}</tbody>
              </table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>By material</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full text-sm"><thead className="text-left text-xs text-muted-foreground"><tr><th className="py-1">Item</th><th className="py-1 text-right">Scrapped</th><th className="py-1 text-right">Value</th><th className="py-1 text-right">Entries</th></tr></thead>
                <tbody className="divide-y">{r.byItem.map((i) => (
                  <tr key={i.itemId}><td className="py-2"><span className="font-medium">{i.name}</span> <span className="font-mono text-xs text-muted-foreground">{i.sku}</span></td><td className="py-2 text-right tabular-nums">{i.quantity.toLocaleString()}</td><td className="py-2 text-right tabular-nums">{formatCents(i.valueCents)}</td><td className="py-2 text-right tabular-nums">{i.lines}</td></tr>
                ))}</tbody>
              </table>
            </CardContent>
          </Card>

          <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            Where it came from:
            {r.bySource.map((s) => <Badge key={s.source} variant="secondary">{SOURCE_LABEL[s.source]}: {formatCents(s.valueCents)}</Badge>)}
            <span>Value uses each item's current unit cost. Yield = good output / (good + scrapped output) of the finished item.</span>
          </p>
        </>
      )}
    </>
  );
}
