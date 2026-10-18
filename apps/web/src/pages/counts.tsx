import { formatQty, type Count, type CountLine, type CountStatus } from "@invintel/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, Plus, ScanLine } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm";
import { QtyInput } from "@/components/qty-input";
import { useQtyEntry } from "@/lib/qty";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { formatCents, formatRelative } from "@/lib/format";
import { invalidateOrg, isAdmin, orgKey, useCurrentOrg, useLocations } from "@/lib/org";
import { cn } from "@/lib/utils";

const STATUS: Record<CountStatus, { label: string; className: string }> = {
  open: { label: "Counting", className: "bg-accent text-accent-foreground" },
  posted: { label: "Posted", className: "bg-success-soft text-success" },
  cancelled: { label: "Cancelled", className: "bg-secondary text-secondary-foreground" },
};

const signed = (n: number) => (n > 0 ? `+${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : n.toLocaleString(undefined, { maximumFractionDigits: 2 }));

function CountDetail({ countId, onClose }: { countId: string; onClose: () => void }) {
  const { id: orgId, role } = useCurrentOrg();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [zero, setZero] = useState(false);
  const count = useQuery({ queryKey: orgKey(orgId, "count", countId), queryFn: () => api.getCount(orgId, countId), refetchInterval: (q) => (q.state.data?.status === "open" ? 8000 : false) });
  const c: Count | undefined = count.data;
  const done = async (msg: string) => { await invalidateOrg(qc, orgId); toast.success(msg); };
  const post = useMutation({
    mutationFn: () => api.postCount(orgId, countId, zero),
    onSuccess: async (r) => {
      await done(r.failures.length ? `Posted with ${r.failures.length} problem(s): ${r.failures[0]}` : `Posted. ${r.adjustments} ${r.adjustments === 1 ? "adjustment" : "adjustments"} made.`);
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const cancel = useMutation({
    mutationFn: () => api.cancelCount(orgId, countId),
    onSuccess: async () => { await done("Count cancelled. Stock is unchanged."); onClose(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const fix = useMutation({
    mutationFn: ({ itemId, counted }: { itemId: string; counted: number }) => api.countItem(orgId, countId, itemId, counted),
    onSuccess: () => qc.invalidateQueries({ queryKey: orgKey(orgId, "count", countId) }),
    onError: (e: Error) => toast.error(e.message),
  });
  if (!c) return null;
  const admin = isAdmin(role);
  const writeOff = zero ? Math.round(c.uncounted.reduce((s, u) => s + u.expected / 10 ** u.uom.decimals, 0)) : 0;
  const askPost = async () => {
    const diffs = c.summary.over + c.summary.under + (zero ? c.uncounted.length : 0);
    if (await confirm({
      title: `Post ${c.number}?`,
      description: diffs ? `${diffs} ${diffs === 1 ? "difference becomes an adjustment" : "differences become adjustments"} in the ledger. You can reverse each one in Activity.` : "Everything matched, so no stock changes.",
      confirmLabel: "Post count",
    })) post.mutate();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">{c.number} <Badge variant="secondary" className={STATUS[c.status].className}>{STATUS[c.status].label}</Badge></DialogTitle>
          <DialogDescription>{c.locationPath} · started by {c.startedBy} {formatRelative(c.startedAt)}</DialogDescription>
        </DialogHeader>
        <p className="text-sm">
          <strong>{c.summary.counted}</strong> counted: {c.summary.matched} matched, <span className={c.summary.over ? "font-medium text-warning" : ""}>{c.summary.over} over</span>, <span className={c.summary.under ? "font-medium text-destructive" : ""}>{c.summary.under} short</span>.
          Net <strong>{signed(c.summary.netUnits)}</strong> units ({formatCents(c.summary.netCents)}).
        </p>
        <div className="max-h-72 overflow-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted text-left text-xs text-muted-foreground"><tr><th className="p-2">Item</th><th className="p-2 text-right">System says</th><th className="p-2 text-right">Counted</th><th className="p-2 text-right">Difference</th><th className="p-2 text-right">Value</th></tr></thead>
            <tbody className="divide-y">
              {c.lines.map((l) => (
                <tr key={l.itemId}>
                  <td className="p-2"><div className="font-medium">{l.itemName}</div><div className="font-mono text-xs text-muted-foreground">{l.itemSku}</div></td>
                  <td className="p-2 text-right tabular-nums">{formatQty(l.expected, l.uom, { unit: false })}</td>
                  <td className="p-2 text-right">
                    {c.status === "open" ? (
                      <CountedBox line={l} onSave={(counted) => fix.mutate({ itemId: l.itemId, counted })} />
                    ) : <span className="tabular-nums">{formatQty(l.counted, l.uom, { unit: false })}</span>}
                  </td>
                  <td className={cn("p-2 text-right font-semibold tabular-nums", l.variance < 0 && "text-destructive", l.variance > 0 && "text-warning", l.variance === 0 && "font-normal text-muted-foreground")}>{l.variance === 0 ? "matched" : formatQty(l.variance, l.uom, { sign: true, unit: false })}</td>
                  <td className="p-2 text-right tabular-nums text-muted-foreground">{l.variance === 0 ? "" : formatCents(l.varianceCents)}</td>
                </tr>
              ))}
              {!c.lines.length && <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">Nothing counted yet. Count from Floor mode, or the items appear here as people scan them.</td></tr>}
            </tbody>
          </table>
        </div>
        {c.status === "open" && c.uncounted.length > 0 && (
          <div className="rounded-lg border bg-muted/30 p-3 text-sm">
            <p className="font-medium">{c.uncounted.length} {c.uncounted.length === 1 ? "item has" : "items have"} stock here that nobody counted</p>
            <p className="mt-1 text-muted-foreground">{c.uncounted.slice(0, 6).map((u) => `${u.itemName} (${formatQty(u.expected, u.uom)})`).join(", ")}{c.uncounted.length > 6 ? `, and ${c.uncounted.length - 6} more` : ""}</p>
            {admin && (
              <label className="mt-2 flex items-center gap-2">
                <input type="checkbox" className="size-4" checked={zero} onChange={(e) => setZero(e.target.checked)} />
                <span>Treat them as zero when posting{zero ? ` (writes off ${writeOff.toLocaleString()} units)` : ""}</span>
              </label>
            )}
          </div>
        )}
        {c.status === "open" && (
          <DialogFooter className="sm:justify-between">
            <Button variant="ghost" className="text-destructive" onClick={() => cancel.mutate()} disabled={cancel.isPending}>Cancel count</Button>
            {admin ? <Button onClick={() => void askPost()} disabled={post.isPending || (!c.lines.length && !zero)}>Post count</Button> : <p className="self-center text-sm text-muted-foreground">An admin reviews and posts this count.</p>}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function CountsPage() {
  const { id: orgId } = useCurrentOrg();
  const qc = useQueryClient();
  const { data: locations = [] } = useLocations(orgId);
  const counts = useQuery({ queryKey: orgKey(orgId, "counts"), queryFn: () => api.listCounts(orgId) });
  const [open, setOpen] = useState<string | null>(null);
  const [locationId, setLocationId] = useState("");
  const start = useMutation({
    mutationFn: () => api.startCount(orgId, locationId),
    onSuccess: async (c) => { await invalidateOrg(qc, orgId); setOpen(c.id); },
    onError: (e: Error) => toast.error(e.message),
  });
  const rows = counts.data ?? [];

  // "Start count" on the Reports page sends people here with ?start=<location id>.
  const [params, setParams] = useSearchParams();
  const startId = params.get("start");
  useEffect(() => {
    if (!startId) return;
    setParams({}, { replace: true });
    api.startCount(orgId, startId).then(async (c) => { await invalidateOrg(qc, orgId); setOpen(c.id); }, (e: Error) => toast.error(e.message));
  }, [startId, orgId, qc, setParams]);

  return (
    <>
      <PageHeader
        title="Counts"
        description="Walk a place, count what's there, and let an admin post the differences."
        actions={<Link to={`/o/${orgId}/floor/count`} className={buttonVariants({ variant: "outline" })}><ScanLine /> Count in Floor mode</Link>}
      />
      <Card>
        <CardHeader><CardTitle>Start a count</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <div className="w-72 max-w-full">
            <Select value={locationId} onValueChange={(v) => v && setLocationId(v)} items={locations.map((l) => ({ value: l.id, label: l.path }))}>
              <SelectTrigger aria-label="Location to count" className="w-full"><SelectValue placeholder="Choose a place to count" /></SelectTrigger>
              <SelectContent>{locations.map((l) => <SelectItem key={l.id} value={l.id}>{l.path}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <Button disabled={!locationId || start.isPending} onClick={() => start.mutate()}><Plus /> Start counting</Button>
          <p className="w-full text-xs text-muted-foreground">One count per place at a time. Starting where one is already open picks it up.</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Counts</CardTitle></CardHeader>
        <CardContent>
          {!rows.length ? (
            <EmptyState icon={ClipboardCheck} title="No counts yet" description="Start one above, or scan a place in Floor mode > Count." />
          ) : (
            <ul className="divide-y">
              {rows.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => setOpen(r.id)} className="flex w-full items-center gap-3 py-3 text-left text-sm hover:bg-muted/40">
                    <span className="w-24 shrink-0 font-mono font-medium">{r.number}</span>
                    <span className="min-w-0 flex-1"><span className="block truncate font-medium">{r.locationPath}</span><span className="block truncate text-xs text-muted-foreground">{r.lines} counted{r.variances ? `, ${r.variances} differ` : ""} · {r.startedBy} {formatRelative(r.startedAt)}</span></span>
                    <Badge variant="secondary" className={STATUS[r.status].className}>{STATUS[r.status].label}</Badge>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      {open && <CountDetail key={open} countId={open} onClose={() => setOpen(null)} />}
    </>
  );
}

/** Fix a counted figure on the desk. Typed in the item's own unit; saved when you leave the box, only if it's a valid, different quantity. */
function CountedBox({ line, onSave }: { line: CountLine; onSave: (counted: number) => void }) {
  const entry = useQtyEntry(line.uom, { initial: line.counted });
  return (
    <div className="ml-auto w-24">
      <QtyInput
        entry={entry}
        aria-label={`Counted ${line.itemName}`}
        inputClassName="h-8 text-right"
        onBlur={() => { if (entry.stored !== null && entry.stored !== line.counted) onSave(entry.stored); }}
      />
    </div>
  );
}
