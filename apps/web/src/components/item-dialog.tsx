import type { Item } from "@invintel/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { centsToDollars, dollarsToCents } from "@/lib/format";
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

function ItemForm({ item }: { item?: Item }) {
  const qc = useQueryClient();
  const close = useUi((s) => s.closeDialog);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (form: FormData) => {
      const text = (k: string) => String(form.get(k) ?? "");
      const base = {
        sku: text("sku"),
        name: text("name"),
        description: text("description"),
        category: text("category"),
        location: text("location"),
        reorderLevel: Number(text("reorderLevel") || 0),
        unitCostCents: dollarsToCents(text("unitCost")),
      };
      return item
        ? api.updateItem(item.id, base)
        : api.createItem({ ...base, quantity: Number(text("quantity") || 0) });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["items"] });
      close();
    },
    onError: (e: Error) => setError(e.message),
  });

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    save.mutate(new FormData(e.currentTarget));
  };

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <div className="grid grid-cols-2 gap-4">
        <Field label="SKU" name="sku" defaultValue={item?.sku} required />
        <Field label="Name" name="name" defaultValue={item?.name} required />
        <Field label="Category" name="category" defaultValue={item?.category} />
        <Field label="Location" name="location" defaultValue={item?.location} />
        {!item && <Field label="Starting quantity" name="quantity" type="number" min={0} defaultValue={0} />}
        <Field label="Reorder level" name="reorderLevel" type="number" min={0} defaultValue={item?.reorderLevel ?? 0} />
        <Field label="Unit cost ($)" name="unitCost" type="number" min={0} step="0.01" defaultValue={centsToDollars(item?.unitCostCents ?? 0)} />
      </div>
      <Field label="Description" name="description" defaultValue={item?.description} />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={close}>Cancel</Button>
        <Button type="submit" disabled={save.isPending}>{item ? "Save" : "Create"}</Button>
      </DialogFooter>
    </form>
  );
}

function AdjustForm({ item }: { item: Item }) {
  const qc = useQueryClient();
  const close = useUi((s) => s.closeDialog);
  const [error, setError] = useState<string | null>(null);

  const adjust = useMutation({
    mutationFn: (form: FormData) =>
      api.adjustStock(item.id, {
        delta: Number(form.get("delta")),
        reason: String(form.get("reason") ?? ""),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["items"] });
      close();
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        adjust.mutate(new FormData(e.currentTarget));
      }}
      className="grid gap-4"
    >
      <p className="text-sm text-muted-foreground">
        {item.name} — currently {item.quantity} in stock. Use a negative number to remove stock.
      </p>
      <Field label="Change" name="delta" type="number" defaultValue={1} required />
      <Field label="Reason" name="reason" />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={close}>Cancel</Button>
        <Button type="submit" disabled={adjust.isPending}>Apply</Button>
      </DialogFooter>
    </form>
  );
}

export function ItemDialogs() {
  const { dialog, closeDialog } = useUi();
  const titles = { create: "New item", edit: "Edit item", adjust: "Adjust stock" } as const;

  return (
    <Dialog open={dialog.kind !== "none"} onOpenChange={(open) => !open && closeDialog()}>
      <DialogContent>
        {dialog.kind !== "none" && (
          <>
            <DialogHeader>
              <DialogTitle>{titles[dialog.kind]}</DialogTitle>
            </DialogHeader>
            {dialog.kind === "create" && <ItemForm />}
            {dialog.kind === "edit" && <ItemForm key={dialog.item.id} item={dialog.item} />}
            {dialog.kind === "adjust" && <AdjustForm key={dialog.item.id} item={dialog.item} />}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
