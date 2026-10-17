import type {
  AdjustmentInput,
  Item,
  ItemInput,
  ItemUpdate,
  LoginInput,
  RegisterInput,
  StockMovement,
  User,
} from "@invintel/shared";

let onUnauthorized: () => void = () => {};
/** The auth store registers itself here so any 401 drops the user back to the login page. */
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

const errorMessage = (data: unknown, fallback: string): string => {
  const err = (data as { error?: unknown })?.error;
  if (typeof err === "string") return err;
  // Validation failures come back as a serialized Zod error.
  const message = (err as { message?: unknown })?.message;
  if (typeof message === "string") {
    try {
      const issues = JSON.parse(message);
      if (Array.isArray(issues) && typeof issues[0]?.message === "string") return issues[0].message;
    } catch {
      /* not JSON, fall through */
    }
  }
  return fallback;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth/")) onUnauthorized();
    throw new Error(errorMessage(data, res.statusText || "Request failed"));
  }
  return data as T;
}

const body = (value: unknown) => JSON.stringify(value);

export const api = {
  me: () => request<User>("/auth/me"),
  authConfig: () => request<{ registrationOpen: boolean }>("/auth/config"),
  login: (input: LoginInput) => request<User>("/auth/login", { method: "POST", body: body(input) }),
  register: (input: RegisterInput) =>
    request<User>("/auth/register", { method: "POST", body: body(input) }),
  logout: () => request<void>("/auth/logout", { method: "POST" }),

  listItems: () => request<Item[]>("/items"),
  createItem: (input: Partial<ItemInput> & Pick<ItemInput, "sku" | "name">) =>
    request<Item>("/items", { method: "POST", body: body(input) }),
  updateItem: (id: string, patch: ItemUpdate) =>
    request<Item>(`/items/${id}`, { method: "PATCH", body: body(patch) }),
  deleteItem: (id: string) => request<void>(`/items/${id}`, { method: "DELETE" }),
  adjustStock: (id: string, input: Partial<AdjustmentInput> & Pick<AdjustmentInput, "delta">) =>
    request<Item>(`/items/${id}/adjust`, { method: "POST", body: body(input) }),
  listMovements: (id: string) => request<StockMovement[]>(`/items/${id}/movements`),
};
