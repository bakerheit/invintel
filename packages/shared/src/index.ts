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

export const locationInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  description: z.string().trim().max(500).default(""),
});
export type LocationInput = z.infer<typeof locationInputSchema>;

export const locationUpdateSchema = locationInputSchema.partial();
export type LocationUpdate = z.infer<typeof locationUpdateSchema>;

export interface Location {
  id: string;
  name: string;
  description: string;
  /** Distinct items with stock here. */
  skuCount: number;
  /** Total units here. */
  unitCount: number;
  createdAt: string;
}

// ---------- items and stock ----------

export const itemInputSchema = z.object({
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).default(""),
  category: z.string().trim().max(100).default(""),
  reorderLevel: z.number().int().min(0).default(0),
  unitCostCents: z.number().int().min(0).default(0),
});
export type ItemInput = z.infer<typeof itemInputSchema>;

export const itemCreateSchema = itemInputSchema.extend({
  initialStock: z
    .object({ locationId: objectIdSchema, quantity: z.number().int().positive() })
    .optional(),
});
export type ItemCreate = z.infer<typeof itemCreateSchema>;

export const itemUpdateSchema = itemInputSchema.partial();
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

export interface StockMovement {
  id: string;
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
