import { DEFAULT_MODULES, type ApprovalKind, type ApprovalRequest, type ApprovalRule, type OrgRole } from "@invintel/shared";
import { ObjectId } from "mongodb";
import { auditActor, recordAudit } from "./audit.js";
import { nextNumber } from "./counters.js";
import type { ApprovalDoc, OrgDoc, Store } from "./db.js";

void DEFAULT_MODULES; // (keeps the shared import grouped with the other org helpers)

export const rulesOf = (org: Pick<OrgDoc, "approvalRules">): ApprovalRule[] => org.approvalRules ?? [];

/** Does this action, for this person, need a second person's OK? */
export function ruleFor(org: Pick<OrgDoc, "approvalRules">, kind: ApprovalKind, valueCents: number, role: OrgRole): ApprovalRule | null {
  const rule = rulesOf(org).find((r) => r.kind === kind);
  if (!rule || valueCents < rule.thresholdCents) return null;
  if (rule.appliesTo === "members" && role !== "member") return null;
  return rule;
}

export const toApproval = (d: ApprovalDoc, viewer: { id: string; role: OrgRole }, soleApprover: boolean): ApprovalRequest => ({
  id: d._id.toHexString(), number: d.number, kind: d.kind, status: d.status, summary: d.summary, valueCents: d.valueCents,
  requestedBy: d.requestedBy.name, requestedById: d.requestedBy.id.toHexString(), requestedAt: d.requestedAt.toISOString(),
  decidedBy: d.decidedBy?.name ?? null, decidedAt: d.decidedAt?.toISOString() ?? null, note: d.note, failure: d.failure ?? null, subject: d.subject,
  canDecide: d.status === "pending" && viewer.role !== "member" && (d.requestedBy.id.toHexString() !== viewer.id || soleApprover),
});

/** Admins and the owner are the approvers. If the requester is the only one, they can approve their own (and it's recorded). */
export const isSoleApprover = async (store: Store, orgId: ObjectId) =>
  (await store.memberships.countDocuments({ orgId, role: { $in: ["admin", "owner"] } })) <= 1;

export async function createApproval(
  store: Store, orgId: ObjectId, user: { id: string; name: string; role: OrgRole },
  input: Pick<ApprovalDoc, "kind" | "summary" | "valueCents" | "payload" | "subject">,
): Promise<ApprovalDoc> {
  const doc: ApprovalDoc = {
    _id: new ObjectId(), orgId, number: await nextNumber(store, orgId, "approval", "APR-"), status: "pending", ...input,
    requestedBy: { id: new ObjectId(user.id), name: user.name }, requestedAt: new Date(), note: "",
  };
  await store.approvals.insertOne(doc);
  await recordAudit(store, {
    orgId, actor: auditActor(user), action: "approval.requested", entity: { type: "approval", id: doc._id.toHexString(), label: doc.number },
    summary: `Asked for approval (${doc.number}): ${doc.summary}`, refs: { kind: doc.kind, valueCents: doc.valueCents },
  });
  return doc;
}
