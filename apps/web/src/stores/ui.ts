import type { ActivityEntry, Item, Location } from "@invintel/shared";
import { create } from "zustand";

type Dialog =
  | { kind: "none" }
  | { kind: "create-item" }
  | { kind: "edit-item"; item: Item }
  | { kind: "adjust"; item: Item; locationId?: string }
  | { kind: "transfer"; item: Item }
  | { kind: "create-location"; parentId?: string }
  | { kind: "edit-location"; location: Location }
  | { kind: "reverse"; entry: ActivityEntry };

interface UiState {
  search: string;
  lowStockOnly: boolean;
  dialog: Dialog;
  setSearch: (search: string) => void;
  setLowStockOnly: (value: boolean) => void;
  openDialog: (dialog: Exclude<Dialog, { kind: "none" }>) => void;
  closeDialog: () => void;
}

export const useUi = create<UiState>((set) => ({
  search: "",
  lowStockOnly: false,
  dialog: { kind: "none" },
  setSearch: (search) => set({ search }),
  setLowStockOnly: (lowStockOnly) => set({ lowStockOnly }),
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: { kind: "none" } }),
}));
