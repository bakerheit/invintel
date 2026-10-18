import { formatQty, type Item } from "@invintel/shared";
import { Minus, Plus, Trash2, Undo2 } from "lucide-react";
import { useState } from "react";
import { QtyStepper } from "@/components/floor/qty-stepper";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { stepOf } from "@/lib/scan-session";
import { cn } from "@/lib/utils";

export interface ListRow {
  key: string;
  item: Item;
  /** Stored whole number. */
  quantity: number;
  /** Small facts under the name: lot, expiry, pallet, source place. */
  chips: string[];
  /** A line under the chips, e.g. "5 of 20 received before". */
  note?: string;
  tone?: "ok" | "warn";
  /** Nothing counted yet (an order line still waiting for its delivery). */
  dim?: boolean;
}

/** Asks how many, for the times scanning can't say: an item measured by weight or length, or a number a person wants to type. */
export function QuantityPrompt({ open, item, title, initial, max, onCancel, onConfirm }: {
  open: boolean;
  item: Item | null;
  title?: string;
  initial: number;
  max?: number;
  onCancel: () => void;
  onConfirm: (quantity: number) => void;
}) {
  // Re-mount the stepper for each item so it starts from the right value.
  return (
    <Dialog open={open && !!item} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="gap-4 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-xl">{title ?? "How many?"}</DialogTitle>
          <DialogDescription>{item?.name}</DialogDescription>
        </DialogHeader>
        {item && <PromptBody key={`${item.id}:${initial}`} item={item} initial={initial} max={max} onCancel={onCancel} onConfirm={onConfirm} />}
      </DialogContent>
    </Dialog>
  );
}

function PromptBody({ item, initial, max, onCancel, onConfirm }: { item: Item; initial: number; max?: number; onCancel: () => void; onConfirm: (q: number) => void }) {
  const [qty, setQty] = useState(initial);
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (qty > 0) onConfirm(qty); }}>
      <QtyStepper value={qty} onChange={setQty} max={max} uom={item} label={`How many${item.unit && item.unit !== "ea" ? ` (${item.unit})` : ""}?`} />
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" variant="outline" className="h-14 text-base" onClick={onCancel}>Cancel</Button>
        <Button type="submit" className="h-14 text-base" disabled={qty < 1}>Add</Button>
      </div>
    </form>
  );
}

/** What the last scan did, with a way to take it back. */
export function LastScan({ text, tone = "ok", onUndo }: { text: string; tone?: "ok" | "error"; onUndo?: () => void }) {
  return (
    <div
      role="status"
      className={cn("flex items-center gap-2 rounded-xl px-3 py-2 text-base", tone === "ok" ? "bg-success-soft text-success" : "bg-destructive/10 text-destructive")}
    >
      <span className="min-w-0 flex-1 break-words font-medium">{text}</span>
      {onUndo && (
        <Button type="button" variant="outline" size="sm" className="h-11 shrink-0 bg-background text-sm" onClick={onUndo}>
          <Undo2 /> Undo
        </Button>
      )}
    </div>
  );
}

/** The running list of what has been scanned. Each line can be nudged up or down by one, typed over, or removed. */
export function RunningList({ rows, onStep, onEdit, onRemove, empty }: {
  rows: ListRow[];
  onStep: (key: string, delta: number) => void;
  onEdit: (key: string) => void;
  onRemove: (key: string) => void;
  empty: string;
}) {
  if (!rows.length) return <p className="rounded-xl border border-dashed p-6 text-center text-base text-muted-foreground">{empty}</p>;
  return (
    <ul className="space-y-2" aria-label="Scanned so far">
      {rows.map((r) => (
        <li key={r.key} className={cn("rounded-xl border bg-card p-3", r.tone === "warn" && "border-warning", r.dim && "opacity-70")}>
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="break-words text-lg font-semibold leading-tight">{r.item.name}</p>
              <p className="font-mono text-sm text-muted-foreground">{r.item.sku}</p>
              {r.chips.length > 0 && (
                <p className="mt-1 flex flex-wrap gap-1">
                  {r.chips.map((c) => <span key={c} className="rounded-md bg-muted px-2 py-0.5 text-sm">{c}</span>)}
                </p>
              )}
              {r.note && <p className={cn("mt-1 text-sm", r.tone === "warn" ? "font-medium text-warning" : "text-muted-foreground")}>{r.note}</p>}
            </div>
            <Button type="button" variant="ghost" className="size-11 shrink-0 p-0" aria-label={`Remove ${r.item.name}`} onClick={() => onRemove(r.key)}>
              <Trash2 className="size-5" />
            </Button>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Button type="button" variant="outline" className="size-12 p-0" aria-label={`One less ${r.item.name}`} onClick={() => onStep(r.key, -stepOf(r.item))}>
              <Minus className="size-5" />
            </Button>
            <button type="button" className="h-12 flex-1 rounded-lg border bg-background text-2xl font-semibold tabular-nums hover:bg-muted" aria-label={`Quantity of ${r.item.name}: ${formatQty(r.quantity, r.item)}. Tap to change`} onClick={() => onEdit(r.key)}>
              {formatQty(r.quantity, r.item)}
            </button>
            <Button type="button" variant="outline" className="size-12 p-0" aria-label={`One more ${r.item.name}`} onClick={() => onStep(r.key, stepOf(r.item))}>
              <Plus className="size-5" />
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
