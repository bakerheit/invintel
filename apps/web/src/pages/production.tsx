import type { Bom, WorkCenter, WorkOrder, WorkOrderStatus } from "@invintel/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardList, Cog, Factory, Gauge, Plus, Trash2 } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { invalidateOrg, isAdmin, orgKey, useCurrentOrg, useLocations } from "@/lib/org";
import { cn } from "@/lib/utils";

const STATUS_STYLE: Record<WorkOrderStatus, string> = {
  planned: "bg-secondary text-secondary-foreground",
  released: "bg-accent text-accent-foreground",
  running: "bg-warning-soft text-warning",
  done: "bg-success-soft text-success",
  cancelled: "bg-destructive/10 text-destructive dark:bg-destructive/20",
};

const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  );
}

const useProd = <T,>(orgId: string, key: string, fn: () => Promise<T>) =>
  useQuery({ queryKey: orgKey(orgId, "production", key), queryFn: fn });

const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");

// ---------- work orders ----------

function VariancePanel({ orgId, id }: { orgId: string; id: string }) {
  const { data: v, isLoading } = useProd(orgId, `variance-${id}`, () => api.workOrderVariance(orgId, id));
  if (isLoading || !v) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  return (
    <div className="space-y-3 bg-muted/30 p-4">
      <p className="text-sm">
        Planned {v.planned.toLocaleString()} · good {v.good.toLocaleString()} · scrapped {v.scrapped.toLocaleString()} · yield{" "}
        <strong>{v.yieldPct === null ? "n/a" : `${v.yieldPct}%`}</strong> (BOM expects {v.expectedYieldPct}%). Expected usage is for{" "}
        {v.basisQuantity.toLocaleString()} started.
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Material</TableHead>
            <TableHead className="text-right">Expected</TableHead>
            <TableHead className="text-right">Loaded</TableHead>
            <TableHead className="text-right">Used</TableHead>
            <TableHead className="text-right">Scrap</TableHead>
            <TableHead className="text-right">Remnant</TableHead>
            <TableHead className="text-right">At machine</TableHead>
            <TableHead className="text-right">Variance</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {v.lines.map((l) => (
            <TableRow key={l.itemId}>
              <TableCell className="font-medium">{l.itemName}</TableCell>
              <TableCell className="text-right tabular-nums">{l.expected.toLocaleString()}</TableCell>
              <TableCell className="text-right tabular-nums">{l.loaded.toLocaleString()}</TableCell>
              <TableCell className="text-right tabular-nums">{l.consumed.toLocaleString()}</TableCell>
              <TableCell className="text-right tabular-nums">{l.scrapped.toLocaleString()}</TableCell>
              <TableCell className="text-right tabular-nums">{l.remnant.toLocaleString()}</TableCell>
              <TableCell className="text-right tabular-nums">{l.atMachine.toLocaleString()}</TableCell>
              <TableCell
                className={cn(
                  "text-right font-medium tabular-nums",
                  l.variancePct !== null && l.consumed + l.scrapped > 0 && (Math.abs(l.variancePct) > 5 ? "text-destructive" : "text-success"),
                )}
              >
                {l.consumed + l.scrapped === 0 ? "—" : `${l.variance > 0 ? "+" : ""}${l.variance.toLocaleString()}${l.variancePct === null ? "" : ` (${l.variancePct > 0 ? "+" : ""}${l.variancePct}%)`}`}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="text-xs text-muted-foreground">Variance = used + scrap − what the BOM says that output should take. Positive means more material than planned.</p>
    </div>
  );
}

function NewWorkOrder({ orgId, centers, boms, onDone }: { orgId: string; centers: WorkCenter[]; boms: Bom[]; onDone: () => void }) {
  const qc = useQueryClient();
  const [bomId, setBomId] = useState(boms[0]?.id ?? "");
  const [centerId, setCenterId] = useState(centers.find((c) => c.active)?.id ?? "");
  const [quantity, setQuantity] = useState("100");
  const [due, setDue] = useState("");
  const create = useMutation({
    mutationFn: () => api.createWorkOrder(orgId, { bomId, workCenterId: centerId, quantity: Number(quantity), dueDate: due || null }),
    onSuccess: (wo) => {
      toast.success(`${wo.number} created. Release it to put it on the floor.`);
      void invalidateOrg(qc, orgId);
      onDone();
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  if (!boms.length || !centers.length) {
    return <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Make a work center and a BOM first (the other two tabs).</p>;
  }
  return (
    <form className="grid gap-3 rounded-lg border p-4 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
      <Field label="Make">
        <select className={selectClass} value={bomId} onChange={(e) => setBomId(e.target.value)}>
          {boms.map((b) => <option key={b.id} value={b.id}>{b.outputItemName} (BOM v{b.version})</option>)}
        </select>
      </Field>
      <Field label="At work center">
        <select className={selectClass} value={centerId} onChange={(e) => setCenterId(e.target.value)}>
          {centers.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      <Field label="Good quantity">
        <Input type="number" min={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
      </Field>
      <Field label="Due (optional)">
        <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
      </Field>
      <div className="sm:col-span-4">
        <Button type="submit" disabled={create.isPending || !bomId || !centerId || Number(quantity) < 1}>Create work order</Button>
      </div>
    </form>
  );
}

function WorkOrders({ orgId, admin }: { orgId: string; admin: boolean }) {
  const qc = useQueryClient();
  const orders = useProd(orgId, "orders", () => api.workOrders(orgId));
  const centers = useProd(orgId, "centers", () => api.workCenters(orgId));
  const boms = useProd(orgId, "boms", () => api.boms(orgId));
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "release" | "complete" | "cancel" }) => api.workOrderAction(orgId, id, action),
    onSuccess: (wo) => { toast.success(`${wo.number} is now ${wo.status}`); void invalidateOrg(qc, orgId); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const rows: WorkOrder[] = orders.data ?? [];
  return (
    <div className="space-y-4">
      {admin && (
        <div>
          <Button variant={adding ? "ghost" : "default"} onClick={() => setAdding((a) => !a)}><Plus /> {adding ? "Close" : "New work order"}</Button>
        </div>
      )}
      {adding && <NewWorkOrder orgId={orgId} centers={centers.data ?? []} boms={boms.data ?? []} onDone={() => setAdding(false)} />}
      {!orders.isLoading && rows.length === 0 ? (
        <EmptyState icon={ClipboardList} title="No work orders yet" description="A work order says: make this much of this item at this machine." />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Output</TableHead>
                <TableHead>Machine</TableHead>
                <TableHead className="text-right">Done / planned</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((o) => (
                <Fragment key={o.id}>
                  <TableRow className="cursor-pointer" onClick={() => setOpen(open === o.id ? null : o.id)}>
                    <TableCell className="font-medium">{o.number}</TableCell>
                    <TableCell>{o.outputItemName} <span className="text-xs text-muted-foreground">BOM v{o.bomVersion}</span></TableCell>
                    <TableCell>{o.workCenterName}</TableCell>
                    <TableCell className="text-right tabular-nums">{o.produced.toLocaleString()} / {o.quantity.toLocaleString()}</TableCell>
                    <TableCell><Badge variant="secondary" className={cn("capitalize", STATUS_STYLE[o.status])}>{o.status}</Badge></TableCell>
                    <TableCell className="space-x-2 text-right" onClick={(e) => e.stopPropagation()}>
                      {admin && o.status === "planned" && <Button size="sm" onClick={() => act.mutate({ id: o.id, action: "release" })}>Release</Button>}
                      {(o.status === "released" || o.status === "running") && <Button size="sm" variant="outline" onClick={() => act.mutate({ id: o.id, action: "complete" })}>Complete</Button>}
                      {admin && (o.status === "planned" || o.status === "released") && <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: o.id, action: "cancel" })}>Cancel</Button>}
                    </TableCell>
                  </TableRow>
                  {open === o.id && (
                    <TableRow key={`${o.id}-v`}>
                      <TableCell colSpan={6} className="p-0"><VariancePanel orgId={orgId} id={o.id} /></TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">Click a row for expected vs actual. People on the floor load, report usage and report output from Floor mode.</p>
    </div>
  );
}

// ---------- work centers ----------

function WorkCenters({ orgId, admin }: { orgId: string; admin: boolean }) {
  const qc = useQueryClient();
  const centers = useProd(orgId, "centers", () => api.workCenters(orgId));
  const { data: locations = [] } = useLocations(orgId);
  const production = locations.filter((l) => l.type === "production");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [locationId, setLocationId] = useState("");
  const create = useMutation({
    mutationFn: () => api.createWorkCenter(orgId, { name, code, locationId: locationId || production[0]!.id }),
    onSuccess: () => { setName(""); setCode(""); void invalidateOrg(qc, orgId); },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <div className="space-y-4">
      {admin && (
        production.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            A work center sits in a production-area location. Add one under Locations (type "Production") first.
          </p>
        ) : (
          <form className="grid gap-3 rounded-lg border p-4 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Corrugator 1" /></Field>
            <Field label="Code (optional)"><Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="WC-1" /></Field>
            <Field label="Production area">
              <select className={selectClass} value={locationId || production[0]!.id} onChange={(e) => setLocationId(e.target.value)}>
                {production.map((l) => <option key={l.id} value={l.id}>{l.path}</option>)}
              </select>
            </Field>
            <div className="flex items-end"><Button type="submit" disabled={create.isPending || !name.trim()}>Add work center</Button></div>
          </form>
        )
      )}
      {centers.data?.length === 0 ? (
        <EmptyState icon={Factory} title="No work centers" description="A work center is a machine, line or cell. Material is staged at its production area." />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Code</TableHead><TableHead>Staging area</TableHead><TableHead className="text-right">Running</TableHead></TableRow></TableHeader>
            <TableBody>
              {centers.data?.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell>{c.code || "—"}</TableCell>
                  <TableCell>{c.locationPath}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.runningOrders}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

// ---------- BOMs ----------

interface Row { itemId: string; quantity: string; scrapPct: string }

function Boms({ orgId, admin }: { orgId: string; admin: boolean }) {
  const qc = useQueryClient();
  const boms = useProd(orgId, "boms-all", () => api.boms(orgId, true));
  const items = useQuery({ queryKey: orgKey(orgId, "items"), queryFn: () => api.listItems(orgId) });
  const [output, setOutput] = useState("");
  const [outQty, setOutQty] = useState("1");
  const [yieldPct, setYield] = useState("100");
  const [rows, setRows] = useState<Row[]>([{ itemId: "", quantity: "1", scrapPct: "0" }]);
  const list = items.data ?? [];
  const create = useMutation({
    mutationFn: () =>
      api.createBom(orgId, {
        outputItemId: output,
        outputQuantity: Number(outQty),
        yieldPct: Number(yieldPct),
        inputs: rows.map((r) => ({ itemId: r.itemId, quantity: Number(r.quantity), scrapPct: Number(r.scrapPct) })),
      }),
    onSuccess: (b) => { toast.success(`Saved ${b.outputItemName} BOM v${b.version}`); setRows([{ itemId: "", quantity: "1", scrapPct: "0" }]); void invalidateOrg(qc, orgId); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const setRow = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const ready = output && rows.every((r) => r.itemId && Number(r.quantity) > 0);
  return (
    <div className="space-y-4">
      {admin && (
        <form className="space-y-3 rounded-lg border p-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Output item">
              <select className={selectClass} value={output} onChange={(e) => setOutput(e.target.value)}>
                <option value="">Pick an item</option>
                {list.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.sku})</option>)}
              </select>
            </Field>
            <Field label="Inputs below make this many"><Input type="number" min={1} value={outQty} onChange={(e) => setOutQty(e.target.value)} /></Field>
            <Field label="Expected yield %"><Input type="number" min={1} max={100} value={yieldPct} onChange={(e) => setYield(e.target.value)} /></Field>
          </div>
          {rows.map((r, i) => (
            <div key={i} className="grid items-end gap-3 sm:grid-cols-[1fr_8rem_8rem_auto]">
              <Field label={i === 0 ? "Input item" : ""}>
                <select className={selectClass} value={r.itemId} onChange={(e) => setRow(i, { itemId: e.target.value })}>
                  <option value="">Pick an item</option>
                  {list.filter((x) => x.id !== output).map((x) => <option key={x.id} value={x.id}>{x.name} ({x.sku})</option>)}
                </select>
              </Field>
              <Field label={i === 0 ? "Quantity" : ""}><Input type="number" min={0} step="any" value={r.quantity} onChange={(e) => setRow(i, { quantity: e.target.value })} /></Field>
              <Field label={i === 0 ? "Scrap %" : ""}><Input type="number" min={0} max={100} step="any" value={r.scrapPct} onChange={(e) => setRow(i, { scrapPct: e.target.value })} /></Field>
              <Button type="button" variant="ghost" size="icon" aria-label="Remove input" disabled={rows.length === 1} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}><Trash2 /></Button>
            </div>
          ))}
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => setRows((rs) => [...rs, { itemId: "", quantity: "1", scrapPct: "0" }])}><Plus /> Add input</Button>
            <Button type="submit" disabled={create.isPending || !ready}>Save BOM</Button>
          </div>
          <p className="text-xs text-muted-foreground">Saving a BOM for an item that already has one makes a new version. Open work orders keep the version they were made from.</p>
        </form>
      )}
      {boms.data?.length === 0 ? (
        <EmptyState icon={Cog} title="No BOMs yet" description="A BOM is the recipe: inputs per output, with expected scrap and yield." />
      ) : (
        <div className="space-y-3">
          {boms.data?.map((b) => (
            <div key={b.id} className={cn("rounded-lg border p-4", b.status === "retired" && "opacity-60")}>
              <p className="font-medium">
                {b.outputItemName} <span className="text-sm text-muted-foreground">v{b.version}</span>{" "}
                <Badge variant="secondary" className="capitalize">{b.status}</Badge>
              </p>
              <p className="text-sm text-muted-foreground">
                makes {b.outputQuantity.toLocaleString()} · expected yield {b.yieldPct}%: {b.inputs.map((i) => `${i.quantity} × ${i.itemName}${i.scrapPct ? ` (+${i.scrapPct}% scrap)` : ""}`).join(", ")}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- variance overview ----------

function VarianceList({ orgId }: { orgId: string }) {
  const rows = useProd(orgId, "variance-summary", () => api.varianceSummary(orgId));
  if (!rows.data?.length) return <EmptyState icon={Gauge} title="Nothing to compare yet" description="Once a work order is running, its expected vs actual usage shows up here, worst first." />;
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader><TableRow><TableHead>Work order</TableHead><TableHead>Output</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Yield</TableHead><TableHead className="text-right">Worst variance</TableHead></TableRow></TableHeader>
        <TableBody>
          {rows.data.map((r) => (
            <TableRow key={r.workOrderId}>
              <TableCell className="font-medium">{r.number}</TableCell>
              <TableCell>{r.outputItemName}</TableCell>
              <TableCell><Badge variant="secondary" className={cn("capitalize", STATUS_STYLE[r.status])}>{r.status}</Badge></TableCell>
              <TableCell className="text-right tabular-nums">{r.yieldPct === null ? "—" : `${r.yieldPct}%`}</TableCell>
              <TableCell className={cn("text-right font-medium tabular-nums", r.worstVariancePct !== null && r.worstVariancePct > 5 && "text-destructive")}>
                {r.worstVariancePct === null ? "—" : `${r.worstVariancePct}%`}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ---------- page ----------

const TABS = [
  { id: "orders", label: "Work orders" },
  { id: "variance", label: "Variance" },
  { id: "centers", label: "Work centers" },
  { id: "boms", label: "BOMs" },
] as const;

export default function ProductionPage() {
  const org = useCurrentOrg();
  const admin = isAdmin(org.role);
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("orders");
  return (
    <div className="space-y-6">
      <PageHeader title="Production" description="Work centers, recipes (BOMs) and work orders. The floor posts usage and output; the ledger keeps score." />
      <div role="tablist" className="flex gap-1 border-b">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn("-mb-px border-b-2 px-3 py-2 text-sm font-medium", tab === t.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "orders" && <WorkOrders orgId={org.id} admin={admin} />}
      {tab === "variance" && <VarianceList orgId={org.id} />}
      {tab === "centers" && <WorkCenters orgId={org.id} admin={admin} />}
      {tab === "boms" && <Boms orgId={org.id} admin={admin} />}
    </div>
  );
}
