import { zValidator } from "@hono/zod-validator";
import { approvalDecisionSchema, approvalRulesInputSchema, objectIdSchema } from "@invintel/shared";
import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { auditActor, recordAudit } from "./audit.js";
import { isSoleApprover, rulesOf, toApproval } from "./approvals-core.js";
import type { ApprovalDoc, Store } from "./db.js";
import { actorOf } from "./items.js";
import { requireRole, type OrgEnv } from "./org-access.js";
import { loadIncomingOrder, sendOrderResponse } from "./exchange.js";
import { placeOrderDirect } from "./purchasing.js";
import { confirmOrderDirect } from "./sales-core.js";
import { postAdjustment } from "./stock-service.js";

const idParam = z.object({ id: objectIdSchema });

/**
 * Second-person approval. Rules say when an action needs one (an adjustment or a purchase order worth at least $X).
 * The action then waits as a request; another admin approves or rejects it, and an approved request is carried out
 * once, as the person who asked, with the approver named in the audit log.
 */
export function createApprovalRoutes(store: Store) {
  const r = new Hono<OrgEnv>();
  const viewer = (c: { get: (k: "user" | "role") => any }) => ({ id: c.get("user").id as string, role: c.get("role") });

  r.get("/rules", (c) => c.json({ rules: rulesOf(c.get("org")) }));

  r.put("/rules", requireRole("admin"), zValidator("json", approvalRulesInputSchema), async (c) => {
    const org = c.get("org");
    const rules = c.req.valid("json").rules;
    await store.orgs.updateOne({ _id: org._id }, { $set: { approvalRules: rules } });
    const text = rules.length ? rules.map((x) => `${x.kind === "adjustment" ? "adjustments" : x.kind === "sales_order" ? "sales orders" : "purchase orders"} from $${(x.thresholdCents / 100).toFixed(2)} (${x.appliesTo === "members" ? "members" : "everyone"})`).join(", ") : "none";
    await recordAudit(store, {
      orgId: org._id, actor: auditActor(c.get("user")), action: "approval.rules_changed", entity: { type: "organization", id: org._id.toHexString(), label: org.name },
      summary: `Changed approval rules: ${text}`, changes: [{ field: "approvalRules", from: rulesOf(org), to: rules }],
    });
    return c.json({ rules });
  });

  r.get("/", async (c) => {
    const org = c.get("org");
    const v = viewer(c);
    const admin = v.role !== "member";
    const status = c.req.query("status");
    // Members see their own requests; admins see everyone's.
    const filter = { orgId: org._id, ...(admin ? {} : { "requestedBy.id": new ObjectId(v.id) }), ...(status ? { status: status as ApprovalDoc["status"] } : {}) };
    const docs = await store.approvals.find(filter).sort({ requestedAt: -1 }).limit(100).toArray();
    const sole = await isSoleApprover(store, org._id);
    return c.json(docs.map((d) => toApproval(d, v, sole)));
  });

  /** How many are waiting for this person to decide (for a badge). */
  r.get("/pending-count", async (c) => {
    const v = viewer(c);
    if (v.role === "member") return c.json({ count: 0 });
    const sole = await isSoleApprover(store, c.get("org")._id);
    const docs = await store.approvals.find({ orgId: c.get("org")._id, status: "pending" }).toArray();
    return c.json({ count: docs.filter((d) => toApproval(d, v, sole).canDecide).length });
  });

  r.post("/:id/approve", requireRole("admin"), zValidator("param", idParam), zValidator("json", approvalDecisionSchema), async (c) => {
    const org = c.get("org");
    const me = c.get("user");
    const doc = await store.approvals.findOne({ _id: new ObjectId(c.req.valid("param").id), orgId: org._id });
    if (!doc) return c.json({ error: "Request not found" }, 404);
    if (doc.status !== "pending") return c.json({ error: `That request is already ${doc.status}` }, 409);
    if (doc.requestedBy.id.toHexString() === me.id && !(await isSoleApprover(store, org._id))) {
      return c.json({ error: "Someone else has to approve your request" }, 403);
    }
    // Claim it first, so two approvers can't both carry it out.
    const claimed = await store.approvals.findOneAndUpdate(
      { _id: doc._id, status: "pending" },
      { $set: { status: "approved", decidedBy: { id: new ObjectId(me.id), name: me.name }, decidedAt: new Date(), note: c.req.valid("json").note } },
      { returnDocument: "after" },
    );
    if (!claimed) return c.json({ error: "Someone else just decided this request" }, 409);
    await recordAudit(store, {
      orgId: org._id, actor: auditActor(me), action: "approval.approved", entity: { type: "approval", id: doc._id.toHexString(), label: doc.number },
      summary: `Approved ${doc.number}${doc.requestedBy.id.toHexString() === me.id ? " (own request: the only approver)" : ` asked by ${doc.requestedBy.name}`}: ${doc.summary}`,
      refs: { kind: doc.kind, requestedBy: doc.requestedBy.name },
    });

    // Carry it out as the person who asked, naming the approver in the reason so Activity shows both.
    let failure: string | null = null;
    const asker = { userId: doc.requestedBy.id, userName: doc.requestedBy.name };
    if (doc.kind === "adjustment") {
      const p = doc.payload;
      const res = await postAdjustment(store, org._id, asker, { itemId: p.itemId!, locationId: p.locationId!, delta: p.delta!, reason: `${p.reason ?? ""} (approved by ${me.name}, ${doc.number})`.trim(), type: "adjust" });
      if (!res.ok) failure = res.error;
    } else if (doc.kind === "sales_order") {
      const p = doc.payload;
      const res = await confirmOrderDirect(store, org._id, { id: doc.requestedBy.id, name: doc.requestedBy.name }, p.orderId!, { allowShortage: p.allowShortage, via: `approved by ${me.name}, ${doc.number}` });
      if (!res.ok) failure = res.error;
      else if (p.respond) {
        // The order came from a customer: now that the stock is promised, tell them.
        const got = await loadIncomingOrder(store, org._id, p.respond.messageId.toHexString());
        const sent = got ? await sendOrderResponse(store, org._id, asker, got, p.respond) : null;
        if (!sent || !sent.ok) failure = `The stock is reserved, but the answer to the customer could not be sent${sent && !sent.ok ? `: ${sent.error}` : ""}`;
      }
    } else {
      const res = await placeOrderDirect(store, org._id, doc.payload.orderId!, { id: doc.requestedBy.id.toHexString(), name: doc.requestedBy.name }, `approved by ${me.name}, ${doc.number}`);
      if (!res.ok) failure = res.error;
    }
    if (failure) await store.approvals.updateOne({ _id: doc._id }, { $set: { status: "failed", failure } });
    const fresh = (await store.approvals.findOne({ _id: doc._id }))!;
    return c.json(toApproval(fresh, viewer(c), await isSoleApprover(store, org._id)), failure ? 409 : 200);
  });

  r.post("/:id/reject", requireRole("admin"), zValidator("param", idParam), zValidator("json", approvalDecisionSchema), async (c) => {
    const org = c.get("org");
    const me = c.get("user");
    const { note } = c.req.valid("json");
    if (!note) return c.json({ error: "Say why, so the person knows what to change" }, 400);
    const res = await store.approvals.findOneAndUpdate(
      { _id: new ObjectId(c.req.valid("param").id), orgId: org._id, status: "pending" },
      { $set: { status: "rejected", decidedBy: { id: new ObjectId(me.id), name: me.name }, decidedAt: new Date(), note } },
      { returnDocument: "after" },
    );
    if (!res) return c.json({ error: "That request isn't waiting any more" }, 409);
    await recordAudit(store, {
      orgId: org._id, actor: auditActor(me), action: "approval.rejected", entity: { type: "approval", id: res._id.toHexString(), label: res.number },
      summary: `Rejected ${res.number} asked by ${res.requestedBy.name}: ${note}`,
    });
    return c.json(toApproval(res, viewer(c), await isSoleApprover(store, org._id)));
  });

  r.post("/:id/cancel", zValidator("param", idParam), async (c) => {
    const org = c.get("org");
    const me = c.get("user");
    const res = await store.approvals.findOneAndUpdate(
      { _id: new ObjectId(c.req.valid("param").id), orgId: org._id, status: "pending", "requestedBy.id": new ObjectId(me.id) },
      { $set: { status: "cancelled", decidedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!res) return c.json({ error: "Only the person who asked can cancel a request that is still waiting" }, 409);
    await recordAudit(store, { orgId: org._id, actor: auditActor(me), action: "approval.cancelled", entity: { type: "approval", id: res._id.toHexString(), label: res.number }, summary: `Cancelled ${res.number}` });
    return c.json(toApproval(res, viewer(c), await isSoleApprover(store, org._id)));
  });

  void actorOf;
  return r;
}
