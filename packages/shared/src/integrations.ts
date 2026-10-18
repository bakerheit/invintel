import { z } from "zod";

// API keys and outbound webhooks: how other software talks to Invintel, and how Invintel tells it things.

// ---------- API keys ----------

/** read: look things up. write: also receive, adjust, move and edit items. Neither can delete, import, restore or manage people or settings. */
export const API_SCOPES = ["read", "write"] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const API_KEY_PREFIX = "ivk_";

export const apiKeyInputSchema = z.object({
  name: z.string().trim().min(1, "Give the key a name").max(80),
  scope: z.enum(API_SCOPES),
  /** Days until it stops working. Null means it works until revoked. */
  expiresInDays: z.number().int().min(1).max(730).nullable().default(null),
});
export type ApiKeyInput = z.input<typeof apiKeyInputSchema>;

export interface ApiKey {
  id: string;
  name: string;
  scope: ApiScope;
  /** The start of the key, so a person can tell which is which. The rest is never kept. */
  prefix: string;
  createdAt: string;
  createdBy: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

/** What creating a key returns: the only time the key itself is shown. */
export interface ApiKeyCreated extends ApiKey {
  key: string;
}

// ---------- webhooks ----------

/** Events a webhook can listen for. These are the names in the audit log. */
export const WEBHOOK_EVENTS = [
  "item.created",
  "item.updated",
  "item.deleted",
  "stock.received",
  "stock.adjusted",
  "stock.moved",
  "stock.reversed",
  "purchase_order.created",
  "purchase_order.ordered",
  "purchase_order.received",
  "purchase_order.cancelled",
  "purchase_order.closed",
  "count.posted",
  "work_order.created",
  "work_order.released",
  "work_order.completed",
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "import.applied",
  "import.undone",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const WEBHOOK_TEST_EVENT = "webhook.test";

export const webhookEventsSchema = z
  .array(z.union([z.literal("*"), z.enum(WEBHOOK_EVENTS)]))
  .min(1, "Pick at least one event")
  .max(WEBHOOK_EVENTS.length + 1)
  .transform((e) => (e.includes("*") ? ["*"] : [...new Set(e)]));

const webhookFields = {
  url: z.string().trim().min(1, "Enter the address to send to").max(2000),
  events: webhookEventsSchema,
  description: z.string().trim().max(200),
};

export const webhookInputSchema = z.object({ ...webhookFields, description: webhookFields.description.default("") });
export type WebhookInput = z.input<typeof webhookInputSchema>;

export const webhookUpdateSchema = z.object({ ...webhookFields, enabled: z.boolean() }).partial();
export type WebhookUpdate = z.input<typeof webhookUpdateSchema>;

export type DeliveryStatus = "pending" | "delivered" | "retrying" | "failed";

export interface WebhookDelivery {
  id: string;
  eventId: string;
  type: string;
  status: DeliveryStatus;
  attempts: number;
  /** The HTTP status the receiver answered with, if it did. */
  responseStatus: number | null;
  /** Why the last attempt failed, in words. */
  error: string | null;
  createdAt: string;
  deliveredAt: string | null;
  nextAttemptAt: string | null;
}

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  description: string;
  enabled: boolean;
  /** Set when too many deliveries in a row failed and it was switched off. */
  disabledReason: string | null;
  createdAt: string;
  createdBy: string;
  /** The newest delivery, so the list can show whether it is working. */
  lastDelivery: WebhookDelivery | null;
}

/** What creating or rotating returns: the only time the signing secret is shown. */
export interface WebhookWithSecret extends Webhook {
  secret: string;
}
