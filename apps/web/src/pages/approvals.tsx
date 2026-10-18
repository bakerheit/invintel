import type { ApprovalRequest, ApprovalStatus } from "@invintel/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { formatCents, formatRelative } from "@/lib/format";
import { invalidateOrg, orgKey, useCurrentOrg } from "@/lib/org";
import { useAuth } from "@/stores/auth";

const STATUS: Record<ApprovalStatus, { label: string; className: string }> = {
  pending: { label: "Waiting", className: "bg-warning-soft text-warning" },
  approved: { label: "Approved", className: "bg-success-soft text-success" },
  rejected: { label: "Rejected", className: "bg-destructive/10 text-destructive" },
  cancelled: { label: "Cancelled", className: "bg-secondary text-secondary-foreground" },
  failed: { label: "Couldn't run", className: "bg-destructive/10 text-destructive" },
};

function Row({ a }: { a: ApprovalRequest }) {
  const { id: orgId } = useCurrentOrg();
  const me = useAuth((s) => s.user?.id ?? "");
  const qc = useQueryClient();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const decide = useMutation({
    mutationFn: (v: { action: "approve" | "reject" | "cancel"; note?: string }) => api.decideApproval(orgId, a.id, v.action, { note: v.note ?? "" }),
    onSuccess: async (r, v) => { await invalidateOrg(qc, orgId); toast.success(v.action === "approve" ? `${r.number} approved and carried out` : v.action === "reject" ? `${r.number} rejected` : `${r.number} cancelled`); setRejecting(false); },
    onError: (e: Error) => { toast.error(e.message); void invalidateOrg(qc, orgId); },
  });
  const link = a.subject.type === "item" ? `/o/${orgId}/inventory/${a.subject.id}` : a.subject.type === "invoice" || a.subject.type === "supplier" ? `/o/${orgId}/payables` : `/o/${orgId}/purchasing`;
  return (
    <li className="space-y-2 py-3 text-sm">
      <div className="flex flex-wrap items-start gap-3">
        <span className="w-20 shrink-0 font-mono font-medium">{a.number}</span>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{a.summary}</p>
          <p className="text-xs text-muted-foreground">
            {formatCents(a.valueCents)} · asked by {a.requestedBy} {formatRelative(a.requestedAt)} ·{" "}
            <Link to={link} className="underline">{a.subject.label}</Link>
            {a.decidedBy ? ` · ${a.status === "rejected" ? "rejected" : "approved"} by ${a.decidedBy}` : ""}
          </p>
          {a.note && <p className="mt-1 text-xs">"{a.note}"</p>}
          {a.failure && <p className="mt-1 text-xs text-destructive">{a.failure}</p>}
        </div>
        <Badge variant="secondary" className={STATUS[a.status].className}>{STATUS[a.status].label}</Badge>
      </div>
      {a.status === "pending" && (
        <div className="flex flex-wrap items-center gap-2 pl-0 sm:pl-[5.75rem]">
          {a.canDecide && !rejecting && (
            <>
              <Button size="sm" onClick={() => decide.mutate({ action: "approve" })} disabled={decide.isPending}><Check /> Approve</Button>
              <Button size="sm" variant="outline" onClick={() => setRejecting(true)}><X /> Reject</Button>
            </>
          )}
          {rejecting && (
            <form className="flex w-full max-w-md gap-2" onSubmit={(e) => { e.preventDefault(); if (note.trim()) decide.mutate({ action: "reject", note }); }}>
              <Input aria-label="Why" autoFocus placeholder="Why? So they know what to change" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
              <Button size="sm" type="submit" disabled={!note.trim() || decide.isPending}>Reject</Button>
              <Button size="sm" type="button" variant="ghost" onClick={() => setRejecting(false)}>Back</Button>
            </form>
          )}
          {!a.canDecide && <span className="text-xs text-muted-foreground">Waiting for an admin who isn't {a.requestedBy}.</span>}
          {a.requestedById === me && !rejecting && <Button size="sm" variant="ghost" onClick={() => decide.mutate({ action: "cancel" })}>Cancel request</Button>}
        </div>
      )}
    </li>
  );
}

export default function ApprovalsPage() {
  const { id: orgId } = useCurrentOrg();
  const list = useQuery({ queryKey: orgKey(orgId, "approvals"), queryFn: () => api.listApprovals(orgId), refetchInterval: 15_000 });
  const rows = list.data ?? [];
  const waiting = rows.filter((r) => r.status === "pending");
  const done = rows.filter((r) => r.status !== "pending");
  return (
    <>
      <PageHeader title="Approvals" description="Actions that need a second person's OK before they happen. Admins set the rules in Settings." />
      <Card>
        <CardHeader><CardTitle>Waiting</CardTitle></CardHeader>
        <CardContent>
          {list.isLoading ? <Skeleton className="h-20" /> : !waiting.length ? <EmptyState icon={ShieldCheck} title="Nothing waiting" description="Requests appear here when an action crosses an approval rule." /> : <ul className="divide-y">{waiting.map((a) => <Row key={a.id} a={a} />)}</ul>}
        </CardContent>
      </Card>
      {done.length > 0 && (
        <Card>
          <CardHeader><CardTitle>History</CardTitle></CardHeader>
          <CardContent><ul className="divide-y">{done.map((a) => <Row key={a.id} a={a} />)}</ul></CardContent>
        </Card>
      )}
    </>
  );
}
