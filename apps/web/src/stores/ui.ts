import type { Item } from "@invintel/shared";
import { create } from "zustand";

type Dialog =
  | { kind: "none" }
  | { kind: "create" }
  | { kind: "edit"; item: Item }
  | { kind: "adjust"; item: Item };

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
