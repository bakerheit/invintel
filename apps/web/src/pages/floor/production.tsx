import type { WorkOrderVariance } from "@invintel/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Minus, Plus, Undo2 } from "lucide-react";
import { useState } from "react";
import { LocationPicker } from "@/components/floor/location-picker";
import { ResultPanel } from "@/components/floor/result-panel";
import { ScanInput } from "@/components/floor/scan-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { feedback } from "@/lib/feedback";
import { invalidateOrg, orgKey, useCurrentOrg, useLocations } from "@/lib/org";
import { cn } from "@/lib/utils";

type Action = "load" | "usage" | "output";

/** A whole-number stepper that can sit at zero (usage and scrap often are zero). */
function Count({ label, value, onChange, max }: { label: string; value: number; onChange: (n: number) => void; max?: number }) {
  const clamp = (n: number) => Math.max(0, Math.min(max ?? Infinity, Math.floor(n) || 0));
  return (
    <div className="space-y-2">
      <p className="text-base font-medium">{label}</p>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" className="h-16 w-16" aria-label={`Less ${label}`} onClick={() => onChange(clamp(value - 1))}>
          <Minus className="size-6" />
        </Button>
        <Input
          type="number"
          inputMode="numeric"
          aria-label={label}
          value={value}
          onChange={(e) => onChange(clamp(Number(e.target.value)))}
          onFocus={(e) => e.currentTarget.select()}
          className="h-16 flex-1 text-center text-3xl font-semibold tabular-nums"
        />
        <Button type="button" variant="outline" className="h-16 w-16" aria-label={`More ${label}`} onClick={() => onChange(clamp(value + 1))}>
          <Plus className="size-6" />
        </Button>
      </div>
    </div>
  );
}

/** Production: pick the work order at your machine, then Load material, Report usage or Report output. */
export default function ProductionFloorPage() {
  const { id: orgId } = useCurrentOrg();
  const qc = useQueryClient();
  const { data: locations = [] } = useLocations(orgId);
  const orders = useQuery({ queryKey: orgKey(orgId, "production", "open"), queryFn: () => api.workOrders(orgId, "released,running") });
  const [orderId, setOrderId] = useState<string | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [done, setDone] = useState<{ title: string; detail: string; movementId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [machineId, setMachineId] = useState<string | null>(null); // a scanned work center narrows the list

  const order = orders.data?.find((o) => o.id === orderId) ?? null;
  const variance = useQuery({
    queryKey: orgKey(orgId, "production", "variance", orderId ?? ""),
    queryFn: () => api.workOrderVariance(orgId, orderId!),
    enabled: !!orderId,
  });

  const [itemId, setItemId] = useState("");
  const [fromId, setFromId] = useState("");
  const [qty, setQty] = useState(0);
  const [scrap, setScrap] = useState(0);
  const [remnant, setRemnant] = useState(0);
  const [toId, setToId] = useState("");
  const [picking, setPicking] = useState<"from" | "to" | null>(null);
  const [pickTitle, setPickTitle] = useState("Pick a place"); // stays put while the dialog animates closed
  const pathOf = (id: string) => locations.find((l) => l.id === id)?.path ?? "";

  const reset = () => {
    setAction(null);
    setItemId("");
    setFromId("");
    setQty(0);
    setScrap(0);
    setRemnant(0);
    setToId("");
    setError(null);
    setDone(null);
  };

  const run = async (title: string, detail: string, fn: () => Promise<{ movementIds: string[] }>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      feedback("ok");
      setDone({ title, detail, movementId: r.movementIds[0]! });
      void invalidateOrg(qc, orgId);
    } catch (e) {
      feedback("error");
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (!done) return;
    setBusy(true);
    try {
      await api.reverseMovement(orgId, done.movementId, {});
      void invalidateOrg(qc, orgId);
      reset();
    } catch (e) {
      feedback("error");
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onScan = async (code: string) => {
    setBusy(true);
    setScanError(null);
    try {
      const r = await api.productionLookup(orgId, code);
      if (r.kind === "none") {
        feedback("error");
        setScanError(`Nothing matches "${code}". Scan a work order or a machine.`);
      } else if (r.kind === "work_order") {
        if (r.workOrder.status !== "released" && r.workOrder.status !== "running") {
          feedback("error");
          setScanError(`${r.workOrder.number} is ${r.workOrder.status}, not open for work.`);
        } else {
          await orders.refetch();
          setOrderId(r.workOrder.id);
        }
      } else if (r.workOrders.length === 1) {
        await orders.refetch();
        setOrderId(r.workOrders[0]!.id);
      } else if (r.workOrders.length === 0) {
        feedback("error");
        setScanError(`Nothing is released for ${r.workCenter.name}.`);
      } else {
        setMachineId(r.workCenter.id);
      }
    } catch (e) {
      feedback("error");
      setScanError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // ----- step 1: which work order -----
  if (!order) {
    const shown = (orders.data ?? []).filter((o) => !machineId || o.workCenterId === machineId);
    return (
      <>
        <h1 className="text-3xl font-semibold tracking-tight">Production</h1>
        <ScanInput label="Scan the work order or the machine" placeholder="WO-0001 or machine code" onScan={onScan} disabled={busy} error={scanError} />
        <p className="text-base text-muted-foreground">
          {machineId ? "Open work orders on this machine:" : "Or pick the work order you're running:"}
          {machineId && <button type="button" className="ml-2 underline" onClick={() => setMachineId(null)}>show all</button>}
        </p>
        {orders.isLoading && <p className="text-muted-foreground">Loading…</p>}
        {orders.data?.length === 0 && (
          <p className="rounded-xl bg-warning-soft p-4 text-base font-medium text-warning">
            No released work orders. Ask a planner to release one on the desk.
          </p>
        )}
        <div className="grid gap-3">
          {shown.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => setOrderId(o.id)}
              className="flex min-h-24 flex-col justify-center rounded-2xl border bg-card p-4 text-left shadow-xs hover:bg-muted/50 active:bg-muted"
            >
              <span className="flex items-baseline justify-between gap-3">
                <span className="text-2xl font-semibold">{o.number}</span>
                <span className="text-sm capitalize text-muted-foreground">{o.status}</span>
              </span>
              <span className="text-lg">{o.quantity.toLocaleString()} × {o.outputItemName}</span>
              <span className="text-sm text-muted-foreground">{o.workCenterName}</span>
            </button>
          ))}
        </div>
      </>
    );
  }

  const v: WorkOrderVariance | undefined = variance.data;
  const line = (id: string) => v?.lines.find((l) => l.itemId === id);
  const atMachine = line(itemId)?.atMachine ?? 0;
  const materialPicker = (
    <div className="space-y-2">
      <p className="text-base font-medium">Which material?</p>
      <div className="grid gap-2">
        {order.requirements.map((r) => (
          <button
            key={r.itemId}
            type="button"
            aria-pressed={itemId === r.itemId}
            onClick={() => setItemId(r.itemId)}
            className={cn(
              "flex min-h-16 items-center justify-between gap-3 rounded-xl border px-4 text-left",
              itemId === r.itemId ? "border-primary bg-accent/60 ring-2 ring-primary" : "hover:bg-muted",
            )}
          >
            <span className="text-lg font-medium">{r.itemName}</span>
            <span className="text-sm text-muted-foreground">
              need {r.expected.toLocaleString()} · at machine {(line(r.itemId)?.atMachine ?? 0).toLocaleString()}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
  const placeButton = (which: "from" | "to", value: string, label: string) => (
    <div className="space-y-2">
      <p className="text-base font-medium">{label}</p>
      <Button type="button" variant="outline" className="h-16 w-full justify-start text-lg" onClick={() => { setPickTitle(which === "from" ? "Take from" : "Send to"); setPicking(which); }}>
        {value ? pathOf(value) : "Pick a place"}
      </Button>
    </div>
  );
  const errorBox = error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-base font-medium text-destructive">{error}</p>;

  return (
    <>
      <div className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">{order.number}</h1>
        <p className="text-base text-muted-foreground">
          {order.quantity.toLocaleString()} × {order.outputItemName} at {order.workCenterName} · {order.produced.toLocaleString()} done
        </p>
      </div>

      {done ? (
        <ResultPanel title={done.title} detail={done.detail}>
          <Button className="h-16 w-full text-xl" onClick={reset}>Next</Button>
          <Button variant="outline" className="h-14 w-full text-base" onClick={() => void undo()} disabled={busy}>
            <Undo2 /> Undo this
          </Button>
          {errorBox}
        </ResultPanel>
      ) : !action ? (
        <div className="grid gap-3">
          <Button className="h-20 text-2xl" onClick={() => setAction("load")}>Load material</Button>
          <Button className="h-20 text-2xl" variant="secondary" onClick={() => setAction("usage")}>Report usage</Button>
          <Button className="h-20 text-2xl" variant="secondary" onClick={() => setAction("output")}>Report output</Button>
          <Button variant="ghost" className="h-12 text-base" onClick={() => { setOrderId(null); reset(); }}>Pick a different work order</Button>
        </div>
      ) : (
        <div className="space-y-6">
          <h2 className="text-2xl font-semibold">
            {action === "load" ? "Load material" : action === "usage" ? "Report usage" : "Report output"}
          </h2>

          {action === "load" && (
            <>
              {materialPicker}
              {placeButton("from", fromId, "Taking it from")}
              <Count label="How many?" value={qty} onChange={setQty} />
              <Button className="h-16 w-full text-xl" disabled={busy || !itemId || !fromId || qty < 1} onClick={() =>
                void run(`Loaded ${qty.toLocaleString()}`, `${order.requirements.find((r) => r.itemId === itemId)?.itemName} → ${order.workCenterName}`, () =>
                  api.loadMaterial(orgId, order.id, { itemId, fromLocationId: fromId, quantity: qty }))}>
                Load it
              </Button>
            </>
          )}

          {action === "usage" && (
            <>
              {materialPicker}
              {itemId && (
                <>
                  <p className="text-sm text-muted-foreground">{atMachine.toLocaleString()} at the machine right now</p>
                  <Count label="Used" value={qty} onChange={setQty} />
                  <Count label="Scrap" value={scrap} onChange={setScrap} />
                  <Count label="Left over (back to stock)" value={remnant} onChange={setRemnant} />
                  {remnant > 0 && placeButton("to", toId, "Leftover goes to")}
                </>
              )}
              <Button className="h-16 w-full text-xl" disabled={busy || !itemId || qty + scrap + remnant < 1 || (remnant > 0 && !toId)} onClick={() =>
                void run("Usage reported", `Used ${qty}, scrap ${scrap}, leftover ${remnant}`, () =>
                  api.reportUsage(orgId, order.id, { itemId, used: qty, scrap, remnant, ...(remnant > 0 ? { remnantLocationId: toId } : {}) }))}>
                Save usage
              </Button>
            </>
          )}

          {action === "output" && (
            <>
              <Count label={`Good ${order.outputItemName}`} value={qty} onChange={setQty} />
              <Count label="Scrapped" value={scrap} onChange={setScrap} />
              {placeButton("to", toId, "Good ones go to")}
              <Button className="h-16 w-full text-xl" disabled={busy || qty + scrap < 1 || !toId} onClick={() =>
                void run(`Output reported`, `${qty} good, ${scrap} scrap → ${pathOf(toId)}`, () =>
                  api.reportOutput(orgId, order.id, { good: qty, scrap, toLocationId: toId }))}>
                Save output
              </Button>
            </>
          )}

          {errorBox}
          <Button variant="ghost" className="h-12 w-full text-base" onClick={reset}>Back</Button>
        </div>
      )}

      <LocationPicker
        open={picking !== null}
        onOpenChange={(o) => !o && setPicking(null)}
        locations={locations}
        title={pickTitle}
        onPick={(l) => {
          if (picking === "from") setFromId(l.id);
          else setToId(l.id);
          setPicking(null);
        }}
      />
    </>
  );
}
