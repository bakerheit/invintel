import { formatQty, type Item, type Location, type PostedBatch } from "@invintel/shared";
import { useQueryClient } from "@tanstack/react-query";
import { ListChecks, MapPin, Undo2 } from "lucide-react";
import { useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { AddItemLink } from "@/components/floor/add-item-link";
import { InspectToggle } from "@/components/floor/inspect-toggle";
import { LocationPicker } from "@/components/floor/location-picker";
import { ResultPanel } from "@/components/floor/result-panel";
import { ScanInput } from "@/components/floor/scan-input";
import { LastScan, QuantityPrompt, RunningList, type ListRow } from "@/components/floor/scan-list";
import { UnitReceive } from "@/components/floor/unit-receive";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { feedback } from "@/lib/feedback";
import { invalidateOrg, useCurrentOrg, useLocations } from "@/lib/org";
import { interpretScan, type Scanned } from "@/lib/scan-resolve";
import { addScan, canUndo, emptySession, needsQuantity, removeLine, setQuantity, stepOf, summarize, undoLast, type ScanFacts, type Session, type SessionLine } from "@/lib/scan-session";

type Step = "place" | "scan" | "done";

/** The small facts a line carries: lot, expiry, pallet. */
export const lineChips = (l: Pick<SessionLine, "lot" | "expiresOn" | "sscc">) =>
  [l.lot && `Lot ${l.lot}`, l.expiresOn && `Expires ${l.expiresOn}`, l.sscc && `Pallet …${l.sscc.slice(-6)}`].filter(Boolean) as string[];

/** Receive: scan where it's going once, then scan what arrived; one receipt at the end, with one undo. */
export default function ReceivePage() {
  const { id: orgId } = useCurrentOrg();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const { data: locations = [] } = useLocations(orgId);

  const [step, setStep] = useState<Step>("place");
  const [place, setPlace] = useState<Location | null>(null);
  const [session, setSession] = useState<Session>(emptySession());
  const [reference, setReference] = useState("");
  const [inspect, setInspect] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unknown, setUnknown] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingSscc, setPendingSscc] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [prompt, setPrompt] = useState<{ item: Item; facts: ScanFacts; editKey?: string; initial: number } | null>(null);
  const [unitItem, setUnitItem] = useState<Item | null>(null);
  const [done, setDone] = useState<{ batch: PostedBatch; place: Location; lines: SessionLine[] } | null>(null);
  const pendingCode = useRef<string | null>(params.get("code"));

  const fail = (message: string, code?: string) => {
    feedback("error");
    setError(message);
    setUnknown(code ?? null);
    setNotice(null);
  };

  const reset = () => {
    setStep("place");
    setPlace(null);
    setSession(emptySession());
    setReference("");
    setInspect(false);
    setError(null);
    setUnknown(null);
    setNotice(null);
    setPendingSscc(null);
    setDone(null);
  };

  // ----- the place -----

  const choosePlace = (loc: Location) => {
    setPlace(loc);
    setStep("scan");
    setError(null);
    setUnknown(null);
    const code = pendingCode.current;
    pendingCode.current = null;
    if (code) void onItemScan(code);
  };

  const onPlaceScan = async (code: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await interpretScan(orgId, code);
      if (r.kind === "location") return choosePlace(r.location);
      fail(r.kind === "error" ? r.error : "That isn't a location. Scan where it's going.");
    } catch (e) {
      fail((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // ----- the items -----

  const apply = (item: Item, facts: ScanFacts, quantity?: number) => {
    const r = addScan(session, item, facts, quantity);
    if (!r.ok) return fail(r.error);
    feedback("ok");
    setSession(r.session);
    setError(null);
    setUnknown(null);
    const added = quantity ?? facts.qty ?? stepOf(item);
    setNotice(`+${formatQty(added, item)} ${item.name}${facts.lot ? ` · lot ${facts.lot}` : ""}${facts.expiresOn ? ` · expires ${facts.expiresOn}` : ""}`);
  };

  const onItemScan = async (code: string) => {
    setBusy(true);
    setError(null);
    try {
      const r: Scanned = await interpretScan(orgId, code);
      switch (r.kind) {
        case "error":
          return fail(r.error, r.unknownCode);
        case "location":
          return fail("That's a place. Scan an item (or tap Change to pick a different place).");
        case "unit":
          return fail(`${r.unit.code} is a roll or pallet that's already in the system. Use Move to move it.`);
        case "pallet":
          feedback("ok");
          setPendingSscc(r.sscc);
          setNotice(`Pallet …${r.sscc.slice(-6)} noted. Now scan what's on it.`);
          return;
        case "item": {
          if (r.item.tracking === "unit") return setUnitItem(r.item);
          const facts: ScanFacts = { ...r.facts };
          if (pendingSscc && !facts.sscc) facts.sscc = pendingSscc;
          if (needsQuantity(r.item, facts)) return setPrompt({ item: r.item, facts, initial: stepOf(r.item) });
          if (facts.sscc) setPendingSscc(null);
          apply(r.item, facts);
        }
      }
    } catch (e) {
      fail((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const confirmPrompt = (quantity: number) => {
    if (!prompt) return;
    const { item, facts, editKey } = prompt;
    setPrompt(null);
    if (editKey) {
      setSession((s) => setQuantity(s, editKey, quantity));
      return;
    }
    if (facts.sscc) setPendingSscc(null);
    apply(item, facts, quantity);
  };

  const rows: ListRow[] = session.lines.map((l) => ({ key: l.key, item: l.item, quantity: l.quantity, chips: lineChips(l) }));
  const edit = (key: string) => {
    const l = session.lines.find((x) => x.key === key);
    if (l) setPrompt({ item: l.item, facts: {}, editKey: key, initial: l.quantity });
  };

  // ----- post and undo -----

  const post = async () => {
    if (!place || !session.lines.length) return;
    setBusy(true);
    setError(null);
    try {
      const batch = await api.receiveBatch(orgId, {
        locationId: place.id,
        reference: reference.trim(),
        inspect,
        lines: session.lines.map((l) => ({
          itemId: l.item.id,
          quantity: l.quantity,
          supplierLot: l.lot,
          ...(l.expiresOn ? { expiresOn: l.expiresOn } : {}),
          ...(l.sscc ? { sscc: l.sscc } : {}),
        })),
      });
      feedback("ok");
      setDone({ batch, place, lines: session.lines });
      setStep("done");
      void invalidateOrg(qc, orgId);
    } catch (e) {
      fail((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (!done) return;
    setBusy(true);
    try {
      await api.undoBatch(orgId, done.batch.batchId);
      void invalidateOrg(qc, orgId);
      toast.success("Receipt undone");
      reset();
    } catch (e) {
      feedback("error");
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const title = <h1 className="text-3xl font-semibold tracking-tight">Receive</h1>;

  if (unitItem) {
    return (
      <>
        {title}
        <UnitReceive item={unitItem} onReset={() => setUnitItem(null)} />
      </>
    );
  }

  const totals = summarize(session);

  return (
    <>
      {title}

      {step === "place" && (
        <div className="space-y-6">
          <ScanInput label="Scan where it's going" placeholder="Scan location" onScan={onPlaceScan} disabled={busy} error={error} />
          <Button variant="outline" className="h-14 w-full text-base" onClick={() => setPicking(true)} disabled={busy}>
            <ListChecks /> Pick from a list
          </Button>
          <p className="text-base text-muted-foreground">Scan the place once, then scan everything that arrived there.</p>
          <LocationPicker open={picking} onOpenChange={setPicking} locations={locations.filter((l) => l.type !== "quarantine")} title="Put it in" onPick={(l) => { setPicking(false); choosePlace(l); }} />
        </div>
      )}

      {step === "scan" && place && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 rounded-xl border bg-card p-3">
            <MapPin className="size-5 shrink-0 text-muted-foreground" />
            <p className="min-w-0 flex-1 break-words text-lg font-semibold leading-tight">{place.path}</p>
            <Button variant="outline" className="h-11 shrink-0" onClick={() => setPicking(true)}>Change</Button>
          </div>
          <ScanInput
            label="Scan an item"
            placeholder="Scan item"
            onScan={(c) => void onItemScan(c)}
            disabled={busy}
            error={error}
            continuousCamera
            errorAction={unknown ? <AddItemLink orgId={orgId} code={unknown} /> : undefined}
          />
          {notice && <LastScan text={notice} onUndo={canUndo(session) ? () => { setSession(undoLast(session)); setNotice(null); } : undefined} />}
          {pendingSscc && <LastScan text={`Pallet …${pendingSscc.slice(-6)} waiting for its item`} onUndo={() => setPendingSscc(null)} />}
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-semibold">Received so far</h2>
            {totals.lines > 0 && <p className="text-sm text-muted-foreground">{totals.lines} {totals.lines === 1 ? "line" : "lines"}</p>}
          </div>
          <RunningList
            rows={rows}
            empty="Nothing yet. Scan the first item."
            onStep={(key, delta) => setSession((s) => setQuantity(s, key, (s.lines.find((l) => l.key === key)?.quantity ?? 0) + delta))}
            onEdit={edit}
            onRemove={(key) => setSession((s) => removeLine(s, key))}
          />
          {totals.lines > 0 && (
            <div className="space-y-3">
              <div className="space-y-2">
                <label htmlFor="floor-ref" className="text-base font-medium">PO or delivery note (optional)</label>
                <Input id="floor-ref" className="h-14 text-lg" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={200} />
              </div>
              <InspectToggle value={inspect} onChange={setInspect} />
            </div>
          )}
          <div className="sticky bottom-0 -mx-4 border-t bg-background/95 px-4 py-3 backdrop-blur">
            <Button className="h-16 w-full text-xl" disabled={busy || totals.lines === 0} onClick={() => void post()}>
              {totals.lines === 0 ? "Receive" : `Receive ${totals.lines} ${totals.lines === 1 ? "line" : "lines"}`}
            </Button>
          </div>
          <LocationPicker open={picking} onOpenChange={setPicking} locations={locations.filter((l) => l.type !== "quarantine")} title="Put it in" onPick={(l) => { setPicking(false); setPlace(l); }} />
        </div>
      )}

      {step === "done" && done && (
        <ResultPanel
          title={`Received ${done.lines.length} ${done.lines.length === 1 ? "line" : "lines"}`}
          detail={done.batch.ncrs?.length ? `On quality hold as ${done.batch.ncrs.map((n) => n.number).join(", ")}. Decide it under Quality.` : `Into ${done.place.path}`}
        >
          <ul className="space-y-1 rounded-xl border bg-card p-3 text-base">
            {done.lines.map((l) => (
              <li key={l.key} className="flex justify-between gap-3">
                <span className="min-w-0 break-words">{l.item.name}{l.lot ? ` · lot ${l.lot}` : ""}</span>
                <span className="shrink-0 font-semibold tabular-nums">{formatQty(l.quantity, l.item)}</span>
              </li>
            ))}
          </ul>
          {error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-base font-medium text-destructive">{error}</p>}
          <Button className="h-16 w-full text-xl" onClick={reset}>Receive more</Button>
          {!done.batch.ncrs?.length && (
            <Button variant="outline" className="h-14 w-full text-base" onClick={() => void undo()} disabled={busy}>
              <Undo2 /> Undo this receipt
            </Button>
          )}
        </ResultPanel>
      )}

      <QuantityPrompt
        open={!!prompt}
        item={prompt?.item ?? null}
        title={prompt?.editKey ? "Change the quantity" : "How many arrived?"}
        initial={prompt?.initial ?? 1}
        onCancel={() => setPrompt(null)}
        onConfirm={confirmPrompt}
      />
    </>
  );
}
