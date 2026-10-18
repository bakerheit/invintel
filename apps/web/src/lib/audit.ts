import type { AuditAction } from "@invintel/shared";

export const ACTION_META: Record<AuditAction, { label: string; className: string }> = {
  "item.created": { label: "Item created", className: "bg-success-soft text-success" },
  "item.updated": { label: "Item edited", className: "bg-accent text-accent-foreground" },
  "item.deleted": { label: "Item deleted", className: "bg-destructive/10 text-destructive dark:bg-destructive/20" },
  "location.created": { label: "Location created", className: "bg-success-soft text-success" },
  "location.updated": { label: "Location edited", className: "bg-accent text-accent-foreground" },
  "location.deleted": { label: "Location deleted", className: "bg-destructive/10 text-destructive dark:bg-destructive/20" },
  "organization.created": { label: "Organization created", className: "bg-success-soft text-success" },
  "organization.renamed": { label: "Organization renamed", className: "bg-accent text-accent-foreground" },
  "organization.join_code_rotated": { label: "Join code changed", className: "bg-warning-soft text-warning" },
  "member.joined": { label: "Member joined", className: "bg-secondary text-secondary-foreground" },
  "member.role_changed": { label: "Role changed", className: "bg-secondary text-secondary-foreground" },
  "member.removed": { label: "Member removed", className: "bg-secondary text-secondary-foreground" },
  "member.left": { label: "Member left", className: "bg-secondary text-secondary-foreground" },
  "stock.received": { label: "Stock received", className: "bg-success-soft text-success" },
  "stock.adjusted": { label: "Stock adjusted", className: "bg-secondary text-secondary-foreground" },
  "stock.moved": { label: "Stock moved", className: "bg-accent text-accent-foreground" },
  "stock.reversed": { label: "Stock reversed", className: "bg-warning-soft text-warning" },
};

/** The "what" filter on the audit page. Each maps to an action prefix. */
export const SCOPES = [
  { value: "item", label: "Items" },
  { value: "stock", label: "Stock" },
  { value: "location", label: "Locations" },
  { value: "organization", label: "Organization" },
  { value: "member", label: "Members" },
] as const;
