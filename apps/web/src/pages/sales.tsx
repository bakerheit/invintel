import { addressOneLine, formatQty, qtyErrorMessage, sameAddress, type PickLine, type SalesOrder, type SoShipInput, type SoStatus } from "@invintel/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, FileText, Mail, PackageCheck, Pencil, Plus, Receipt, Trash2, Truck } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm";
import { AddressFields, addressOrNull, orBlank } from "@/components/address-fields";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { centsToDollars, dollarsToCents, formatCents } from "@/lib/format";
import { qtyText, readQtyEntry } from "@/lib/qty";
import { invalidateOrg, isAdmin, orgKey, useCurrentOrg } from "@/lib/org";
import { cn } from "@/lib/utils";

const STATUS: Record<SoStatus, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-secondary text-secondary-foreground" },
  confirmed: { label: "Reserved", className: "bg-accent text-accent-foreground" },
  partial: { label: "Part shipped", className: "bg-warning-soft text-warning" },
  shipped: { label: "Shipped", className: "bg-success-soft text-success" },
  closed: { label: "Closed short", className: "bg-warning-soft text-warning" },
  cancelled: { label: "Cancelled", className: "bg-destructive/10 text-destructive" },
};
const RANK: Record<SoStatus, number> = { partial: 0, confirmed: 1, draft: 2, shipped: 3, closed: 4, cancelled: 5 };

const StatusPill = ({ status }: { status: SoStatus }) => <Badge variant="secondary" className={STATUS[status].className}>{STATUS[status].label}</Badge>;
const today = () => new Date().toISOString().slice(0, 10);
const FREE_TEXT = "__free__";

// ---------- a new order ----------

interface Draft { itemId: string; quantity: string; price: string }
const blank: Draft = { itemId: "", quantity: "", price: "" };

/** A new order, or (with `order`) the edit of a draft: the same form either way. */
function OrderFormDialog({ open, onOpenChange, order }: { open: boolean; onOpenChange: (o: boolean) => void; order?: SalesOrder }) {
  const { id: orgId } = useCurrentOrg();
  const qc = useQueryClient();
  const items = useQuery({ queryKey: orgKey(orgId, "items"), queryFn: () => api.listItems(orgId), enabled: open });
  const partners = useQuery({ queryKey: orgKey(orgId, "b2b", "partners"), queryFn: () => api.b2bPartners(orgId), enabled: open });
  const customers = (partners.data ?? []).filter((p) => p.kind === "customer");
  const [customer, setCustomer] = useState(order?.customer.partnerId ?? FREE_TEXT);
  const [name, setName] = useState(order && !order.customer.partnerId ? order.customer.name : "");
  const [ref, setRef] = useState(order?.customerRef ?? "");
  const [date, setDate] = useState(order?.requestedDate ?? "");
  const [billTo, setBillTo] = useState(orBlank(order?.billTo));
  const [shipTo, setShipTo] = useState(orBlank(order?.shipTo));
  const [sameShip, setSameShip] = useState(!order?.shipTo || sameAddress(order.shipTo, order.billTo));
  const [lines, setLines] = useState<Draft[]>(order ? order.lines.map((l) => ({ itemId: l.itemId, quantity: qtyText(l.quantity, l.uom), price: centsToDollars(l.unitPriceCents) })) : [{ ...blank }]);
  const [error, setError] = useState<string | null>(null);
  const item = (id: string) => items.data?.find((x) => x.id === id);
  const read = (l: Draft) => {
    const r = readQtyEntry(l.quantity, { uom: item(l.itemId) ?? {} });
    return r.ok ? { ok: true as const, stored: r.stored } : { ok: false as const, stored: 0, reason: r.reason };
  };
  const set = (i: number, patch: Partial<Draft>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const create = useMutation({
    mutationFn: () => {
      const input = {
        customerPartnerId: customer === FREE_TEXT ? null : customer, customerName: customer === FREE_TEXT ? name : "", customerRef: ref, requestedDate: date || null,
        billTo: addressOrNull(billTo), shipTo: sameShip ? addressOrNull(billTo) : addressOrNull(shipTo),
        lines: lines.map((l) => ({ itemId: l.itemId, quantity: read(l).stored, unitPriceCents: dollarsToCents(l.price) })),
      };
      return order ? api.updateSalesOrder(orgId, order.id, input) : api.createSalesOrder(orgId, input);
    },
    onSuccess: async (o) => {
      await invalidateOrg(qc, orgId);
      toast.success(order ? `Saved ${o.number}. Confirm it to reserve the stock.` : `Created ${o.number} as a draft. Confirm it to reserve the stock.`);
      onOpenChange(false);
      if (!order) { setLines([{ ...blank }]); setName(""); setRef(""); setDate(""); }
    },
    onError: (e: Error) => setError(e.message),
  });
  const ready = (customer !== FREE_TEXT || name.trim()) && lines.every((l) => l.itemId && read(l).ok && read(l).stored > 0 && l.price.trim() !== "");
  const picks = [{ value: FREE_TEXT, label: "Someone else (type a name)" }, ...customers.map((c) => ({ value: c.id, label: c.name }))];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader><DialogTitle>{order ? `Edit ${order.number}` : "New sales order"}</DialogTitle><DialogDescription>{order ? "A draft: nothing is reserved until you confirm it." : "Saved as a draft. Stock is reserved when you confirm it."}</DialogDescription></DialogHeader>
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid min-w-0 gap-1.5">
              <Label>Customer</Label>
              <Select value={customer} onValueChange={(v) => {
                if (!v) return;
                setCustomer(v);
                // A customer's own addresses fill in the order's (copied, so a later change to the customer can't change this order).
                const p = customers.find((x) => x.id === v);
                if (p) { setBillTo(orBlank(p.billTo)); setShipTo(orBlank(p.shipTo ?? p.billTo)); setSameShip(!p.shipTo || sameAddress(p.shipTo, p.billTo)); }
              }} items={picks}>
                <SelectTrigger aria-label="Customer" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{picks.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            {customer === FREE_TEXT && <div className="grid gap-1.5"><Label htmlFor="so-name">Customer name</Label><Input id="so-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></div>}
            <div className="grid gap-1.5"><Label htmlFor="so-ref">Their order number</Label><Input id="so-ref" value={ref} maxLength={80} onChange={(e) => setRef(e.target.value)} /></div>
            <div className="grid gap-1.5"><Label htmlFor="so-date">Wanted by</Label><Input id="so-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          </div>
          <details className="rounded-md border p-3" open={!!(order?.billTo || order?.shipTo)}>
            <summary className="cursor-pointer text-sm font-medium">Addresses <span className="font-normal text-muted-foreground">(optional: printed on the confirmation, packing slip and invoice)</span></summary>
            <div className="mt-3 space-y-3">
              <div className="space-y-2"><p className="text-sm font-medium">Bill to</p><AddressFields idPrefix="so-bill" value={billTo} onChange={setBillTo} /></div>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sameShip} onChange={(e) => setSameShip(e.target.checked)} /> Ship to the same address</label>
              {!sameShip && <div className="space-y-2"><p className="text-sm font-medium">Ship to</p><AddressFields idPrefix="so-ship" value={shipTo} onChange={setShipTo} /></div>}
            </div>
          </details>
          <div className="space-y-2">
            <Label>Lines</Label>
            {lines.map((l, i) => {
              const it = item(l.itemId);
              const bad = l.quantity.trim() !== "" && !read(l).ok;
              return (
                <div key={i} className="space-y-1">
                  <div className="grid grid-cols-[minmax(0,1fr)_4.25rem_4.75rem_2rem] items-center gap-1.5 sm:grid-cols-[minmax(0,1fr)_5rem_5.5rem_2rem] sm:gap-2">
                    <Select value={l.itemId} onValueChange={(v) => set(i, { itemId: v ?? "" })} items={(items.data ?? []).map((x) => ({ value: x.id, label: `${x.name} (${x.sku})` }))}>
                      <SelectTrigger aria-label={`Item for line ${i + 1}`} className="w-full"><SelectValue placeholder="Choose an item" /></SelectTrigger>
                      <SelectContent>{(items.data ?? []).map((x) => <SelectItem key={x.id} value={x.id} disabled={lines.some((o, j) => j !== i && o.itemId === x.id)}>{x.name} ({x.sku})</SelectItem>)}</SelectContent>
                    </Select>
                    <Input aria-label="Quantity" inputMode="decimal" placeholder={`Qty${it && it.unit !== "ea" ? ` (${it.unit})` : ""}`} value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} aria-invalid={bad ? true : undefined} title={bad ? qtyErrorMessage((read(l) as { reason: Parameters<typeof qtyErrorMessage>[0] }).reason, it) : undefined} />
                    <Input aria-label="Unit price" type="number" min={0} step="0.01" placeholder="Price" value={l.price} onChange={(e) => set(i, { price: e.target.value })} />
                    <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove line" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><Trash2 /></Button>
                  </div>
                  {it && <p className={cn("pl-1 text-xs", (it.available ?? 0) < (read(l).stored || 0) ? "text-warning" : "text-muted-foreground")}>{formatQty(it.available ?? it.quantity, it)} available now{(it.reserved ?? 0) > 0 ? `, ${formatQty(it.reserved ?? 0, it, { unit: false })} already promised` : ""}</p>}
                </div>
              );
            })}
            <Button type="button" variant="ghost" size="sm" onClick={() => setLines((ls) => [...ls, { ...blank }])}><Plus /> Add a line</Button>
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={!ready || create.isPending} onClick={() => { setError(null); create.mutate(); }}>{order ? "Save changes" : "Save draft"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- shipping ----------

interface Pick { qty: string; locationId: string; units: Set<string> }

function ShipDialog({ order, onClose, onShipped }: { order: SalesOrder; onClose: () => void; onShipped: () => void }) {
  const { id: orgId } = useCurrentOrg();
  const pick = useQuery({ queryKey: orgKey(orgId, "sales-pick", order.id), queryFn: () => api.salesPick(orgId, order.id) });
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [carrier, setCarrier] = useState("");
  const [tracking, setTracking] = useState("");
  const [date, setDate] = useState(today());
  const lines = pick.data ?? [];
  // Defaults: everything that is left, from the place with the most stock (or the oldest units).
  const get = (l: PickLine): Pick => picks[l.itemId] ?? { qty: qtyText(l.remaining, l.uom), locationId: (l.locations.find((x) => x.quantity >= l.remaining) ?? l.locations[0])?.locationId ?? "", units: new Set() };
  const put = (l: PickLine, patch: Partial<Pick>) => setPicks((p) => ({ ...p, [l.itemId]: { ...get(l), ...patch } }));
  const [include, setInclude] = useState<Record<string, boolean>>({});
  const on = (l: PickLine) => include[l.itemId] ?? l.tracking === "quantity";
  const qty = (l: PickLine) => { const r = readQtyEntry(get(l).qty, { uom: l.uom }); return r.ok ? r.stored : 0; };
  const unitTotal = (l: PickLine) => l.units.filter((u) => get(l).units.has(u.unitId)).reduce((s, u) => s + u.quantity, 0);
  const chosen = lines.filter(on);
  const valid = chosen.length > 0 && chosen.every((l) => (l.tracking === "unit" ? get(l).units.size > 0 && unitTotal(l) <= l.remaining : qty(l) > 0 && qty(l) <= l.remaining && get(l).locationId));
  const ship = useMutation({
    mutationFn: () => {
      const input: SoShipInput = {
        shippedDate: date || undefined, carrier, trackingNumber: tracking,
        lines: chosen.map((l) => (l.tracking === "unit" ? { itemId: l.itemId, unitIds: [...get(l).units] } : { itemId: l.itemId, quantity: qty(l), locationId: get(l).locationId })),
      };
      return api.shipSalesOrder(orgId, order.id, input);
    },
    onSuccess: (r) => {
      if (r.notice === "failed") toast.warning(`Shipped ${r.shipmentNumber}, but the customer's ship notice could not be sent${r.noticeError ? `: ${r.noticeError}` : ""}. Send it again from the order.`);
      else toast.success(r.notice === "sent" ? `Shipped ${r.shipmentNumber} and told the customer` : `Shipped ${r.shipmentNumber}`);
      onShipped();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader><DialogTitle>Ship {order.number}</DialogTitle><DialogDescription>Pick what goes out now. Stock leaves through the ledger; stock on quality hold is left out.</DialogDescription></DialogHeader>
        {!lines.length && !pick.isLoading && <p className="text-sm text-muted-foreground">Nothing left to ship.</p>}
        <div className="space-y-3">
          {lines.map((l) => (
            <div key={l.itemId} className="space-y-2 rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <input type="checkbox" className="size-4" aria-label={`Ship ${l.itemName}`} checked={on(l)} onChange={(e) => setInclude((x) => ({ ...x, [l.itemId]: e.target.checked }))} />
                <span className="font-medium">{l.itemName}</span><span className="font-mono text-xs text-muted-foreground">{l.itemSku}</span>
                <span className="ml-auto text-xs text-muted-foreground">{formatQty(l.remaining, l.uom)} left to ship</span>
              </div>
              {l.tracking === "unit" ? (
                !l.units.length ? <p className="text-warning">No rolls or pallets in stock to ship.</p> : (
                  <ul className="grid gap-1">
                    {l.units.map((u) => (
                      <li key={u.unitId}>
                        <label className="flex items-center gap-2">
                          <input type="checkbox" className="size-4" checked={get(l).units.has(u.unitId)} onChange={(e) => { const s = new Set(get(l).units); if (e.target.checked) s.add(u.unitId); else s.delete(u.unitId); put(l, { units: s }); setInclude((x) => ({ ...x, [l.itemId]: s.size > 0 })); }} />
                          <span className="font-mono text-xs">{u.code}</span><span className="text-muted-foreground">{formatQty(u.quantity, l.uom)}{u.lot ? ` · lot ${u.lot}` : ""} · {u.locationName}</span>
                        </label>
                      </li>
                    ))}
                    {get(l).units.size > 0 && <li className={cn("text-xs", unitTotal(l) > l.remaining ? "text-destructive" : "text-muted-foreground")}>Selected {formatQty(unitTotal(l), l.uom)}{unitTotal(l) > l.remaining ? ": more than is left to ship (whole units only)" : ""}</li>}
                  </ul>
                )
              ) : !l.locations.length ? <p className="text-warning">None in stock outside quality hold.</p> : (
                <div className="grid grid-cols-[6rem_1fr] items-center gap-2">
                  <Input aria-label={`Quantity of ${l.itemName}`} inputMode="decimal" className="h-8 text-right" value={get(l).qty} onChange={(e) => put(l, { qty: e.target.value })} aria-invalid={on(l) && qty(l) > l.remaining ? true : undefined} />
                  <Select value={get(l).locationId} onValueChange={(v) => v && put(l, { locationId: v })} items={l.locations.map((x) => ({ value: x.locationId, label: `${x.locationName} (${formatQty(x.quantity, l.uom, { unit: false })})` }))}>
                    <SelectTrigger aria-label={`Ship ${l.itemName} from`} className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>{l.locations.map((x) => <SelectItem key={x.locationId} value={x.locationId}>{x.locationName} ({formatQty(x.quantity, l.uom, { unit: false })})</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-1.5"><Label htmlFor="sh-date">Ship date</Label><Input id="sh-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div className="grid gap-1.5"><Label htmlFor="sh-carrier">Carrier</Label><Input id="sh-carrier" value={carrier} maxLength={80} onChange={(e) => setCarrier(e.target.value)} /></div>
          <div className="grid gap-1.5"><Label htmlFor="sh-track">Tracking number</Label><Input id="sh-track" value={tracking} maxLength={120} onChange={(e) => setTracking(e.target.value)} /></div>
        </div>
        {order.noticeVia && <p className="text-xs text-muted-foreground">{order.customer.name} is told by {order.noticeVia}, for exactly what you send now.</p>}
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!valid || ship.isPending} onClick={() => ship.mutate()}><Truck /> Ship</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- one order ----------

function OrderDetail({ order, onClose, onShip, onEdit, onRewritten }: { order: SalesOrder; onClose: () => void; onShip: () => void; onEdit: () => void; onRewritten: (copyId: string) => void }) {
  const { id: orgId, role } = useCurrentOrg();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const admin = isAdmin(role);
  const [shortError, setShortError] = useState<string | null>(null);
  const done = async (msg: string) => { await invalidateOrg(qc, orgId); toast.success(msg); };
  const doConfirm = useMutation({
    mutationFn: (allowShortage: boolean) => api.confirmSalesOrder(orgId, order.id, allowShortage),
    onSuccess: async (o) => {
      if ("approvalRequired" in o) { await done(`${o.approval.number} sent for approval. The stock is reserved when an admin approves.`); onClose(); return; }
      await done(`${o.number} confirmed: stock reserved${o.short ? " (short: back-order)" : ""}`);
      setShortError(null);
    },
    onError: (e: Error) => { if (e.message.startsWith("Not enough available")) setShortError(e.message); else toast.error(e.message); },
  });
  const act = useMutation({
    mutationFn: (a: "cancel" | "close") => (a === "cancel" ? api.cancelSalesOrder(orgId, order.id) : api.closeSalesOrder(orgId, order.id)),
    onSuccess: async (o) => { await done(`${o.number} is ${o.status}`); onClose(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const rewrite = useMutation({
    mutationFn: () => api.rewriteSalesOrder(orgId, order.id),
    onSuccess: async (copy) => { await done(`${order.number} cancelled and its stock released. ${copy.number} is a draft copy: change it, then confirm it.`); onRewritten(copy.id); },
    onError: (e: Error) => toast.error(e.message),
  });
  const sendConf = useMutation({
    mutationFn: () => api.sendSalesConfirmation(orgId, order.id),
    onSuccess: async (r) => { await done(r.alreadySent ? "That confirmation had already been sent" : `Confirmation sent to ${order.customer.name}`); },
    onError: (e: Error) => toast.error(e.message),
  });
  const sendInv = useMutation({
    mutationFn: (shipment: string) => api.sendSalesInvoice(orgId, order.id, shipment),
    onSuccess: async (r) => { await done(r.alreadySent ? `${r.invoiceNumber} had already been sent` : `${r.invoiceNumber} sent to ${order.customer.name}`); },
    onError: (e: Error) => toast.error(e.message),
  });
  const resend = useMutation({
    mutationFn: (n: string) => api.resendShipNotice(orgId, order.id, n),
    onSuccess: async () => { await done("Ship notice sent"); },
    onError: (e: Error) => toast.error(e.message),
  });
  const holding = order.status === "confirmed" || order.status === "partial";
  const ask = async (a: "cancel" | "close") => {
    if (await confirm(a === "cancel"
      ? { title: `Cancel ${order.number}?`, description: order.status === "draft" ? "Nothing is reserved yet." : "The stock reserved for it is released.", confirmLabel: "Cancel order", destructive: true }
      : { title: `Close ${order.number} short?`, description: "What has not shipped is released and won't be expected any more. What shipped stays shipped.", confirmLabel: "Close short" })) act.mutate(a);
  };
  const canRewrite = admin && order.status === "confirmed" && order.shipments.every((s) => s.reversed);
  const askRewrite = async () => {
    if (await confirm({
      title: `Change ${order.number}?`,
      description: `${order.number} is cancelled and its stock released, and a draft copy is made for you to change. The copy reserves nothing until you confirm it again${order.source === "exchange" ? ", and the customer was already told yes to the original: tell them about the change" : ""}.`,
      confirmLabel: "Cancel and make a copy",
    })) rewrite.mutate();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">{order.number} <StatusPill status={order.status} />{order.short && <Badge variant="secondary" className="bg-warning-soft text-warning"><AlertTriangle className="size-3" /> Short</Badge>}</DialogTitle>
          <DialogDescription>
            {order.customer.name}{order.customerRef ? ` · their order ${order.customerRef}` : ""}{order.requestedDate ? ` · wanted by ${order.requestedDate}` : ""}{order.note ? ` · ${order.note}` : ""}
          </DialogDescription>
        </DialogHeader>
        {(order.billTo || order.shipTo) && (
          <p className="text-xs text-muted-foreground">
            {order.billTo && <>Bill to: {addressOneLine(order.billTo)}. </>}
            {order.shipTo && !sameAddress(order.shipTo, order.billTo) && <>Ship to: {addressOneLine(order.shipTo)}.</>}
          </p>
        )}
        {order.source === "exchange" && <p className="text-xs text-muted-foreground">Made from an order they sent over the <Link className="underline" to={`/o/${orgId}/exchange`}>Exchange</Link>.</p>}
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground"><tr><th className="p-2">Item</th><th className="p-2 text-right">Ordered</th><th className="p-2 text-right">Shipped</th><th className="p-2 text-right">Reserved</th><th className="p-2 text-right">Available</th><th className="p-2 text-right">Price</th></tr></thead>
            <tbody className="divide-y">
              {order.lines.map((l) => (
                <tr key={l.itemId}>
                  <td className="p-2"><div className="font-medium">{l.itemName}</div><div className="font-mono text-xs text-muted-foreground">{l.itemSku}</div></td>
                  <td className="p-2 text-right tabular-nums">{formatQty(l.quantity, l.uom)}</td>
                  <td className={cn("p-2 text-right tabular-nums", l.shipped >= l.quantity && "font-medium")}>{formatQty(l.shipped, l.uom, { unit: false })}</td>
                  <td className="p-2 text-right tabular-nums">{l.reserved ? formatQty(l.reserved, l.uom, { unit: false }) : "·"}</td>
                  <td className={cn("p-2 text-right tabular-nums", l.available < 0 && "font-medium text-warning")}>{formatQty(l.available, l.uom, { unit: false })}</td>
                  <td className="p-2 text-right tabular-nums">{formatCents(l.unitPriceCents)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr className="border-t bg-muted/30 font-medium"><td className="p-2" colSpan={5}>Total</td><td className="p-2 text-right tabular-nums">{formatCents(order.totalCents)}</td></tr></tfoot>
          </table>
        </div>
        {order.status === "draft" && <p className="text-xs text-muted-foreground">Nothing is reserved yet. "Available" is what you could promise today.</p>}
        {shortError && (
          <div role="alert" className="space-y-2 rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm">
            <p className="flex items-start gap-2 text-warning"><AlertTriangle className="mt-0.5 size-4 shrink-0" /><span>{shortError}</span></p>
            {admin && <Button size="sm" variant="outline" onClick={() => doConfirm.mutate(true)} disabled={doConfirm.isPending}>Confirm anyway (back-order)</Button>}
          </div>
        )}
        {order.status !== "draft" && (
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Documents</p>
            <div className="flex flex-wrap gap-2">
              <a href={api.salesDocUrl(orgId, order.id, "confirmation")} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline", size: "sm" })}><FileText /> Order confirmation</a>
              {admin && order.sendDocs.confirmation && <Button size="sm" variant="outline" onClick={() => sendConf.mutate()} disabled={sendConf.isPending}><Mail /> Email it to {order.customer.name}</Button>}
            </div>
          </div>
        )}
        {order.shipments.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Shipments</p>
            <ul className="divide-y rounded-lg border text-sm">
              {order.shipments.map((s) => (
                <li key={s.number} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-2">
                  <span className="font-mono text-xs font-medium">{s.number}</span>
                  <span className="text-xs text-muted-foreground">{s.at.slice(0, 10)} · {s.by}{s.carrier || s.trackingNumber ? ` · ${[s.carrier, s.trackingNumber].filter(Boolean).join(" ")}` : ""}</span>
                  <span className="min-w-0 flex-1 truncate text-xs">{s.lines.map((l) => `${formatQty(l.quantity, l.uom)} ${l.itemName}`).join(", ")}</span>
                  {s.reversed && <Badge variant="secondary" className="bg-warning-soft text-warning">undone</Badge>}
                  <span className="flex flex-wrap items-center gap-1.5">
                    <a href={api.salesDocUrl(orgId, order.id, { shipment: s.number, doc: "packing-slip" })} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "ghost", size: "sm" })}><FileText /> Packing slip</a>
                    {admin && <a href={api.salesDocUrl(orgId, order.id, { shipment: s.number, doc: "invoice" })} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "ghost", size: "sm" })}><FileText /> {s.invoiceNumber ? `Invoice ${s.invoiceNumber}` : "Make invoice"}</a>}
                    {admin && order.sendDocs.invoice && <Button size="sm" variant="ghost" onClick={() => sendInv.mutate(s.number)} disabled={sendInv.isPending}><Mail /> Email invoice</Button>}
                  </span>
                  {s.notice === "sent" && <Badge variant="secondary" className="bg-success-soft text-success"><Receipt className="size-3" /> told the customer</Badge>}
                  {s.notice === "failed" && (
                    <span className="flex items-center gap-1.5"><Badge variant="secondary" className="bg-warning-soft text-warning">notice not sent</Badge>{admin && <Button size="sm" variant="outline" onClick={() => resend.mutate(s.number)} disabled={resend.isPending}>Send again</Button>}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        <DialogFooter className="sm:justify-between">
          <div className="flex gap-2">
            {admin && (order.status === "draft" || (order.status === "confirmed" && order.shipments.every((s) => s.reversed))) && <Button variant="ghost" className="text-destructive" onClick={() => void ask("cancel")}>Cancel order</Button>}
            {admin && order.status === "partial" && <Button variant="ghost" onClick={() => void ask("close")}>Close short</Button>}
            {canRewrite && <Button variant="outline" onClick={() => void askRewrite()} disabled={rewrite.isPending}><Pencil /> Change lines</Button>}
          </div>
          <div className="flex gap-2">
            {admin && order.status === "draft" && <Button variant="outline" onClick={onEdit}><Pencil /> Edit</Button>}
            {admin && order.status === "draft" && <Button onClick={() => { setShortError(null); doConfirm.mutate(false); }} disabled={doConfirm.isPending}><Check /> Confirm and reserve</Button>}
            {holding && <Button onClick={onShip}><PackageCheck /> Ship</Button>}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function SalesPage() {
  const { id: orgId, role } = useCurrentOrg();
  const admin = isAdmin(role);
  const orders = useQuery({ queryKey: orgKey(orgId, "sales-orders"), queryFn: () => api.salesOrders(orgId), refetchInterval: 30_000 });
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [shipping, setShipping] = useState(false);
  const [editing, setEditing] = useState(false);
  const qc = useQueryClient();
  const list = [...(orders.data ?? [])].sort((a, b) => RANK[a.status] - RANK[b.status] || b.number.localeCompare(a.number));
  const current = list.find((o) => o.id === selected);
  return (
    <>
      <PageHeader title="Sales" description="Customer orders: what's promised, what's been picked and shipped." actions={admin ? <Button onClick={() => setCreating(true)}><Plus /> New order</Button> : undefined} />
      <Card>
        <CardHeader><CardTitle>Sales orders</CardTitle></CardHeader>
        <CardContent>
          {orders.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : !list.length ? (
            <EmptyState icon={Receipt} title="No sales orders yet" description={admin ? "Write one for a customer, or accept an order a customer sent you over the Exchange." : "Orders will show up here once an admin writes or accepts them."} />
          ) : (
            <ul className="divide-y">
              {list.map((o) => (
                <li key={o.id}>
                  <button type="button" onClick={() => setSelected(o.id)} className="flex w-full items-center gap-3 py-3 text-left text-sm hover:bg-muted/40">
                    <span className="w-20 shrink-0 font-mono font-medium">{o.number}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{o.customer.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{o.lines.length} {o.lines.length === 1 ? "line" : "lines"}{o.customerRef ? ` · their ${o.customerRef}` : ""}{o.requestedDate ? ` · wanted ${o.requestedDate}` : ""}{o.source === "exchange" ? " · from the Exchange" : ""}</span>
                    </span>
                    {o.short && <AlertTriangle className="size-4 shrink-0 text-warning" aria-label="Short of stock" />}
                    <span className="hidden shrink-0 tabular-nums sm:block">{formatCents(o.totalCents)}</span>
                    <StatusPill status={o.status} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      {current && !shipping && !editing && <OrderDetail key={current.id + current.updatedAt + current.shipments.length} order={current} onClose={() => setSelected(null)} onShip={() => setShipping(true)} onEdit={() => setEditing(true)} onRewritten={(id) => { setSelected(id); setEditing(true); }} />}
      {current && editing && <OrderFormDialog key={current.id + current.updatedAt} open order={current} onOpenChange={(o) => !o && setEditing(false)} />}
      {current && shipping && <ShipDialog order={current} onClose={() => setShipping(false)} onShipped={async () => { setShipping(false); await invalidateOrg(qc, orgId); }} />}
      <OrderFormDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
