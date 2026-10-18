import type {
  B2BAckInput,
  B2BMessage,
  B2BMessageDetail,
  CapturedInvoice,
  CapturedInvoiceUpdate,
  InvoiceUpload,
  OrderExchange,
  PortalOrder,
  SupplierAnswer,
  TradingPartner,
  TradingPartnerInput,
  TradingPartnerUpdate,
  RecallDrill,
  TraceQuery,
  TraceResult,
  ScrapReport,
  DisposeInput,
  HoldInput,
  Ncr,
  NcrSummary,
  Reasons,
  ReasonsUpdate,
  Alert,
  AlertSettings,
  AlertsResponse,
  DigestPreview,
  DowntimeEvent,
  DowntimeSettings,
  DowntimeSummary,
  ApprovalDecisionInput,
  ApprovalRequest,
  ApprovalRequired,
  ApprovalRule,
  AgingReport,
  CountAccuracyReport,
  CountScheduleReport,
  Count,
  CountListRow,
  Bom,
  BomInput,
  ConsumeInput,
  LoadInput,
  OutputInput,
  ProductionLookup,
  ProductionPosted,
  VarianceSummaryRow,
  WorkCenter,
  WorkCenterInput,
  WorkCenterUpdate,
  ProductionSettings,
  WorkOrder,
  WorkOrderAction,
  WorkOrderInput,
  WorkOrderVariance,
  ActivityPage,
  AdjustUnitInput,
  MoveUnitInput,
  ReceiveUnitsInput,
  UnitsPage,
  UnitsPosted,
  AuditPage,
  AuditVerification,
  ArchiveRestoreResult,
  ImportBatch,
  ImportInput,
  ImportUndoResult,
  PoReceiveInput,
  PoReceiveResult,
  PurchaseOrder,
  PurchaseOrderInput,
  ReorderSuggestion,
  Supplier,
  SupplierInput,
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
  OrgModules,
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

const traceParams = (q: TraceQuery) => new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString();

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
  setModules: (orgId: string, modules: Partial<OrgModules>) => request<OrgSummary>(`/orgs/${orgId}/modules`, patch(modules)),
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
  restoreArchive: async (orgId: string, archive: unknown, dryRun: boolean): Promise<ArchiveRestoreResult> => {
    const res = await fetch(`/api/orgs/${orgId}/data/archive/restore`, {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ archive, dryRun }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data as ArchiveRestoreResult;
    throw new Error(typeof data.error === "string" ? data.error : "Restore failed");
  },
  listImports: (orgId: string) => request<ImportBatch[]>(`/orgs/${orgId}/data/imports`),
  undoImport: async (orgId: string, id: string): Promise<ImportUndoResult> => {
    // A refused undo says which items have been built on since, so carry that text through.
    const res = await fetch(`/api/orgs/${orgId}/data/imports/${id}/undo`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}" });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data as ImportUndoResult;
    const problems = Array.isArray(data.problems) ? ` ${data.problems.join(" ")}` : "";
    throw new Error(`${typeof data.error === "string" ? data.error : "Undo failed"}${problems}`);
  },
  listSuppliers: (orgId: string) => request<Supplier[]>(`/orgs/${orgId}/purchasing/suppliers`),
  createSupplier: (orgId: string, input: SupplierInput) => request<Supplier>(`/orgs/${orgId}/purchasing/suppliers`, post(input)),
  suggestions: (orgId: string) => request<ReorderSuggestion[]>(`/orgs/${orgId}/purchasing/suggestions`),
  listOrders: (orgId: string) => request<PurchaseOrder[]>(`/orgs/${orgId}/purchasing/orders`),
  createOrder: (orgId: string, input: PurchaseOrderInput) => request<PurchaseOrder>(`/orgs/${orgId}/purchasing/orders`, post(input)),
  orderFromSuggestions: (orgId: string, input: { supplierId: string; itemIds: string[] }) =>
    request<PurchaseOrder>(`/orgs/${orgId}/purchasing/orders/from-suggestions`, post(input)),
  orderAction: (orgId: string, id: string, action: "place" | "cancel" | "close") =>
    request<PurchaseOrder | ApprovalRequired>(`/orgs/${orgId}/purchasing/orders/${id}/${action}`, post({})),
  receiveOrder: (orgId: string, id: string, input: PoReceiveInput) =>
    request<PoReceiveResult>(`/orgs/${orgId}/purchasing/orders/${id}/receive`, post(input)),
  listCounts: (orgId: string) => request<CountListRow[]>(`/orgs/${orgId}/counts`),
  getCount: (orgId: string, id: string) => request<Count>(`/orgs/${orgId}/counts/${id}`),
  startCount: (orgId: string, locationId: string) => request<Count>(`/orgs/${orgId}/counts`, post({ locationId })),
  countItem: (orgId: string, id: string, itemId: string, counted: number) =>
    request<Count>(`/orgs/${orgId}/counts/${id}/lines`, { method: "PUT", body: body({ itemId, counted }) }),
  uncountItem: (orgId: string, id: string, itemId: string) =>
    request<Count>(`/orgs/${orgId}/counts/${id}/lines/${itemId}`, { method: "DELETE" }),
  postCount: (orgId: string, id: string, zeroUncounted: boolean) =>
    request<{ count: Count; adjustments: number; failures: string[] }>(`/orgs/${orgId}/counts/${id}/post`, post({ zeroUncounted })),
  cancelCount: (orgId: string, id: string) => request<Count>(`/orgs/${orgId}/counts/${id}/cancel`, post({})),
  agingReport: (orgId: string, locationId?: string) =>
    request<AgingReport>(`/orgs/${orgId}/reports/aging${locationId ? `?locationId=${locationId}` : ""}`),
  agingCsvUrl: (orgId: string, locationId?: string) => `/api/orgs/${orgId}/reports/aging.csv${locationId ? `?locationId=${locationId}` : ""}`,
  countAccuracy: (orgId: string) => request<CountAccuracyReport>(`/orgs/${orgId}/reports/count-accuracy`),
  countSchedule: (orgId: string) => request<CountScheduleReport>(`/orgs/${orgId}/reports/count-schedule`),
  approvalRules: (orgId: string) => request<{ rules: ApprovalRule[] }>(`/orgs/${orgId}/approvals/rules`),
  saveApprovalRules: (orgId: string, rules: ApprovalRule[]) => request<{ rules: ApprovalRule[] }>(`/orgs/${orgId}/approvals/rules`, { method: "PUT", body: body({ rules }) }),
  listApprovals: (orgId: string) => request<ApprovalRequest[]>(`/orgs/${orgId}/approvals`),
  pendingApprovals: (orgId: string) => request<{ count: number }>(`/orgs/${orgId}/approvals/pending-count`),
  decideApproval: (orgId: string, id: string, action: "approve" | "reject" | "cancel", input: ApprovalDecisionInput = {}) =>
    request<ApprovalRequest>(`/orgs/${orgId}/approvals/${id}/${action}`, post(input)),
  downtimeSettings: (orgId: string) => request<DowntimeSettings>(`/orgs/${orgId}/production/downtime/settings`),
  saveDowntimeSettings: (orgId: string, input: DowntimeSettings) => request<DowntimeSettings>(`/orgs/${orgId}/production/downtime/settings`, { method: "PUT", body: body(input) }),
  downtimeOpen: (orgId: string) => request<DowntimeEvent[]>(`/orgs/${orgId}/production/downtime?open=1`),
  downtimeEvents: (orgId: string) => request<DowntimeEvent[]>(`/orgs/${orgId}/production/downtime`),
  downtimeSummary: (orgId: string, days: number) => request<DowntimeSummary>(`/orgs/${orgId}/production/downtime/summary?days=${days}`),
  startDowntime: (orgId: string, workCenterId: string, reason: string, note = "") =>
    request<DowntimeEvent>(`/orgs/${orgId}/production/downtime/start`, post({ workCenterId, reason, note })),
  endDowntime: (orgId: string, id: string) => request<DowntimeEvent>(`/orgs/${orgId}/production/downtime/${id}/end`, post({})),
  alerts: (orgId: string) => request<AlertsResponse>(`/orgs/${orgId}/alerts`),
  alertDigest: (orgId: string) => request<DigestPreview>(`/orgs/${orgId}/alerts/digest`),
  alertSettings: (orgId: string) => request<AlertSettings>(`/orgs/${orgId}/alerts/settings`),
  saveAlertSettings: (orgId: string, s: AlertSettings) => request<AlertSettings>(`/orgs/${orgId}/alerts/settings`, { method: "PUT", body: body(s) }),
  alertAction: (orgId: string, action: "acknowledge" | "reopen" | { snooze: number }, key: string) =>
    typeof action === "string" ? request<Alert>(`/orgs/${orgId}/alerts/${action}`, post({ key })) : request<Alert>(`/orgs/${orgId}/alerts/snooze`, post({ key, days: action.snooze })),
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
    request<Item | ApprovalRequired>(`/orgs/${orgId}/items/${id}/adjust`, post(input)),
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

  // Production: work centers, BOMs, work orders, floor actions, variance.
  workCenters: (orgId: string) => request<WorkCenter[]>(`/orgs/${orgId}/production/work-centers`),
  createWorkCenter: (orgId: string, input: Partial<WorkCenterInput> & Pick<WorkCenterInput, "name" | "locationId">) =>
    request<WorkCenter>(`/orgs/${orgId}/production/work-centers`, post(input)),
  boms: (orgId: string, all = false) => request<Bom[]>(`/orgs/${orgId}/production/boms${all ? "?all=1" : ""}`),
  createBom: (orgId: string, input: Partial<BomInput> & Pick<BomInput, "outputItemId" | "inputs">) =>
    request<Bom>(`/orgs/${orgId}/production/boms`, post(input)),
  workOrders: (orgId: string, status?: string) =>
    request<WorkOrder[]>(`/orgs/${orgId}/production/work-orders${status ? `?status=${status}` : ""}`),
  createWorkOrder: (orgId: string, input: Partial<WorkOrderInput> & Pick<WorkOrderInput, "quantity" | "workCenterId">) =>
    request<WorkOrder>(`/orgs/${orgId}/production/work-orders`, post(input)),
  workOrderAction: (orgId: string, id: string, action: WorkOrderAction["action"]) =>
    request<WorkOrder>(`/orgs/${orgId}/production/work-orders/${id}/action`, post({ action })),
  loadMaterial: (orgId: string, id: string, input: LoadInput) =>
    request<ProductionPosted>(`/orgs/${orgId}/production/work-orders/${id}/load`, post(input)),
  reportUsage: (orgId: string, id: string, input: Partial<ConsumeInput> & Pick<ConsumeInput, "itemId" | "used">) =>
    request<ProductionPosted>(`/orgs/${orgId}/production/work-orders/${id}/consume`, post(input)),
  reportOutput: (orgId: string, id: string, input: Partial<OutputInput> & Pick<OutputInput, "good" | "toLocationId">) =>
    request<ProductionPosted>(`/orgs/${orgId}/production/work-orders/${id}/output`, post(input)),
  updateWorkCenter: (orgId: string, id: string, input: WorkCenterUpdate) =>
    request<WorkCenter>(`/orgs/${orgId}/production/work-centers/${id}`, patch(input)),
  productionSettings: (orgId: string) => request<ProductionSettings>(`/orgs/${orgId}/production/settings`),
  saveProductionSettings: (orgId: string, input: ProductionSettings) =>
    request<ProductionSettings>(`/orgs/${orgId}/production/settings`, { method: "PUT", body: JSON.stringify(input) }),
  approveWorkOrder: (orgId: string, id: string, note: string) =>
    request<WorkOrder>(`/orgs/${orgId}/production/work-orders/${id}/approve`, post({ note })),
  productionLookup: (orgId: string, code: string) =>
    request<ProductionLookup>(`/orgs/${orgId}/production/lookup?code=${encodeURIComponent(code)}`),
  workOrderVariance: (orgId: string, id: string) =>
    request<WorkOrderVariance>(`/orgs/${orgId}/production/work-orders/${id}/variance`),
  varianceSummary: (orgId: string) => request<VarianceSummaryRow[]>(`/orgs/${orgId}/production/variance`),

  // Quality hold and NCR, and the shared reason lists.
  ncrs: (orgId: string, status: "open" | "closed" | "all" = "all") => request<Ncr[]>(`/orgs/${orgId}/quality/ncrs?status=${status}`),
  ncrSummary: (orgId: string) => request<NcrSummary>(`/orgs/${orgId}/quality/summary`),
  putOnHold: (orgId: string, input: HoldInput) => request<Ncr>(`/orgs/${orgId}/quality/holds`, post(input)),
  disposeNcr: (orgId: string, id: string, input: DisposeInput) => request<Ncr>(`/orgs/${orgId}/quality/ncrs/${id}/dispose`, post(input)),
  reasons: (orgId: string) => request<Reasons>(`/orgs/${orgId}/reasons`),
  saveReasons: (orgId: string, input: ReasonsUpdate) => request<Reasons>(`/orgs/${orgId}/reasons`, { method: "PUT", body: JSON.stringify(input) }),

  // Lot genealogy and mock recall.
  trace: (orgId: string, q: TraceQuery) => request<TraceResult>(`/orgs/${orgId}/traceability/trace?${traceParams(q)}`),
  traceCsvUrl: (orgId: string, q: TraceQuery) => `/api/orgs/${orgId}/traceability/trace.csv?${traceParams(q)}`,
  runDrill: (orgId: string, q: TraceQuery) => request<{ drill: RecallDrill; result: TraceResult }>(`/orgs/${orgId}/traceability/drills`, post(q)),
  drills: (orgId: string) => request<RecallDrill[]>(`/orgs/${orgId}/traceability/drills`),
  // Scrap and yield trends (production reports).
  scrapReport: (orgId: string, days: number, workCenterId?: string) =>
    request<ScrapReport>(`/orgs/${orgId}/production/scrap?days=${days}${workCenterId ? `&workCenterId=${workCenterId}` : ""}`),
  scrapCsvUrl: (orgId: string, days: number, workCenterId?: string) =>
    `/api/orgs/${orgId}/production/scrap/lines.csv?days=${days}${workCenterId ? `&workCenterId=${workCenterId}` : ""}`,

  // Business-to-business exchange: partners, messages, supplier orders, captured invoices.
  b2bBridges: (orgId: string) => request<{ id: string; carries: string[] }[]>(`/orgs/${orgId}/b2b/bridges`),
  b2bPartners: (orgId: string) => request<TradingPartner[]>(`/orgs/${orgId}/b2b/partners`),
  createB2bPartner: (orgId: string, input: TradingPartnerInput) => request<TradingPartner>(`/orgs/${orgId}/b2b/partners`, post(input)),
  updateB2bPartner: (orgId: string, id: string, input: TradingPartnerUpdate) => request<TradingPartner>(`/orgs/${orgId}/b2b/partners/${id}`, patch(input)),
  b2bMessages: (orgId: string, q: { direction?: string; state?: string } = {}) => {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]);
    return request<B2BMessage[]>(`/orgs/${orgId}/b2b/messages?${qs}`);
  },
  b2bMessage: (orgId: string, id: string) => request<B2BMessageDetail>(`/orgs/${orgId}/b2b/messages/${id}`),
  retryB2bMessage: (orgId: string, id: string) => request<B2BMessage>(`/orgs/${orgId}/b2b/messages/${id}/retry`, post({})),
  ackB2bMessage: (orgId: string, id: string, input: B2BAckInput) => request<B2BMessage>(`/orgs/${orgId}/b2b/messages/${id}/ack`, post(input)),
  orderExchange: (orgId: string, poId: string) => request<OrderExchange>(`/orgs/${orgId}/b2b/orders/${poId}`),
  sendOrderToSupplier: (orgId: string, poId: string) => request<B2BMessage>(`/orgs/${orgId}/b2b/orders/${poId}/send`, post({})),
  orderPreviewUrl: (orgId: string, poId: string) => `/api/orgs/${orgId}/b2b/orders/${poId}/preview.pdf`,
  capturedInvoices: (orgId: string, status = "captured") => request<CapturedInvoice[]>(`/orgs/${orgId}/b2b/invoices?status=${status}`),
  updateCapturedInvoice: (orgId: string, id: string, input: CapturedInvoiceUpdate) => request<CapturedInvoice>(`/orgs/${orgId}/b2b/invoices/${id}`, patch(input)),
  discardCapturedInvoice: (orgId: string, id: string, note: string) => request<CapturedInvoice>(`/orgs/${orgId}/b2b/invoices/${id}/discard`, post({ note })),
  uploadInvoice: (orgId: string, input: InvoiceUpload) => request<CapturedInvoice>(`/orgs/${orgId}/b2b/invoices/upload`, post(input)),
  capturedInvoiceInput: (orgId: string, id: string) => request<Record<string, unknown>>(`/orgs/${orgId}/b2b/invoices/${id}/invoice-input`),
  b2bFileUrl: (orgId: string, id: string) => `/api/orgs/${orgId}/b2b/files/${id}`,
  // The supplier's page: no session, the token in the link is the key.
  portalOrder: (token: string) => request<PortalOrder>(`/b2b/portal/${token}`),
  portalAnswer: (token: string, answer: SupplierAnswer) => request<{ ok: true }>(`/b2b/portal/${token}/answer`, post(answer)),
};
