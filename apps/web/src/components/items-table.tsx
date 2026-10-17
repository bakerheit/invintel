import type { Item } from "@invintel/shared";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCents } from "@/lib/format";
import { useUi } from "@/stores/ui";

interface Props {
  items: Item[];
  onDelete: (item: Item) => void;
}

export function ItemsTable({ items, onDelete }: Props) {
  const { search, lowStockOnly, openDialog } = useUi();
  const [sorting, setSorting] = useState<SortingState>([]);

  const data = useMemo(
    () => (lowStockOnly ? items.filter((i) => i.quantity <= i.reorderLevel) : items),
    [items, lowStockOnly],
  );

  const columns = useMemo<ColumnDef<Item>[]>(
    () => [
      { accessorKey: "sku", header: "SKU" },
      { accessorKey: "name", header: "Name" },
      { accessorKey: "category", header: "Category" },
      { accessorKey: "location", header: "Location" },
      {
        accessorKey: "quantity",
        header: "Qty",
        cell: ({ row }) => {
          const low = row.original.quantity <= row.original.reorderLevel;
          return (
            <span className="flex items-center gap-2">
              {row.original.quantity}
              {low && <Badge variant="destructive">Low</Badge>}
            </span>
          );
        },
      },
      {
        accessorKey: "unitCostCents",
        header: "Unit cost",
        cell: ({ row }) => formatCents(row.original.unitCostCents),
      },
      {
        id: "value",
        header: "Value",
        accessorFn: (i) => i.quantity * i.unitCostCents,
        cell: ({ getValue }) => formatCents(getValue<number>()),
      },
      {
        id: "actions",
        enableSorting: false,
        header: "",
        cell: ({ row }) => (
          <div className="flex justify-end gap-1">
            <Button size="sm" variant="outline" onClick={() => openDialog({ kind: "adjust", item: row.original })}>
              Adjust
            </Button>
            <Button size="sm" variant="ghost" onClick={() => openDialog({ kind: "edit", item: row.original })}>
              Edit
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onDelete(row.original)}>
              Delete
            </Button>
          </div>
        ),
      },
    ],
    [openDialog, onDelete],
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
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                No items yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
