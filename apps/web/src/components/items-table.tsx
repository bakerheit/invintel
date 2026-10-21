import { formatQty, lineValueCents, type Item, type Location } from "@invintel/shared";
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowLeftRight, ArrowUp, ArrowUpDown, History, MoreHorizontal, Package, Pencil, ShieldCheck, SlidersHorizontal, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCents } from "@/lib/format";
import { isAdmin, useCurrentOrg } from "@/lib/org";
import { needsAttention, stockStatus } from "@/lib/stock";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";

interface Props {
  items: Item[];
  locations: Location[];
  /** When set, only items with stock there are shown, with quantities for that location. */
  locationId?: string;
  /** The location plus everything inside it. Defaults to just `locationId`. */
  locationIds?: string[];
  onDelete: (item: Item) => void;
  onFilteredCount?: (count: number) => void;
}

/** Hides a column below a breakpoint. Applied to both header and cells via column meta. */
type Meta = { className?: string; align?: "right" };
const metaOf = (c: { columnDef: { meta?: unknown } }) => (c.columnDef.meta ?? {}) as Meta;

const stockIn = (item: Item, ids: Set<string>) =>
  item.stock.reduce((sum, s) => (ids.has(s.locationId) ? sum + s.quantity : sum), 0);

function SortIcon({ state }: { state: false | "asc" | "desc" }) {
  if (state === "asc") return <ArrowUp className="size-3.5" />;
  if (state === "desc") return <ArrowDown className="size-3.5" />;
  return <ArrowUpDown className="size-3.5 opacity-40" />;
}

export function ItemsTable({ items, locations, locationId, locationIds, onDelete }: Props) {
  const { search, lowStockOnly, openDialog } = useUi();
  const org = useCurrentOrg();
  const navigate = useNavigate();
  const [sorting, setSorting] = useState<SortingState>([]);

  const idSet = useMemo(() => new Set(locationIds ?? (locationId ? [locationId] : [])), [locationIds, locationId]);
  const filtering = idSet.size > 0;

  const locationNames = useMemo(() => new Map(locations.map((l) => [l.id, l.name])), [locations]);

  const data = useMemo(
    () =>
      items.filter((i) => {
        if (filtering && stockIn(i, idSet) === 0) return false;
        if (lowStockOnly && !needsAttention(i)) return false;
        return true;
      }),
    // locationNames is a dependency only to hand the table a fresh array when locations load:
    // it caches each row's accessor values per data array, and "Where" reads the names.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, filtering, idSet, lowStockOnly, locationNames],
  );

  const columns = useMemo<ColumnDef<Item>[]>(
    () => [
      {
        id: "name",
        header: "Item",
        accessorFn: (i) => `${i.name} ${i.sku} ${i.barcodes.join(" ")}`,
        sortingFn: (a, b) => a.original.name.localeCompare(b.original.name),
        cell: ({ row }) => (
          <div className="min-w-0">
            <Link to={`/o/${org.id}/inventory/${row.original.id}`} className="block truncate font-medium hover:underline">{row.original.name}</Link>
            <div className="truncate font-mono text-xs text-muted-foreground">{row.original.sku}</div>
            {/* On phones the Status column is hidden to make room for Qty, so the badge sits here instead. */}
            <div className="mt-1 sm:hidden"><StatusBadge status={stockStatus(row.original)} /></div>
          </div>
        ),
      },
      {
        accessorKey: "category",
        header: "Category",
        meta: { className: "hidden lg:table-cell" } satisfies Meta,
        cell: ({ row }) => row.original.category || <span className="text-muted-foreground">-</span>,
      },
      {
        id: "quantity",
        header: filtering ? "Qty here" : "Qty",
        accessorFn: (i) => (filtering ? stockIn(i, idSet) : i.quantity),
        meta: { align: "right", className: "w-28 sm:w-auto" } satisfies Meta,
        cell: ({ row, getValue }) => (
          <div className="text-right">
            <span className="font-medium tabular-nums">{formatQty(getValue<number>(), row.original)}</span>
            {!filtering && (row.original.reserved ?? 0) > 0 && (
              <div className={cn("text-xs tabular-nums", (row.original.available ?? 0) < 0 ? "text-warning" : "text-muted-foreground")}>
                {formatQty(row.original.reserved ?? 0, row.original, { unit: false })} promised · {formatQty(row.original.available ?? 0, row.original, { unit: false })} free
              </div>
            )}
          </div>
        ),
      },
      {
        id: "status",
        header: "Status",
        accessorFn: (i) => stockStatus(i),
        meta: { className: "hidden sm:table-cell" } satisfies Meta,
        cell: ({ row }) => <StatusBadge status={stockStatus(row.original)} />,
      },
      ...(filtering
        ? []
        : [
            {
              id: "where",
              header: "Where",
              enableSorting: false,
              accessorFn: (i: Item) => i.stock.map((s) => locationNames.get(s.locationId) ?? "").join(" "),
              meta: { className: "hidden xl:table-cell" } satisfies Meta,
              cell: ({ row }: { row: { original: Item } }) => {
                const stock = [...row.original.stock].sort((a, b) => b.quantity - a.quantity);
                if (!stock.length) return <span className="text-muted-foreground">No stock</span>;
                const shown = stock.slice(0, 2);
                return (
                  <div className="flex flex-wrap items-center gap-1">
                    {shown.map((s) => (
                      <span key={s.locationId} className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-1.5 py-0.5 text-xs">
                        <span className="text-muted-foreground">{locationNames.get(s.locationId) ?? "Unknown"}</span>
                        <span className="font-medium tabular-nums">{formatQty(s.quantity, row.original, { unit: false })}</span>
                      </span>
                    ))}
                    {stock.length > shown.length && (
                      <span className="text-xs text-muted-foreground">+{stock.length - shown.length}</span>
                    )}
                  </div>
                );
              },
            } satisfies ColumnDef<Item>,
          ]),
      {
        accessorKey: "unitCostCents",
        header: "Unit cost",
        meta: { align: "right", className: "hidden md:table-cell" } satisfies Meta,
        cell: ({ row }) => (
          <span className="tabular-nums">
            {formatCents(row.original.unitCostCents)}
            {row.original.unit !== "ea" && <span className="text-xs text-muted-foreground"> / {row.original.unit}</span>}
          </span>
        ),
      },
      {
        id: "value",
        header: "Value",
        accessorFn: (i) => lineValueCents(filtering ? stockIn(i, idSet) : i.quantity, i.unitCostCents, i.decimals),
        meta: { align: "right", className: "hidden md:table-cell" } satisfies Meta,
        cell: ({ getValue }) => <span className="tabular-nums">{formatCents(getValue<number>())}</span>,
      },
      {
        id: "actions",
        enableSorting: false,
        header: () => <span className="sr-only">Actions</span>,
        meta: { align: "right", className: "w-12 sm:w-auto" } satisfies Meta,
        cell: ({ row }) => (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${row.original.name}`} />}
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              {row.original.tracking === "unit" ? (
                <DropdownMenuItem onClick={() => navigate(`/o/${org.id}/inventory/${row.original.id}`)}>
                  <Package /> Rolls and pallets
                </DropdownMenuItem>
              ) : (
                <>
                  <DropdownMenuItem onClick={() => openDialog({ kind: "adjust", item: row.original, locationId })}>
                    <SlidersHorizontal /> Adjust stock
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => openDialog({ kind: "transfer", item: row.original })}>
                    <ArrowLeftRight /> Move stock
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuItem onClick={() => openDialog({ kind: "edit-item", item: row.original })}>
                <Pencil /> Edit details
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigate(`/o/${org.id}/activity?item=${row.original.id}`)}>
                <History /> Stock history
              </DropdownMenuItem>
              {isAdmin(org.role) && (
                <DropdownMenuItem onClick={() => navigate(`/o/${org.id}/audit?entityId=${row.original.id}`)}>
                  <ShieldCheck /> Audit trail
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => onDelete(row.original)}>
                <Trash2 /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    [openDialog, onDelete, locationId, filtering, idSet, locationNames, org.id, org.role, navigate],
  );

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter: search },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const rows = table.getRowModel().rows;

  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
        <Table className="table-fixed sm:table-auto">
          <TableHeader className="bg-muted/40">
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id} className="hover:bg-transparent">
                {group.headers.map((header) => {
                  const meta = metaOf(header.column);
                  const sortable = header.column.getCanSort();
                  return (
                    <TableHead key={header.id} className={cn("h-10 text-xs font-medium text-muted-foreground", meta.className, meta.align === "right" && "text-right")}>
                      {sortable ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className={cn("-mx-1.5 inline-flex h-8 items-center gap-1 rounded px-1.5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none", meta.align === "right" && "flex-row-reverse")}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          <SortIcon state={header.column.getIsSorted()} />
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => {
                  const meta = metaOf(cell.column);
                  return (
                    <TableCell key={cell.id} className={cn("py-3", meta.className, meta.align === "right" && "text-right")}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
            {!rows.length && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columns.length} className="h-32 text-center text-muted-foreground">
                  {filtering ? "Nothing stored here matches." : "No items match."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <p className="px-1 text-xs text-muted-foreground">
        Showing {rows.length} of {items.length} {items.length === 1 ? "item" : "items"}
      </p>
    </div>
  );
}
