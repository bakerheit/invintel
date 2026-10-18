import type { ActivityEntry, MovementType } from "@invintel/shared";
import { MOVEMENT_TYPES } from "@invintel/shared";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { History, Link2, MoreHorizontal, Search, Undo2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { Dialogs } from "@/components/dialogs";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatDateTime, formatRelative } from "@/lib/format";
import { orgKey, useCurrentOrg, useLocations } from "@/lib/org";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";

const ALL = "__all__";

const TYPE_STYLE: Record<MovementType, { label: string; className: string }> = {
  receive: { label: "Received", className: "bg-success-soft text-success" },
  adjust: { label: "Adjusted", className: "bg-secondary text-secondary-foreground" },
  transfer: { label: "Moved", className: "bg-accent text-accent-foreground" },
  reversal: { label: "Reversal", className: "bg-warning-soft text-warning" },
  load: { label: "Loaded", className: "bg-accent text-accent-foreground" },
  consume: { label: "Used", className: "bg-secondary text-secondary-foreground" },
  produce: { label: "Produced", className: "bg-success-soft text-success" },
  scrap: { label: "Scrap", className: "bg-warning-soft text-warning" },
};

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function Row({ entry, onReverse }: { entry: ActivityEntry; onReverse: () => void }) {
  const style = TYPE_STYLE[entry.type];
  return (
    <TableRow className={cn(entry.reversed && "text-muted-foreground")}>
      <TableCell className="whitespace-nowrap py-3">
        <span title={formatDateTime(entry.createdAt)}>{formatRelative(entry.createdAt)}</span>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-1">
          <Badge variant="secondary" className={style.className}>{style.label}</Badge>
          {entry.reversed && <Badge variant="outline">Reversed</Badge>}
        </div>
      </TableCell>
      <TableCell>
        <div className="font-medium">{entry.itemName}</div>
        <div className="font-mono text-xs text-muted-foreground">{entry.itemSku}</div>
      </TableCell>
      <TableCell>
        <span className="inline-flex items-center gap-1.5">
          {entry.transferId && <Link2 className="size-3.5 text-muted-foreground" aria-label="Part of a move" />}
          {entry.locationPath}
        </span>
      </TableCell>
      <TableCell
        className={cn(
          "text-right font-medium tabular-nums",
          entry.delta > 0 ? "text-success" : "text-destructive",
          entry.reversed && "line-through opacity-60",
        )}
      >
        {entry.delta > 0 ? "+" : "−"}
        {Math.abs(entry.delta).toLocaleString()}
      </TableCell>
      <TableCell className="hidden max-w-56 truncate xl:table-cell" title={entry.reason}>
        {entry.reason || <span className="text-muted-foreground">-</span>}
      </TableCell>
      <TableCell className="hidden whitespace-nowrap 2xl:table-cell">{entry.userName}</TableCell>
      <TableCell className="w-10">
        {entry.canReverse && (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Entry actions" />}>
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-40">
              <DropdownMenuItem onClick={onReverse}>
                <Undo2 /> Reverse…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </TableCell>
    </TableRow>
  );
}

export default function ActivityPage() {
  const { id: orgId } = useCurrentOrg();
  const openDialog = useUi((s) => s.openDialog);
  const { data: locations = [] } = useLocations(orgId);
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());

  const itemId = params.get("item") ?? undefined;
  const locationId = locations.find((l) => l.id === params.get("location"))?.id;
  const type = MOVEMENT_TYPES.find((t) => t === params.get("type"));

  const setParam = (key: string, value?: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const filters = { itemId, locationId, type, q: q || undefined };
  const activity = useInfiniteQuery({
    queryKey: orgKey(orgId, "activity", JSON.stringify(filters)),
    queryFn: ({ pageParam }) => api.activity(orgId, { ...filters, before: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextBefore,
  });
  const entries = activity.data?.pages.flatMap((p) => p.entries) ?? [];

  // Name for the "Item: …" chip, read from whatever is already loaded.
  const itemLabel = useQuery({
    queryKey: orgKey(orgId, "items"),
    queryFn: () => api.listItems(orgId),
    enabled: !!itemId,
    select: (items) => items.find((i) => i.id === itemId)?.name,
  }).data;

  const filtering = !!(itemId || locationId || type || q);
  const clear = () => {
    setSearch("");
    setParams({}, { replace: true });
  };

  return (
    <>
      <PageHeader
        title="Activity"
        description="Every stock change, newest first. Nothing is edited: if something was recorded wrong, reverse it and a matching entry is added."
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Search item or SKU…"
            aria-label="Search activity"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select
          value={type ?? ALL}
          onValueChange={(v) => setParam("type", !v || v === ALL ? undefined : v)}
          items={[{ value: ALL, label: "All types" }, ...MOVEMENT_TYPES.map((t) => ({ value: t, label: TYPE_STYLE[t].label }))]}
        >
          <SelectTrigger className="w-full sm:w-40" aria-label="Type filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All types</SelectItem>
            {MOVEMENT_TYPES.map((t) => (
              <SelectItem key={t} value={t}>{TYPE_STYLE[t].label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={locationId ?? ALL}
          onValueChange={(v) => setParam("location", !v || v === ALL ? undefined : v)}
          items={[{ value: ALL, label: "All locations" }, ...locations.map((l) => ({ value: l.id, label: l.path }))]}
        >
          <SelectTrigger className="w-full sm:w-52" aria-label="Location filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All locations</SelectItem>
            {locations.map((l) => (
              <SelectItem key={l.id} value={l.id}>{l.path}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {itemId && (
          <Badge variant="secondary" className="h-8 gap-1.5 pr-1.5 pl-3 text-sm">
            Item: {itemLabel ?? "…"}
            <button
              type="button"
              aria-label="Remove item filter"
              onClick={() => setParam("item")}
              className="rounded-full p-0.5 hover:bg-foreground/10"
            >
              <X className="size-3.5" />
            </button>
          </Badge>
        )}
        {filtering && !itemId && (
          <Button variant="ghost" size="sm" onClick={clear}>
            <X /> Clear filters
          </Button>
        )}
      </div>

      {activity.error ? (
        <p className="text-destructive">Couldn't load activity: {activity.error.message}</p>
      ) : activity.isLoading ? (
        <Skeleton className="h-80 rounded-xl" />
      ) : !entries.length ? (
        <div className="rounded-xl border border-dashed bg-card">
          <EmptyState
            icon={History}
            title={filtering ? "Nothing matches those filters" : "No activity yet"}
            description={
              filtering
                ? "Try a different item, location or type."
                : "Receiving, moving and adjusting stock all show up here, with who did it."
            }
            action={filtering ? <Button variant="outline" onClick={clear}>Clear filters</Button> : undefined}
          />
        </div>
      ) : (
        <div className="space-y-3">
          <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
            <Table>
              <TableHeader className="bg-muted/40">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-10 text-xs text-muted-foreground">When</TableHead>
                  <TableHead className="h-10 text-xs text-muted-foreground">Type</TableHead>
                  <TableHead className="h-10 text-xs text-muted-foreground">Item</TableHead>
                  <TableHead className="h-10 text-xs text-muted-foreground">Location</TableHead>
                  <TableHead className="h-10 text-right text-xs text-muted-foreground">Change</TableHead>
                  <TableHead className="hidden h-10 text-xs text-muted-foreground xl:table-cell">Note</TableHead>
                  <TableHead className="hidden h-10 text-xs text-muted-foreground 2xl:table-cell">By</TableHead>
                  <TableHead className="h-10 w-10"><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((e) => (
                  <Row key={e.id} entry={e} onReverse={() => openDialog({ kind: "reverse", entry: e })} />
                ))}
              </TableBody>
            </Table>
          </div>
          {activity.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="outline" disabled={activity.isFetchingNextPage} onClick={() => void activity.fetchNextPage()}>
                {activity.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </div>
      )}
      <Dialogs />
    </>
  );
}
