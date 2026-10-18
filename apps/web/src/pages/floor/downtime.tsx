import type { DowntimeEvent, WorkCenter } from "@invintel/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Power, PowerOff } from "lucide-react";
import { useState } from "react";
import { ScanInput } from "@/components/floor/scan-input";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { feedback } from "@/lib/feedback";
import { formatRelative } from "@/lib/format";
import { invalidateOrg, orgKey, useCurrentOrg } from "@/lib/org";

/** Downtime: pick the machine (scan its code or tap it), then tap why it stopped, or tap Back up. */
export default function DowntimePage() {
  const { id: orgId } = useCurrentOrg();
  const qc = useQueryClient();
  const centers = useQuery({ queryKey: orgKey(orgId, "work-centers"), queryFn: () => api.workCenters(orgId) });
  const open = useQuery({ queryKey: orgKey(orgId, "downtime-open"), queryFn: () => api.downtimeOpen(orgId), refetchInterval: 20_000 });
  const settings = useQuery({ queryKey: orgKey(orgId, "downtime-settings"), queryFn: () => api.downtimeSettings(orgId) });
  const [picked, setPicked] = useState<WorkCenter | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = (centers.data ?? []).filter((c) => c.active);
  const downFor = (id: string): DowntimeEvent | undefined => open.data?.find((e) => e.workCenterId === id);
  const mine = picked ? downFor(picked.id) : undefined;

  const scan = (code: string) => {
    const q = code.trim().toLowerCase();
    const hit = list.find((c) => c.code.toLowerCase() === q || c.name.toLowerCase() === q);
    if (!hit) { feedback("error"); setError(`No machine matches "${code}"`); return; }
    feedback("ok"); setError(null); setPicked(hit);
  };
  const after = async (msg: string) => { feedback("ok"); setError(null); await invalidateOrg(qc, orgId); void msg; };
  const start = useMutation({ mutationFn: (reason: string) => api.startDowntime(orgId, picked!.id, reason), onSuccess: () => after("down"), onError: (e: Error) => { feedback("error"); setError(e.message); void invalidateOrg(qc, orgId); } });
  const end = useMutation({ mutationFn: () => api.endDowntime(orgId, mine!.id), onSuccess: () => after("up"), onError: (e: Error) => { feedback("error"); setError(e.message); } });

  if (!picked) {
    return (
      <>
        <h1 className="text-3xl font-semibold tracking-tight">Downtime</h1>
        <ScanInput label="Scan the machine, or tap it below" onScan={scan} error={error} />
        <div className="grid gap-2">
          {list.map((c) => {
            const d = downFor(c.id);
            return (
              <button key={c.id} type="button" onClick={() => { setPicked(c); setError(null); }} className="flex min-h-16 items-center justify-between gap-3 rounded-xl border bg-card p-4 text-left text-lg active:bg-muted">
                <span className="font-semibold">{c.name}</span>
                {d ? <span className="rounded-full bg-destructive/10 px-3 py-1 text-sm font-medium text-destructive">Down: {d.reason}</span> : <span className="text-sm text-muted-foreground">Running</span>}
              </button>
            );
          })}
          {centers.isSuccess && !list.length && <p className="text-base text-muted-foreground">No machines yet. An admin adds them under Production, then Work centers.</p>}
        </div>
      </>
    );
  }
  return (
    <>
      <div className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">{picked.name}</h1>
        <button type="button" className="text-base text-muted-foreground underline" onClick={() => { setPicked(null); setError(null); }}>Pick another machine</button>
      </div>
      {mine ? (
        <div className="space-y-4">
          <div role="status" className="rounded-2xl bg-destructive/10 p-5 text-destructive">
            <p className="flex items-center gap-2 text-2xl font-semibold"><PowerOff className="size-7" /> Down: {mine.reason}</p>
            <p className="mt-1 text-base">Since {formatRelative(mine.startedAt)} ({mine.minutes} min), started by {mine.startedBy}.</p>
          </div>
          {error && <p role="alert" className="text-base text-destructive">{error}</p>}
          <Button className="h-20 w-full text-2xl" onClick={() => end.mutate()} disabled={end.isPending}><Power className="size-7" /> Back up and running</Button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-lg font-medium">Why did it stop?</p>
          {error && <p role="alert" className="text-base text-destructive">{error}</p>}
          <div className="grid gap-2">
            {(settings.data?.reasons ?? []).map((r) => (
              <Button key={r} variant="outline" className="h-16 justify-start px-5 text-lg" onClick={() => start.mutate(r)} disabled={start.isPending}>{r}</Button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
