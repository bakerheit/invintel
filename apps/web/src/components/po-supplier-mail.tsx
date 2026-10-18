import type { PurchaseOrder } from "@invintel/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Link2, Mail } from "lucide-react";
import { Link } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { invalidateOrg, isAdmin, orgKey, useCurrentOrg } from "@/lib/org";

/** On a placed purchase order: email it to the supplier (a PDF and a link to confirm), and see what they answered. */
export function PoSupplierMail({ order }: { order: PurchaseOrder }) {
  const { id: orgId, role } = useCurrentOrg();
  const qc = useQueryClient();
  const placed = order.status === "ordered" || order.status === "partial";
  const ex = useQuery({ queryKey: orgKey(orgId, "b2b", "order", order.id), queryFn: () => api.orderExchange(orgId, order.id), enabled: placed });
  const send = useMutation({
    mutationFn: () => api.sendOrderToSupplier(orgId, order.id),
    onSuccess: (m) => { toast[m.state === "failed" ? "error" : "success"](m.state === "failed" ? `Could not send: ${m.attempts.at(-1)?.error ?? "unknown error"}` : "Order emailed to the supplier"); void invalidateOrg(qc, orgId); },
    onError: (e: Error) => toast.error(e.message),
  });
  const useDate = useMutation({
    mutationFn: (d: string) => api.updateOrderDate(orgId, order.id, d),
    onSuccess: () => { toast.success("Expected date updated"); void invalidateOrg(qc, orgId); },
    onError: (e: Error) => toast.error(e.message),
  });
  if (!placed || !ex.data) return null;
  const d = ex.data;
  const admin = isAdmin(role);
  const last = d.lastMessage;
  return (
    <div className="space-y-2 rounded-lg border p-3 text-sm">
      <p className="flex items-center gap-2 font-medium"><Mail className="size-4" /> Email the supplier</p>
      {!d.partner ? (
        <p className="text-muted-foreground">To email orders to this supplier, add them as a trading partner under <Link className="underline" to={`/o/${orgId}/documents`}>Documents</Link>.</p>
      ) : (
        <>
          <p className="text-muted-foreground">
            {d.partner.name}{d.partner.mode === "test" ? " (test partner: emails say TEST)" : ""}
            {last ? ` · last sent ${formatRelative(last.at)}: ${last.state}${last.error ? ` (${last.error})` : ""}` : " · not sent yet"}
          </p>
          {(d.confirmed || d.rejected) && <p className={d.confirmed ? "font-medium text-success" : "font-medium text-destructive"}>{d.confirmed ? "Supplier confirmed" : "Supplier declined"}{d.promisedDate ? `, promising ${d.promisedDate}` : ""}{d.note ? `: ${d.note}` : ""}</p>}
          {(d.shipDate || d.trackingNumber) && <p>Shipped {d.shipDate ?? ""}{d.carrier || d.trackingNumber ? ` · ${[d.carrier, d.trackingNumber].filter(Boolean).join(" ")}` : ""}</p>}
          <div className="flex flex-wrap gap-2">
            {admin && <Button size="sm" onClick={() => send.mutate()} disabled={send.isPending}><Mail /> {last ? "Send again" : "Email to supplier"}</Button>}
            <a href={api.orderPreviewUrl(orgId, order.id)} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1 rounded-md border px-2.5 text-sm font-medium hover:bg-muted"><FileText className="size-4" /> Preview PDF</a>
            {admin && d.portalUrl && <Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(d.portalUrl!).then(() => toast.success("Supplier link copied"))}><Link2 /> Copy supplier link</Button>}
            {admin && d.promisedDate && d.promisedDate !== order.expectedDate && <Button size="sm" variant="outline" onClick={() => useDate.mutate(d.promisedDate!)}>Use promised date {d.promisedDate}</Button>}
          </div>
        </>
      )}
    </div>
  );
}
