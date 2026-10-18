import type { PurchaseOrder } from "@invintel/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { isAdmin, orgKey, useCurrentOrg } from "@/lib/org";

const LABEL: Record<string, string> = { order: "Order sent", order_response: "Supplier answered", despatch_advice: "Supplier shipped" };

/** On a placed purchase order: send it to a connected Invintel supplier and see what came back. */
export function PoExchange({ order }: { order: PurchaseOrder }) {
  const { id: orgId, role } = useCurrentOrg();
  const qc = useQueryClient();
  const partners = useQuery({ queryKey: orgKey(orgId, "ex-partners"), queryFn: () => api.exPartners(orgId) });
  const timeline = useQuery({ queryKey: orgKey(orgId, "ex-timeline", order.id), queryFn: () => api.exTimeline(orgId, order.id), refetchInterval: 15_000 });
  const suppliers = (partners.data ?? []).filter((p) => p.kind === "supplier" && p.enabled);
  const [pick, setPick] = useState("");
  const send = useMutation({
    mutationFn: () => api.exSendPo(orgId, order.id, pick || suppliers[0]!.id),
    onSuccess: async (r) => { await qc.invalidateQueries({ queryKey: orgKey(orgId, "ex-timeline", order.id) }); toast.success(r.alreadySent ? "That order was already sent" : "Sent, signed, to your supplier"); },
    onError: (e: Error) => toast.error(e.message),
  });
  const events = timeline.data ?? [];
  if (!suppliers.length && !events.length) return null;
  const placed = order.status !== "draft" && order.status !== "cancelled";
  return (
    <div className="space-y-2 rounded-lg border p-3 text-sm">
      <p className="font-medium">Trade with your supplier</p>
      {isAdmin(role) && placed && suppliers.length > 0 && !events.some((e) => e.docType === "order" && e.direction === "out") && (
        <div className="flex items-center gap-2">
          <select aria-label="Supplier to send to" className="h-8 rounded-md border bg-background px-2" value={pick || suppliers[0]!.id} onChange={(e) => setPick(e.target.value)}>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          <Button size="sm" onClick={() => send.mutate()} disabled={send.isPending}><Send /> Send this order</Button>
        </div>
      )}
      {events.length > 0 && (
        <ul className="space-y-1">
          {events.map((e) => {
            const s = e.summary as { status?: string; promisedDate?: string | null; tracking?: string; carrier?: string } | null;
            return (
              <li key={e.messageId} className="flex flex-wrap gap-x-2">
                <span className="font-medium">{LABEL[e.docType] ?? e.docType}</span>
                <span className="text-muted-foreground">{e.partner} · {formatRelative(e.at)}{e.direction === "out" ? ` · ${e.state}` : ""}</span>
                {s?.status && <span>{s.status}{s.promisedDate ? `, promised ${s.promisedDate}` : ""}</span>}
                {s?.tracking && <span>tracking {s.tracking}{s.carrier ? ` (${s.carrier})` : ""}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
