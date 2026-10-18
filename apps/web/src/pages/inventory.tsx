import type { Item } from "@invintel/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, CircleDollarSign, Download, Layers, Package, Plus, Search, TriangleAlert, Upload, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm";
import { Dialogs } from "@/components/dialogs";
import { EmptyState } from "@/components/empty-state";
import { ImportDialog } from "@/components/import-dialog";
import { ItemsTable } from "@/components/items-table";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { formatCents } from "@/lib/format";
import { withDescendants } from "@/lib/locations";
import { invalidateOrg, isAdmin, orgKey, useCurrentOrg, useLocations } from "@/lib/org";
import { needsAttention } from "@/lib/stock";
import { useUi } from "@/stores/ui";

const ALL = "__all__";

export default function InventoryPage() {
  const { id: orgId, role } = useCurrentOrg();
  const [importing, setImporting] = useState(false);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { search, setSearch, lowStockOnly, setLowStockOnly, openDialog } = useUi();
  const [params, setParams] = useSearchParams();
  const { data: locations = [] } = useLocations(orgId);
  const items = useQuery({ queryKey: orgKey(orgId, "items"), queryFn: () => api.listItems(orgId) });

  // Floor mode sends unknown scans here as ?newItem=CODE so they can be added as an item.
  const newItemCode = params.get("newItem");
  useEffect(() => {
    if (!newItemCode) return;
    openDialog({ kind: "create-item", barcode: newItemCode });
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("newItem");
        return next;
      },
      { replace: true },
    );
  }, [newItemCode, openDialog, setParams]);

  // The filter lives in the URL so a location's "View stock" link is shareable.
  const requested = params.get("location");
  const locationId = locations.find((l) => l.id === requested)?.id;
  // Picking an area includes everything stored inside it.
  const locationIds = locationId ? withDescendants(locations, locationId) : undefined;

  const remove = useMutation({
    mutationFn: (item: Item) => api.deleteItem(orgId, item.id),
    onSuccess: async (_data, item) => {
      await invalidateOrg(qc, orgId);
      toast.success(`Deleted ${item.name}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const onDelete = useCallback(
    async (item: Item) => {
      const ok = await confirm({
        title: `Delete ${item.name}?`,
        description: "The item disappears from the inventory and any stock on hand is written off. Its history stays in Activity and the audit log.",
        confirmLabel: "Delete item",
        destructive: true,
      });
      if (ok) remove.mutate(item);
    },
    [confirm, remove],
  );

  const all = items.data ?? [];
  const units = all.reduce((sum, i) => sum + i.quantity, 0);
  const totalValue = all.reduce((sum, i) => sum + i.quantity * i.unitCostCents, 0);
  const lowCount = all.filter(needsAttention).length;
  const filtering = !!search || lowStockOnly || !!locationId;

  const clearFilters = () => {
    setSearch("");
    setLowStockOnly(false);
    setParams({}, { replace: true });
  };

  return (
    <>
      <PageHeader
        title="Inventory"
        description="Everything you stock, and where it is."
        actions={
          <>
            <a href={api.itemsCsvUrl(orgId)} download className={buttonVariants({ variant: "outline" })}>
              <Download /> Export
            </a>
            {isAdmin(role) && (
              <Button variant="outline" onClick={() => setImporting(true)}>
                <Upload /> Import
              </Button>
            )}
            <Button onClick={() => openDialog({ kind: "create-item" })}>
              <Plus /> New item
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Items" value={all.length.toLocaleString()} icon={Package} hint="Distinct SKUs" />
        <StatCard label="Units on hand" value={units.toLocaleString()} icon={Layers} hint={`Across ${locations.length} ${locations.length === 1 ? "location" : "locations"}`} />
        <StatCard label="Inventory value" value={formatCents(totalValue)} icon={CircleDollarSign} hint="At unit cost" />
        <StatCard
          label="Low stock"
          value={lowCount.toLocaleString()}
          icon={TriangleAlert}
          tone={lowCount ? "warning" : "default"}
          hint={lowCount ? (lowStockOnly ? "Showing only these" : "Low or out of stock. Click to filter") : "Everything is stocked"}
          onClick={lowCount || lowStockOnly ? () => setLowStockOnly(!lowStockOnly) : undefined}
          active={lowStockOnly}
        />
      </div>

      {items.error ? (
        <p className="text-destructive">Couldn't load items: {items.error.message}</p>
      ) : items.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-9 w-full max-w-md" />
          <Skeleton className="h-72 w-full rounded-xl" />
        </div>
      ) : !all.length ? (
        <div className="rounded-xl border border-dashed bg-card">
          <EmptyState
            icon={Boxes}
            title="No items yet"
            description="Add your first item, then record how many you have and where they're kept."
            action={
              <Button onClick={() => openDialog({ kind: "create-item" })}>
                <Plus /> Add your first item
              </Button>
            }
          />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-72">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="Search name, SKU, category…"
                aria-label="Search items"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Select
              value={locationId ?? ALL}
              onValueChange={(v) => setParams(!v || v === ALL ? {} : { location: v }, { replace: true })}
              items={[{ value: ALL, label: "All locations" }, ...locations.map((l) => ({ value: l.id, label: l.path }))]}
            >
              <SelectTrigger className="w-full sm:w-48" aria-label="Location filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All locations</SelectItem>
                {locations.map((l) => (
                  <SelectItem key={l.id} value={l.id}>{l.path}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {filtering && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <X /> Clear filters
              </Button>
            )}
          </div>
          <ItemsTable items={all} locations={locations} locationId={locationId} locationIds={locationIds} onDelete={onDelete} />
        </div>
      )}
      <Dialogs />
      <ImportDialog orgId={orgId} open={importing} onOpenChange={setImporting} />
    </>
  );
}
