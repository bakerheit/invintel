import type { AdjustmentInput, Item, ItemInput, ItemUpdate, StockMovement } from "@invintel/shared";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? (data.success === false ? "Invalid input" : res.statusText));
  return data as T;
}

const body = (value: unknown) => JSON.stringify(value);

export const api = {
  listItems: () => request<Item[]>("/items"),
  createItem: (input: Partial<ItemInput> & Pick<ItemInput, "sku" | "name">) =>
    request<Item>("/items", { method: "POST", body: body(input) }),
  updateItem: (id: number, patch: ItemUpdate) =>
    request<Item>(`/items/${id}`, { method: "PATCH", body: body(patch) }),
  deleteItem: (id: number) => request<void>(`/items/${id}`, { method: "DELETE" }),
  adjustStock: (id: number, input: Partial<AdjustmentInput> & Pick<AdjustmentInput, "delta">) =>
    request<Item>(`/items/${id}/adjust`, { method: "POST", body: body(input) }),
  listMovements: (id: number) => request<StockMovement[]>(`/items/${id}/movements`),
};
