import { formatQty, type Item, type Location, type PostedBatch, type StockUnit } from "@invintel/shared";
import { useQueryClient } from "@tanstack/react-query";
import { ListChecks, MapPin, Undo2 } from "lucide-react";
import { useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { AddItemLink } from "@/components/floor/add-item-link";
import { LocationPicker } from "@/components/floor/location-picker";
import { ResultPanel } from "@/components/floor/result-panel";
import { ScanInput } from "@/components/floor/scan-input";
import { LastScan, QuantityPrompt, RunningList, type ListRow } from "@/components/floor/scan-list";
import { UnitMove, UnitPick } from "@/components/floor/unit-move";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { feedback } from "@/lib/feedback";
import { invalidateOrg, useCurrentOrg, useLocations } from "@/lib/org";
import { interpretScan } from "@/lib/scan-resolve";
import { addScan, canUndo, emptySession, needsQuantity, removeLine, setQuantity, stepOf, summarize, undoLast, type Session, type SessionLine } from "@/lib/scan-session";

type Step = "place" | "scan" | "done";

/** Move: scan where it's going once, then scan each item; one move document at the end, with one undo. */
export default function MovePage() {
  const { id: orgId } = useCurrentOrg();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const { data: locations = [] } = useLocations(orgId);

  const [step, setStep] = useState<Step>("place");
  const [dest, setDest] = useState<Location | null>(null);
  const [session, setSession] = useState<Session>(emptySession());
  const [error, setError] = useState<string | null>(null);
  const [unknown, setUnknown] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [prompt, setPrompt] = useState<{ item: Item; from: string; editKey?: string; initial: number; max: number } | null>(null);
  const [source, setSource] = useState<{ item: Item; options: { locationId: string; quantity: number }[] } | null>(null);
  const [unit, setUnit] = useState<StockUnit | null>(null);
  const [pickFrom, setPickFrom] = useState<Item | null>(null);
  const [done, setDone] = useState<{ batch: PostedBatch; dest: Location; lines: SessionLine[] } | null>(null);
  const pendingCode = useRef<string | null>(params.get("code"));

  const nameOf = (id: string) => locations.find((l) => l.id === id)?.path ?? "Unknown";
  const isHold = (id: string) => locations.find((l) => l.id === id)?.type === "quarantine";

  const fail = (message: string, code?: string) => {
    feedback("error");
    setError(message);
    setUnknown(code ?? null);
    setNotice(null);
  };

  const reset = () => {
    setStep("place");
    setDest(null);
    setSession(emptySession());
    setError(null);
    setUnknown(null);
    setNotice(null);
    setDone(null);
  };

  // ----- the destination -----

  const chooseDest = (loc: Location) => {
    setDest(loc);
    setStep("scan");
    setError(null);
    setUnknown(null);
    const code = pendingCode.current;
    pendingCode.current = null;
    if (code) void onItemScan(code, loc);
  };

  const onDestScan = async (code: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await interpretScan(orgId, code);
      if (r.kind === "location") return chooseDest(r.location);
      fail(r.kind === "error" ? r.error : "That isn't a location. Scan where it's going.");
    } catch (e) {
      fail((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // ----- the items -----

  /** Already on the list from this place, so a second scan can't promise more than is there. */
  const taken = (itemId: string, from: string) => session.lines.filter((l) => l.item.id === itemId && l.from === from).reduce((n, l) => n + l.quantity, 0);
  const availableAt = (item: Item, from: string) => item.stock.find((s) => s.locationId === from)?.quantity ?? 0;

  const add = (item: Item, from: string, quantity?: number) => {
    const have = availableAt(item, from);
    const wanted = quantity ?? stepOf(item);
    if (taken(item.id, from) + wanted > have) return fail(`Only ${formatQty(have, item)} of ${item.name} at ${nameOf(from)}${taken(item.id, from) ? `, and ${formatQty(taken(item.id, from), item)} is already on the list` : ""}.`);
    const r = addScan(session, item, { from }, quantity);
    if (!r.ok) return fail(r.error);
    feedback("ok");
    setSession(r.session);
    setError(null);
    setUnknown(null);
    setNotice(`+${formatQty(wanted, item)} ${item.name} from ${nameOf(from)}`);
  };

  const withSource = (item: Item, from: string) => {
    if (needsQuantity(item)) {
      return setPrompt({ item, from, initial: stepOf(item), max: Math.max(availableAt(item, from) - taken(item.id, from), 0) });
    }
    add(item, from);
  };

  const onItemScan = async (code: string, toPlace?: Location) => {
    const target = toPlace ?? dest;
    setBusy(true);
    setError(null);
    try {
      const r = await interpretScan(orgId, code);
      if (r.kind === "error") return fail(r.error, r.unknownCode);
      if (r.kind === "location") return fail("That's a place. Scan an item (or tap Change to pick a different place).");
      if (r.kind === "pallet") return fail("That label only names a pallet. Scan the item's own barcode.");
      // A roll or pallet label moves that one unit; a unit-tracked item asks which unit.
      if (r.kind === "unit") return setUnit(r.unit);
      if (r.item.tracking === "unit") return setPickFrom(r.item);
      const item = r.item;
      const options = item.stock.filter((s) => s.quantity > 0 && s.locationId !== target?.id && !isHold(s.locationId));
      if (options.length === 0) return fail(item.stock.length ? `${item.name} has no stock outside ${target?.name ?? "that place"}.` : `There's no stock of ${item.name} to move. Receive it first.`);
      if (options.length === 1) return withSource(item, options[0]!.locationId);
      setSource({ item, options });
    } catch (e) {
      fail((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const confirmPrompt = (quantity: number) => {
    if (!prompt) return;
    const { item, from, editKey } = prompt;
    setPrompt(null);
    if (editKey) return setSession((s) => setQuantity(s, editKey, quantity));
    add(item, from, quantity);
  };

  const rows: ListRow[] = session.lines.map((l) => {
    const have = availableAt(l.item, l.from);
    return { key: l.key, item: l.item, quantity: l.quantity, chips: [`From ${nameOf(l.from)}`], note: `${formatQty(have, l.item)} there`, tone: l.quantity > have ? "warn" : undefined };
  });
  const step1 = (key: string, delta: number) => {
    const l = session.lines.find((x) => x.key === key);
    if (!l) return;
    const next = l.quantity + delta;
    if (next > availableAt(l.item, l.from)) return fail(`Only ${formatQty(availableAt(l.item, l.from), l.item)} of ${l.item.name} at ${nameOf(l.from)}.`);
    setError(null);
    setSession((s) => setQuantity(s, key, next));
  };
  const edit = (key: string) => {
    const l = session.lines.find((x) => x.key === key);
    if (l) setPrompt({ item: l.item, from: l.from, editKey: key, initial: l.quantity, max: availableAt(l.item, l.from) });
  };

  // ----- post and undo -----

  const post = async () => {
    if (!dest || !session.lines.length) return;
    setBusy(true);
    setError(null);
    try {
      const batch = await api.moveBatch(orgId, { toLocationId: dest.id, reason: "", lines: session.lines.map((l) => ({ itemId: l.item.id, fromLocationId: l.from, quantity: l.quantity })) });
      feedback("ok");
      setDone({ batch, dest, lines: session.lines });
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
      toast.success("Move undone");
      reset();
    } catch (e) {
      feedback("error");
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const title = <h1 className="text-3xl font-semibold tracking-tight">Move</h1>;

  if (unit) {
    return (
      <>
        {title}
        <UnitMove unit={unit} onReset={() => { setUnit(null); setPickFrom(null); }} />
      </>
    );
  }
  if (pickFrom) {
    return (
      <>
        {title}
        <UnitPick item={pickFrom} onPick={setUnit} onBack={() => setPickFrom(null)} />
      </>
    );
  }

  const totals = summarize(session);
  const placeChoices = locations.filter((l) => l.type !== "quarantine");

  return (
    <>
      {title}

      {step === "place" && (
        <div className="space-y-6">
          <ScanInput label="Scan where it's going" placeholder="Scan location" onScan={onDestScan} disabled={busy} error={error} />
          <Button variant="outline" className="h-14 w-full text-base" onClick={() => setPicking(true)} disabled={busy}>
            <ListChecks /> Pick from a list
          </Button>
          <p className="text-base text-muted-foreground">Scan the destination once, then scan each item you're taking there.</p>
          <LocationPicker open={picking} onOpenChange={setPicking} locations={placeChoices} title="Move to" onPick={(l) => { setPicking(false); chooseDest(l); }} />
        </div>
      )}

      {step === "scan" && dest && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 rounded-xl border bg-card p-3">
            <MapPin className="size-5 shrink-0 text-muted-foreground" />
            <p className="min-w-0 flex-1 break-words text-lg font-semibold leading-tight">To {dest.path}</p>
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
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-semibold">Moving</h2>
            {totals.lines > 0 && <p className="text-sm text-muted-foreground">{totals.lines} {totals.lines === 1 ? "line" : "lines"}</p>}
          </div>
          <RunningList rows={rows} empty="Nothing yet. Scan the first item." onStep={step1} onEdit={edit} onRemove={(key) => setSession((s) => removeLine(s, key))} />
          <div className="sticky bottom-0 -mx-4 border-t bg-background/95 px-4 py-3 backdrop-blur">
            <Button className="h-16 w-full text-xl" disabled={busy || totals.lines === 0} onClick={() => void post()}>
              {totals.lines === 0 ? "Move" : `Move ${totals.lines} ${totals.lines === 1 ? "line" : "lines"}`}
            </Button>
          </div>
          <LocationPicker open={picking} onOpenChange={setPicking} locations={placeChoices.filter((l) => !session.lines.some((x) => x.from === l.id))} title="Move to" onPick={(l) => { setPicking(false); setDest(l); }} />
        </div>
      )}

      {step === "done" && done && (
        <ResultPanel title={`Moved ${done.lines.length} ${done.lines.length === 1 ? "line" : "lines"}`} detail={`To ${done.dest.path}`}>
          <ul className="space-y-1 rounded-xl border bg-card p-3 text-base">
            {done.lines.map((l) => (
              <li key={l.key} className="flex justify-between gap-3">
                <span className="min-w-0 break-words">{l.item.name}<span className="block text-sm text-muted-foreground">from {nameOf(l.from)}</span></span>
                <span className="shrink-0 font-semibold tabular-nums">{formatQty(l.quantity, l.item)}</span>
              </li>
            ))}
          </ul>
          {error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-base font-medium text-destructive">{error}</p>}
          <Button className="h-16 w-full text-xl" onClick={reset}>Move more</Button>
          <Button variant="outline" className="h-14 w-full text-base" onClick={() => void undo()} disabled={busy}>
            <Undo2 /> Undo this move
          </Button>
        </ResultPanel>
      )}

      <Dialog open={!!source} onOpenChange={(o) => !o && setSource(null)}>
        <DialogContent className="gap-3 sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-xl">Take from where?</DialogTitle>
            <DialogDescription>{source?.item.name}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            {source?.options.map((o) => (
              <button
                key={o.locationId}
                type="button"
                className="flex min-h-16 items-center justify-between gap-3 rounded-xl border px-4 text-left hover:bg-muted"
                onClick={() => { const item = source.item; setSource(null); withSource(item, o.locationId); }}
              >
                <span className="text-lg font-medium">{nameOf(o.locationId)}</span>
                <span className="text-xl font-semibold tabular-nums">{formatQty(o.quantity, source.item)}</span>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <QuantityPrompt
        open={!!prompt}
        item={prompt?.item ?? null}
        title={prompt?.editKey ? "Change the quantity" : "How many are you moving?"}
        initial={prompt?.initial ?? 1}
        max={prompt?.max}
        onCancel={() => setPrompt(null)}
        onConfirm={confirmPrompt}
      />
    </>
  );
}
