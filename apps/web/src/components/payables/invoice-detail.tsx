import { formatQty, PAYMENT_METHOD_LABELS, type Invoice, type InvoiceStatus, type MatchFlag } from "@invintel/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, CircleCheck, Info, Pencil, Receipt, Wallet, XCircle } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { invalidateOrg, orgKey } from "@/lib/org";
import { cn } from "@/lib/utils";

export const INVOICE_STATUS: Record<InvoiceStatus, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-secondary text-secondary-foreground" },
  review: { label: "Needs review", className: "bg-warning-soft text-warning" },
  approved: { label: "Ready to pay", className: "bg-accent text-accent-foreground" },
  paid: { label: "Paid", className: "bg-success-soft text-success" },
  void: { label: "Void", className: "bg-destructive/10 text-destructive" },
};

const FLAG_STYLE: Record<MatchFlag["severity"], { icon: typeof Info; className: string }> = {
  block: { icon: XCircle, className: "text-destructive" },
  warn: { icon: AlertTriangle, className: "text-warning" },
  info: { icon: Info, className: "text-muted-foreground" },
};

/** One invoice: what it says, what the order and the dock say about it, and what can be done next. */
export function InvoiceDetail({ orgId, id, onClose, onEdit, onPay }: { orgId: string; id: string; onClose: () => void; onEdit: (i: Invoice) => void; onPay: (i: Invoice) => void }) {
  const qc = useQueryClient();
  const key = orgKey(orgId, "invoice", id);
  const q = useQuery({ queryKey: key, queryFn: () => api.getInvoice(orgId, id) });
  const pays = useQuery({ queryKey: orgKey(orgId, "invoice-payments", id), queryFn: () => api.listPayments(orgId, { invoiceId: id }) });
  const [reason, setReason] = useState("");
  const [voiding, setVoiding] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  const refresh = async () => { await invalidateOrg(qc, orgId); };

  const act = useMutation({
    mutationFn: (a: "submit" | "approve") => (a === "submit" ? api.submitInvoice(orgId, id) : api.approveInvoice(orgId, id, { overrideReason: reason })),
    onSuccess: async (r) => {
      if ("approvalRequired" in r) toast.success(`Sent for approval (${r.approval.number}). It is ready to pay once another admin approves it.`);
      else toast.success(r.status === "approved" ? "Approved. It is ready to pay." : "Matched. It needs a person to look at it.");
      await refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const voidIt = useMutation({
    mutationFn: () => api.voidInvoice(orgId, id, { reason: voidReason }),
    onSuccess: async () => { toast.success("Invoice voided"); setVoiding(false); await refresh(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const inv = q.data;
  const blocking = inv?.match?.flags.some((f) => f.severity === "block") ?? false;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {inv ? `${inv.number} · ${inv.supplierName} · ${inv.invoiceNumber}` : "Invoice"}
            {inv && <Badge variant="secondary" className={INVOICE_STATUS[inv.status].className}>{INVOICE_STATUS[inv.status].label}</Badge>}
          </DialogTitle>
        </DialogHeader>
        {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {q.error && <p role="alert" className="text-sm text-destructive">{(q.error as Error).message}</p>}
        {inv && (
          <div className="grid max-h-[70vh] gap-4 overflow-auto pr-1 text-sm">
            <p className="text-muted-foreground">
              Dated {inv.issueDate}{inv.dueDate ? ` · due ${inv.dueDate}` : ""} · {inv.purchaseOrderNumber ? `against ${inv.purchaseOrderNumber}` : "no purchase order"} · entered by {inv.createdBy}
              {inv.approvedBy ? ` · approved by ${inv.approvedBy}` : ""}{inv.approvalNumber ? ` · waiting for a second person (${inv.approvalNumber})` : ""}
            </p>
            {inv.note && <p>{inv.note}</p>}
            {inv.voidReason && <p className="text-destructive">Voided: {inv.voidReason}</p>}
            {inv.overrideReason && <p className="rounded-lg bg-warning-soft p-2 text-warning">Paid despite problems: {inv.overrideReason}</p>}

            {inv.match && (
              <section aria-label="Match" className="space-y-2">
                <h3 className="flex items-center gap-2 font-medium">
                  {inv.match.status === "matched" ? <CircleCheck className="size-4 text-success" /> : <AlertTriangle className="size-4 text-warning" />}
                  {inv.match.status === "matched" ? "Matches the order and what arrived" : inv.match.status === "no_po" ? "Nothing to match against" : "Doesn't match"}
                </h3>
                {inv.match.flags.length > 0 && (
                  <ul className="space-y-1">
                    {inv.match.flags.map((f, i) => {
                      const S = FLAG_STYLE[f.severity];
                      return <li key={i} className={cn("flex items-start gap-2", S.className)}><S.icon className="mt-0.5 size-4 shrink-0" /><span className="text-foreground">{f.line ? <span className="text-muted-foreground">Line {f.line}: </span> : null}{f.message}</span></li>;
                    })}
                  </ul>
                )}
              </section>
            )}

            <div className="overflow-auto rounded-lg border">
              <table className="w-full min-w-[44rem] text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr><th className="p-2">Line</th><th className="p-2 text-right">Billed</th><th className="p-2 text-right">Price</th><th className="p-2 text-right">Amount</th>{inv.match?.lines.some((l) => l.orderedQuantity !== null) && <><th className="p-2 text-right">Ordered</th><th className="p-2 text-right">Order price</th><th className="p-2 text-right">Received</th></>}</tr>
                </thead>
                <tbody className="divide-y">
                  {inv.lines.map((l, i) => {
                    const m = inv.match?.lines[i];
                    const flagged = (code: string) => inv.match?.flags.some((f) => f.line === l.line && f.code.startsWith(code) && f.severity !== "info");
                    return (
                      <tr key={l.line}>
                        <td className="p-2"><div className="font-medium">{l.itemSku ? l.description : l.description}</div>{l.itemSku && <div className="font-mono text-xs text-muted-foreground">{l.itemSku}</div>}</td>
                        <td className={cn("p-2 text-right tabular-nums", (flagged("over") || flagged("not_received")) && "font-semibold text-destructive")}>{formatQty(l.quantity, l.uom)}</td>
                        <td className={cn("p-2 text-right tabular-nums", flagged("price") && "font-semibold text-destructive")}>{formatMoney(l.unitPriceCents, inv.currency)}</td>
                        <td className="p-2 text-right tabular-nums">{formatMoney(l.amountCents, inv.currency)}</td>
                        {inv.match?.lines.some((x) => x.orderedQuantity !== null) && (
                          <>
                            <td className="p-2 text-right tabular-nums">{m?.orderedQuantity != null ? formatQty(m.orderedQuantity, l.uom, { unit: false }) : "-"}</td>
                            <td className="p-2 text-right tabular-nums">{m?.orderedPriceCents != null ? formatMoney(m.orderedPriceCents, inv.currency) : "-"}</td>
                            <td className="p-2 text-right tabular-nums">{m?.receivedQuantity != null ? formatQty(m.receivedQuantity, l.uom, { unit: false }) : "-"}{m && m.invoicedElsewhere > 0 ? <span className="block text-xs text-muted-foreground">+{formatQty(m.invoicedElsewhere, l.uom, { unit: false })} billed already</span> : null}</td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="border-t bg-muted/30 text-sm">
                  <tr><td className="p-2" colSpan={3}>Subtotal</td><td className="p-2 text-right tabular-nums">{formatMoney(inv.subtotalCents, inv.currency)}</td><td colSpan={3} /></tr>
                  {inv.taxCents > 0 && <tr><td className="p-2" colSpan={3}>Tax</td><td className="p-2 text-right tabular-nums">{formatMoney(inv.taxCents, inv.currency)}</td><td colSpan={3} /></tr>}
                  {inv.freightCents > 0 && <tr><td className="p-2" colSpan={3}>Freight</td><td className="p-2 text-right tabular-nums">{formatMoney(inv.freightCents, inv.currency)}</td><td colSpan={3} /></tr>}
                  <tr className="font-semibold"><td className="p-2" colSpan={3}>Total{inv.statedTotalCents != null && inv.statedTotalCents !== inv.totalCents ? ` (they say ${formatMoney(inv.statedTotalCents, inv.currency)})` : ""}</td><td className="p-2 text-right tabular-nums">{formatMoney(inv.totalCents, inv.currency)}</td><td colSpan={3} /></tr>
                  {inv.paidCents > 0 && <tr><td className="p-2" colSpan={3}>Paid so far</td><td className="p-2 text-right tabular-nums">{formatMoney(inv.paidCents, inv.currency)}</td><td colSpan={3} /></tr>}
                  {inv.status !== "void" && inv.paidCents > 0 && <tr className="font-semibold"><td className="p-2" colSpan={3}>Still to pay</td><td className="p-2 text-right tabular-nums">{formatMoney(inv.balanceCents, inv.currency)}</td><td colSpan={3} /></tr>}
                </tfoot>
              </table>
            </div>

            {(pays.data?.length ?? 0) > 0 && (
              <section aria-label="Payments" className="space-y-1">
                <h3 className="font-medium">Payments</h3>
                <ul className="divide-y rounded-lg border">
                  {pays.data!.map((p) => (
                    <li key={p.id} className={cn("flex flex-wrap items-center justify-between gap-2 p-2", p.voidedAt && "text-muted-foreground line-through")}>
                      <span>{p.number} · {p.paidOn} · {PAYMENT_METHOD_LABELS[p.method]}{p.reference ? ` · ${p.reference}` : ""}</span>
                      <span className="flex items-center gap-3"><span className="tabular-nums">{formatMoney(p.allocations.find((a) => a.invoiceId === inv.id)?.amountCents ?? p.amountCents, p.currency)}</span><Link to={`/o/${orgId}/remittance/${p.id}`} className="text-xs underline no-underline hover:underline"><Receipt className="inline size-3" /> Remittance</Link></span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {inv.can.approve && blocking && (
              <div className="space-y-1.5 rounded-lg border border-warning/50 p-3">
                <label htmlFor="override" className="font-medium">To pay it anyway, say why</label>
                <Input id="override" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Mill raised the price, confirmed by phone" />
                <p className="text-xs text-muted-foreground">Someone other than the person who entered it has to do this, unless you're the only admin. It is kept with the invoice.</p>
              </div>
            )}
            {voiding && (
              <div className="flex flex-wrap items-end gap-2">
                <div className="grid flex-1 gap-1.5"><label htmlFor="void-reason" className="font-medium">Why void it?</label><Input id="void-reason" value={voidReason} onChange={(e) => setVoidReason(e.target.value)} maxLength={300} autoFocus /></div>
                <Button variant="destructive" disabled={!voidReason.trim() || voidIt.isPending} onClick={() => voidIt.mutate()}>Void invoice</Button>
                <Button variant="ghost" onClick={() => setVoiding(false)}>Keep it</Button>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {inv.can.submit && <Button onClick={() => act.mutate("submit")} disabled={act.isPending}><Check /> Match it</Button>}
              {inv.can.approve && <Button onClick={() => act.mutate("approve")} disabled={act.isPending || (blocking && !reason.trim()) || !!inv.approvalNumber}><Check /> {blocking ? "Pay anyway: approve" : "Approve"}</Button>}
              {inv.can.pay && <Button onClick={() => onPay(inv)}><Wallet /> Record a payment</Button>}
              {inv.can.edit && <Button variant="outline" onClick={() => onEdit(inv)}><Pencil /> Edit</Button>}
              {inv.can.void && !voiding && <Button variant="ghost" className="text-destructive" onClick={() => setVoiding(true)}>Void</Button>}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
