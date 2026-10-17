import type { Item, Location } from "@invintel/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { centsToDollars, dollarsToCents } from "@/lib/format";
import { invalidateOrg, useCurrentOrg, useLocations } from "@/lib/org";
import { useUi } from "@/stores/ui";

function Field({ label, name, defaultValue, type = "text", required, min, step }: {
  label: string;
  name: string;
  defaultValue?: string | number;
  type?: string;
  required?: boolean;
  min?: number;
  step?: string;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} type={type} defaultValue={defaultValue} required={required} min={min} step={step} />
    </div>
  );
}

function LocationSelect({ label, value, onChange, locations }: {
  label: string;
  value: string;
  onChange: (id: string) => void;
  locations: { id: string; name: string; hint?: string }[];
}) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      <Select
        value={value}
        onValueChange={(v) => v && onChange(v)}
        items={locations.map((l) => ({ value: l.id, label: l.hint ? `${l.name} (${l.hint})` : l.name }))}
      >
        <SelectTrigger aria-label={label}>
          <SelectValue placeholder="Choose a location" />
        </SelectTrigger>
        <SelectContent>
          {locations.map((l) => (
            <SelectItem key={l.id} value={l.id}>
              {l.name}
              {l.hint ? ` (${l.hint})` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Shared submit plumbing: runs the mutation, refreshes the org's data, closes on success. */
function useSubmit<T>(run: (form: FormData) => Promise<T>) {
  const qc = useQueryClient();
  const { id: orgId } = useCurrentOrg();
  const close = useUi((s) => s.closeDialog);
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: run,
    onSuccess: async () => {
      await invalidateOrg(qc, orgId);
      close();
    },
    onError: (e: Error) => setError(e.message),
  });
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    mutation.mutate(new FormData(e.currentTarget));
  };
  return { onSubmit, error, pending: mutation.isPending, close };
}

function FormShell({ onSubmit, error, pending, close, submitLabel, children }: {
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  error: string | null;
  pending: boolean;
  close: () => void;
  submitLabel: string;
  children: ReactNode;
}) {
  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      {children}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={close}>Cancel</Button>
        <Button type="submit" disabled={pending}>{submitLabel}</Button>
      </DialogFooter>
    </form>
  );
}

const text = (form: FormData, key: string) => String(form.get(key) ?? "");

function ItemForm({ item, locations }: { item?: Item; locations: Location[] }) {
  const { id: orgId } = useCurrentOrg();
  const [locationId, setLocationId] = useState(locations[0]?.id ?? "");
  const submit = useSubmit((form) => {
    const base = {
      sku: text(form, "sku"),
      name: text(form, "name"),
      description: text(form, "description"),
      category: text(form, "category"),
      reorderLevel: Number(text(form, "reorderLevel") || 0),
      unitCostCents: dollarsToCents(text(form, "unitCost")),
    };
    if (item) return api.updateItem(orgId, item.id, base);
    const quantity = Number(text(form, "quantity") || 0);
    return api.createItem(orgId, { ...base, ...(quantity > 0 && locationId ? { initialStock: { locationId, quantity } } : {}) });
  });

  return (
    <FormShell {...submit} submitLabel={item ? "Save" : "Create"}>
      <div className="grid grid-cols-2 gap-4">
        <Field label="SKU" name="sku" defaultValue={item?.sku} required />
        <Field label="Name" name="name" defaultValue={item?.name} required />
        <Field label="Category" name="category" defaultValue={item?.category} />
        <Field label="Reorder level" name="reorderLevel" type="number" min={0} defaultValue={item?.reorderLevel ?? 0} />
        <Field label="Unit cost ($)" name="unitCost" type="number" min={0} step="0.01" defaultValue={centsToDollars(item?.unitCostCents ?? 0)} />
      </div>
      <Field label="Description" name="description" defaultValue={item?.description} />
      {!item && (
        <div className="grid grid-cols-2 gap-4">
          <Field label="Starting quantity" name="quantity" type="number" min={0} defaultValue={0} />
          <LocationSelect label="Stored at" value={locationId} onChange={setLocationId} locations={locations} />
        </div>
      )}
    </FormShell>
  );
}

function AdjustForm({ item, locations, locationId: preferred }: { item: Item; locations: Location[]; locationId?: string }) {
  const { id: orgId } = useCurrentOrg();
  const held = (id: string) => item.stock.find((s) => s.locationId === id)?.quantity ?? 0;
  const [locationId, setLocationId] = useState(
    preferred ?? item.stock[0]?.locationId ?? locations[0]?.id ?? "",
  );
  const submit = useSubmit((form) =>
    api.adjustStock(orgId, item.id, {
      locationId,
      delta: Number(form.get("delta")),
      reason: text(form, "reason"),
    }),
  );

  return (
    <FormShell {...submit} submitLabel="Apply">
      <p className="text-sm text-muted-foreground">
        {item.name}: {item.quantity} in stock in total. Use a negative number to remove stock.
      </p>
      <LocationSelect
        label="Location"
        value={locationId}
        onChange={setLocationId}
        locations={locations.map((l) => ({ id: l.id, name: l.name, hint: `${held(l.id)} here` }))}
      />
      <Field label="Change" name="delta" type="number" defaultValue={1} required />
      <Field label="Reason" name="reason" />
    </FormShell>
  );
}

function TransferForm({ item, locations }: { item: Item; locations: Location[] }) {
  const { id: orgId } = useCurrentOrg();
  const held = (id: string) => item.stock.find((s) => s.locationId === id)?.quantity ?? 0;
  const sources = locations.filter((l) => held(l.id) > 0);
  const [from, setFrom] = useState(sources[0]?.id ?? "");
  const [to, setTo] = useState(locations.find((l) => l.id !== sources[0]?.id)?.id ?? "");
  const submit = useSubmit((form) =>
    api.transferStock(orgId, item.id, {
      fromLocationId: from,
      toLocationId: to,
      quantity: Number(form.get("quantity")),
      reason: text(form, "reason"),
    }),
  );

  if (!sources.length) {
    return <p className="text-sm text-muted-foreground">{item.name} has no stock to move yet. Add some first.</p>;
  }
  return (
    <FormShell {...submit} submitLabel="Move">
      <div className="grid grid-cols-2 gap-4">
        <LocationSelect
          label="From"
          value={from}
          onChange={setFrom}
          locations={sources.map((l) => ({ id: l.id, name: l.name, hint: `${held(l.id)} here` }))}
        />
        <LocationSelect
          label="To"
          value={to}
          onChange={setTo}
          locations={locations.filter((l) => l.id !== from)}
        />
      </div>
      <Field label="Quantity" name="quantity" type="number" min={1} defaultValue={1} required />
      <Field label="Note" name="reason" />
    </FormShell>
  );
}

function LocationForm({ location }: { location?: Location }) {
  const { id: orgId } = useCurrentOrg();
  const submit = useSubmit((form) => {
    const input = { name: text(form, "name"), description: text(form, "description") };
    return location ? api.updateLocation(orgId, location.id, input) : api.createLocation(orgId, input);
  });
  return (
    <FormShell {...submit} submitLabel={location ? "Save" : "Create"}>
      <Field label="Name" name="name" defaultValue={location?.name} required />
      <Field label="Description" name="description" defaultValue={location?.description} />
    </FormShell>
  );
}

const TITLES = {
  "create-item": "New item",
  "edit-item": "Edit item",
  adjust: "Adjust stock",
  transfer: "Move stock",
  "create-location": "New location",
  "edit-location": "Edit location",
} as const;

export function Dialogs() {
  const { dialog, closeDialog } = useUi();
  const { id: orgId } = useCurrentOrg();
  const { data: locations = [] } = useLocations(orgId);

  return (
    <Dialog open={dialog.kind !== "none"} onOpenChange={(open) => !open && closeDialog()}>
      <DialogContent>
        {dialog.kind !== "none" && (
          <>
            <DialogHeader>
              <DialogTitle>{TITLES[dialog.kind]}</DialogTitle>
            </DialogHeader>
            {dialog.kind === "create-item" && <ItemForm locations={locations} />}
            {dialog.kind === "edit-item" && <ItemForm key={dialog.item.id} item={dialog.item} locations={locations} />}
            {dialog.kind === "adjust" && (
              <AdjustForm key={dialog.item.id} item={dialog.item} locations={locations} locationId={dialog.locationId} />
            )}
            {dialog.kind === "transfer" && <TransferForm key={dialog.item.id} item={dialog.item} locations={locations} />}
            {dialog.kind === "create-location" && <LocationForm />}
            {dialog.kind === "edit-location" && <LocationForm key={dialog.location.id} location={dialog.location} />}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
