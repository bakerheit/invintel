import { formatQty, type Item, type Location } from "@invintel/shared";
import { Package } from "lucide-react";

export function ItemSummary({ item, locations }: { item: Item; locations: Location[] }) {
  const names = new Map(locations.map((l) => [l.id, l.path]));
  return (
    <div className="flex items-start gap-3 rounded-xl border bg-card p-4">
      <span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
        <Package className="size-6" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xl font-semibold">{item.name}</p>
        <p className="font-mono text-sm text-muted-foreground">{item.sku}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {formatQty(item.quantity, item)} in stock
          {item.stock.length > 0 && (
            <>
              {": "}
              {item.stock.map((s) => `${(names.get(s.locationId) ?? "Unknown")} ${formatQty(s.quantity, item, { unit: false })}`).join(", ")}
            </>
          )}
        </p>
      </div>
    </div>
  );
}
