import { Minus, Plus } from "lucide-react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function QtyStepper({ value, onChange, max, label = "Quantity" }: {
  value: number;
  onChange: (n: number) => void;
  max?: number;
  label?: string;
}) {
  const id = useId();
  const clamp = (n: number) => Math.max(1, Math.min(max ?? Infinity, Math.floor(n) || 1));
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-base font-medium">{label}</label>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" className="h-16 w-16" aria-label="Less" onClick={() => onChange(clamp(value - 1))}>
          <Minus className="size-6" />
        </Button>
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={1}
          max={max}
          value={value}
          onChange={(e) => onChange(clamp(Number(e.target.value)))}
          onFocus={(e) => e.currentTarget.select()}
          className="h-16 flex-1 text-center text-3xl font-semibold tabular-nums"
        />
        <Button type="button" variant="outline" className="h-16 w-16" aria-label="More" onClick={() => onChange(clamp(value + 1))}>
          <Plus className="size-6" />
        </Button>
      </div>
      {max !== undefined && (
        <Button type="button" variant="ghost" className="h-11 w-full text-base" onClick={() => onChange(max)}>
          All {max.toLocaleString()}
        </Button>
      )}
    </div>
  );
}
