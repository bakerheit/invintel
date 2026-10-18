import { formatQty, type Item, type Location, type PoReceiveResult, type PurchaseOrder } from "@invintel/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCheck, ListChecks, MapPin, Undo2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { InspectToggle } from "@/components/floor/inspect-toggle";
import { LocationPicker } from "@/components/floor/location-picker";
import { ResultPanel } from "@/components/floor/result-panel";
import { ScanInput } from "@/components/floor/scan-input";
import { LastScan, QuantityPrompt, RunningList, type ListRow } from "@/components/floor/scan-list";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { feedback } from "@/lib/feedback";
import { invalidateOrg, orgKey, useCurrentOrg, useLocations } from "@/lib/org";
import { interpretScan } from "@/lib/scan-resolve";
import { needsQuantity, scanPoLine, stepOf, type PoLine, type ScanFacts } from "@/lib/scan-session";
import { cn } from "@/lib/utils";

type Step = "order" | "place" | "scan" | "done";

const isOpen = (o: PurchaseOrder) => o.status === "ordered" || o.status === "partial";

/** The item as the scan screens use it: the order line carries the unit rules; the order itself doesn't have the rest. */
const asItem = (l: PurchaseOrder["lines"][number]): Item => ({ id: l.itemId, sku: l.itemSku, name: l.itemName, ...l.uom }) as Item;

/** Receive a delivery against its purchase order: pick the order, scan the place once, then scan what's on the truck. */
export default function ReceivePoPage() {
  const { id: orgId } = useCurrentOrg();
  const qc = useQueryClient();
  const { data: locations = [] } = useLocations(orgId);
  const orders = useQuery({ queryKey: orgKey(orgId, "orders"), queryFn: () => api.listOrders(orgId) });

  const [step, setStep] = useState<Step>("order");
  const [po, setPo] = useState<PurchaseOrder | null>(null);
  const [lines, setLines] = useState<PoLine[]>([]);
  const [place, setPlace] = useState<Location | null>(null);
  const [inspect, setInspect] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [prompt, setPrompt] = useState<{ line: PoLine; facts: ScanFacts; edit: boolean } | null>(null);
  const [done, setDone] = useState<{ result: PoReceiveResult; place: Location; count: number } | null>(null);
  const [previous, setPrevious] = useState<PoLine[][]>([]);

  const open = (orders.data ?? []).filter(isOpen);

  const fail = (message: string) => {
    feedback("error");
    setError(message);
    setNotice(null);
  };

  const reset = () => {
    setStep("order");
    setPo(null);
    setLines([]);
    setPlace(null);
    setInspect(false);
    setError(null);
    setNotice(null);
    setPrevious([]);
    setDone(null);
    void orders.refetch();
  };

  const pickOrder = (order: PurchaseOrder) => {
    setPo(order);
    setLines(order.lines.map((l) => ({ item: asItem(l), ordered: l.quantity, received: l.received, quantity: 0, lot: "", expiresOn: "" })));
    setStep("place");
    setError(null);
  };

  const onOrderScan = (code: string) => {
    const wanted = code.trim().toLowerCase();
    const found = open.find((o) => o.number.toLowerCase() === wanted);
    if (!found) return fail(`No open order "${code}". Pick one from the list.`);
    pickOrder(found);
  };

  const onPlaceScan = async (code: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await interpretScan(orgId, code);
      if (r.kind === "location") {
        if (r.location.type === "quarantine") return fail("That's the quality hold area. Receive into a normal place and tick Inspect before release.");
        setPlace(r.location);
        setStep("scan");
        return;
      }
      fail(r.kind === "error" ? r.error : "That isn't a location. Scan where it's going.");
    } catch (e) {
      fail((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const apply = (line: PoLine, facts: ScanFacts, quantity?: number) => {
    const r = scanPoLine(lines, line.item, facts, quantity);
    if (!r.ok) return fail(r.error);
    feedback("ok");
    setPrevious((p) => [...p, lines].slice(-50));
    setLines(r.lines);
    setError(null);
    setNotice(`+${formatQty(quantity ?? facts.qty ?? stepOf(line.item), line.item)} ${line.item.name}${facts.lot ? ` · lot ${facts.lot}` : ""}${facts.expiresOn ? ` · expires ${facts.expiresOn}` : ""}`);
  };

  const onItemScan = async (code: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await interpretScan(orgId, code);
      if (r.kind === "error") return fail(r.error);
      if (r.kind !== "item") return fail(r.kind === "pallet" ? "That label only names a pallet. Scan the item's own barcode." : "That isn't an item. Scan what's on the truck.");
      const line = lines.find((l) => l.item.id === r.item.id);
      if (!line) return fail(`${r.item.name} isn't on ${po?.number}.`);
      if (r.item.tracking === "unit") return fail(`${r.item.name} is received roll by roll. Use Receive for it.`);
      if (needsQuantity(r.item, r.facts)) return setPrompt({ line, facts: r.facts, edit: false });
      apply(line, r.facts);
    } catch (e) {
      fail((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const confirmPrompt = (quantity: number) => {
    if (!prompt) return;
    const { line, facts, edit } = prompt;
    setPrompt(null);
    if (edit) return setLines((ls) => ls.map((l) => (l.item.id === line.item.id ? { ...l, quantity } : l)));
    apply(line, facts, quantity);
  };

  const counted = lines.filter((l) => l.quantity > 0);
  const rows: ListRow[] = lines.map((l) => {
    const left = Math.max(l.ordered - l.received - l.quantity, 0);
    const over = l.received + l.quantity - l.ordered;
    return {
      key: l.item.id,
      item: l.item,
      quantity: l.quantity,
      chips: [l.lot && `Lot ${l.lot}`, l.expiresOn && `Expires ${l.expiresOn}`].filter(Boolean) as string[],
      note: over > 0 ? `${formatQty(over, l.item)} more than ordered` : l.quantity > 0 && left === 0 ? "Complete" : `${formatQty(l.received + l.quantity, l.item)} of ${formatQty(l.ordered, l.item)}${l.received ? ` (${formatQty(l.received, l.item)} came before)` : ""}`,
      tone: over > 0 ? "warn" : undefined,
      dim: l.quantity === 0,
    };
  });

  const everything = () => {
    setPrevious((p) => [...p, lines].slice(-50));
    setLines((ls) => ls.map((l) => (l.quantity === 0 ? { ...l, quantity: Math.max(l.ordered - l.received, 0) } : l)));
    setNotice("Everything still owed is counted as arrived.");
  };

  const post = async () => {
    if (!po || !place || !counted.length) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.receiveOrder(orgId, po.id, {
        locationId: place.id,
        inspect,
        lines: counted.map((l) => ({ itemId: l.item.id, quantity: l.quantity, supplierLot: l.lot, ...(l.expiresOn ? { expiresOn: l.expiresOn } : {}) })),
      });
      feedback("ok");
      setDone({ result, place, count: counted.length });
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
      await api.undoBatch(orgId, done.result.batchId);
      void invalidateOrg(qc, orgId);
      toast.success("Delivery undone");
      reset();
    } catch (e) {
      feedback("error");
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const title = <h1 className="text-3xl font-semibold tracking-tight">Receive a PO</h1>;
  const placeChoices = locations.filter((l) => l.type !== "quarantine");

  return (
    <>
      {title}

      {step === "order" && (
        <div className="space-y-4">
          <ScanInput label="Type or scan the PO number" placeholder="PO-0001" onScan={onOrderScan} error={error} />
          <h2 className="text-lg font-semibold">Open orders</h2>
          {orders.isLoading && <p className="text-base text-muted-foreground">Loading…</p>}
          {!orders.isLoading && open.length === 0 && <p className="rounded-xl border border-dashed p-6 text-center text-base text-muted-foreground">No open purchase orders.</p>}
          <ul className="grid gap-2">
            {open.map((o) => (
              <li key={o.id}>
                <button type="button" onClick={() => pickOrder(o)} className="flex min-h-16 w-full items-center justify-between gap-3 rounded-xl border bg-card px-4 py-2 text-left hover:bg-muted">
                  <span className="min-w-0">
                    <span className="block font-mono text-lg font-semibold">{o.number}</span>
                    <span className="block truncate text-sm text-muted-foreground">{o.supplierName}{o.expectedDate ? ` · due ${o.expectedDate}` : ""}</span>
                  </span>
                  <span className="shrink-0 text-sm text-muted-foreground">{o.receivedUnits.toLocaleString("en-US")} of {o.orderedUnits.toLocaleString("en-US")}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {step === "place" && po && (
        <div className="space-y-6">
          <div className="rounded-xl border bg-card p-4">
            <p className="font-mono text-xl font-semibold">{po.number}</p>
            <p className="text-base text-muted-foreground">{po.supplierName}</p>
          </div>
          <ScanInput label="Scan where the delivery is going" placeholder="Scan location" onScan={onPlaceScan} disabled={busy} error={error} />
          <Button variant="outline" className="h-14 w-full text-base" onClick={() => setPicking(true)} disabled={busy}>
            <ListChecks /> Pick from a list
          </Button>
          <Button variant="ghost" className="h-12 w-full text-base" onClick={reset}>Pick a different order</Button>
          <LocationPicker open={picking} onOpenChange={setPicking} locations={placeChoices} title="Put it in" onPick={(l) => { setPicking(false); setPlace(l); setStep("scan"); }} />
        </div>
      )}

      {step === "scan" && po && place && (
        <div className="space-y-4">
          <div className="rounded-xl border bg-card p-3">
            <div className="flex items-center gap-2">
              <span className="font-mono text-lg font-semibold">{po.number}</span>
              <span className="min-w-0 flex-1 truncate text-base text-muted-foreground">{po.supplierName}</span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <MapPin className="size-5 shrink-0 text-muted-foreground" />
              <p className="min-w-0 flex-1 break-words text-base font-medium leading-tight">{place.path}</p>
              <Button variant="outline" className="h-11 shrink-0" onClick={() => setPicking(true)}>Change</Button>
            </div>
          </div>
          <ScanInput label="Scan what's on the truck" placeholder="Scan item" onScan={(c) => void onItemScan(c)} disabled={busy} error={error} continuousCamera />
          {notice && <LastScan text={notice} onUndo={previous.length ? () => { setLines(previous[previous.length - 1]!); setPrevious((p) => p.slice(0, -1)); setNotice(null); } : undefined} />}
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">On this order</h2>
            <Button variant="outline" className="h-11" onClick={everything}><CheckCheck /> All arrived</Button>
          </div>
          <RunningList
            rows={rows}
            empty="This order has no lines."
            onStep={(key, delta) => setLines((ls) => ls.map((l) => (l.item.id === key ? { ...l, quantity: Math.max(l.quantity + delta, 0) } : l)))}
            onEdit={(key) => { const line = lines.find((l) => l.item.id === key); if (line) setPrompt({ line, facts: {}, edit: true }); }}
            onRemove={(key) => setLines((ls) => ls.map((l) => (l.item.id === key ? { ...l, quantity: 0, lot: "", expiresOn: "" } : l)))}
          />
          <InspectToggle value={inspect} onChange={setInspect} />
          <div className={cn("sticky bottom-0 -mx-4 border-t bg-background/95 px-4 py-3 backdrop-blur")}>
            <Button className="h-16 w-full text-xl" disabled={busy || counted.length === 0} onClick={() => void post()}>
              {counted.length === 0 ? "Receive" : `Receive ${counted.length} ${counted.length === 1 ? "line" : "lines"}`}
            </Button>
          </div>
          <LocationPicker open={picking} onOpenChange={setPicking} locations={placeChoices} title="Put it in" onPick={(l) => { setPicking(false); setPlace(l); }} />
        </div>
      )}

      {step === "done" && done && po && (
        <ResultPanel
          title={`Received ${done.count} ${done.count === 1 ? "line" : "lines"} on ${po.number}`}
          detail={done.result.ncrs?.length ? `On quality hold as ${done.result.ncrs.map((n) => n.number).join(", ")}. Decide it under Quality.` : `Into ${done.place.path}`}
        >
          {done.result.overReceived.length > 0 && (
            <p className="rounded-xl bg-warning-soft p-4 text-base font-medium text-warning">
              More than ordered: {done.result.overReceived.map((o) => `${o.itemName} (+${o.over.toLocaleString("en-US")})`).join(", ")}
            </p>
          )}
          <p className="text-center text-base text-muted-foreground">{done.result.order.status === "received" ? "The order is complete." : `${done.result.order.receivedUnits.toLocaleString("en-US")} of ${done.result.order.orderedUnits.toLocaleString("en-US")} received so far.`}</p>
          {error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-base font-medium text-destructive">{error}</p>}
          <Button className="h-16 w-full text-xl" onClick={reset}>Receive another delivery</Button>
          {!done.result.ncrs?.length && (
            <Button variant="outline" className="h-14 w-full text-base" onClick={() => void undo()} disabled={busy}>
              <Undo2 /> Undo this delivery
            </Button>
          )}
        </ResultPanel>
      )}

      <QuantityPrompt
        open={!!prompt}
        item={prompt?.line.item ?? null}
        title={prompt?.edit ? "Change the quantity" : "How many arrived?"}
        initial={prompt ? (prompt.edit ? prompt.line.quantity || stepOf(prompt.line.item) : stepOf(prompt.line.item)) : 1}
        onCancel={() => setPrompt(null)}
        onConfirm={confirmPrompt}
      />
    </>
  );
}
