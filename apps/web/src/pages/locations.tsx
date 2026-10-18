import type { Location } from "@invintel/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, MapPin, MoreHorizontal, Pencil, Plus, ScanBarcode, Trash2, FolderPlus, Eye } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm";
import { Dialogs } from "@/components/dialogs";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { buildTree, LOCATION_TYPE_META, type LocationNode } from "@/lib/locations";
import { invalidateOrg, isAdmin, useCurrentOrg, useLocations } from "@/lib/org";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";

function flatten(nodes: LocationNode[], collapsed: Set<string>): LocationNode[] {
  return nodes.flatMap((n) => [n, ...(collapsed.has(n.location.id) ? [] : flatten(n.children, collapsed))]);
}

function TypeBadge({ type }: { type: Location["type"] }) {
  const { label, icon: Icon, className } = LOCATION_TYPE_META[type];
  return (
    <Badge variant="secondary" className={cn("gap-1", className)}>
      <Icon /> {label}
    </Badge>
  );
}

export default function LocationsPage() {
  const org = useCurrentOrg();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const openDialog = useUi((s) => s.openDialog);
  const { data: locations = [], isLoading, error } = useLocations(org.id);
  const admin = isAdmin(org.role);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const tree = useMemo(() => buildTree(locations), [locations]);
  const rows = useMemo(() => flatten(tree, collapsed), [tree, collapsed]);

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const remove = useMutation({
    mutationFn: (l: Location) => api.deleteLocation(org.id, l.id),
    onSuccess: async (_d, l) => {
      await invalidateOrg(qc, org.id);
      toast.success(`Deleted ${l.name}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const onDelete = async (l: Location) => {
    const ok = await confirm({
      title: `Delete ${l.name}?`,
      description: "Locations that still hold stock, or have other locations inside, can't be deleted.",
      confirmLabel: "Delete location",
      destructive: true,
    });
    if (ok) remove.mutate(l);
  };

  return (
    <>
      <PageHeader
        title="Locations"
        description="Sites, areas, racks and machines: anywhere you keep or use stock. Nest them as deep as you need."
        actions={
          admin && (
            <Button onClick={() => openDialog({ kind: "create-location" })}>
              <Plus /> New location
            </Button>
          )
        }
      />

      {error ? (
        <p className="text-destructive">Couldn't load locations: {error.message}</p>
      ) : isLoading ? (
        <Skeleton className="h-72 rounded-xl" />
      ) : !locations.length ? (
        <div className="rounded-xl border border-dashed bg-card">
          <EmptyState
            icon={MapPin}
            title="No locations yet"
            description={admin ? "Add a location so you can start storing stock." : "Ask an admin to add a location."}
            action={
              admin && (
                <Button onClick={() => openDialog({ kind: "create-location" })}>
                  <Plus /> Add a location
                </Button>
              )
            }
          />
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
          <div className="hidden grid-cols-[minmax(0,1fr)_9rem_7rem_6rem_2.5rem] items-center gap-3 border-b bg-muted/40 px-4 py-2.5 text-xs font-medium text-muted-foreground md:grid">
            <span>Location</span>
            <span>Type</span>
            <span>Code</span>
            <span className="text-right">Units</span>
            <span />
          </div>
          <ul className="divide-y">
            {rows.map(({ location: l, children, depth, totalUnits }) => {
              const isCollapsed = collapsed.has(l.id);
              return (
                <li
                  key={l.id}
                  className="grid grid-cols-[minmax(0,1fr)_2.5rem] items-center gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_9rem_7rem_6rem_2.5rem]"
                >
                  <div className="flex min-w-0 items-center gap-1" style={{ paddingLeft: `${depth * 1.5}rem` }}>
                    {children.length ? (
                      <button
                        type="button"
                        onClick={() => toggle(l.id)}
                        aria-label={isCollapsed ? `Expand ${l.name}` : `Collapse ${l.name}`}
                        aria-expanded={!isCollapsed}
                        className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted"
                      >
                        <ChevronRight className={cn("size-4 transition-transform", !isCollapsed && "rotate-90")} />
                      </button>
                    ) : (
                      <span className="size-6 shrink-0" />
                    )}
                    <div className="min-w-0">
                      <div className="truncate font-medium">{l.name}</div>
                      <div className="truncate text-xs text-muted-foreground md:hidden">
                        {LOCATION_TYPE_META[l.type].label}
                        {l.code ? ` · ${l.code}` : ""} · {totalUnits.toLocaleString()} units
                      </div>
                      {l.description && (
                        <div className="hidden truncate text-xs text-muted-foreground md:block">{l.description}</div>
                      )}
                    </div>
                  </div>
                  <div className="hidden md:block">
                    <TypeBadge type={l.type} />
                  </div>
                  <div className="hidden md:block">
                    {l.code ? (
                      <span className="inline-flex items-center gap-1 font-mono text-xs">
                        <ScanBarcode className="size-3.5 text-muted-foreground" /> {l.code}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </div>
                  <div className="hidden text-right tabular-nums md:block">
                    {totalUnits.toLocaleString()}
                    {totalUnits !== l.unitCount && (
                      <div className="text-xs text-muted-foreground">{l.unitCount.toLocaleString()} here</div>
                    )}
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${l.name}`} />}
                    >
                      <MoreHorizontal />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-44">
                      <DropdownMenuItem onClick={() => navigate(`/o/${org.id}?location=${l.id}`)}>
                        <Eye /> View stock
                      </DropdownMenuItem>
                      {admin && (
                        <>
                          <DropdownMenuItem onClick={() => openDialog({ kind: "create-location", parentId: l.id })}>
                            <FolderPlus /> Add inside
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => openDialog({ kind: "edit-location", location: l })}>
                            <Pencil /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onClick={() => void onDelete(l)}>
                            <Trash2 /> Delete
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {!admin && !!locations.length && (
        <p className="text-sm text-muted-foreground">Only admins can add or change locations.</p>
      )}
      <Dialogs />
    </>
  );
}
