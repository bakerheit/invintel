import { formatQty } from "@invintel/shared";
import { Input } from "@/components/ui/input";
import type { QtyEntry } from "@/lib/qty";
import { cn } from "@/lib/utils";

/**
 * A quantity box that knows the item's unit. Whole-number items behave as a plain number box;
 * items with decimals take "12.5"; items with other units (cases, reels) get a unit picker and
 * show what the typed amount comes to.
 */
export function QtyInput({ entry, id, className, inputClassName, "aria-label": ariaLabel, required, autoFocus, onKeyDown, onBlur }: {
  entry: QtyEntry;
  id?: string;
  className?: string;
  inputClassName?: string;
  "aria-label"?: string;
  required?: boolean;
  autoFocus?: boolean;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onBlur?: () => void;
}) {
  const { uom, altUnits, entryUnit } = entry;
  const hasAlt = altUnits.length > 0;
  const converted = hasAlt && entryUnit !== uom.unit && entry.stored !== null;
  const errorId = id ? `${id}-error` : undefined;
  return (
    <div className={cn("grid gap-1", className)}>
      <div className="flex items-stretch gap-2">
        <div className="relative flex-1">
          <Input
            id={id}
            inputMode={uom.decimals || entry.signed || hasAlt ? "decimal" : "numeric"}
            autoComplete="off"
            value={entry.text}
            onChange={(e) => entry.setText(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={onKeyDown}
            onBlur={onBlur}
            required={required}
            autoFocus={autoFocus}
            aria-label={ariaLabel}
            aria-invalid={entry.error ? true : undefined}
            aria-describedby={entry.error ? errorId : undefined}
            className={cn(!hasAlt && uom.unit !== "ea" && "pr-12", inputClassName)}
          />
          {!hasAlt && uom.unit !== "ea" && (
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">{uom.unit}</span>
          )}
        </div>
        {hasAlt && (
          <select
            aria-label="Unit"
            value={entryUnit}
            onChange={(e) => entry.setEntryUnit(e.target.value)}
            className="rounded-lg border border-input bg-background px-2 text-sm"
          >
            <option value={uom.unit}>{uom.unit}</option>
            {altUnits.map((a) => (
              <option key={a.name} value={a.name}>{a.name}</option>
            ))}
          </select>
        )}
      </div>
      {entry.error ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">{entry.error}</p>
      ) : (
        converted && <p className="text-xs text-muted-foreground">= {formatQty(entry.stored!, uom, { unit: true })}</p>
      )}
    </div>
  );
}
