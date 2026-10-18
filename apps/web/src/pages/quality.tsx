import { DISPOSITIONS, DISPOSITION_LABELS, type DispositionType, type Ncr } from "@invintel/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { invalidateOrg, isAdmin, orgKey, useCurrentOrg, useLocations } from "@/lib/org";
import { cn } from "@/lib/utils";

const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");

function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn("grid gap-1 text-sm", className)}>
      <span className="font-medium">{label}</span>
      {children}
    </label>
  );
}

// ---------- put something on hold ----------

function HoldForm({ orgId, reasons }: { orgId: string; reasons: string[] }) {
  const qc = useQueryClient();
  const { data: locations = [] } = useLocations(orgId);
  const items = useQuery({ queryKey: orgKey(orgId, "items"), queryFn: () => api.listItems(orgId) });
  const [mode, setMode] = useState<"stock" | "unit">("stock");
  const [itemId, setItemId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unitCode, setUnitCode] = useState("");
  const [reason, setReason] = useState(reasons[0] ?? "");
  const [lot, setLot] = useState("");
  const [note, setNote] = useState("");

  const plain = (items.data ?? []).filter((i) => i.tracking !== "unit");
  const chosen = plain.find((i) => i.id === itemId);
  const places = locations.filter((l) => l.type !== "quarantine" && (!chosen || chosen.stock.some((s) => s.locationId === l.id)));
  const have = chosen?.stock.find((s) => s.locationId === locationId)?.quantity ?? 0;

  const hold = useMutation({
    mutationFn: async () => {
      if (mode === "unit") {
        const r = await api.lookup(orgId, unitCode.trim());
        if (r.kind !== "unit") throw new Error(r.kind === "none" ? `Nothing matches "${unitCode}"` : "That isn't a roll or pallet label");
        return api.putOnHold(orgId, { unitId: r.unit.id, reason, note });
      }
      return api.putOnHold(orgId, { itemId, locationId, quantity: Number(quantity), reason, note, supplierLot: lot });
    },
    onSuccess: (n) => {
      toast.success(`${n.number}: ${n.unitCode ?? `${n.quantity.toLocaleString()} × ${n.itemName}`} is on hold`);
      setNote("");
      setUnitCode("");
      void invalidateOrg(qc, orgId);
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  const ready = reason && (mode === "unit" ? unitCode.trim() : itemId && locationId && Number(quantity) >= 1 && Number(quantity) <= have);
  return (
    <form className="space-y-3 rounded-lg border p-4" onSubmit={(e) => { e.preventDefault(); hold.mutate(); }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">Put something on hold</h2>
        <div role="tablist" className="flex gap-1 rounded-md bg-muted p-1 text-sm">
          {(["stock", "unit"] as const).map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)} className={cn("rounded px-2.5 py-1", mode === m ? "bg-background font-medium shadow-xs" : "text-muted-foreground")}>
              {m === "stock" ? "Stock" : "Roll or pallet"}
            </button>
          ))}
        </div>
      </div>
      {mode === "stock" ? (
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Item">
            <select className={selectClass} value={itemId} onChange={(e) => { setItemId(e.target.value); setLocationId(""); }}>
              <option value="">Pick an item</option>
              {plain.filter((i) => i.quantity > 0).map((i) => <option key={i.id} value={i.id}>{i.name} ({i.sku})</option>)}
            </select>
          </Field>
          <Field label="Where it is">
            <select className={selectClass} value={locationId} onChange={(e) => setLocationId(e.target.value)} disabled={!itemId}>
              <option value="">Pick a place</option>
              {places.map((l) => <option key={l.id} value={l.id}>{l.path}</option>)}
            </select>
          </Field>
          <Field label={locationId ? `How many (up to ${have.toLocaleString()})` : "How many"}>
            <Input type="number" min={1} max={have || undefined} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </Field>
          <Field label="Supplier lot (optional)"><Input maxLength={64} value={lot} onChange={(e) => setLot(e.target.value)} /></Field>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Label code" className="sm:col-span-2"><Input placeholder="Scan or type, e.g. U-000123" value={unitCode} onChange={(e) => setUnitCode(e.target.value)} /></Field>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Why">
          <select className={selectClass} value={reason} onChange={(e) => setReason(e.target.value)}>
            {reasons.map((r) => <option key={r}>{r}</option>)}
          </select>
        </Field>
        <Field label="Note (optional)" className="sm:col-span-3"><Input maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
      <Button type="submit" disabled={!ready || hold.isPending}><ShieldAlert /> Put on hold</Button>
    </form>
  );
}

// ---------- one NCR ----------

function Decide({ orgId, ncr, scrapReasons }: { orgId: string; ncr: Ncr; scrapReasons: string[] }) {
  const qc = useQueryClient();
  const { data: locations = [] } = useLocations(orgId);
  const [type, setType] = useState<DispositionType>("use");
  const [quantity, setQuantity] = useState(String(ncr.remaining));
  const [toId, setToId] = useState("");
  const [reason, setReason] = useState(scrapReasons[0] ?? "");
  const [note, setNote] = useState("");
  const places = locations.filter((l) => l.type !== "quarantine");
  const decide = useMutation({
    mutationFn: () =>
      api.disposeNcr(orgId, ncr.id, {
        type,
        ...(ncr.unitId ? {} : { quantity: Number(quantity) }),
        ...((type === "use" || type === "rework") && toId ? { toLocationId: toId } : {}),
        ...(type === "scrap" ? { reason } : {}),
        note,
      }),
    onSuccess: (n) => {
      toast.success(n.status === "closed" ? `${n.number} is closed` : `${n.remaining.toLocaleString()} still on hold`);
      void invalidateOrg(qc, orgId);
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <form className="grid gap-3 bg-muted/30 p-4 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); decide.mutate(); }}>
      <Field label="Decision">
        <select className={selectClass} value={type} onChange={(e) => setType(e.target.value as DispositionType)}>
          {DISPOSITIONS.map((d) => <option key={d} value={d}>{DISPOSITION_LABELS[d]}</option>)}
        </select>
      </Field>
      {!ncr.unitId && (
        <Field label={`How many (of ${ncr.remaining.toLocaleString()})`}>
          <Input type="number" min={1} max={ncr.remaining} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </Field>
      )}
      {(type === "use" || type === "rework") && (
        <Field label="Put it in">
          <select className={selectClass} value={toId} onChange={(e) => setToId(e.target.value)}>
            <option value="">Where it came from ({ncr.fromLocationPath})</option>
            {places.map((l) => <option key={l.id} value={l.id}>{l.path}</option>)}
          </select>
        </Field>
      )}
      {type === "scrap" && (
        <Field label="Scrap reason">
          <select className={selectClass} value={reason} onChange={(e) => setReason(e.target.value)}>
            {scrapReasons.map((r) => <option key={r}>{r}</option>)}
          </select>
        </Field>
      )}
      <Field label="Note (optional)"><Input maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <div className="sm:col-span-4">
        <Button type="submit" disabled={decide.isPending || (!ncr.unitId && (Number(quantity) < 1 || Number(quantity) > ncr.remaining))}>Record decision</Button>
      </div>
    </form>
  );
}

function NcrTable({ orgId, rows, admin, scrapReasons }: { orgId: string; rows: Ncr[]; admin: boolean; scrapReasons: string[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr><th className="p-2">Hold</th><th className="p-2">What</th><th className="p-2">Why</th><th className="p-2 text-right">Left</th><th className="p-2">When</th></tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((n) => (
            <Fragment key={n.id}>
              <tr className="cursor-pointer hover:bg-muted/40" onClick={() => setOpen(open === n.id ? null : n.id)}>
                <td className="p-2 font-medium">{n.number}{n.source === "receiving" && <Badge variant="secondary" className="ml-1">Receiving</Badge>}</td>
                <td className="p-2">
                  {n.unitCode ?? `${n.quantity.toLocaleString()} × ${n.itemName}`}
                  <span className="block text-xs text-muted-foreground">{n.unitCode ? `${n.itemName} · ` : ""}{n.heldAtPath}{n.supplierLot ? ` · lot ${n.supplierLot}` : ""}{n.purchaseOrderNumber ? ` · ${n.purchaseOrderNumber}` : ""}</span>
                </td>
                <td className="p-2">{n.reason}{n.note && <span className="block text-xs text-muted-foreground">{n.note}</span>}</td>
                <td className="p-2 text-right tabular-nums">{n.remaining.toLocaleString()} / {n.quantity.toLocaleString()}</td>
                <td className="whitespace-nowrap p-2 text-xs text-muted-foreground">{formatDateTime(n.heldAt)}<span className="block">{n.heldBy}</span></td>
              </tr>
              {open === n.id && (
                <tr>
                  <td colSpan={5} className="p-0">
                    {n.dispositions.length > 0 && (
                      <ul className="space-y-1 p-3 text-sm">
                        {n.dispositions.map((d, i) => (
                          <li key={i}>
                            <strong className="capitalize">{d.type}</strong> {d.quantity.toLocaleString()}{d.toLocationPath ? ` to ${d.toLocationPath}` : ""}{d.reason ? ` (${d.reason})` : ""} · {d.by}, {formatDateTime(d.at)}{d.note ? ` · ${d.note}` : ""}
                          </li>
                        ))}
                      </ul>
                    )}
                    {n.status === "open" && (admin ? <Decide orgId={orgId} ncr={n} scrapReasons={scrapReasons} /> : <p className="p-3 text-sm text-muted-foreground">An admin decides what happens to this.</p>)}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- reasons ----------

function ReasonEditor({ orgId, label, kind, list }: { orgId: string; label: string; kind: "hold" | "scrap"; list: string[] }) {
  const qc = useQueryClient();
  const [text, setText] = useState<string | null>(null);
  const value = text ?? list.join("\n");
  const save = useMutation({
    mutationFn: () => api.saveReasons(orgId, { [kind]: value.split("\n").map((x) => x.trim()).filter(Boolean) }),
    onSuccess: () => { toast.success(`${label} list saved`); setText(null); void invalidateOrg(qc, orgId); },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <div className="space-y-2">
      <Field label={`${label} (one per line, up to 20)`}>
        <textarea className="min-h-32 w-full rounded-md border border-input bg-transparent p-2 text-sm" value={value} onChange={(e) => setText(e.target.value)} />
      </Field>
      <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || text === null}>Save</Button>
    </div>
  );
}

export default function QualityPage() {
  const org = useCurrentOrg();
  const admin = isAdmin(org.role);
  const [tab, setTab] = useState<"open" | "closed" | "reasons">("open");
  const reasons = useQuery({ queryKey: orgKey(org.id, "reasons"), queryFn: () => api.reasons(org.id) });
  const ncrs = useQuery({ queryKey: orgKey(org.id, "ncrs"), queryFn: () => api.ncrs(org.id) });
  const rows = (ncrs.data ?? []).filter((n) => n.status === tab);
  const TABS: { id: "open" | "closed" | "reasons"; label: string }[] = [
    { id: "open", label: `Open${ncrs.data ? ` (${ncrs.data.filter((n) => n.status === "open").length})` : ""}` },
    { id: "closed", label: "Closed" },
    ...(admin ? [{ id: "reasons" as const, label: "Reason lists" }] : []),
  ];
  return (
    <div className="space-y-6">
      <PageHeader title="Quality" description="Hold stock that shouldn't be used, then decide: use it, rework it, scrap it or send it back. Every step goes in the ledger." />
      {reasons.data && <HoldForm orgId={org.id} reasons={reasons.data.hold} />}
      <div role="tablist" className="flex gap-1 border-b">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={cn("-mb-px border-b-2 px-3 py-2 text-sm font-medium", tab === t.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "reasons" ? (
        reasons.data && (
          <div className="grid gap-6 sm:grid-cols-2">
            <ReasonEditor orgId={org.id} label="Quality hold reasons" kind="hold" list={reasons.data.hold} />
            <ReasonEditor orgId={org.id} label="Scrap reasons (also used on the floor)" kind="scrap" list={reasons.data.scrap} />
          </div>
        )
      ) : rows.length === 0 ? (
        <EmptyState icon={ShieldAlert} title={tab === "open" ? "Nothing on hold" : "No closed holds yet"} description={tab === "open" ? "Stock on hold shows up here until an admin decides what to do with it." : "Holds appear here once every piece of them has a decision."} />
      ) : (
        reasons.data && <NcrTable orgId={org.id} rows={rows} admin={admin} scrapReasons={reasons.data.scrap} />
      )}
    </div>
  );
}
