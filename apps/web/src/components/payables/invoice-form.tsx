import { formatQty, lineValueCents, uomOf, type Invoice, type Item, type PurchaseOrder, type Supplier } from "@invintel/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Wand2 } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { centsToDollars, formatMoney } from "@/lib/format";
import { invalidateOrg, orgKey } from "@/lib/org";
import { qtyText, readQtyEntry } from "@/lib/qty";

const selectClass = "h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-sm";
const NONE = "";

interface LineDraft { key: number; itemId: string; description: string; qty: string; price: string; tax: string }

/** "12.50" to 1250, or null if it isn't an amount. */
export const parseDollars = (text: string): number | null => {
  const t = text.trim().replace(/^\$/, "").replace(/,/g, "");
  if (t === "") return 0;
  return /^\d+(\.\d{1,2})?$/.test(t) ? Math.round(Number(t) * 100) : null;
};

/** Enter a supplier's invoice, or fix one that is still a draft or waiting for review. */
export function InvoiceForm({ orgId, invoice, onClose, onSaved }: { orgId: string; invoice?: Invoice; onClose: () => void; onSaved: (i: Invoice) => void }) {
  const qc = useQueryClient();
  const suppliers = useQuery({ queryKey: orgKey(orgId, "suppliers"), queryFn: () => api.listSuppliers(orgId) });
  const items = useQuery({ queryKey: orgKey(orgId, "items"), queryFn: () => api.listItems(orgId) });
  const orders = useQuery({ queryKey: orgKey(orgId, "orders"), queryFn: () => api.listOrders(orgId) });
  const settings = useQuery({ queryKey: orgKey(orgId, "invoice-settings"), queryFn: () => api.invoiceSettings(orgId) });
  const today = new Date().toISOString().slice(0, 10);
  const [supplierId, setSupplierId] = useState(invoice?.supplierId ?? "");
  const [poId, setPoId] = useState(invoice?.purchaseOrderId ?? NONE);
  const [number, setNumber] = useState(invoice?.invoiceNumber ?? "");
  const [issueDate, setIssueDate] = useState(invoice?.issueDate ?? today);
  const [dueDate, setDueDate] = useState(invoice?.dueDate ?? "");
  const [currency, setCurrency] = useState(invoice?.currency ?? "");
  const [freight, setFreight] = useState(invoice ? centsToDollars(invoice.freightCents) : "0.00");
  const [stated, setStated] = useState(invoice?.statedTotalCents != null ? centsToDollars(invoice.statedTotalCents) : "");
  const [note, setNote] = useState(invoice?.note ?? "");
  const [seq, setSeq] = useState(1000);
  const itemById = useMemo(() => new Map((items.data ?? []).map((i: Item) => [i.id, i])), [items.data]);
  const [lines, setLines] = useState<LineDraft[]>(() =>
    invoice
      ? invoice.lines.map((l, i) => ({ key: i, itemId: l.itemId ?? NONE, description: l.itemId ? "" : l.description, qty: qtyText(l.quantity, l.uom), price: centsToDollars(l.unitPriceCents), tax: centsToDollars(l.taxCents) }))
      : [{ key: 0, itemId: NONE, description: "", qty: "", price: "", tax: "0.00" }],
  );
  const [error, setError] = useState<string | null>(null);

  const supplierOrders = (orders.data ?? []).filter((o: PurchaseOrder) => o.supplierId === supplierId && o.status !== "draft" && o.status !== "cancelled");
  const set = (key: number, patch: Partial<LineDraft>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const effectiveCurrency = (currency || settings.data?.currency || "USD").toUpperCase();

  /** Reads one row into what the API takes, or says what is wrong with it. */
  type LineIn = { itemId: string | null; description: string; quantity: number; unitPriceCents: number; taxCents: number };
  type Read = { ok: false; error: string } | { ok: true; line: LineIn };
  const read = (l: LineDraft, n: number): Read => {
    const item = l.itemId ? itemById.get(l.itemId) : undefined;
    const q = l.itemId ? readQtyEntry(l.qty, { uom: item ?? {} }) : readQtyEntry(l.qty, { uom: {} });
    const price = parseDollars(l.price);
    const tax = parseDollars(l.tax);
    if (!l.itemId && !l.description.trim()) return { ok: false, error: `Line ${n}: pick an item or describe it (freight, a fee)` };
    if (!q.ok || q.stored < 1) return { ok: false, error: `Line ${n}: ${l.qty.trim() ? "that isn't a valid quantity for this item" : "enter a quantity"}` };
    if (price === null || l.price.trim() === "") return { ok: false, error: `Line ${n}: enter the price like 12.50` };
    if (tax === null) return { ok: false, error: `Line ${n}: tax should be an amount like 1.20` };
    return { ok: true, line: { itemId: l.itemId || null, description: l.itemId ? "" : l.description.trim(), quantity: q.stored, unitPriceCents: price, taxCents: tax } };
  };
  const parsed = lines.map((l, i) => read(l, i + 1));
  const preview = parsed.reduce(
    (acc, p, i) => {
      if (!p.ok) return acc;
      const item = lines[i]!.itemId ? itemById.get(lines[i]!.itemId) : undefined;
      acc.subtotal += lineValueCents(p.line.quantity, p.line.unitPriceCents, item?.decimals ?? 0);
      acc.tax += p.line.taxCents;
      return acc;
    },
    { subtotal: 0, tax: 0 },
  );
  const freightCents = parseDollars(freight) ?? 0;

  const fillFromOrder = () => {
    const order = orders.data?.find((o: PurchaseOrder) => o.id === poId);
    if (!order) return;
    const next = order.lines.filter((l) => l.received > 0).map((l, i) => ({ key: seq + i, itemId: l.itemId, description: "", qty: qtyText(l.received, l.uom), price: centsToDollars(l.unitCostCents), tax: "0.00" }));
    if (!next.length) return toast.info("Nothing has been received against that order yet.");
    setSeq(seq + next.length);
    setLines(next);
  };

  const save = useMutation({
    mutationFn: async () => {
      const lineIns: LineIn[] = [];
      for (const p of parsed) {
        if (!p.ok) throw new Error(p.error);
        lineIns.push(p.line);
      }
      const freightCents = parseDollars(freight);
      const statedCents = stated.trim() === "" ? null : parseDollars(stated);
      if (freightCents === null) throw new Error("Freight should be an amount like 12.50");
      if (statedCents === null && stated.trim() !== "") throw new Error("The supplier's total should be an amount like 132.00");
      const body = {
        supplierId, purchaseOrderId: poId || null, invoiceNumber: number, issueDate, dueDate: dueDate || null, currency: effectiveCurrency,
        freightCents, statedTotalCents: statedCents, note, lines: lineIns,
      };
      return invoice ? api.updateInvoice(orgId, invoice.id, body) : api.createInvoice(orgId, body);
    },
    onSuccess: async (inv) => { await invalidateOrg(qc, orgId); toast.success(invoice ? "Invoice saved" : `Entered ${inv.number}`); onSaved(inv); },
    onError: (e: Error) => setError(e.message),
  });
  const submit = (e: FormEvent) => { e.preventDefault(); setError(null); if (!supplierId) return setError("Choose the supplier"); save.mutate(); };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader><DialogTitle>{invoice ? `Edit ${invoice.number}` : "Enter a supplier invoice"}</DialogTitle></DialogHeader>
        <form onSubmit={submit} className="grid max-h-[70vh] gap-4 overflow-auto pr-1">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label htmlFor="inv-supplier">Supplier</Label>
              <select id="inv-supplier" className={selectClass} value={supplierId} onChange={(e) => { setSupplierId(e.target.value); setPoId(NONE); }} required>
                <option value="">Choose…</option>
                {(suppliers.data ?? []).map((s: Supplier) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="inv-po">Purchase order</Label>
              <select id="inv-po" className={selectClass} value={poId} onChange={(e) => setPoId(e.target.value)}>
                <option value={NONE}>None (can't be matched)</option>
                {supplierOrders.map((o: PurchaseOrder) => <option key={o.id} value={o.id}>{o.number} · {o.status}</option>)}
              </select>
            </div>
            <div className="grid gap-1.5"><Label htmlFor="inv-number">Their invoice number</Label><Input id="inv-number" value={number} onChange={(e) => setNumber(e.target.value)} required maxLength={64} /></div>
            <div className="grid gap-1.5"><Label htmlFor="inv-date">Invoice date</Label><Input id="inv-date" type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} required /></div>
            <div className="grid gap-1.5"><Label htmlFor="inv-due">Due date</Label><Input id="inv-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></div>
            <div className="grid gap-1.5"><Label htmlFor="inv-cur">Currency</Label><Input id="inv-cur" value={currency || (settings.data?.currency ?? "")} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} /></div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">Lines</h3>
              <Button type="button" size="sm" variant="outline" disabled={!poId} onClick={fillFromOrder}><Wand2 /> Fill from what arrived</Button>
            </div>
            <div className="overflow-auto rounded-lg border">
              <table className="w-full min-w-[40rem] text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground"><tr><th className="p-2">Item or description</th><th className="w-32 p-2">Quantity</th><th className="w-28 p-2">Price each ($)</th><th className="w-24 p-2">Tax ($)</th><th className="w-24 p-2 text-right">Amount</th><th className="w-10" /></tr></thead>
                <tbody className="divide-y">
                  {lines.map((l, i) => {
                    const item = l.itemId ? itemById.get(l.itemId) : undefined;
                    const p = parsed[i]!;
                    const u = uomOf(item);
                    return (
                      <tr key={l.key} className="align-top">
                        <td className="space-y-1 p-2">
                          <select aria-label={`Item for line ${i + 1}`} className={selectClass} value={l.itemId} onChange={(e) => set(l.key, { itemId: e.target.value })}>
                            <option value={NONE}>Something else (freight, a fee)…</option>
                            {(items.data ?? []).map((it: Item) => <option key={it.id} value={it.id}>{it.name} ({it.sku})</option>)}
                          </select>
                          {!l.itemId && <Input aria-label={`Description for line ${i + 1}`} placeholder="Fuel surcharge" value={l.description} onChange={(e) => set(l.key, { description: e.target.value })} maxLength={200} />}
                        </td>
                        <td className="p-2">
                          <div className="relative">
                            <Input aria-label={`Quantity for line ${i + 1}`} inputMode="decimal" className={u.unit !== "ea" ? "pr-9" : ""} value={l.qty} onChange={(e) => set(l.key, { qty: e.target.value })} />
                            {u.unit !== "ea" && <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-muted-foreground">{u.unit}</span>}
                          </div>
                        </td>
                        <td className="p-2"><Input aria-label={`Price for line ${i + 1}`} inputMode="decimal" value={l.price} onChange={(e) => set(l.key, { price: e.target.value })} /></td>
                        <td className="p-2"><Input aria-label={`Tax for line ${i + 1}`} inputMode="decimal" value={l.tax} onChange={(e) => set(l.key, { tax: e.target.value })} /></td>
                        <td className="p-2 text-right tabular-nums">{p.ok ? formatMoney(lineValueCents(p.line.quantity, p.line.unitPriceCents, item?.decimals ?? 0), effectiveCurrency) : <span className="text-muted-foreground">-</span>}</td>
                        <td className="p-2"><Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove line ${i + 1}`} disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}><Trash2 /></Button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={() => { setLines((ls) => [...ls, { key: seq, itemId: NONE, description: "", qty: "", price: "", tax: "0.00" }]); setSeq(seq + 1); }}><Plus /> Add a line</Button>
          </div>

          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_2fr]">
            <div className="grid gap-1.5"><Label htmlFor="inv-freight">Freight ($)</Label><Input id="inv-freight" inputMode="decimal" value={freight} onChange={(e) => setFreight(e.target.value)} /></div>
            <div className="grid gap-1.5"><Label htmlFor="inv-stated">Their total ($, to check)</Label><Input id="inv-stated" inputMode="decimal" placeholder="optional" value={stated} onChange={(e) => setStated(e.target.value)} /></div>
            <div className="grid gap-1.5"><Label htmlFor="inv-note">Note</Label><Input id="inv-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></div>
          </div>
          <p className="text-right text-sm">
            Lines {formatMoney(preview.subtotal, effectiveCurrency)} · tax {formatMoney(preview.tax, effectiveCurrency)} · freight {formatMoney(freightCents, effectiveCurrency)} ·{" "}
            <strong>Total {formatMoney(preview.subtotal + preview.tax + freightCents, effectiveCurrency)}</strong>
          </p>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" disabled={save.isPending}>{invoice ? "Save" : "Enter invoice"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

void formatQty;
