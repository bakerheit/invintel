import type { Item } from "@invintel/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useSearchParams } from "react-router";
import { Dialogs } from "@/components/dialogs";
import { ItemsTable } from "@/components/items-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { formatCents } from "@/lib/format";
import { invalidateOrg, orgKey, useCurrentOrg, useLocations } from "@/lib/org";
import { useUi } from "@/stores/ui";

const ALL = "__all__";

export default function InventoryPage() {
  const { id: orgId } = useCurrentOrg();
  const qc = useQueryClient();
  const { search, setSearch, lowStockOnly, setLowStockOnly, openDialog } = useUi();
  const [params, setParams] = useSearchParams();
  const { data: locations = [] } = useLocations(orgId);
  const items = useQuery({ queryKey: orgKey(orgId, "items"), queryFn: () => api.listItems(orgId) });

  // The filter lives in the URL so a location's "View stock" link is shareable.
  const requested = params.get("location");
  const locationId = locations.find((l) => l.id === requested)?.id;

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteItem(orgId, id),
    onSuccess: () => invalidateOrg(qc, orgId),
  });
  const onDelete = useCallback(
    (item: Item) => {
      if (confirm(`Delete "${item.name}" and its stock history?`)) remove.mutate(item.id);
    },
    [remove],
  );

  const all = items.data ?? [];
  const totalValue = all.reduce((sum, i) => sum + i.quantity * i.unitCostCents, 0);
  const lowCount = all.filter((i) => i.quantity <= i.reorderLevel).length;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <p className="text-sm text-muted-foreground">
          {all.length} items · {formatCents(totalValue)} on hand · {lowCount} low stock
        </p>
        <Button onClick={() => openDialog({ kind: "create-item" })}>New item</Button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Input className="max-w-xs" placeholder="Search items…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Select
          value={locationId ?? ALL}
          items={[{ value: ALL, label: "All locations" }, ...locations.map((l) => ({ value: l.id, label: l.name }))]}
          onValueChange={(v) => setParams(!v || v === ALL ? {} : { location: v }, { replace: true })}
        >
          <SelectTrigger className="w-48" aria-label="Location filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All locations</SelectItem>
            {locations.map((l) => (
              <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant={lowStockOnly ? "default" : "outline"} onClick={() => setLowStockOnly(!lowStockOnly)}>
          Low stock only
        </Button>
      </div>

      {items.error ? (
        <p className="text-destructive">Couldn't load items: {items.error.message}</p>
      ) : items.isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : (
        <ItemsTable items={all} locations={locations} locationId={locationId} onDelete={onDelete} />
      )}
      <Dialogs />
    </div>
  );
}
