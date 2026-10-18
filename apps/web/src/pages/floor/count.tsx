import type { Count } from "@invintel/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { ScanInput } from "@/components/floor/scan-input";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { feedback } from "@/lib/feedback";
import { resolveItem, resolveLocation } from "@/lib/floor";
import { invalidateOrg, isAdmin, useCurrentOrg } from "@/lib/org";
import { cn } from "@/lib/utils";

/**
 * Count: scan a place, then scan each item and say how many are there. It is a blind count: the screen
 * never shows what the system expects, so people count what they see. An admin reviews the differences.
 */
export default function CountPage() {
  const { id: orgId, role } = useCurrentOrg();
  const qc = useQueryClient();
  const [count, setCount] = useState<Count | null>(null);
  const [item, setItem] = useState<{ id: string; name: string; sku: string } | null>(null);
  const [qty, setQty] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: async (code: string) => {
      const loc = await resolveLocation(orgId, code);
      if (!loc.ok) throw new Error(loc.error);
      return api.startCount(orgId, loc.value.id);
    },
    onSuccess: (c) => { feedback("ok"); setError(null); setCount(c); },
    onError: (e: Error) => { feedback("error"); setError(e.message); },
  });
  const pick = useMutation({
    mutationFn: async (code: string) => {
      const r = await resolveItem(orgId, code);
      if (!r.ok) throw new Error(r.error);
      return r.value;
    },
    onSuccess: (i) => {
      feedback("ok");
      setError(null);
      setSaved(null);
      setItem({ id: i.id, name: i.name, sku: i.sku });
      // Counting it again replaces the number, so start from what was entered before.
      const before = count?.lines.find((l) => l.itemId === i.id);
      setQty(before ? String(before.counted) : "");
    },
    onError: (e: Error) => { feedback("error"); setError(e.message); },
  });
  const save = useMutation({
    mutationFn: () => api.countItem(orgId, count!.id, item!.id, Number(qty)),
    onSuccess: async (c) => {
      feedback("ok");
      setSaved(`${item!.name}: ${qty}`);
      setCount(c);
      setItem(null);
      setQty("");
      await invalidateOrg(qc, orgId);
    },
    onError: (e: Error) => { feedback("error"); setError(e.message); },
  });

  if (!count) {
    return (
      <>
        <h1 className="text-3xl font-semibold tracking-tight">Count</h1>
        <ScanInput label="Scan the shelf, rack or area you're counting" onScan={(c) => start.mutate(c)} disabled={start.isPending} error={error} />
      </>
    );
  }
  const admin = isAdmin(role);
  return (
    <>
      <div className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">Count</h1>
        <p className="text-base text-muted-foreground">{count.locationPath} · {count.number}</p>
      </div>

      {saved && !item && (
        <p role="status" className="flex items-center gap-2 rounded-xl bg-success-soft p-3 text-base font-medium text-success"><Check className="size-5" /> Saved {saved}</p>
      )}

      {!item ? (
        <ScanInput label="Scan an item, then say how many are here" onScan={(c) => pick.mutate(c)} disabled={pick.isPending} error={error} />
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => { e.preventDefault(); if (qty !== "" && Number(qty) >= 0) save.mutate(); }}
        >
          <div>
            <p className="text-2xl font-semibold">{item.name}</p>
            <p className="font-mono text-sm text-muted-foreground">{item.sku}</p>
          </div>
          <div className="space-y-2">
            <label htmlFor="count-qty" className="text-base font-medium">How many are here?</label>
            <Input
              id="count-qty" autoFocus type="number" inputMode="numeric" min={0} value={qty}
              onChange={(e) => setQty(e.target.value.replace(/[^\d]/g, ""))}
              className="h-20 text-center text-4xl font-semibold tabular-nums"
            />
            <p className="text-sm text-muted-foreground">Zero is a real answer: it means you looked and there are none.</p>
          </div>
          {error && <p role="alert" className="text-base text-destructive">{error}</p>}
          <div className="grid grid-cols-2 gap-2">
            <Button type="button" variant="outline" className="h-16 text-lg" onClick={() => { setItem(null); setError(null); }}>Cancel</Button>
            <Button type="submit" className="h-16 text-lg" disabled={qty === "" || save.isPending}>Save</Button>
          </div>
        </form>
      )}

      {!item && (
        <div className="space-y-3 border-t pt-4">
          <p className="text-base"><strong>{count.summary.counted}</strong> {count.summary.counted === 1 ? "item" : "items"} counted here.</p>
          {count.lines.length > 0 && (
            <ul className="divide-y rounded-xl border">
              {[...count.lines].sort((a, b) => a.itemName.localeCompare(b.itemName)).map((l) => (
                <li key={l.itemId} className="flex items-center justify-between gap-3 px-3 py-2 text-base">
                  <span className="min-w-0 truncate">{l.itemName}</span>
                  <span className="shrink-0 font-semibold tabular-nums">{l.counted.toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="grid gap-2">
            <Link to={`/o/${orgId}/counts`} className={cn(buttonVariants({ variant: admin ? "default" : "outline" }), "h-16 text-lg")}>
              {admin ? "Review and post the count" : "I'm done: an admin will review"}
            </Link>
            <Button variant="ghost" className="h-12" onClick={() => { setCount(null); setSaved(null); setError(null); }}>Count somewhere else</Button>
          </div>
        </div>
      )}
    </>
  );
}
