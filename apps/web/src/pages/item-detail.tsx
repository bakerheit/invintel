import { formatQty, lineValueCents } from "@invintel/shared";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowLeftRight, History, Package, Pencil, Printer, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { Link, useParams } from "react-router";
import { Dialogs } from "@/components/dialogs";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { formatCents, formatRelative } from "@/lib/format";
import { isAdmin, orgKey, useCurrentOrg, useLocations } from "@/lib/org";
import { stockStatus } from "@/lib/stock";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";

/** Everything about one item: where it is, what it's worth, and what has happened to it. */
export default function ItemDetailPage() {
  const { itemId = "" } = useParams();
  const org = useCurrentOrg();
  const openDialog = useUi((s) => s.openDialog);
  const { data: locations = [] } = useLocations(org.id);
  const items = useQuery({ queryKey: orgKey(org.id, "items"), queryFn: () => api.listItems(org.id) });
  const history = useQuery({ queryKey: orgKey(org.id, "item-history", itemId), queryFn: () => api.activity(org.id, { itemId }) });
  const units = useQuery({ queryKey: orgKey(org.id, "units", itemId), queryFn: () => api.listUnits(org.id, { itemId, status: "available", limit: 100 }) });
  const back = (
    <Link to={`/o/${org.id}/inventory`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
      <ArrowLeft /> Inventory
    </Link>
  );

  if (items.isLoading) return <Skeleton className="h-96 rounded-xl" />;
  const item = items.data?.find((i) => i.id === itemId);
  if (!item) {
    return (
      <>
        {back}
        <EmptyState icon={Package} title="Item not found" description="It may have been deleted." />
      </>
    );
  }

  const placeOf = new Map(locations.map((l) => [l.id, l]));
  const where = [...item.stock].sort((a, b) => b.quantity - a.quantity);
  const entries = history.data?.entries.slice(0, 12) ?? [];

  return (
    <>
      <div>{back}</div>
      <PageHeader
        title={item.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <code className="font-mono">{item.sku}</code>
            {item.category && <Badge variant="secondary">{item.category}</Badge>}
            <StatusBadge status={stockStatus(item)} />
          </span>
        }
        actions={
          <>
            {item.tracking === "unit" ? (
              <Link to={`/o/${org.id}/labels?units=${(units.data?.units ?? []).map((u) => u.id).join(",")}`} className={buttonVariants({ variant: "outline" })}>
                <Printer /> Print labels
              </Link>
            ) : (
              <>
                <Button variant="outline" onClick={() => openDialog({ kind: "adjust", item })}>
                  <SlidersHorizontal /> Adjust
                </Button>
                <Button variant="outline" onClick={() => openDialog({ kind: "transfer", item })} disabled={item.quantity === 0}>
                  <ArrowLeftRight /> Move
                </Button>
              </>
            )}
            <Button variant="outline" onClick={() => openDialog({ kind: "edit-item", item })}>
              <Pencil /> Edit
            </Button>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["On hand", formatQty(item.quantity, item)],
          ...((item.reserved ?? 0) > 0 || (item.available ?? item.quantity) !== item.quantity
            ? [[`Available${(item.reserved ?? 0) > 0 ? ` (${formatQty(item.reserved ?? 0, item, { unit: false })} promised)` : " (not on hold)"}`, formatQty(item.available ?? item.quantity, item)]]
            : []),
          ["Value", formatCents(lineValueCents(item.quantity, item.unitCostCents, item.decimals))],
          [item.unit === "ea" ? "Unit cost" : `Cost per ${item.unit}`, formatCents(item.unitCostCents)],
          ["Reorder at", item.reorderLevel > 0 ? formatQty(item.reorderLevel, item) : "Not tracked"],
        ].map(([label, value]) => (
          <Card key={label} className="gap-0 p-4">
            <div className="text-sm text-muted-foreground">{label}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
          </Card>
        ))}
      </div>

      {item.tracking === "unit" && (
        <Card>
          <CardHeader>
            <CardTitle>Rolls and pallets</CardTitle>
          </CardHeader>
          <CardContent>
            {!units.data?.units.length ? (
              <p className="text-sm text-muted-foreground">{units.isLoading ? "Loading…" : "None in stock. Receive some from Floor mode, then print their labels."}</p>
            ) : (
              <ul className="divide-y">
                {units.data.units.map((u) => (
                  <li key={u.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <div className="min-w-0">
                      <p className="font-mono font-semibold">{u.code}</p>
                      <p className="truncate text-xs text-muted-foreground">{u.locationPath}{u.lot ? ` · Lot ${u.lot}` : ""}</p>
                    </div>
                    <p className="tabular-nums">
                      <span className="font-medium">{formatQty(u.quantity, item)}</span>
                      {u.quantity !== u.initialQuantity && <span className="text-muted-foreground"> of {formatQty(u.initialQuantity, item, { unit: false })}</span>}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Where it is</CardTitle></CardHeader>
          <CardContent>
            {!where.length ? (
              <p className="text-sm text-muted-foreground">No stock anywhere. Receive some in Floor mode, or adjust it here.</p>
            ) : (
              <ul className="divide-y">
                {where.map((s) => {
                  const loc = placeOf.get(s.locationId);
                  return (
                    <li key={s.locationId} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                      <Link to={`/o/${org.id}/inventory?location=${s.locationId}`} className="min-w-0 truncate hover:underline">
                        {loc?.path ?? "Unknown location"}
                        {loc?.code && <span className="ml-2 font-mono text-xs text-muted-foreground">{loc.code}</span>}
                      </Link>
                      <div className="flex shrink-0 items-center gap-3">
                        <span className="font-medium tabular-nums">{formatQty(s.quantity, item)}</span>
                        <Button variant="ghost" size="sm" onClick={() => openDialog({ kind: "adjust", item, locationId: s.locationId })}>Adjust</Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {item.barcodes.length > 0 && (
              <div className="mt-4 border-t pt-3">
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">Barcodes</p>
                <div className="flex flex-wrap gap-1.5">
                  {item.barcodes.map((b) => <code key={b} className="rounded border bg-muted/40 px-1.5 py-0.5 font-mono text-xs">{b}</code>)}
                </div>
              </div>
            )}
            {item.description && <p className="mt-4 border-t pt-3 text-sm text-muted-foreground">{item.description}</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
           <div className="flex items-center justify-between gap-2">
            <CardTitle>What happened</CardTitle>
            <div className="flex gap-1">
              <Link to={`/o/${org.id}/activity?item=${item.id}`} className={buttonVariants({ variant: "ghost", size: "sm" })}><History /> All</Link>
              {isAdmin(org.role) && (
                <Link to={`/o/${org.id}/audit?entityId=${item.id}`} className={buttonVariants({ variant: "ghost", size: "sm" })}><ShieldCheck /> Audit</Link>
              )}
            </div>
           </div>
          </CardHeader>
          <CardContent>
            {!entries.length ? (
              <p className="text-sm text-muted-foreground">{history.isLoading ? "Loading…" : "No stock movements yet."}</p>
            ) : (
              <ul className="divide-y">
                {entries.map((e) => (
                  <li key={e.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <div className="min-w-0">
                      <p className="truncate">
                        <span className="capitalize">{e.type}</span> <span className="text-muted-foreground">· {e.locationName}</span>
                        {e.reversed && <span className="ml-2 text-xs text-muted-foreground">(reversed)</span>}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">{e.userName} · {formatRelative(e.createdAt)}{e.reason ? ` · ${e.reason}` : ""}</p>
                    </div>
                    <span className={cn("shrink-0 font-medium tabular-nums", e.delta < 0 && "text-muted-foreground")}>{formatQty(e.delta, item, { sign: true })}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
      <Dialogs />
    </>
  );
}
