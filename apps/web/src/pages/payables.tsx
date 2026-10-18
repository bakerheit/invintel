import { PAYMENT_METHOD_LABELS, type Invoice, type InvoiceSettings, type Payment } from "@invintel/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileText, Plus, Scale, Truck } from "lucide-react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";
import { InvoiceDetail, INVOICE_STATUS } from "@/components/payables/invoice-detail";
import { InvoiceForm, type InvoicePrefill } from "@/components/payables/invoice-form";
import { PaymentDialog } from "@/components/payables/payment-dialog";
import { ShipmentDetail, ShipmentForm, SHIPMENT_STATUS } from "@/components/payables/shipments";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { invalidateOrg, isAdmin, orgKey, useCurrentOrg } from "@/lib/org";
import { cn } from "@/lib/utils";

type Tab = "invoices" | "shipments" | "payments";
const selectClass = "h-8 rounded-lg border border-input bg-background px-2 text-sm";

/** The matching rules: how far a price or quantity may be off before a person has to look. */
function RulesDialog({ orgId, onClose }: { orgId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: orgKey(orgId, "invoice-settings"), queryFn: () => api.invoiceSettings(orgId) });
  const [form, setForm] = useState<{ currency: string; price: string; qty: string; total: string } | null>(null);
  const v = form ?? { currency: q.data?.currency ?? "USD", price: String(q.data?.priceTolerancePct ?? 1), qty: String(q.data?.qtyTolerancePct ?? 0), total: ((q.data?.totalToleranceCents ?? 5) / 100).toFixed(2) };
  const save = useMutation({
    mutationFn: (): Promise<InvoiceSettings> => api.saveInvoiceSettings(orgId, { currency: v.currency.trim().toUpperCase(), priceTolerancePct: Number(v.price), qtyTolerancePct: Number(v.qty), totalToleranceCents: Math.round(Number(v.total) * 100) }),
    onSuccess: async () => { await invalidateOrg(qc, orgId); toast.success("Matching rules saved"); onClose(); },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Matching rules</DialogTitle></DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="grid gap-3">
          <p className="text-sm text-muted-foreground">An invoice is matched against its purchase order and what actually arrived. Anything outside these limits needs a person to look.</p>
          <div className="grid gap-1.5"><Label htmlFor="r-cur">Currency of your books</Label><Input id="r-cur" className="w-24" maxLength={3} value={v.currency} onChange={(e) => setForm({ ...v, currency: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label htmlFor="r-price">A price may be this much above the order (%)</Label><Input id="r-price" className="w-28" inputMode="decimal" value={v.price} onChange={(e) => setForm({ ...v, price: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label htmlFor="r-qty">Billed may be this much over what arrived (%)</Label><Input id="r-qty" className="w-28" inputMode="decimal" value={v.qty} onChange={(e) => setForm({ ...v, qty: e.target.value })} /></div>
          <div className="grid gap-1.5"><Label htmlFor="r-total">Their total may differ from the lines by ($)</Label><Input id="r-total" className="w-28" inputMode="decimal" value={v.total} onChange={(e) => setForm({ ...v, total: e.target.value })} /></div>
          <DialogFooter><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" disabled={save.isPending || q.isLoading}>Save</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PaymentsTab({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: orgKey(orgId, "payments"), queryFn: () => api.listPayments(orgId) });
  const [voiding, setVoiding] = useState<Payment | null>(null);
  const [reason, setReason] = useState("");
  const void_ = useMutation({
    mutationFn: () => api.voidPayment(orgId, voiding!.id, { reason }),
    onSuccess: async () => { toast.success("Payment voided. The invoices owe it again."); setVoiding(null); setReason(""); await invalidateOrg(qc, orgId); },
    onError: (e: Error) => toast.error(e.message),
  });
  if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!q.data?.length) return <EmptyState icon={FileText} title="No payments yet" description="Pay an approved invoice and the record shows up here, with a remittance you can print." />;
  return (
    <>
      <div className="overflow-auto rounded-lg border">
        <table className="w-full min-w-[44rem] text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground"><tr><th className="p-2">Payment</th><th className="p-2">Paid on</th><th className="p-2">Supplier</th><th className="p-2">How</th><th className="p-2">For</th><th className="p-2 text-right">Amount</th><th className="p-2" /></tr></thead>
          <tbody className="divide-y">
            {q.data.map((p) => (
              <tr key={p.id} className={cn(p.voidedAt && "text-muted-foreground")}>
                <td className="p-2 font-mono">{p.number}{p.voidedAt && <Badge variant="secondary" className="ml-2 bg-destructive/10 text-destructive">Void</Badge>}</td>
                <td className="p-2">{p.paidOn}</td><td className="p-2">{p.supplierName}</td>
                <td className="p-2">{PAYMENT_METHOD_LABELS[p.method]}{p.reference ? ` · ${p.reference}` : ""}</td>
                <td className="p-2">{p.allocations.map((a) => a.invoiceNumber).join(", ")}</td>
                <td className={cn("p-2 text-right tabular-nums", p.voidedAt && "line-through")}>{formatMoney(p.amountCents, p.currency)}</td>
                <td className="p-2 text-right"><Link to={`/o/${orgId}/remittance/${p.id}`} className="underline">Remittance</Link>{!p.voidedAt && <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setVoiding(p)}>Void</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {voiding && (
        <Dialog open onOpenChange={(o) => !o && setVoiding(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Void {voiding.number}?</DialogTitle></DialogHeader>
            <p className="text-sm text-muted-foreground">The invoices it covered owe this amount again. The record stays, marked void.</p>
            <div className="grid gap-1.5"><Label htmlFor="v-reason">Why?</Label><Input id="v-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} autoFocus /></div>
            <DialogFooter><Button variant="ghost" onClick={() => setVoiding(null)}>Keep it</Button><Button variant="destructive" disabled={!reason.trim() || void_.isPending} onClick={() => void_.mutate()}>Void payment</Button></DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

export default function PayablesPage() {
  const org = useCurrentOrg();
  const admin = isAdmin(org.role);
  const [params, setParams] = useSearchParams();
  const tab = (admin ? (params.get("tab") as Tab | null) : "shipments") ?? (admin ? "invoices" : "shipments");
  const [status, setStatus] = useState("open");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Invoice | "new" | null>(null);
  const [capture, setCapture] = useState<{ id: string; prefill: InvoicePrefill } | null>(null);
  const [openInvoice, setOpenInvoice] = useState<string | null>(null);
  const [paying, setPaying] = useState<{ supplierId: string; invoiceId?: string } | null>(null);
  const [newShipment, setNewShipment] = useState(false);
  const [openShipment, setOpenShipment] = useState<string | null>(null);
  const [rules, setRules] = useState(false);
  const [paySupplier, setPaySupplier] = useState("");
  const suppliers = useQuery({ queryKey: orgKey(org.id, "suppliers"), queryFn: () => api.listSuppliers(org.id) });
  const invoices = useQuery({ queryKey: orgKey(org.id, "invoices", status, search), queryFn: () => api.listInvoices(org.id, { status, q: search }), enabled: admin && tab === "invoices" });
  const captured = useQuery({ queryKey: orgKey(org.id, "captured-invoices", "captured"), queryFn: () => api.capturedInvoices(org.id, "captured"), enabled: admin && tab === "invoices" });
  const shipments = useQuery({ queryKey: orgKey(org.id, "shipments"), queryFn: () => api.listShipments(org.id), enabled: tab === "shipments" });
  const goTab = (t: Tab) => setParams({ tab: t });
  const qc = useQueryClient();
  /** Start an invoice from one that arrived by email or upload. The capture closes when the invoice is saved. */
  const fromCapture = async (id: string) => {
    try {
      const [prefill] = await Promise.all([api.capturedInvoiceInput(org.id, id), qc.fetchQuery({ queryKey: orgKey(org.id, "items"), queryFn: () => api.listItems(org.id) }), qc.fetchQuery({ queryKey: orgKey(org.id, "suppliers"), queryFn: () => api.listSuppliers(org.id) })]);
      setCapture({ id, prefill });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <>
      <PageHeader
        title="Payables"
        description="Supplier invoices matched against what you ordered and what arrived, shipments on their way, and the payments you've made."
        actions={
          <>
            {admin && <Button variant="outline" onClick={() => setRules(true)}><Scale /> Matching rules</Button>}
            {admin && <a href={`/api/orgs/${org.id}/invoices/export/bills.csv`} className={buttonVariants({ variant: "outline" })}><Download /> Bills CSV</a>}
            {admin && <a href={`/api/orgs/${org.id}/invoices/export/payments.csv`} className={buttonVariants({ variant: "outline" })}><Download /> Payments CSV</a>}
          </>
        }
      />
      <div role="tablist" aria-label="Payables" className="flex gap-1 border-b">
        {(admin ? (["invoices", "shipments", "payments"] as Tab[]) : (["shipments"] as Tab[])).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => goTab(t)} className={cn("-mb-px border-b-2 px-3 py-2 text-sm font-medium capitalize", tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>{t === "shipments" ? "incoming shipments" : t}</button>
        ))}
      </div>

      {tab === "invoices" && admin && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label="Show invoices" className={selectClass} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="open">Not paid yet</option><option value="review">Needs review</option><option value="approved">Ready to pay</option><option value="paid">Paid</option><option value="draft">Drafts</option><option value="void">Void</option><option value="">All</option>
            </select>
            <Input aria-label="Search invoices" placeholder="Search by invoice number" className="h-8 w-56" value={search} onChange={(e) => setSearch(e.target.value)} />
            <div className="ml-auto flex items-center gap-2">
              <select aria-label="Pay a supplier" className={selectClass} value={paySupplier} onChange={(e) => { setPaySupplier(e.target.value); if (e.target.value) { setPaying({ supplierId: e.target.value }); setPaySupplier(""); } }}>
                <option value="">Record a payment to…</option>
                {(suppliers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <Button onClick={() => setEditing("new")}><Plus /> Enter invoice</Button>
            </div>
          </div>
          {(captured.data?.length ?? 0) > 0 && (
            <div className="space-y-1 rounded-lg border border-accent bg-accent/30 p-3 text-sm">
              <p className="font-medium">{captured.data!.length} {captured.data!.length === 1 ? "invoice has" : "invoices have"} arrived and {captured.data!.length === 1 ? "isn't" : "aren't"} entered yet</p>
              <ul className="divide-y">
                {captured.data!.slice(0, 5).map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                    <span><span className="font-medium">{c.invoiceNumber || "(no number)"}</span> <span className="text-muted-foreground">from {c.partnerName} · {c.source}{c.totalCents != null ? ` · ${formatMoney(c.totalCents, c.currency)}` : ""}{c.poNumber ? ` · ${c.poNumber}` : ""}</span></span>
                    <Button size="sm" variant="outline" onClick={() => void fromCapture(c.id)}>Enter as invoice</Button>
                  </li>
                ))}
              </ul>
              {captured.data!.length > 5 && <p className="text-xs text-muted-foreground">And {captured.data!.length - 5} more in Documents.</p>}
            </div>
          )}
          {invoices.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : !invoices.data?.length ? (
            <EmptyState icon={FileText} title="No invoices here" description="Enter an invoice from a supplier, and it is matched against the order and what arrived." />
          ) : (
            <div className="overflow-auto rounded-lg border">
              <table className="w-full min-w-[48rem] text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground"><tr><th className="p-2">Invoice</th><th className="p-2">Supplier</th><th className="p-2">Order</th><th className="p-2">Dated</th><th className="p-2">Due</th><th className="p-2 text-right">Total</th><th className="p-2 text-right">Owed</th><th className="p-2">Status</th></tr></thead>
                <tbody className="divide-y">
                  {invoices.data.map((r) => (
                    <tr key={r.id} className="cursor-pointer hover:bg-muted/40" onClick={() => setOpenInvoice(r.id)}>
                      <td className="p-2"><button className="text-left font-medium underline-offset-2 hover:underline" onClick={(e) => { e.stopPropagation(); setOpenInvoice(r.id); }}>{r.invoiceNumber}</button><div className="font-mono text-xs text-muted-foreground">{r.number}</div></td>
                      <td className="p-2">{r.supplierName}</td><td className="p-2">{r.purchaseOrderNumber ?? <span className="text-muted-foreground">none</span>}</td>
                      <td className="p-2">{r.issueDate}</td>
                      <td className="p-2">{r.dueDate ?? "-"}{r.overdue && <Badge variant="secondary" className="ml-1 bg-destructive/10 text-destructive">Overdue</Badge>}</td>
                      <td className="p-2 text-right tabular-nums">{formatMoney(r.totalCents, r.currency)}</td>
                      <td className="p-2 text-right tabular-nums">{r.status === "void" ? "-" : formatMoney(r.balanceCents, r.currency)}</td>
                      <td className="p-2"><Badge variant="secondary" className={INVOICE_STATUS[r.status].className}>{INVOICE_STATUS[r.status].label}</Badge>{r.flags > 0 && r.status !== "approved" && r.status !== "paid" && <span className="ml-1 text-xs text-warning">{r.flags} {r.flags === 1 ? "problem" : "problems"}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {tab === "shipments" && (
        <section className="space-y-3">
          <div className="flex justify-end"><Button onClick={() => setNewShipment(true)}><Plus /> Record a shipment</Button></div>
          {shipments.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : !shipments.data?.length ? (
            <EmptyState icon={Truck} title="No shipments recorded" description="When a supplier sends an advance ship notice, record it here. Receiving against it fills in the lot and links the receipt." />
          ) : (
            <div className="overflow-auto rounded-lg border">
              <table className="w-full min-w-[40rem] text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground"><tr><th className="p-2">Shipment</th><th className="p-2">Supplier</th><th className="p-2">Their reference</th><th className="p-2">Order</th><th className="p-2">Expected</th><th className="p-2">Status</th></tr></thead>
                <tbody className="divide-y">
                  {shipments.data.map((s) => (
                    <tr key={s.id} className="cursor-pointer hover:bg-muted/40" onClick={() => setOpenShipment(s.id)}>
                      <td className="p-2 font-mono"><button className="underline-offset-2 hover:underline" onClick={(e) => { e.stopPropagation(); setOpenShipment(s.id); }}>{s.number}</button></td>
                      <td className="p-2">{s.supplierName}</td><td className="p-2">{s.reference}</td><td className="p-2">{s.purchaseOrderNumber ?? "-"}</td><td className="p-2">{s.expectedDate ?? "-"}</td>
                      <td className="p-2"><Badge variant="secondary" className={SHIPMENT_STATUS[s.status].className}>{SHIPMENT_STATUS[s.status].label}</Badge>{s.warnings.length > 0 && <span className="ml-1 text-xs text-warning">{s.warnings.length} to check</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {tab === "payments" && admin && <PaymentsTab orgId={org.id} />}

      {editing && <InvoiceForm orgId={org.id} invoice={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} onSaved={(i) => { setEditing(null); setOpenInvoice(i.id); }} />}
      {capture && (
        <InvoiceForm
          orgId={org.id}
          prefill={capture.prefill}
          onClose={() => setCapture(null)}
          onSaved={async (i) => {
            const id = capture.id;
            setCapture(null);
            setOpenInvoice(i.id);
            try { await api.markCaptureConverted(org.id, id, i.id); } catch (e) { toast.error(`Saved, but the capture couldn't be closed: ${(e as Error).message}`); }
            await qc.invalidateQueries({ queryKey: orgKey(org.id, "captured-invoices", "captured") });
          }}
        />
      )}
      {openInvoice && !editing && !paying && !capture && <InvoiceDetail orgId={org.id} id={openInvoice} onClose={() => setOpenInvoice(null)} onEdit={(i) => setEditing(i)} onPay={(i) => setPaying({ supplierId: i.supplierId, invoiceId: i.id })} />}
      {paying && <PaymentDialog orgId={org.id} supplierId={paying.supplierId} invoiceId={paying.invoiceId} onClose={() => setPaying(null)} />}
      {newShipment && <ShipmentForm orgId={org.id} onClose={() => setNewShipment(false)} onSaved={(s) => { setNewShipment(false); setOpenShipment(s.id); }} />}
      {openShipment && <ShipmentDetail orgId={org.id} id={openShipment} admin={admin} onClose={() => setOpenShipment(null)} />}
      {rules && <RulesDialog orgId={org.id} onClose={() => setRules(false)} />}
    </>
  );
}
