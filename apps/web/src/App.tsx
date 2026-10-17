import type { Item } from "@invintel/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { ItemDialogs } from "@/components/item-dialog";
import { ItemsTable } from "@/components/items-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { formatCents } from "@/lib/format";
import { useUi } from "@/stores/ui";

export default function App() {
  const qc = useQueryClient();
  const { search, setSearch, lowStockOnly, setLowStockOnly, openDialog } = useUi();
  const { data: items = [], isLoading, error } = useQuery({ queryKey: ["items"], queryFn: api.listItems });

  const remove = useMutation({
    mutationFn: (id: number) => api.deleteItem(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["items"] }),
  });

  const onDelete = useCallback(
    (item: Item) => {
      if (confirm(`Delete "${item.name}" and its stock history?`)) remove.mutate(item.id);
    },
    [remove],
  );

  const totalValue = items.reduce((sum, i) => sum + i.quantity * i.unitCostCents, 0);
  const lowCount = items.filter((i) => i.quantity <= i.reorderLevel).length;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Invintel</h1>
          <p className="text-sm text-muted-foreground">
            {items.length} items · {formatCents(totalValue)} on hand · {lowCount} low stock
          </p>
        </div>
        <Button onClick={() => openDialog({ kind: "create" })}>New item</Button>
      </header>

      <div className="flex items-center gap-3">
        <Input
          className="max-w-xs"
          placeholder="Search items…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Button variant={lowStockOnly ? "default" : "outline"} onClick={() => setLowStockOnly(!lowStockOnly)}>
          Low stock only
        </Button>
      </div>

      {error ? (
        <p className="text-destructive">Couldn't load items: {error.message}</p>
      ) : isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : (
        <ItemsTable items={items} onDelete={onDelete} />
      )}
      <ItemDialogs />
    </div>
  );
}
