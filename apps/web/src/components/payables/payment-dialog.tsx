import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentMethod } from "@invintel/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Landmark, Pencil } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { centsToDollars, formatMoney } from "@/lib/format";
import { invalidateOrg, orgKey } from "@/lib/org";
import { parseDollars } from "./invoice-form";

const selectClass = "h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-sm";

/** How a supplier is paid: the method and the last four digits, never a whole account number. */
export function PaymentDetailsDialog({ orgId, supplierId, supplierName, onClose }: { orgId: string; supplierId: string; supplierName: string; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: orgKey(orgId, "supplier-payment-details", supplierId), queryFn: () => api.supplierPaymentDetails(orgId, supplierId) });
  const [form, setForm] = useState<{ method: PaymentMethod; accountName: string; bankName: string; accountLast4: string; instructions: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const v = form ?? { method: q.data?.method ?? "bank_transfer", accountName: q.data?.accountName ?? "", bankName: q.data?.bankName ?? "", accountLast4: q.data?.accountLast4 ?? "", instructions: q.data?.instructions ?? "" };
  const save = useMutation({
    mutationFn: () => api.saveSupplierPaymentDetails(orgId, supplierId, v),
    onSuccess: async (r) => {
      await invalidateOrg(qc, orgId);
      if ("approvalRequired" in r) toast.success(`Sent for approval (${r.approval.number}). It changes once another admin approves it.`);
      else toast.success("Saved");
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });
  const set = (patch: Partial<typeof v>) => setForm({ ...v, ...patch });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>How {supplierName} is paid</DialogTitle></DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); setError(null); save.mutate(); }} className="grid gap-3">
          <p className="rounded-lg bg-warning-soft p-2 text-sm text-warning">Changing where money goes is how invoice fraud works, so changes are recorded, and your rules can ask for a second person's OK. Don't enter a full account number: the last four digits are enough to recognise it.</p>
          <div className="grid gap-1.5"><Label htmlFor="pd-method">Usually paid by</Label><select id="pd-method" className={selectClass} value={v.method} onChange={(e) => set({ method: e.target.value as PaymentMethod })}>{PAYMENT_METHODS.map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>)}</select></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5"><Label htmlFor="pd-name">Account name</Label><Input id="pd-name" value={v.accountName} onChange={(e) => set({ accountName: e.target.value })} maxLength={120} /></div>
            <div className="grid gap-1.5"><Label htmlFor="pd-bank">Bank</Label><Input id="pd-bank" value={v.bankName} onChange={(e) => set({ bankName: e.target.value })} maxLength={120} /></div>
          </div>
          <div className="grid gap-1.5"><Label htmlFor="pd-last4">Last 4 digits</Label><Input id="pd-last4" value={v.accountLast4} inputMode="numeric" maxLength={4} onChange={(e) => set({ accountLast4: e.target.value })} className="w-28" /></div>
          <div className="grid gap-1.5"><Label htmlFor="pd-notes">Instructions</Label><Input id="pd-notes" value={v.instructions} onChange={(e) => set({ instructions: e.target.value })} maxLength={300} placeholder="Quote the invoice number" /></div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" disabled={save.isPending || q.isLoading}>Save</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Record that a supplier was paid. Nothing is sent anywhere: this keeps the books and makes a remittance. */
export function PaymentDialog({ orgId, supplierId, invoiceId, onClose }: { orgId: string; supplierId: string; invoiceId?: string; onClose: () => void }) {
  const qc = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);
  const supplier = useQuery({ queryKey: orgKey(orgId, "suppliers"), queryFn: () => api.listSuppliers(orgId) });
  const open = useQuery({ queryKey: orgKey(orgId, "invoices", "payable", supplierId), queryFn: () => api.listInvoices(orgId, { status: "approved", supplierId }) });
  const details = useQuery({ queryKey: orgKey(orgId, "supplier-payment-details", supplierId), queryFn: () => api.supplierPaymentDetails(orgId, supplierId) });
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [method, setMethod] = useState<PaymentMethod | "">("");
  const [paidOn, setPaidOn] = useState(today);
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = supplier.data?.find((s) => s.id === supplierId)?.name ?? "supplier";
  const rows = (open.data ?? []).filter((r) => r.balanceCents > 0);
  const shown = (r: (typeof rows)[number]) => amounts[r.id] ?? (r.id === invoiceId ? centsToDollars(r.balanceCents) : "");
  const entries = rows.map((r) => ({ r, cents: parseDollars(shown(r)) })).filter((x) => x.cents === null || x.cents > 0);
  const total = entries.reduce((s, x) => s + (x.cents ?? 0), 0);
  const currency = rows[0]?.currency ?? "USD";

  const pay = useMutation({
    mutationFn: () => {
      for (const x of entries) {
        if (x.cents === null) throw new Error(`${x.r.number}: enter an amount like 50.00`);
        if (x.cents > x.r.balanceCents) throw new Error(`${x.r.number} only has ${formatMoney(x.r.balanceCents, x.r.currency)} left to pay`);
      }
      if (!entries.length) throw new Error("Enter how much of an invoice was paid");
      return api.createPayment(orgId, { supplierId, method: (method || details.data?.method || "bank_transfer") as PaymentMethod, paidOn, reference, note, allocations: entries.map((x) => ({ invoiceId: x.r.id, amountCents: x.cents! })) });
    },
    onSuccess: async (p) => { await invalidateOrg(qc, orgId); toast.success(`Recorded ${p.number}`); onClose(); },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <>
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader><DialogTitle>Record a payment to {name}</DialogTitle></DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); setError(null); pay.mutate(); }} className="grid max-h-[70vh] gap-4 overflow-auto pr-1">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
              <span className="flex items-center gap-2"><Landmark className="size-4 text-muted-foreground" />
                {details.data ? <>Usually paid by <strong>{PAYMENT_METHOD_LABELS[details.data.method]}</strong>{details.data.accountName ? ` to ${details.data.accountName}` : ""}{details.data.accountLast4 ? `, account ending ${details.data.accountLast4}` : ""}</> : <span className="text-muted-foreground">No payment details on file.</span>}
              </span>
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(true)}><Pencil /> {details.data ? "Change" : "Add"}</Button>
            </div>
            <div className="space-y-1">
              <h3 className="text-sm font-medium">Which invoices?</h3>
              {open.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
              {!open.isLoading && !rows.length && <p className="text-sm text-muted-foreground">Nothing is ready to pay for this supplier. An invoice has to be matched and approved first.</p>}
              <ul className="divide-y rounded-lg border">
                {rows.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 p-2 text-sm">
                    <span><span className="font-medium">{r.invoiceNumber}</span> <span className="text-muted-foreground">{r.number} · owes {formatMoney(r.balanceCents, r.currency)}{r.dueDate ? ` · due ${r.dueDate}` : ""}</span></span>
                    <span className="flex items-center gap-1">$<Input aria-label={`Amount paid on ${r.invoiceNumber}`} className="h-8 w-28 text-right" inputMode="decimal" placeholder="0.00" value={shown(r)} onChange={(e) => setAmounts({ ...amounts, [r.id]: e.target.value })} /></span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="grid gap-1.5"><Label htmlFor="pay-method">Paid by</Label><select id="pay-method" className={selectClass} value={method || details.data?.method || "bank_transfer"} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>{PAYMENT_METHODS.map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>)}</select></div>
              <div className="grid gap-1.5"><Label htmlFor="pay-date">Paid on</Label><Input id="pay-date" type="date" max={today} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} required /></div>
              <div className="grid gap-1.5"><Label htmlFor="pay-ref">Check number or reference</Label><Input id="pay-ref" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={80} /></div>
            </div>
            <div className="grid gap-1.5"><Label htmlFor="pay-note">Note for the remittance</Label><Input id="pay-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></div>
            <p className="text-xs text-muted-foreground">This records a payment you made. No money moves from here.</p>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <DialogFooter><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" disabled={pay.isPending || !entries.length}>Record {formatMoney(total, currency)}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {editing && <PaymentDetailsDialog orgId={orgId} supplierId={supplierId} supplierName={name} onClose={() => setEditing(false)} />}
    </>
  );
}
