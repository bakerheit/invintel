import { z } from "zod";

// ---------- ids ----------

export const objectIdSchema = z.string().regex(/^[0-9a-f]{24}$/i, "Invalid id");

// ---------- organizations ----------

export const orgRoleSchema = z.enum(["owner", "admin", "member"]);
export type OrgRole = z.infer<typeof orgRoleSchema>;

export const organizationNameSchema = z.string().trim().min(1, "Organization name is required").max(100);

export const organizationInputSchema = z.object({ name: organizationNameSchema });
export type OrganizationInput = z.infer<typeof organizationInputSchema>;

/** Join codes are 8 characters. People type them with spaces or dashes, so normalise first. */
export const joinCodeSchema = z
  .string()
  .transform((s) => s.replace(/[^a-z0-9]/gi, "").toUpperCase())
  .pipe(z.string().length(8, "Join codes are 8 characters"));

export const joinOrganizationInputSchema = z.object({ joinCode: joinCodeSchema });
export type JoinOrganizationInput = z.infer<typeof joinOrganizationInputSchema>;

/** What a user picks while registering: start a new organization or join an existing one. */
export const registrationOrganizationSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("create"), name: organizationNameSchema }),
  z.object({ mode: z.literal("join"), joinCode: joinCodeSchema }),
]);
export type RegistrationOrganization = z.infer<typeof registrationOrganizationSchema>;

export interface OrgSummary {
  id: string;
  name: string;
  /** The caller's role in this organization. */
  role: OrgRole;
  /** Only sent to owners and admins. */
  joinCode?: string;
  memberCount: number;
  createdAt: string;
}

export interface OrgMember {
  userId: string;
  name: string;
  email: string;
  role: OrgRole;
  joinedAt: string;
}

// ---------- auth ----------

export const registerInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  password: z.string().min(8, "Password must be at least 8 characters").max(128),
  organization: registrationOrganizationSchema,
});
export type RegisterInput = z.infer<typeof registerInputSchema>;

export const loginInputSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(1).max(128),
});
export type LoginInput = z.infer<typeof loginInputSchema>;

export interface User {
  id: string;
  name: string;
  email: string;
}

export interface RegisterResult {
  user: User;
  organization: OrgSummary;
}

// ---------- locations ----------

/** What a place is for. Drives floor workflows (receive into receiving, load from production, etc). */
export const locationTypeSchema = z.enum(["receiving", "storage", "wip", "production", "finished", "shipping"]);
export type LocationType = z.infer<typeof locationTypeSchema>;
export const LOCATION_TYPES = locationTypeSchema.options;

// Update schemas are built from these default-less fields. Zod 4 applies .default() inside
// .partial(), which would silently reset omitted fields on PATCH.
const locationFields = {
  name: z.string().trim().min(1, "Name is required").max(100),
  description: z.string().trim().max(500),
  type: locationTypeSchema,
  parentId: objectIdSchema.nullable(),
  /** Short scannable code like "A-01-03". Empty means none. */
  code: z.string().trim().max(40),
};

export const locationInputSchema = z.object({
  ...locationFields,
  description: locationFields.description.default(""),
  type: locationFields.type.default("storage"),
  parentId: locationFields.parentId.default(null),
  code: locationFields.code.default(""),
});
export type LocationInput = z.infer<typeof locationInputSchema>;

export const locationUpdateSchema = z.object(locationFields).partial();
export type LocationUpdate = z.infer<typeof locationUpdateSchema>;

export interface Location {
  id: string;
  name: string;
  description: string;
  type: LocationType;
  parentId: string | null;
  code: string;
  /** Ancestors and this location, e.g. "Plant 1 / Roll storage / A-01". */
  path: string;
  /** Distinct items with stock in this location itself (not its children). */
  skuCount: number;
  /** Total units in this location itself. */
  unitCount: number;
  createdAt: string;
}

// ---------- items and stock ----------

const itemFields = {
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000),
  category: z.string().trim().max(100),
  reorderLevel: z.number().int().min(0),
  unitCostCents: z.number().int().min(0),
};

export const itemInputSchema = z.object({
  ...itemFields,
  description: itemFields.description.default(""),
  category: itemFields.category.default(""),
  reorderLevel: itemFields.reorderLevel.default(0),
  unitCostCents: itemFields.unitCostCents.default(0),
});
export type ItemInput = z.infer<typeof itemInputSchema>;

export const itemCreateSchema = itemInputSchema.extend({
  initialStock: z
    .object({ locationId: objectIdSchema, quantity: z.number().int().positive() })
    .optional(),
});
export type ItemCreate = z.infer<typeof itemCreateSchema>;

export const itemUpdateSchema = z.object(itemFields).partial();
export type ItemUpdate = z.infer<typeof itemUpdateSchema>;

export interface StockLevel {
  locationId: string;
  quantity: number;
}

export interface Item extends ItemInput {
  id: string;
  /** Total across all locations. */
  quantity: number;
  /** Only locations that hold stock. */
  stock: StockLevel[];
  createdAt: string;
  updatedAt: string;
}

export const adjustmentInputSchema = z.object({
  locationId: objectIdSchema,
  delta: z.number().int().refine((n) => n !== 0, "Change must not be 0"),
  reason: z.string().trim().max(200).default(""),
});
export type AdjustmentInput = z.infer<typeof adjustmentInputSchema>;

export const transferInputSchema = z
  .object({
    fromLocationId: objectIdSchema,
    toLocationId: objectIdSchema,
    quantity: z.number().int().positive(),
    reason: z.string().trim().max(200).default(""),
  })
  .refine((t) => t.fromLocationId !== t.toLocationId, {
    message: "Pick two different locations",
    path: ["toLocationId"],
  });
export type TransferInput = z.infer<typeof transferInputSchema>;

export const movementTypeSchema = z.enum(["receive", "adjust", "transfer", "reversal"]);
export type MovementType = z.infer<typeof movementTypeSchema>;
export const MOVEMENT_TYPES = movementTypeSchema.options;

export interface StockMovement {
  id: string;
  type: MovementType;
  itemId: string;
  locationId: string;
  delta: number;
  reason: string;
  /** Name of whoever made the change, as it was at the time. */
  userName: string;
  /** Set on both halves of a transfer. */
  transferId?: string;
  createdAt: string;
}

// ---------- floor documents ----------

export const receiveInputSchema = z.object({
  itemId: objectIdSchema,
  locationId: objectIdSchema,
  quantity: z.number().int().positive(),
  /** Free text: PO number, delivery note, supplier. */
  reference: z.string().trim().max(200).default(""),
});
export type ReceiveInput = z.infer<typeof receiveInputSchema>;

export const moveInputSchema = z
  .object({
    itemId: objectIdSchema,
    fromLocationId: objectIdSchema,
    toLocationId: objectIdSchema,
    quantity: z.number().int().positive(),
    reason: z.string().trim().max(200).default(""),
  })
  .refine((m) => m.fromLocationId !== m.toLocationId, {
    message: "Pick two different locations",
    path: ["toLocationId"],
  });
export type MoveInput = z.infer<typeof moveInputSchema>;

/** Result of posting a floor document. Ids let the client offer "undo". */
export interface PostedDocument {
  item: Item;
  movementIds: string[];
}

/** What a scanned code resolved to. Items match by SKU; locations by code or name. */
export type LookupResult =
  | { kind: "item"; item: Item }
  | { kind: "location"; location: Location }
  | { kind: "none" };

// ---------- activity (the ledger) ----------

export interface ActivityEntry {
  id: string;
  type: MovementType;
  itemId: string;
  itemSku: string;
  itemName: string;
  locationId: string;
  locationName: string;
  locationPath: string;
  delta: number;
  reason: string;
  userName: string;
  /** Set on both halves of a transfer. */
  transferId?: string;
  /** Set on a reversal: the movement it undoes. */
  reversalOf?: string;
  /** Set on an original that has been reversed. */
  reversed: boolean;
  /** Whether the current user may reverse this entry right now. */
  canReverse: boolean;
  createdAt: string;
}

export interface ActivityPage {
  entries: ActivityEntry[];
  /** Pass as `before` to get the next page. Absent when there is no more. */
  nextBefore?: string;
}

export const reverseInputSchema = z.object({
  reason: z.string().trim().max(200).default(""),
});
export type ReverseInput = z.infer<typeof reverseInputSchema>;

/**
 * UPC-A (12 digits), EAN-13 and GTIN-14 are one numbering system padded with different numbers of
 * leading zeros, and scanners disagree about which form to report (browsers' native detector
 * says 12 digits for UPC-A, ZXing says 13). Returns the forms that mean the same product.
 * Anything that isn't 8-14 digits is returned as is.
 */
export function gtinVariants(code: string): string[] {
  if (!/^\d{8,14}$/.test(code)) return [code];
  const stripped = code.replace(/^0+/, "");
  const forms = new Set([code]);
  for (const length of [12, 13, 14]) {
    if (stripped.length <= length) forms.add(stripped.padStart(length, "0"));
  }
  return [...forms];
}
