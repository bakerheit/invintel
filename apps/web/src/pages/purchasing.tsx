import type { PoStatus, PurchaseOrder, Supplier } from "@invintel/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Mail, PackageCheck, Phone, Plus, ShoppingCart, Trash2, Truck } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { centsToDollars, dollarsToCents, formatCents } from "@/lib/format";
import { invalidateOrg, isAdmin, orgKey, useCurrentOrg, useLocations } from "@/lib/org";
import { cn } from "@/lib/utils";

const STATUS: Record<PoStatus, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-secondary text-secondary-foreground" },
  ordered: { label: "Ordered", className: "bg-accent text-accent-foreground" },
  partial: { label: "Partly received", className: "bg-warning-soft text-warning" },
  received: { label: "Received", className: "bg-success-soft text-success" },
  cancelled: { label: "Cancelled", className: "bg-destructive/10 text-destructive" },
};

const StatusPill = ({ status, short }: { status: PoStatus; short?: boolean }) => (
  <Badge variant="secondary" className={STATUS[status].className}>{short ? "Closed short" : STATUS[status].label}</Badge>
);

function SupplierSelect({ value, onChange, suppliers }: { value: string; onChange: (id: string) => void; suppliers: Supplier[] }) {
  return (
    <Select value={value} onValueChange={(v) => v && onChange(v)} items={suppliers.map((s) => ({ value: s.id, label: s.name }))}>
      <SelectTrigger aria-label="Supplier" className="w-full"><SelectValue placeholder="Choose a supplier" /></SelectTrigger>
      <SelectContent>{suppliers.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
    </Select>
  );
}

function SupplierDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { id: orgId } = useCurrentOrg();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (f: FormData) => api.createSupplier(orgId, { name: String(f.get("name")), contact: String(f.get("contact") ?? ""), email: String(f.get("email") ?? ""), phone: String(f.get("phone") ?? "") }),
    onSuccess: async (s) => { await invalidateOrg(qc, orgId); toast.success(`Added ${s.name}`); onOpenChange(false); },
    onError: (e: Error) => setError(e.message),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>New supplier</DialogTitle></DialogHeader>
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); setError(null); save.mutate(new FormData(e.currentTarget)); }}>
          {([["name", "Name", true], ["contact", "Contact person"], ["email", "Email"], ["phone", "Phone"]] as const).map(([name, label, req]) => (
            <div key={name} className="grid gap-1.5"><Label htmlFor={`s-${name}`}>{label}</Label><Input id={`s-${name}`} name={name} required={!!req} maxLength={name === "name" ? 100 : 200} /></div>
          ))}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={save.isPending}>Add supplier</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface Draft { itemId: string; quantity: string; cost: string }

function OrderDialog({ open, onOpenChange, suppliers }: { open: boolean; onOpenChange: (o: boolean) => void; suppliers: Supplier[] }) {
  const { id: orgId } = useCurrentOrg();
  const qc = useQueryClient();
  const items = useQuery({ queryKey: orgKey(orgId, "items"), queryFn: () => api.listItems(orgId), enabled: open });
  const [supplierId, setSupplierId] = useState("");
  const [date, setDate] = useState("");
  const [lines, setLines] = useState<Draft[]>([{ itemId: "", quantity: "", cost: "" }]);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.createOrder(orgId, {
      supplierId, expectedDate: date || null,
      lines: lines.map((l) => ({ itemId: l.itemId, quantity: Number(l.quantity), unitCostCents: dollarsToCents(l.cost) })),
    }),
    onSuccess: async (o) => { await invalidateOrg(qc, orgId); toast.success(`Created ${o.number} as a draft`); onOpenChange(false); setLines([{ itemId: "", quantity: "", cost: "" }]); },
    onError: (e: Error) => setError(e.message),
  });
  const set = (i: number, patch: Partial<Draft>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const ready = supplierId && lines.every((l) => l.itemId && Number(l.quantity) > 0);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader><DialogTitle>New purchase order</DialogTitle><DialogDescription>Saved as a draft. Nothing is ordered until you place it.</DialogDescription></DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5"><Label>Supplier</Label><SupplierSelect value={supplierId} onChange={setSupplierId} suppliers={suppliers} /></div>
            <div className="grid gap-1.5"><Label htmlFor="po-date">Expected by</Label><Input id="po-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          </div>
          <div className="space-y-2">
            <Label>Lines</Label>
            {lines.map((l, i) => (
              <div key={i} className="grid grid-cols-[1fr_5rem_6rem_2rem] items-center gap-2">
                <Select value={l.itemId} onValueChange={(v) => { const it = items.data?.find((x) => x.id === v); set(i, { itemId: v ?? "", cost: l.cost || (it ? centsToDollars(it.unitCostCents) : "") }); }}
                  items={(items.data ?? []).map((x) => ({ value: x.id, label: `${x.name} (${x.sku})` }))}>
                  <SelectTrigger aria-label={`Item for line ${i + 1}`} className="w-full"><SelectValue placeholder="Choose an item" /></SelectTrigger>
                  <SelectContent>{(items.data ?? []).map((x) => <SelectItem key={x.id} value={x.id} disabled={lines.some((o, j) => j !== i && o.itemId === x.id)}>{x.name} ({x.sku})</SelectItem>)}</SelectContent>
                </Select>
                <Input aria-label="Quantity" type="number" min={1} placeholder="Qty" value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} />
                <Input aria-label="Unit cost" type="number" min={0} step="0.01" placeholder="Cost" value={l.cost} onChange={(e) => set(i, { cost: e.target.value })} />
                <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove line" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><Trash2 /></Button>
              </div>
            ))}
            <Button type="button" variant="ghost" size="sm" onClick={() => setLines((ls) => [...ls, { itemId: "", quantity: "", cost: "" }])}><Plus /> Add a line</Button>
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={!ready || create.isPending} onClick={() => { setError(null); create.mutate(); }}>Save draft</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OrderDetail({ order, onClose }: { order: PurchaseOrder; onClose: () => void }) {
  const { id: orgId, role } = useCurrentOrg();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: locations = [] } = useLocations(orgId);
  const receivingFirst = [...locations].sort((a, b) => Number(b.type === "receiving") - Number(a.type === "receiving"));
  const [locationId, setLocationId] = useState("");
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(order.lines.map((l) => [l.itemId, String(Math.max(0, l.quantity - l.received))])));
  const where = locationId || receivingFirst[0]?.id || "";
  const done = async (msg: string) => { await invalidateOrg(qc, orgId); toast.success(msg); };
  const act = useMutation({
    mutationFn: (a: "place" | "cancel" | "close") => api.orderAction(orgId, order.id, a),
    onSuccess: async (o) => {
      await done("approvalRequired" in o ? `${o.approval.number} sent for approval. The order goes out when an admin approves.` : `${o.number} is ${o.status === "received" ? "closed" : o.status}`);
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const receive = useMutation({
    mutationFn: () => api.receiveOrder(orgId, order.id, { locationId: where, lines: order.lines.map((l) => ({ itemId: l.itemId, quantity: Number(qty[l.itemId] || 0) })).filter((l) => l.quantity > 0) }),
    onSuccess: async (r) => {
      await done(r.overReceived.length ? `Received. ${r.overReceived.map((o) => `${o.itemName} is ${o.over} over`).join(", ")}` : `Received against ${r.order.number}`);
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const open = order.status === "ordered" || order.status === "partial";
  const admin = isAdmin(role);
  const anyQty = order.lines.some((l) => Number(qty[l.itemId] || 0) > 0);
  const ask = async (a: "cancel" | "close") => {
    if (await confirm(a === "cancel"
      ? { title: `Cancel ${order.number}?`, description: "Nothing has been received, so no stock changes.", confirmLabel: "Cancel order", destructive: true }
      : { title: `Close ${order.number} short?`, description: "The lines still missing won't be expected any more. What arrived stays in stock.", confirmLabel: "Close short" })) act.mutate(a);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">{order.number} <StatusPill status={order.status} short={order.closedShort} /></DialogTitle>
          <DialogDescription>{order.supplierName}{order.expectedDate ? ` · expected ${order.expectedDate}` : ""}{order.note ? ` · ${order.note}` : ""}</DialogDescription>
        </DialogHeader>
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground"><tr><th className="p-2">Item</th><th className="p-2 text-right">Ordered</th><th className="p-2 text-right">Received</th><th className="p-2 text-right">Cost</th>{open && <th className="w-24 p-2 text-right">Receive now</th>}</tr></thead>
            <tbody className="divide-y">
              {order.lines.map((l) => (
                <tr key={l.itemId}>
                  <td className="p-2"><div className="font-medium">{l.itemName}</div><div className="font-mono text-xs text-muted-foreground">{l.itemSku}</div></td>
                  <td className="p-2 text-right tabular-nums">{l.quantity.toLocaleString()}</td>
                  <td className={cn("p-2 text-right tabular-nums", l.received > l.quantity && "text-warning", l.received >= l.quantity && "font-medium")}>{l.received.toLocaleString()}</td>
                  <td className="p-2 text-right tabular-nums">{formatCents(l.unitCostCents)}</td>
                  {open && <td className="p-2"><Input aria-label={`Receive ${l.itemName}`} className="h-8 text-right" type="number" min={0} value={qty[l.itemId] ?? ""} onChange={(e) => setQty((q) => ({ ...q, [l.itemId]: e.target.value }))} /></td>}
                </tr>
              ))}
            </tbody>
            <tfoot><tr className="border-t bg-muted/30 font-medium"><td className="p-2">Total</td><td className="p-2 text-right tabular-nums">{order.orderedUnits.toLocaleString()}</td><td className="p-2 text-right tabular-nums">{order.receivedUnits.toLocaleString()}</td><td className="p-2 text-right tabular-nums">{formatCents(order.totalCents)}</td>{open && <td />}</tr></tfoot>
          </table>
        </div>
        {open && (
          <div className="grid gap-1.5">
            <Label>Put it in</Label>
            <Select value={where} onValueChange={(v) => v && setLocationId(v)} items={receivingFirst.map((l) => ({ value: l.id, label: l.path }))}>
              <SelectTrigger aria-label="Receive into" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{receivingFirst.map((l) => <SelectItem key={l.id} value={l.id}>{l.path}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        )}
        <DialogFooter className="sm:justify-between">
          <div className="flex gap-2">
            {admin && (order.status === "draft" || order.status === "ordered") && <Button variant="ghost" className="text-destructive" onClick={() => void ask("cancel")}>Cancel order</Button>}
            {admin && order.status === "partial" && <Button variant="ghost" onClick={() => void ask("close")}>Close short</Button>}
          </div>
          <div className="flex gap-2">
            {admin && order.status === "draft" && <Button onClick={() => act.mutate("place")} disabled={act.isPending}><Check /> Place order</Button>}
            {open && <Button onClick={() => receive.mutate()} disabled={!anyQty || !where || receive.isPending}><PackageCheck /> Receive</Button>}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Suggestions({ suppliers }: { suppliers: Supplier[] }) {
  const { id: orgId } = useCurrentOrg();
  const qc = useQueryClient();
  const suggestions = useQuery({ queryKey: orgKey(orgId, "suggestions"), queryFn: () => api.suggestions(orgId) });
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [supplierId, setSupplierId] = useState("");
  const rows = suggestions.data ?? [];
  const picked = rows.filter((r) => !skip.has(r.itemId));
  const draft = useMutation({
    mutationFn: () => api.orderFromSuggestions(orgId, { supplierId, itemIds: picked.map((r) => r.itemId) }),
    onSuccess: async (o) => { await invalidateOrg(qc, orgId); toast.success(`Created ${o.number} as a draft. Review it, then place it.`); },
    onError: (e: Error) => toast.error(e.message),
  });
  if (!rows.length) return null;
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Truck className="size-4" /> Running low <span className="text-sm font-normal text-muted-foreground">· order enough to get back to twice the reorder level</span></CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <ul className="divide-y">
          {rows.map((r) => (
            <li key={r.itemId} className="flex items-center gap-3 py-2 text-sm">
              <input type="checkbox" className="size-4" aria-label={`Include ${r.name}`} checked={!skip.has(r.itemId)}
                onChange={(e) => setSkip((s) => { const n = new Set(s); if (e.target.checked) n.delete(r.itemId); else n.add(r.itemId); return n; })} />
              <div className="min-w-0 flex-1"><p className="truncate font-medium">{r.name}</p><p className="truncate text-xs text-muted-foreground">{r.sku} · {r.quantity} on hand, reorder at {r.reorderLevel}{r.onOrder ? `, ${r.onOrder} already on order` : ""}</p></div>
              <span className="shrink-0 tabular-nums font-medium">+{r.suggestedQuantity.toLocaleString()}</span>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-56"><SupplierSelect value={supplierId} onChange={setSupplierId} suppliers={suppliers} /></div>
          <Button disabled={!supplierId || !picked.length || draft.isPending} onClick={() => draft.mutate()}><ShoppingCart /> Draft an order for {picked.length}</Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function PurchasingPage() {
  const { id: orgId, role } = useCurrentOrg();
  const admin = isAdmin(role);
  const orders = useQuery({ queryKey: orgKey(orgId, "orders"), queryFn: () => api.listOrders(orgId) });
  const suppliers = useQuery({ queryKey: orgKey(orgId, "suppliers"), queryFn: () => api.listSuppliers(orgId) });
  const [selected, setSelected] = useState<string | null>(null);
  const [newOrder, setNewOrder] = useState(false);
  const [newSupplier, setNewSupplier] = useState(false);
  const list = orders.data ?? [];
  const sup: Supplier[] = suppliers.data ?? [];
  const current = list.find((o) => o.id === selected);
  const rank: Record<PoStatus, number> = { partial: 0, ordered: 1, draft: 2, received: 3, cancelled: 4 };
  const sorted = [...list].sort((a, b) => rank[a.status] - rank[b.status] || b.number.localeCompare(a.number));
  const header: ReactNode = admin ? (
    <>
      <Button variant="outline" onClick={() => setNewSupplier(true)}><Plus /> Supplier</Button>
      <Button onClick={() => (sup.length ? setNewOrder(true) : setNewSupplier(true))}><Plus /> New order</Button>
    </>
  ) : undefined;

  return (
    <>
      <PageHeader title="Purchasing" description="What's running low, what's on order, and what's due in." actions={header} />
      {admin && <Suggestions suppliers={sup} />}
      <Card>
        <CardHeader><CardTitle>Purchase orders</CardTitle></CardHeader>
        <CardContent>
          {!sorted.length ? (
            <EmptyState icon={ShoppingCart} title="No orders yet" description={admin ? "Add a supplier, then write your first order." : "Orders will show up here once an admin places them."} />
          ) : (
            <ul className="divide-y">
              {sorted.map((o) => (
                <li key={o.id}>
                  <button type="button" onClick={() => setSelected(o.id)} className="flex w-full items-center gap-3 py-3 text-left text-sm hover:bg-muted/40">
                    <span className="w-20 shrink-0 font-mono font-medium">{o.number}</span>
                    <span className="min-w-0 flex-1"><span className="block truncate font-medium">{o.supplierName}</span><span className="block truncate text-xs text-muted-foreground">{o.receivedUnits.toLocaleString()} of {o.orderedUnits.toLocaleString()} units{o.expectedDate ? ` · due ${o.expectedDate}` : ""}</span></span>
                    <span className="hidden shrink-0 tabular-nums sm:block">{formatCents(o.totalCents)}</span>
                    <StatusPill status={o.status} short={o.closedShort} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Suppliers</CardTitle></CardHeader>
        <CardContent>
          {!sup.length ? <p className="text-sm text-muted-foreground">No suppliers yet.</p> : (
            <ul className="divide-y">
              {sup.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                  <div><p className="font-medium">{s.name}</p><p className="text-xs text-muted-foreground">{s.contact}</p></div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    {s.email && <span className="flex items-center gap-1"><Mail className="size-3.5" />{s.email}</span>}
                    {s.phone && <span className="flex items-center gap-1"><Phone className="size-3.5" />{s.phone}</span>}
                    {s.openOrders > 0 && <Badge variant="secondary">{s.openOrders} open</Badge>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      {current && <OrderDetail key={current.id + current.updatedAt} order={current} onClose={() => setSelected(null)} />}
      <OrderDialog open={newOrder} onOpenChange={setNewOrder} suppliers={sup} />
      <SupplierDialog open={newSupplier} onOpenChange={setNewSupplier} />
    </>
  );
}
