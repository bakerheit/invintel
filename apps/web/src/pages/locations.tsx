import type { Location } from "@invintel/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { Dialogs } from "@/components/dialogs";
import { Button, buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { invalidateOrg, isAdmin, useCurrentOrg, useLocations } from "@/lib/org";
import { useUi } from "@/stores/ui";

export default function LocationsPage() {
  const org = useCurrentOrg();
  const qc = useQueryClient();
  const openDialog = useUi((s) => s.openDialog);
  const { data: locations = [], isLoading, error } = useLocations(org.id);
  const admin = isAdmin(org.role);

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteLocation(org.id, id),
    onSuccess: () => invalidateOrg(qc, org.id),
    onError: (e: Error) => alert(e.message),
  });
  const onDelete = (l: Location) => {
    if (confirm(`Delete the location "${l.name}"?`)) remove.mutate(l.id);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <p className="text-sm text-muted-foreground">
          Places that hold stock: warehouses, shelves, trucks, anything you track separately.
        </p>
        {admin && <Button onClick={() => openDialog({ kind: "create-location" })}>New location</Button>}
      </div>

      {error ? (
        <p className="text-destructive">Couldn't load locations: {error.message}</p>
      ) : isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Items</TableHead>
                <TableHead>Units</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {locations.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="font-medium">{l.name}</TableCell>
                  <TableCell className="text-muted-foreground">{l.description}</TableCell>
                  <TableCell>{l.skuCount}</TableCell>
                  <TableCell>{l.unitCount}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Link
                        to={`/o/${org.id}?location=${l.id}`}
                        className={buttonVariants({ variant: "outline", size: "sm" })}
                      >
                        View stock
                      </Link>
                      {admin && (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => openDialog({ kind: "edit-location", location: l })}>
                            Edit
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => onDelete(l)}>
                            Delete
                          </Button>
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {!locations.length && (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                    No locations yet. {admin ? "Add one to start storing stock." : "Ask an admin to add one."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
      {!admin && <p className="text-sm text-muted-foreground">Only admins can add or change locations.</p>}
      <Dialogs />
    </div>
  );
}
