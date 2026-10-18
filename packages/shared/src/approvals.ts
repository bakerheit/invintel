import { z } from "zod";

/** Things that can need a second person's OK. */
export const APPROVAL_KINDS = ["adjustment", "purchase_order", "sales_order", "invoice", "supplier_payment_details"] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

/** For sentences: "Changed approval rules: supplier invoices from $500.00". */
export const APPROVAL_KIND_LABELS: Record<ApprovalKind, string> = {
  adjustment: "stock adjustments",
  purchase_order: "purchase orders",
  sales_order: "sales orders",
  invoice: "supplier invoices",
  supplier_payment_details: "changes to a supplier's payment details",
};

export const approvalRuleSchema = z.object({
  kind: z.enum(APPROVAL_KINDS),
  /** Needs approval when the money involved is at or above this. 0 means always. */
  thresholdCents: z.number().int().min(0).max(1_000_000_000),
  /** "members": only regular members need a second person. "everyone": admins too. */
  appliesTo: z.enum(["members", "everyone"]),
});
export type ApprovalRule = z.infer<typeof approvalRuleSchema>;

export const approvalRulesInputSchema = z.object({
  rules: z.array(approvalRuleSchema).max(APPROVAL_KINDS.length).refine((rs) => new Set(rs.map((r) => r.kind)).size === rs.length, "One rule per kind"),
});
export type ApprovalRulesInput = z.infer<typeof approvalRulesInputSchema>;

export const approvalDecisionSchema = z.object({ note: z.string().trim().max(300).default("") });
export type ApprovalDecisionInput = z.input<typeof approvalDecisionSchema>;

export type ApprovalStatus = "pending" | "approved" | "rejected" | "cancelled" | "failed";

export interface ApprovalRequest {
  id: string;
  number: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  /** One plain sentence: what is being asked. */
  summary: string;
  valueCents: number;
  requestedBy: string;
  requestedById: string;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  note: string;
  /** Why an approved request couldn't be carried out (e.g. the stock was gone by then). */
  failure: string | null;
  /** The thing it is about: a link target for the screen. */
  subject: { type: "item" | "purchase_order" | "sales_order" | "invoice" | "supplier"; id: string; label: string };
  /** Whether the current user may approve or reject it right now. */
  canDecide: boolean;
}

/** What a gated endpoint answers (HTTP 202) instead of doing the thing. */
export interface ApprovalRequired {
  approvalRequired: true;
  approval: ApprovalRequest;
}
