import { formatQty } from "@invintel/shared";
import { Minus, Plus } from "lucide-react";
import { useEffect, useId } from "react";
import { QtyInput } from "@/components/qty-input";
import { Button } from "@/components/ui/button";
import { useQtyEntry, type UomSource } from "@/lib/qty";

/**
 * Big quantity box for the floor. `value` and `max` are stored whole numbers; `uom` says how to
 * read them (kg with 3 decimals, cases of 12, plain each). The + and - buttons move by one whole
 * display unit (one kg), and typing accepts decimals when the item has them.
 */
export function QtyStepper({ value, onChange, max, label = "Quantity", uom }: {
  value: number;
  onChange: (n: number) => void;
  max?: number;
  label?: string;
  uom?: UomSource;
}) {
  const id = useId();
  const entry = useQtyEntry(uom ?? {}, { initial: value });
  const step = 10 ** entry.uom.decimals;
  const clamp = (n: number) => Math.max(1, Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.floor(n) || 1));

  // The parent changed the value (buttons, "All"): show it. 0 means "nothing valid typed", so leave the box alone.
  useEffect(() => {
    if (value > 0 && entry.stored !== value) entry.set(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Report each reading. Anything that isn't a valid positive quantity ("12.", "", "0") reports 0,
  // so the page can disable its button instead of posting a number that isn't what the box shows.
  useEffect(() => {
    const next = entry.stored !== null && entry.stored > 0 ? clamp(entry.stored) : 0;
    if (next !== value) onChange(next);
    // Typed past the limit and the page already holds the limit: pull the box back to it.
    else if (max !== undefined && entry.stored !== null && entry.stored > max) entry.set(max);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.stored]);

  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-base font-medium">{label}</label>
      <div className="flex items-start gap-2">
        <Button type="button" variant="outline" className="h-16 w-16" aria-label="Less" onClick={() => onChange(clamp(value - step))}>
          <Minus className="size-6" />
        </Button>
        <QtyInput
          id={id}
          entry={entry}
          className="flex-1"
          inputClassName="h-16 text-center text-3xl font-semibold tabular-nums"
        />
        <Button type="button" variant="outline" className="h-16 w-16" aria-label="More" onClick={() => onChange(clamp(value + step))}>
          <Plus className="size-6" />
        </Button>
      </div>
      {max !== undefined && (
        <Button type="button" variant="ghost" className="h-11 w-full text-base" onClick={() => onChange(max)}>
          All {formatQty(max, entry.uom)}
        </Button>
      )}
    </div>
  );
}
