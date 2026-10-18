import { formatQty, type Item, type PurchaseOrder, type Shipment, type Supplier } from "@invintel/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, PackageCheck, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { invalidateOrg, orgKey, useLocations } from "@/lib/org";
import { qtyText, readQtyEntry } from "@/lib/qty";

const selectClass = "h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-sm";

export const SHIPMENT_STATUS: Record<Shipment["status"], { label: string; className: string }> = {
  expected: { label: "On its way", className: "bg-accent text-accent-foreground" },
  partial: { label: "Partly received", className: "bg-warning-soft text-warning" },
  received: { label: "Received", className: "bg-success-soft text-success" },
  cancelled: { label: "Cancelled", className: "bg-secondary text-secondary-foreground" },
};

interface Row { key: number; itemId: string; qty: string; lot: string }

/** Note down a supplier's advance ship notice: what they say is coming. It changes no stock until it is received. */
export function ShipmentForm({ orgId, onClose, onSaved }: { orgId: string; onClose: () => void; onSaved: (s: Shipment) => void }) {
  const qc = useQueryClient();
  const suppliers = useQuery({ queryKey: orgKey(orgId, "suppliers"), queryFn: () => api.listSuppliers(orgId) });
  const items = useQuery({ queryKey: orgKey(orgId, "items"), queryFn: () => api.listItems(orgId) });
  const orders = useQuery({ queryKey: orgKey(orgId, "orders"), queryFn: () => api.listOrders(orgId) });
  const [supplierId, setSupplierId] = useState("");
  const [poId, setPoId] = useState("");
  const [reference, setReference] = useState("");
  const [carrier, setCarrier] = useState("");
  const [tracking, setTracking] = useState("");
  const [shipDate, setShipDate] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [rows, setRows] = useState<Row[]>([{ key: 0, itemId: "", qty: "", lot: "" }]);
  const [seq, setSeq] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const itemById = new Map((items.data ?? []).map((i: Item) => [i.id, i]));
  const supplierOrders = (orders.data ?? []).filter((o: PurchaseOrder) => o.supplierId === supplierId && (o.status === "ordered" || o.status === "partial"));
  const set = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const fill = () => {
    const o = orders.data?.find((x: PurchaseOrder) => x.id === poId);
    if (!o) return;
    const next = o.lines.filter((l) => l.quantity > l.received).map((l, i) => ({ key: seq + i, itemId: l.itemId, qty: qtyText(l.quantity - l.received, l.uom), lot: "" }));
    setSeq(seq + next.length);
    if (next.length) setRows(next);
  };
  const save = useMutation({
    mutationFn: () => {
      const lines = rows.map((r, i) => {
        const item = itemById.get(r.itemId);
        if (!item) throw new Error(`Line ${i + 1}: choose an item`);
        const q = readQtyEntry(r.qty, { uom: item });
        if (!q.ok || q.stored < 1) throw new Error(`Line ${i + 1}: enter a valid quantity`);
        return { itemId: r.itemId, quantity: q.stored, supplierLot: r.lot };
      });
      return api.createShipment(orgId, { supplierId, purchaseOrderId: poId || null, reference, carrier, tracking, shipDate: shipDate || null, expectedDate: expectedDate || null, lines });
    },
    onSuccess: async (s) => { await invalidateOrg(qc, orgId); toast.success(`Recorded ${s.number}`); onSaved(s); },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader><DialogTitle>Record a shipment that is on its way</DialogTitle></DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); setError(null); if (!supplierId) return setError("Choose the supplier"); save.mutate(); }} className="grid max-h-[70vh] gap-4 overflow-auto pr-1">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5"><Label htmlFor="sh-supplier">Supplier</Label><select id="sh-supplier" className={selectClass} value={supplierId} onChange={(e) => { setSupplierId(e.target.value); setPoId(""); }} required><option value="">Choose…</option>{(suppliers.data ?? []).map((s: Supplier) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
            <div className="grid gap-1.5"><Label htmlFor="sh-po">Purchase order</Label><select id="sh-po" className={selectClass} value={poId} onChange={(e) => setPoId(e.target.value)}><option value="">None</option>{supplierOrders.map((o: PurchaseOrder) => <option key={o.id} value={o.id}>{o.number} · {o.status}</option>)}</select></div>
            <div className="grid gap-1.5"><Label htmlFor="sh-ref">Their reference (ASN or packing slip)</Label><Input id="sh-ref" value={reference} onChange={(e) => setReference(e.target.value)} required maxLength={64} /></div>
            <div className="grid gap-1.5"><Label htmlFor="sh-carrier">Carrier</Label><Input id="sh-carrier" value={carrier} onChange={(e) => setCarrier(e.target.value)} maxLength={80} /></div>
            <div className="grid gap-1.5"><Label htmlFor="sh-track">Tracking</Label><Input id="sh-track" value={tracking} onChange={(e) => setTracking(e.target.value)} maxLength={120} /></div>
            <div className="grid grid-cols-2 gap-2"><div className="grid gap-1.5"><Label htmlFor="sh-ship">Shipped</Label><Input id="sh-ship" type="date" value={shipDate} onChange={(e) => setShipDate(e.target.value)} /></div><div className="grid gap-1.5"><Label htmlFor="sh-exp">Expected</Label><Input id="sh-exp" type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} /></div></div>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between"><h3 className="text-sm font-medium">What is on it</h3><Button type="button" size="sm" variant="outline" disabled={!poId} onClick={fill}>Fill from what is still to come</Button></div>
            {rows.map((r, i) => {
              const item = itemById.get(r.itemId);
              return (
                <div key={r.key} className="grid grid-cols-[1fr_7rem_8rem_2rem] items-center gap-2">
                  <select aria-label={`Item for line ${i + 1}`} className={selectClass} value={r.itemId} onChange={(e) => set(r.key, { itemId: e.target.value })}><option value="">Choose an item…</option>{(items.data ?? []).map((it: Item) => <option key={it.id} value={it.id} disabled={rows.some((x) => x.key !== r.key && x.itemId === it.id)}>{it.name} ({it.sku})</option>)}</select>
                  <div className="relative"><Input aria-label={`Quantity for line ${i + 1}`} inputMode="decimal" placeholder="Qty" value={r.qty} onChange={(e) => set(r.key, { qty: e.target.value })} className={item && item.unit !== "ea" ? "pr-9" : ""} />{item && item.unit !== "ea" && <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-muted-foreground">{item.unit}</span>}</div>
                  <Input aria-label={`Supplier lot for line ${i + 1}`} placeholder="Their lot" value={r.lot} onChange={(e) => set(r.key, { lot: e.target.value })} maxLength={64} />
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove line ${i + 1}`} disabled={rows.length === 1} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}><Trash2 /></Button>
                </div>
              );
            })}
            <Button type="button" variant="ghost" size="sm" onClick={() => { setRows((rs) => [...rs, { key: seq, itemId: "", qty: "", lot: "" }]); setSeq(seq + 1); }}><Plus /> Add a line</Button>
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" disabled={save.isPending}>Record shipment</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A shipment's lines, what has arrived, and receiving the rest. */
export function ShipmentDetail({ orgId, id, admin, onClose }: { orgId: string; id: string; admin: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: orgKey(orgId, "shipment", id), queryFn: () => api.listShipments(orgId).then((all) => all.find((s) => s.id === id)!) });
  const { data: locations = [] } = useLocations(orgId);
  const [locationId, setLocationId] = useState("");
  const [inspect, setInspect] = useState(false);
  const [arrived, setArrived] = useState<Record<string, string>>({});
  const s = q.data;
  const receivingFirst = [...locations].sort((a, b) => Number(b.type === "receiving") - Number(a.type === "receiving"));
  const where = locationId || receivingFirst[0]?.id || "";
  const shownQty = (l: Shipment["lines"][number]) => arrived[l.itemId] ?? qtyText(Math.max(0, l.quantity - l.received), l.uom);

  const receive = useMutation({
    mutationFn: () => {
      if (!s) throw new Error("Not loaded");
      const lines = s.lines.flatMap((l) => {
        const r = readQtyEntry(shownQty(l), { uom: l.uom });
        if (!r.ok) throw new Error(`${l.itemName}: that isn't a valid quantity`);
        return r.stored > 0 ? [{ itemId: l.itemId, quantity: r.stored }] : [];
      });
      if (!lines.length) throw new Error("Enter what arrived");
      return api.receiveShipment(orgId, id, { locationId: where, lines, inspect });
    },
    onSuccess: async (r) => { await invalidateOrg(qc, orgId); toast.success(r.ncrs?.length ? `Received and put on quality hold (${r.ncrs.map((n) => n.number).join(", ")})` : `Received. ${r.shipment.number} is ${SHIPMENT_STATUS[r.shipment.status].label.toLowerCase()}.`); setArrived({}); },
    onError: (e: Error) => toast.error(e.message),
  });
  const cancel = useMutation({
    mutationFn: () => api.cancelShipment(orgId, id),
    onSuccess: async () => { await invalidateOrg(qc, orgId); toast.success("Shipment cancelled"); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader><DialogTitle className="flex flex-wrap items-center gap-2">{s ? `${s.number} · ${s.supplierName} · ${s.reference}` : "Shipment"}{s && <Badge variant="secondary" className={SHIPMENT_STATUS[s.status].className}>{SHIPMENT_STATUS[s.status].label}</Badge>}</DialogTitle></DialogHeader>
        {!s ? <p className="text-sm text-muted-foreground">Loading…</p> : (
          <div className="grid max-h-[70vh] gap-4 overflow-auto pr-1 text-sm">
            <p className="text-muted-foreground">{s.purchaseOrderNumber ? `Against ${s.purchaseOrderNumber}` : "No purchase order"}{s.carrier ? ` · ${s.carrier}` : ""}{s.tracking ? ` · ${s.tracking}` : ""}{s.expectedDate ? ` · expected ${s.expectedDate}` : ""}</p>
            {s.warnings.length > 0 && <ul className="space-y-1 rounded-lg bg-warning-soft p-2 text-warning">{s.warnings.map((w) => <li key={w} className="flex items-start gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0" /><span>{w}</span></li>)}</ul>}
            <div className="overflow-auto rounded-lg border">
              <table className="w-full min-w-[32rem]">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground"><tr><th className="p-2">Item</th><th className="p-2 text-right">Expected</th><th className="p-2 text-right">Received</th>{s.status !== "cancelled" && <th className="w-32 p-2 text-right">Arrived now</th>}</tr></thead>
                <tbody className="divide-y">
                  {s.lines.map((l) => (
                    <tr key={l.itemId}>
                      <td className="p-2"><div className="font-medium">{l.itemName}</div><div className="font-mono text-xs text-muted-foreground">{l.itemSku}{l.supplierLot ? ` · lot ${l.supplierLot}` : ""}</div></td>
                      <td className="p-2 text-right tabular-nums">{formatQty(l.quantity, l.uom)}</td>
                      <td className="p-2 text-right tabular-nums">{formatQty(l.received, l.uom, { unit: false })}</td>
                      {s.status !== "cancelled" && <td className="p-2"><Input aria-label={`Arrived now: ${l.itemName}`} className="h-8 text-right" inputMode="decimal" value={shownQty(l)} onChange={(e) => setArrived({ ...arrived, [l.itemId]: e.target.value })} /></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {s.status !== "cancelled" && (
              <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                <div className="grid gap-1.5"><Label htmlFor="sh-where">Put it in</Label><select id="sh-where" className={selectClass} value={where} onChange={(e) => setLocationId(e.target.value)}>{receivingFirst.map((l) => <option key={l.id} value={l.id}>{l.path}</option>)}</select></div>
                {s.purchaseOrderId && <label className="flex items-center gap-2"><input type="checkbox" className="size-4" checked={inspect} onChange={(e) => setInspect(e.target.checked)} /> Hold for inspection</label>}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {s.status !== "cancelled" && <Button onClick={() => receive.mutate()} disabled={receive.isPending || !where}><PackageCheck /> Receive what arrived</Button>}
              {admin && s.status === "expected" && <Button variant="ghost" className="text-destructive" onClick={() => cancel.mutate()} disabled={cancel.isPending}>Cancel shipment</Button>}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
