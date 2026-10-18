import { toStored, uomOf, type ApprovalRequest, type SoShortage } from "@invintel/shared";
import { ObjectId } from "mongodb";
import { createApproval, isSoleApprover, ruleFor, toApproval } from "./approvals-core.js";
import type { OrgDoc, Store, TradingPartnerDoc } from "./db.js";
import type { IncomingOrder } from "./exchange.js";
import { cancelOrder, confirmOrderDirect, createDraft, toSalesOrders } from "./sales-core.js";

// INV-15: what answering a customer's order from the Exchange does to stock. Accepting an incoming order makes it a sales order and
// reserves the stock; a rejection releases it. The answer to the customer is only sent once the stock is really promised.

export type SalesAnswer =
  | { kind: "ok"; salesOrder: { id: string; number: string } | null }
  | { kind: "approval"; approval: ApprovalRequest; salesOrder: { id: string; number: string } }
  | { kind: "refused"; status: 409 | 422; error: string; shortages?: SoShortage[]; salesOrder?: { id: string; number: string } };

type User = { id: string; name: string; role: "owner" | "admin" | "member" };
const ci = { locale: "en", strength: 2 } as const;
const ref = (d: { _id: ObjectId; number: string }) => ({ id: d._id.toHexString(), number: d.number });

/** Maps an incoming order's lines onto our items. Anything that can't be mapped exactly is refused, never guessed. */
async function mapLines(store: Store, orgId: ObjectId, order: IncomingOrder["order"]): Promise<{ ok: true; lines: { itemId: string; quantity: number; unitPriceCents: number }[] } | { ok: false; error: string }> {
  const problems: string[] = [];
  const merged = new Map<string, { itemId: string; quantity: number; unitPriceCents: number }>();
  for (const l of order.lines) {
    const item = await store.items.findOne({ orgId, sku: l.sku }, { collation: ci });
    if (!item) { problems.push(`we don't carry ${l.sku}`); continue; }
    const u = uomOf(item);
    if (l.unit && l.unit.trim().toLowerCase() !== u.unit.toLowerCase()) { problems.push(`${l.sku} is ordered in ${l.unit}, we count it in ${u.unit}`); continue; }
    const stored = toStored(String(l.quantity), u.decimals);
    if (stored === null || stored <= 0) { problems.push(`${l.sku}: quantity ${l.quantity} isn't something we can count (${u.decimals} decimal${u.decimals === 1 ? "" : "s"} at most)`); continue; }
    const key = item._id.toHexString();
    const have = merged.get(key);
    if (have) {
      if (have.unitPriceCents !== l.unitPriceCents) { problems.push(`${l.sku} is on the order twice at different prices`); continue; }
      have.quantity += stored;
    } else merged.set(key, { itemId: key, quantity: stored, unitPriceCents: l.unitPriceCents });
  }
  if (problems.length) return { ok: false, error: `Can't turn this order into a sales order: ${problems.join("; ")}.` };
  return { ok: true, lines: [...merged.values()] };
}

/**
 * Answers an incoming order. "accepted" or "changed": make (once) and confirm a sales order, or ask for approval when a rule says so.
 * "rejected": release anything we had reserved for it. The caller sends the reply to the customer only when this says "ok".
 */
export async function answerWithSales(
  store: Store, org: OrgDoc, user: User, got: IncomingOrder,
  input: { status: "accepted" | "rejected" | "changed"; promisedDate: string | null; note: string; backorder: boolean },
): Promise<SalesAnswer> {
  const orgId = org._id;
  const actor = { id: new ObjectId(user.id), name: user.name };
  let so = await store.salesOrders.findOne({ orgId, messageId: got.m._id });

  if (input.status === "rejected") {
    if (!so) return { kind: "ok", salesOrder: null };
    if (so.state === "draft" || so.state === "confirmed") {
      const r = await cancelOrder(store, orgId, actor, so._id, "the customer's order was rejected");
      if (!r.ok && r.status !== 409) return { kind: "refused", status: 409, error: r.error };
      // Part-shipped (409): it stays as it is; a rejection can't take stock back from the customer.
    }
    return { kind: "ok", salesOrder: ref(so) };
  }

  if (so && so.state === "confirmed") return { kind: "ok", salesOrder: ref(so) };
  if (so && (so.state === "cancelled" || so.state === "closed")) return { kind: "refused", status: 409, error: `${so.number} was ${so.state}. Ask the customer for a new order.`, salesOrder: ref(so) };

  if (!so) {
    const lines = await mapLines(store, orgId, got.order);
    if (!lines.ok) return { kind: "refused", status: 422, error: lines.error };
    const partner: TradingPartnerDoc | null = await store.tradingPartners.findOne({ _id: got.m.partnerId, orgId });
    const made = await createDraft(store, orgId, actor, {
      customerPartnerId: partner?.kind === "customer" ? partner._id.toHexString() : null, customerName: partner?.name ?? "Customer", customerRef: got.order.poNumber,
      requestedDate: got.order.requestedDate ?? null, note: got.order.note ?? "", lines: lines.lines,
    }, { source: "exchange", messageId: got.m._id });
    if (!made.ok) {
      // Two answers at once: the other one made it.
      so = await store.salesOrders.findOne({ orgId, messageId: got.m._id });
      if (!so) return { kind: "refused", status: 409, error: made.error };
    } else so = made.order;
  }

  const [view] = await toSalesOrders(store, [so]);
  const rule = ruleFor(org, "sales_order", view!.totalCents, user.role);
  if (rule) {
    const open = await store.approvals.findOne({ orgId, kind: "sales_order", status: "pending", "payload.orderId": so._id });
    const approval = open ?? (await createApproval(store, orgId, user, {
      kind: "sales_order", valueCents: view!.totalCents,
      payload: { orderId: so._id, allowShortage: input.backorder, respond: { messageId: got.m._id, status: input.status === "changed" ? "changed" : "accepted", promisedDate: input.promisedDate, note: input.note } },
      summary: `Accept ${view!.customer.name}'s order ${got.order.poNumber} as ${so.number}: ${view!.lines.length} line${view!.lines.length === 1 ? "" : "s"}, $${(view!.totalCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
      subject: { type: "sales_order", id: so._id.toHexString(), label: `${so.number} (${view!.customer.name})` },
    }));
    return { kind: "approval", approval: toApproval(approval, { id: user.id, role: user.role }, await isSoleApprover(store, orgId)), salesOrder: ref(so) };
  }

  const done = await confirmOrderDirect(store, orgId, actor, so._id, { allowShortage: input.backorder, via: "accepted an incoming order" });
  if (!done.ok) return { kind: "refused", status: done.status === 404 ? 409 : done.status, error: `${done.error}. ${so.number} was made as a draft; confirm it once there is stock, or accept it as a back-order.`, ...(done.shortages ? { shortages: done.shortages } : {}), salesOrder: ref(so) };
  return { kind: "ok", salesOrder: ref(done.order) };
}
