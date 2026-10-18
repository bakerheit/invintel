import type { TraceNode, TraceQuery, TraceResult } from "@invintel/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Download, GitBranch, Timer } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { invalidateOrg, orgKey, useCurrentOrg } from "@/lib/org";
import { cn } from "@/lib/utils";

const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

type StartBy = "lot" | "unit" | "workOrder";
const START_LABEL: Record<StartBy, string> = { lot: "Lot number", unit: "Roll or pallet label", workOrder: "Work order" };
const START_HINT: Record<StartBy, string> = { lot: "e.g. SUP-A", unit: "e.g. U-000123", workOrder: "e.g. WO-0001" };

const STATUS_LABEL: Record<string, string> = { available: "Available", consumed: "Used up", quarantined: "On hold", produced: "Made" };

const KIND_LABEL: Record<TraceNode["kind"], string> = {
  lot: "Lot", receipt: "Received", unit: "Roll or pallet", work_order: "Work order", output: "Made", inputs: "Material used",
};

function Tree({ nodes, depth = 0 }: { nodes: TraceNode[]; depth?: number }) {
  return (
    <ul className={cn("space-y-1", depth > 0 && "ml-4 border-l pl-3")}>
      {nodes.map((n) => (
        <li key={n.id + depth}>
          <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <Badge variant="secondary" className="shrink-0">{KIND_LABEL[n.kind]}</Badge>
            <span className="font-medium">{n.label}</span>
            {!n.exact && <Badge variant="secondary" className="bg-warning-soft text-warning">possible</Badge>}
            {n.repeat && <span className="text-xs text-muted-foreground">(already shown above)</span>}
          </div>
          {n.detail && <p className="ml-1 text-xs text-muted-foreground">{n.detail}</p>}
          {n.children.length > 0 && <Tree nodes={n.children} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}

function Result({ r, orgId, q }: { r: TraceResult; orgId: string; q: TraceQuery }) {
  const s = r.summary;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Card className="gap-0 p-4"><div className="text-sm text-muted-foreground">Answered in</div><div className="mt-1 text-2xl font-semibold tabular-nums">{r.tookMs.toLocaleString()} ms</div></Card>
        <Card className="gap-0 p-4"><div className="text-sm text-muted-foreground">Rolls and pallets</div><div className="mt-1 text-2xl font-semibold tabular-nums">{s.units}</div></Card>
        <Card className="gap-0 p-4"><div className="text-sm text-muted-foreground">Still in stock</div><div className="mt-1 text-2xl font-semibold tabular-nums">{s.stillInStock.toLocaleString()}</div></Card>
        <Card className="gap-0 p-4"><div className="text-sm text-muted-foreground">Work orders</div><div className="mt-1 text-2xl font-semibold tabular-nums">{s.workOrders.length}</div></Card>
        <Card className="gap-0 p-4"><div className="text-sm text-muted-foreground">Places</div><div className="mt-1 text-2xl font-semibold tabular-nums">{s.locations.length}</div></Card>
      </div>
      {r.notes.map((n) => <p key={n} role="note" className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">{n}</p>)}
      {(s.purchaseOrders.length > 0 || s.suppliers.length > 0) && (
        <p className="text-sm text-muted-foreground">Orders: {s.purchaseOrders.join(", ") || "none"} · Suppliers: {s.suppliers.join(", ") || "none"}</p>
      )}
      <Card className="gap-3 p-4">
        <h2 className="font-semibold">{r.query}</h2>
        <Tree nodes={r.tree} />
      </Card>
      <Card className="gap-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold">Affected stock</h2>
          <a href={api.traceCsvUrl(orgId, q)} download className={buttonVariants({ variant: "outline", size: "sm" })}><Download /> CSV</a>
        </div>
        {s.locations.length > 0 && <p className="text-sm text-muted-foreground">Where it is now: {s.locations.map((l) => `${l.path} (${l.quantity.toLocaleString()})`).join(", ")}</p>}
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground"><tr><th className="p-2">What</th><th className="p-2">Lot</th><th className="p-2 text-right">Quantity</th><th className="p-2">Status</th><th className="p-2">Where</th><th className="p-2">Via</th></tr></thead>
            <tbody className="divide-y">
              {r.affected.map((a, i) => (
                <tr key={i}>
                  <td className="p-2"><span className="font-medium">{a.code ?? a.itemName}</span>{a.code && <span className="block text-xs text-muted-foreground">{a.itemName}</span>}</td>
                  <td className="p-2">{a.lot || "—"}</td>
                  <td className="p-2 text-right tabular-nums">{a.quantity.toLocaleString()}</td>
                  <td className="p-2">{STATUS_LABEL[a.status] ?? a.status}</td>
                  <td className="p-2">{a.location}</td>
                  <td className="p-2">{a.via || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

export default function TraceReportPage() {
  const { id: orgId } = useCurrentOrg();
  const qc = useQueryClient();
  const [direction, setDirection] = useState<"forward" | "backward">("forward");
  const [startBy, setStartBy] = useState<StartBy>("lot");
  const [text, setText] = useState("");
  const [result, setResult] = useState<{ r: TraceResult; q: TraceQuery; drill: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const drills = useQuery({ queryKey: orgKey(orgId, "trace-drills"), queryFn: () => api.drills(orgId) });

  const query = (): TraceQuery => ({ direction, [startBy]: text.trim() });
  const run = useMutation({
    mutationFn: async (drill: boolean) => {
      const q = query();
      return { q, drill, ...(drill ? { r: (await api.runDrill(orgId, q)).result } : { r: await api.trace(orgId, q) }) };
    },
    onSuccess: (x) => { setResult(x); setError(null); if (x.drill) void invalidateOrg(qc, orgId); },
    onError: (e) => { setResult(null); setError(e instanceof Error ? e.message : "Something went wrong"); },
  });

  return (
    <>
      <Link to={`/o/${orgId}/reports`} className={buttonVariants({ variant: "ghost", size: "sm" })}><ArrowLeft /> Reports</Link>
      <PageHeader title="Lot trace and mock recall" description="Follow a supplier lot, a roll or pallet, or a work order forward to everything made from it, or backward to what went into it. A mock recall is the same trace, timed and kept, so you can show how fast you can answer." />

      <form className="space-y-3 rounded-lg border p-4" onSubmit={(e) => { e.preventDefault(); if (text.trim()) run.mutate(false); }}>
        <div role="tablist" className="flex flex-wrap gap-1 rounded-md bg-muted p-1 text-sm sm:w-fit">
          {([["forward", "Where did it go?"], ["backward", "What went into it?"]] as const).map(([d, label]) => (
            <button key={d} type="button" role="tab" aria-selected={direction === d} onClick={() => setDirection(d)} className={cn("rounded px-3 py-1.5", direction === d ? "bg-background font-medium shadow-xs" : "text-muted-foreground")}>{label}</button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-[14rem_1fr]">
          <label className="grid gap-1 text-sm"><span className="font-medium">Start from</span>
            <select className={selectClass} value={startBy} onChange={(e) => setStartBy(e.target.value as StartBy)}>
              {(Object.keys(START_LABEL) as StartBy[]).map((k) => <option key={k} value={k}>{START_LABEL[k]}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm"><span className="font-medium">{START_LABEL[startBy]}</span>
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={START_HINT[startBy]} maxLength={64} />
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!text.trim() || run.isPending}><GitBranch /> Trace</Button>
          <Button type="button" variant="outline" disabled={!text.trim() || run.isPending} onClick={() => run.mutate(true)}><Timer /> Run as a mock recall</Button>
        </div>
      </form>

      {error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">{error}</p>}
      {result && (
        <>
          {result.drill && <p className="rounded-lg bg-success-soft px-3 py-2 text-sm text-success">Mock recall recorded: answered in {result.r.tookMs.toLocaleString()} ms.</p>}
          <Result r={result.r} orgId={orgId} q={result.q} />
        </>
      )}

      <Card className="gap-3 p-4">
        <h2 className="font-semibold">Mock recall history</h2>
        {!drills.data?.length ? (
          <p className="text-sm text-muted-foreground">No drills yet. Run one to see how long it takes and keep the record.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground"><tr><th className="p-2">When</th><th className="p-2">Traced</th><th className="p-2 text-right">Units</th><th className="p-2 text-right">Work orders</th><th className="p-2 text-right">Took</th></tr></thead>
              <tbody className="divide-y">
                {drills.data.map((d) => (
                  <tr key={d.id}>
                    <td className="whitespace-nowrap p-2">{formatDateTime(d.at)}<span className="block text-xs text-muted-foreground">{d.by}</span></td>
                    <td className="p-2">{d.query}{d.hasInferred && <Badge variant="secondary" className="ml-2 bg-warning-soft text-warning">has possible links</Badge>}</td>
                    <td className="p-2 text-right tabular-nums">{d.units}</td>
                    <td className="p-2 text-right tabular-nums">{d.workOrders}</td>
                    <td className="p-2 text-right tabular-nums">{d.tookMs.toLocaleString()} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
