import type {
  ActivityPage,
  AdjustUnitInput,
  MoveUnitInput,
  ReceiveUnitsInput,
  UnitsPage,
  UnitsPosted,
  AuditPage,
  AuditVerification,
  ImportInput,
  ImportResult,
  Overview,
  AdjustmentInput,
  Item,
  ItemCreate,
  ItemUpdate,
  Location,
  LocationInput,
  LocationUpdate,
  LoginInput,
  LookupResult,
  MoveInput,
  MovementType,
  OrganizationInput,
  OrgMember,
  OrgSummary,
  RegisterInput,
  PostedDocument,
  ReceiveInput,
  RegisterResult,
  StockMovement,
  TransferInput,
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
const post = (value?: unknown): RequestInit => ({ method: "POST", body: value === undefined ? undefined : body(value) });
const patch = (value: unknown): RequestInit => ({ method: "PATCH", body: body(value) });

export const api = {
  me: () => request<User>("/auth/me"),
  authConfig: () => request<{ registrationOpen: boolean }>("/auth/config"),
  login: (input: LoginInput) => request<User>("/auth/login", post(input)),
  register: (input: RegisterInput) => request<RegisterResult>("/auth/register", post(input)),
  logout: () => request<void>("/auth/logout", post()),

  listOrgs: () => request<OrgSummary[]>("/orgs"),
  createOrg: (input: OrganizationInput) => request<OrgSummary>("/orgs", post(input)),
  joinOrg: (input: { joinCode: string }) => request<OrgSummary>("/orgs/join", post(input)),
  renameOrg: (orgId: string, input: OrganizationInput) => request<OrgSummary>(`/orgs/${orgId}`, patch(input)),
  rotateJoinCode: (orgId: string) => request<OrgSummary>(`/orgs/${orgId}/join-code`, post()),
  listMembers: (orgId: string) => request<OrgMember[]>(`/orgs/${orgId}/members`),
  setMemberRole: (orgId: string, userId: string, role: "admin" | "member") =>
    request<{ userId: string; role: string }>(`/orgs/${orgId}/members/${userId}`, patch({ role })),
  removeMember: (orgId: string, userId: string) =>
    request<void>(`/orgs/${orgId}/members/${userId}`, { method: "DELETE" }),

  importItems: async (orgId: string, input: ImportInput): Promise<ImportResult> => {
    // A refused import (422) still carries the per-row report, so show that instead of a bare error.
    const res = await fetch(`/api/orgs/${orgId}/data/items/import`, {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok || (res.status === 422 && Array.isArray(data.rows))) return data as ImportResult;
    throw new Error(typeof data.error === "string" ? data.error : "Import failed");
  },
  itemsCsvUrl: (orgId: string) => `/api/orgs/${orgId}/data/items.csv`,
  overview: (orgId: string) => request<Overview>(`/orgs/${orgId}/overview`),

  listLocations: (orgId: string) => request<Location[]>(`/orgs/${orgId}/locations`),
  createLocation: (orgId: string, input: Partial<LocationInput> & Pick<LocationInput, "name">) =>
    request<Location>(`/orgs/${orgId}/locations`, post(input)),
  updateLocation: (orgId: string, id: string, input: LocationUpdate) =>
    request<Location>(`/orgs/${orgId}/locations/${id}`, patch(input)),
  deleteLocation: (orgId: string, id: string) =>
    request<void>(`/orgs/${orgId}/locations/${id}`, { method: "DELETE" }),

  listItems: (orgId: string) => request<Item[]>(`/orgs/${orgId}/items`),
  createItem: (orgId: string, input: Partial<ItemCreate> & Pick<ItemCreate, "sku" | "name">) =>
    request<Item>(`/orgs/${orgId}/items`, post(input)),
  updateItem: (orgId: string, id: string, input: ItemUpdate) =>
    request<Item>(`/orgs/${orgId}/items/${id}`, patch(input)),
  deleteItem: (orgId: string, id: string) =>
    request<void>(`/orgs/${orgId}/items/${id}`, { method: "DELETE" }),
  adjustStock: (orgId: string, id: string, input: Partial<AdjustmentInput> & Pick<AdjustmentInput, "locationId" | "delta">) =>
    request<Item>(`/orgs/${orgId}/items/${id}/adjust`, post(input)),
  transferStock: (orgId: string, id: string, input: Partial<TransferInput> & Pick<TransferInput, "fromLocationId" | "toLocationId" | "quantity">) =>
    request<Item>(`/orgs/${orgId}/items/${id}/transfer`, post(input)),
  listMovements: (orgId: string, id: string) =>
    request<StockMovement[]>(`/orgs/${orgId}/items/${id}/movements`),

  activity: (orgId: string, params: { itemId?: string; locationId?: string; type?: MovementType; q?: string; before?: string }) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    return request<ActivityPage>(`/orgs/${orgId}/movements?${qs}`);
  },
  reverseMovement: (orgId: string, id: string, input: { reason?: string }) =>
    request<{ reversedIds: string[]; movementIds: string[] }>(`/orgs/${orgId}/movements/${id}/reverse`, post(input)),

  auditLog: (orgId: string, params: { entityId?: string; action?: string; actorId?: string; q?: string; before?: number }) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
    return request<AuditPage>(`/orgs/${orgId}/audit?${qs}`);
  },
  verifyAudit: (orgId: string) => request<AuditVerification>(`/orgs/${orgId}/audit/verify`),

  listUnits: (orgId: string, params: { itemId?: string; locationId?: string; status?: string; q?: string; ids?: string; before?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
    return request<UnitsPage>(`/orgs/${orgId}/units?${qs}`);
  },
  receiveUnits: (orgId: string, input: Partial<ReceiveUnitsInput> & Pick<ReceiveUnitsInput, "itemId" | "locationId" | "quantity">) =>
    request<UnitsPosted>(`/orgs/${orgId}/units`, post(input)),
  moveUnit: (orgId: string, id: string, input: Partial<MoveUnitInput> & Pick<MoveUnitInput, "toLocationId">) =>
    request<UnitsPosted>(`/orgs/${orgId}/units/${id}/move`, post(input)),
  adjustUnit: (orgId: string, id: string, input: Partial<AdjustUnitInput> & Pick<AdjustUnitInput, "delta">) =>
    request<UnitsPosted>(`/orgs/${orgId}/units/${id}/adjust`, post(input)),

  lookup: (orgId: string, code: string) =>
    request<LookupResult>(`/orgs/${orgId}/lookup?code=${encodeURIComponent(code)}`),
  receive: (orgId: string, input: Partial<ReceiveInput> & Pick<ReceiveInput, "itemId" | "locationId" | "quantity">) =>
    request<PostedDocument>(`/orgs/${orgId}/receipts`, post(input)),
  move: (orgId: string, input: Partial<MoveInput> & Pick<MoveInput, "itemId" | "fromLocationId" | "toLocationId" | "quantity">) =>
    request<PostedDocument>(`/orgs/${orgId}/moves`, post(input)),
};
