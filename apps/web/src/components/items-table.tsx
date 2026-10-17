import type { Item, Location } from "@invintel/shared";
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCents } from "@/lib/format";
import { useUi } from "@/stores/ui";

interface Props {
  items: Item[];
  locations: Location[];
  /** When set, only items with stock there are shown, with quantities for that location. */
  locationId?: string;
  onDelete: (item: Item) => void;
}

const stockAt = (item: Item, locationId: string) =>
  item.stock.find((s) => s.locationId === locationId)?.quantity ?? 0;

export function ItemsTable({ items, locations, locationId, onDelete }: Props) {
  const { search, lowStockOnly, openDialog } = useUi();
  const [sorting, setSorting] = useState<SortingState>([]);

  const locationNames = useMemo(() => new Map(locations.map((l) => [l.id, l.name])), [locations]);

  const data = useMemo(
    () =>
      items.filter((i) => {
        if (locationId && stockAt(i, locationId) === 0) return false;
        // Reorder levels are for the item as a whole, so "low" always compares the total.
        if (lowStockOnly && i.quantity > i.reorderLevel) return false;
        return true;
      }),
    // locationNames is a dependency only to hand the table a fresh array when locations load:
    // it caches each row's accessor values per data array, and "Where" reads the names.
    [items, locationId, lowStockOnly, locationNames],
  );

  const columns = useMemo<ColumnDef<Item>[]>(
    () => [
      { accessorKey: "sku", header: "SKU" },
      { accessorKey: "name", header: "Name" },
      { accessorKey: "category", header: "Category" },
      {
        id: "quantity",
        header: locationId ? "Qty here" : "Qty",
        accessorFn: (i) => (locationId ? stockAt(i, locationId) : i.quantity),
        cell: ({ row, getValue }) => (
          <span className="flex items-center gap-2">
            {getValue<number>()}
            {row.original.quantity <= row.original.reorderLevel && <Badge variant="destructive">Low</Badge>}
          </span>
        ),
      },
      ...(locationId
        ? []
        : [
            {
              id: "where",
              header: "Where",
              enableSorting: false,
              accessorFn: (i: Item) =>
                i.stock.map((s) => `${locationNames.get(s.locationId) ?? "Unknown"} ${s.quantity}`).join(", "),
              cell: ({ getValue }: { getValue: () => unknown }) => (
                <span className="text-muted-foreground">{(getValue() as string) || "No stock"}</span>
              ),
            } satisfies ColumnDef<Item>,
          ]),
      {
        accessorKey: "unitCostCents",
        header: "Unit cost",
        cell: ({ row }) => formatCents(row.original.unitCostCents),
      },
      {
        id: "value",
        header: "Value",
        accessorFn: (i) => (locationId ? stockAt(i, locationId) : i.quantity) * i.unitCostCents,
        cell: ({ getValue }) => formatCents(getValue<number>()),
      },
      {
        id: "actions",
        enableSorting: false,
        header: "",
        cell: ({ row }) => (
          <div className="flex justify-end gap-1">
            <Button size="sm" variant="outline" onClick={() => openDialog({ kind: "adjust", item: row.original, locationId })}>
              Adjust
            </Button>
            <Button size="sm" variant="outline" onClick={() => openDialog({ kind: "transfer", item: row.original })}>
              Move
            </Button>
            <Button size="sm" variant="ghost" onClick={() => openDialog({ kind: "edit-item", item: row.original })}>
              Edit
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onDelete(row.original)}>
              Delete
            </Button>
          </div>
        ),
      },
    ],
    [openDialog, onDelete, locationId, locationNames],
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

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => (
                <TableHead
                  key={header.id}
                  className={header.column.getCanSort() ? "cursor-pointer select-none" : undefined}
                  onClick={header.column.getToggleSortingHandler()}
                >
                  {flexRender(header.column.columnDef.header, header.getContext())}
                  {{ asc: " ↑", desc: " ↓" }[header.column.getIsSorted() as string] ?? null}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.length ? (
            table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                {locationId ? "Nothing stored here yet." : "No items yet."}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
