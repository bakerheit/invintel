import { LOCATION_TYPES, type ActivityEntry, type Item, type Location, type LocationType } from "@invintel/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { type FormEvent, type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { centsToDollars, dollarsToCents } from "@/lib/format";
import { BarcodeField } from "@/components/barcode-field";
import { LOCATION_TYPE_META, withDescendants } from "@/lib/locations";
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

/** Option list for LocationSelect: shows the full path so nested places are unambiguous. */
const locationOptions = (locations: Location[], hint?: (id: string) => string) =>
  locations.map((l) => ({ id: l.id, name: l.path, hint: hint?.(l.id) }));

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
        <SelectTrigger aria-label={label} className="w-full">
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
function useSubmit<T>(run: (form: FormData) => Promise<T>, successMessage: string) {
  const qc = useQueryClient();
  const { id: orgId } = useCurrentOrg();
  const close = useUi((s) => s.closeDialog);
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: run,
    onSuccess: async () => {
      await invalidateOrg(qc, orgId);
      toast.success(successMessage);
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

function ItemForm({ item, locations, initialBarcode }: { item?: Item; locations: Location[]; initialBarcode?: string }) {
  const { id: orgId } = useCurrentOrg();
  const [locationId, setLocationId] = useState(locations[0]?.id ?? "");
  const [barcodes, setBarcodes] = useState<string[]>(item?.barcodes ?? (initialBarcode ? [initialBarcode] : []));
  // Many small shops use the product barcode as the SKU, so a blank SKU takes the first code scanned.
  const [sku, setSku] = useState(item?.sku ?? initialBarcode ?? "");
  const [tracking, setTracking] = useState<"quantity" | "unit">(item?.tracking ?? "quantity");
  // Switching how an item is counted is only safe while nothing is in stock.
  const canChangeTracking = !item || item.quantity === 0;
  const submit = useSubmit((form) => {
    const base = {
      sku: sku.trim(),
      name: text(form, "name"),
      description: text(form, "description"),
      category: text(form, "category"),
      reorderLevel: Number(text(form, "reorderLevel") || 0),
      unitCostCents: dollarsToCents(text(form, "unitCost")),
      barcodes,
      ...(canChangeTracking ? { tracking } : {}),
    };
    if (item) return api.updateItem(orgId, item.id, base);
    const quantity = Number(text(form, "quantity") || 0);
    return api.createItem(orgId, { ...base, ...(tracking === "quantity" && quantity > 0 && locationId ? { initialStock: { locationId, quantity } } : {}) });
  }, item ? "Changes saved" : "Item created");

  return (
    <FormShell {...submit} submitLabel={item ? "Save" : "Create"}>
      <div className="grid grid-cols-2 gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="sku">SKU</Label>
          <Input id="sku" name="sku" value={sku} onChange={(e) => setSku(e.target.value)} required />
        </div>
        <Field label="Name" name="name" defaultValue={item?.name} required />
        <Field label="Category" name="category" defaultValue={item?.category} />
        <Field label="Reorder level" name="reorderLevel" type="number" min={0} defaultValue={item?.reorderLevel ?? 0} />
        <Field label="Unit cost ($)" name="unitCost" type="number" min={0} step="0.01" defaultValue={centsToDollars(item?.unitCostCents ?? 0)} />
      </div>
      <BarcodeField
        value={barcodes}
        onChange={setBarcodes}
        selfId={item?.id}
        onAdded={(code, first) => {
          if (first && !sku.trim()) setSku(code);
        }}
      />
      <Field label="Description" name="description" defaultValue={item?.description} />
      <div className="grid gap-1.5">
        <Label>How is it counted?</Label>
        <Select
          value={tracking}
          onValueChange={(v) => v && setTracking(v as "quantity" | "unit")}
          disabled={!canChangeTracking}
          items={[
            { value: "quantity", label: "By quantity (bolts, boxes, gloves)" },
            { value: "unit", label: "By roll or pallet (each one has its own label)" },
          ]}
        >
          <SelectTrigger aria-label="How is it counted?" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="quantity">By quantity (bolts, boxes, gloves)</SelectItem>
            <SelectItem value="unit">By roll or pallet (each one has its own label)</SelectItem>
          </SelectContent>
        </Select>
        {!canChangeTracking && <p className="text-xs text-muted-foreground">Can't change while it has stock.</p>}
      </div>
      {!item && tracking === "quantity" && (
        <div className="grid grid-cols-2 gap-4">
          <Field label="Starting quantity" name="quantity" type="number" min={0} defaultValue={0} />
          <LocationSelect label="Stored at" value={locationId} onChange={setLocationId} locations={locationOptions(locations)} />
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
    "Stock updated",
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
        locations={locationOptions(locations, (id) => `${held(id)} here`)}
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
    "Stock moved",
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
          locations={locationOptions(sources, (id) => `${held(id)} here`)}
        />
        <LocationSelect
          label="To"
          value={to}
          onChange={setTo}
          locations={locationOptions(locations.filter((l) => l.id !== from))}
        />
      </div>
      <Field label="Quantity" name="quantity" type="number" min={1} defaultValue={1} required />
      <Field label="Note" name="reason" />
    </FormShell>
  );
}

const NO_PARENT = "__none__";

function LocationForm({ location, parentId: presetParent, locations }: { location?: Location; parentId?: string; locations: Location[] }) {
  const { id: orgId } = useCurrentOrg();
  const [type, setType] = useState<LocationType>(location?.type ?? "storage");
  const [parentId, setParentId] = useState<string>(location?.parentId ?? presetParent ?? NO_PARENT);
  // A location can't be moved inside itself or anything in it.
  const blocked = new Set(location ? withDescendants(locations, location.id) : []);
  const parents = locations.filter((l) => !blocked.has(l.id));

  const submit = useSubmit((form) => {
    const input = {
      name: text(form, "name"),
      description: text(form, "description"),
      code: text(form, "code"),
      type,
      parentId: parentId === NO_PARENT ? null : parentId,
    };
    return location ? api.updateLocation(orgId, location.id, input) : api.createLocation(orgId, input);
  }, location ? "Location updated" : "Location created");

  return (
    <FormShell {...submit} submitLabel={location ? "Save" : "Create"}>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Name" name="name" defaultValue={location?.name} required />
        <Field label="Code (for scanning)" name="code" defaultValue={location?.code} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="grid gap-1.5">
          <Label>Type</Label>
          <Select
            value={type}
            onValueChange={(v) => v && setType(v as LocationType)}
            items={LOCATION_TYPES.map((t) => ({ value: t, label: LOCATION_TYPE_META[t].label }))}
          >
            <SelectTrigger aria-label="Type" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LOCATION_TYPES.map((t) => (
                <SelectItem key={t} value={t}>{LOCATION_TYPE_META[t].label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label>Inside</Label>
          <Select
            value={parentId}
            onValueChange={(v) => v && setParentId(v)}
            items={[{ value: NO_PARENT, label: "Top level" }, ...parents.map((l) => ({ value: l.id, label: l.path }))]}
          >
            <SelectTrigger aria-label="Inside" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_PARENT}>Top level</SelectItem>
              {parents.map((l) => (
                <SelectItem key={l.id} value={l.id}>{l.path}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">{LOCATION_TYPE_META[type].hint}.</p>
      <Field label="Description" name="description" defaultValue={location?.description} />
    </FormShell>
  );
}

function ReverseForm({ entry }: { entry: ActivityEntry }) {
  const { id: orgId } = useCurrentOrg();
  const submit = useSubmit(
    (form) => api.reverseMovement(orgId, entry.id, { reason: text(form, "reason") }),
    "Entry reversed",
  );
  const what =
    entry.type === "transfer"
      ? "Both halves of this transfer will be undone."
      : entry.delta > 0
        ? `${entry.delta} will be taken back out of ${entry.locationPath}.`
        : `${-entry.delta} will be put back into ${entry.locationPath}.`;
  return (
    <FormShell {...submit} submitLabel="Reverse entry">
      <div className="rounded-lg border bg-muted/40 p-3 text-sm">
        <p className="font-medium">{entry.itemName}</p>
        <p className="text-muted-foreground">
          {entry.delta > 0 ? "+" : ""}
          {entry.delta} at {entry.locationPath}. {what}
        </p>
      </div>
      <p className="text-sm text-muted-foreground">
        The original entry stays in the history. A matching reversal is added next to it.
      </p>
      <Field label="Why? (optional)" name="reason" />
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
  reverse: "Reverse entry",
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
            {dialog.kind === "create-item" && <ItemForm key={dialog.barcode ?? "new"} locations={locations} initialBarcode={dialog.barcode} />}
            {dialog.kind === "edit-item" && <ItemForm key={dialog.item.id} item={dialog.item} locations={locations} />}
            {dialog.kind === "adjust" && (
              <AdjustForm key={dialog.item.id} item={dialog.item} locations={locations} locationId={dialog.locationId} />
            )}
            {dialog.kind === "transfer" && <TransferForm key={dialog.item.id} item={dialog.item} locations={locations} />}
            {dialog.kind === "create-location" && <LocationForm parentId={dialog.parentId} locations={locations} />}
            {dialog.kind === "edit-location" && (
              <LocationForm key={dialog.location.id} location={dialog.location} locations={locations} />
            )}
            {dialog.kind === "reverse" && <ReverseForm key={dialog.entry.id} entry={dialog.entry} />}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
