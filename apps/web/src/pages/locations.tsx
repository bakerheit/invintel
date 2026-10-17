import type { Location } from "@invintel/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, MapPin, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { Link } from "react-router";
import { toast } from "sonner";
import { useConfirm } from "@/components/confirm";
import { Dialogs } from "@/components/dialogs";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { invalidateOrg, isAdmin, useCurrentOrg, useLocations } from "@/lib/org";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";

function LocationCard({ location, orgId, admin, onEdit, onDelete }: {
  location: Location;
  orgId: string;
  admin: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <Card className="gap-4 p-5">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
          <MapPin className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold">{location.name}</h2>
          <p className="line-clamp-2 min-h-10 text-sm text-muted-foreground">
            {location.description || "No description"}
          </p>
        </div>
        {admin && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${location.name}`} />}
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-40">
              <DropdownMenuItem onClick={onEdit}>
                <Pencil /> Edit
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash2 /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 rounded-lg bg-muted/50 p-3">
        <div>
          <div className="text-xl font-semibold tabular-nums">{location.skuCount.toLocaleString()}</div>
          <div className="text-xs text-muted-foreground">{location.skuCount === 1 ? "Item" : "Items"}</div>
        </div>
        <div>
          <div className="text-xl font-semibold tabular-nums">{location.unitCount.toLocaleString()}</div>
          <div className="text-xs text-muted-foreground">{location.unitCount === 1 ? "Unit" : "Units"}</div>
        </div>
      </div>
      <Link
        to={`/o/${orgId}?location=${location.id}`}
        className={cn(buttonVariants({ variant: "outline" }), "w-full justify-between")}
      >
        View stock <ArrowRight />
      </Link>
    </Card>
  );
}

export default function LocationsPage() {
  const org = useCurrentOrg();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const openDialog = useUi((s) => s.openDialog);
  const { data: locations = [], isLoading, error } = useLocations(org.id);
  const admin = isAdmin(org.role);

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
      description: "Locations that still hold stock can't be deleted. Move the stock somewhere else first.",
      confirmLabel: "Delete location",
      destructive: true,
    });
    if (ok) remove.mutate(l);
  };

  return (
    <>
      <PageHeader
        title="Locations"
        description="Warehouses, shelves, trucks: anywhere you keep stock and want to count it separately."
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
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-56 rounded-xl" />
          ))}
        </div>
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
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {locations.map((l) => (
            <LocationCard
              key={l.id}
              location={l}
              orgId={org.id}
              admin={admin}
              onEdit={() => openDialog({ kind: "edit-location", location: l })}
              onDelete={() => void onDelete(l)}
            />
          ))}
        </div>
      )}
      {!admin && !!locations.length && (
        <p className="text-sm text-muted-foreground">Only admins can add or change locations.</p>
      )}
      <Dialogs />
    </>
  );
}
