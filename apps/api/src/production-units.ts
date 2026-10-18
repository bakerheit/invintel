import type { ConsumeInput, LoadInput, OutputInput } from "@invintel/shared";
import { ObjectId } from "mongodb";
import type { Store, WorkCenterDoc, WorkOrderDoc } from "./db.js";
import type { Actor } from "./stock-service.js";
import { adjustUnit, moveUnit, receiveUnits } from "./units.js";

// Production on unit-tracked items (rolls, pallets): the floor scans a unit label instead of typing a quantity.
// Every line goes through the unit operations so the stock rows stay equal to the sum of the units' remaining
// quantities, and every line carries the work order and one group id (so one floor document stays together).

export type UnitProd =
  | { ok: true; movementIds: ObjectId[]; summary: string; snapshot: Record<string, unknown> }
  | { ok: false; status: 404 | 409 | 422; error: string };

const bad = (status: 404 | 409 | 422, error: string): UnitProd => ({ ok: false, status, error });

export const isUnitTracked = async (store: Store, orgId: ObjectId, itemId: ObjectId) =>
  (await store.items.findOne({ _id: itemId, orgId }, { projection: { tracking: 1 } }))?.tracking === "unit";

const findUnit = async (store: Store, orgId: ObjectId, unitId: string, itemId: ObjectId) => {
  const unit = await store.units.findOne({ _id: new ObjectId(unitId), orgId });
  if (!unit) return { error: bad(404, "That roll or pallet isn't in the system") };
  if (!unit.itemId.equals(itemId)) return { error: bad(422, `${unit.code} is a different material than the one you picked`) };
  if (unit.status !== "available") return { error: bad(409, `${unit.code} is ${unit.status === "consumed" ? "used up" : unit.status}`) };
  return { unit };
};

/** Load: the whole unit moves to the machine's staging location. */
export async function loadUnit(store: Store, orgId: ObjectId, actor: Actor, wo: WorkOrderDoc, center: WorkCenterDoc, itemId: ObjectId, input: LoadInput): Promise<UnitProd> {
  if (!input.unitId) return bad(409, "Scan the roll or pallet label: this material is tracked by unit");
  const found = await findUnit(store, orgId, input.unitId, itemId);
  if (found.error) return found.error;
  const { unit } = found;
  if (unit.locationId.equals(center.locationId)) return bad(409, `${unit.code} is already at the machine`);
  const res = await moveUnit(store, orgId, actor, unit._id, center.locationId, `Loaded ${unit.code} to ${center.name} for ${wo.number}`, {
    type: "load",
    workOrderId: wo._id,
    transferId: new ObjectId(),
  });
  if (!res.ok) return res;
  return { ok: true, movementIds: res.movementIds, summary: `Loaded ${unit.code} (${unit.quantity} left) to ${center.name} for ${wo.number}`, snapshot: { unit: unit.code, quantity: unit.quantity } };
}

/**
 * Report usage on a unit that is at the machine. `used` and `scrap` come off the unit (it flips to consumed at 0).
 * What's left stays on the same unit: it goes back to `remnantLocationId` if given, else stays loaded.
 */
export async function consumeUnit(store: Store, orgId: ObjectId, actor: Actor, wo: WorkOrderDoc, center: WorkCenterDoc, itemId: ObjectId, input: ConsumeInput): Promise<UnitProd> {
  if (!input.unitId) return bad(409, "Scan the roll or pallet label: this material is tracked by unit");
  const found = await findUnit(store, orgId, input.unitId, itemId);
  if (found.error) return found.error;
  const { unit } = found;
  if (!unit.locationId.equals(center.locationId)) return bad(422, `${unit.code} isn't at the machine. Load it first.`);
  const left = unit.quantity - input.used - input.scrap;
  if (left < 0) return bad(422, `${unit.code} only has ${unit.quantity} left`);
  if (input.remnant > 0 && input.remnant !== left) return bad(422, `What's left on ${unit.code} is ${left}: report that as the leftover`);
  const group = new ObjectId();
  const ids: ObjectId[] = [];
  const step = async (delta: number, type: "consume" | "scrap", reason: string) => {
    if (delta === 0) return null;
    const r = await adjustUnit(store, orgId, actor, unit._id, delta, reason, { type, workOrderId: wo._id, transferId: group, ...(type === "scrap" && input.scrapReason ? { reasonCode: input.scrapReason } : {}) });
    if (r.ok) ids.push(...r.movementIds);
    return r.ok ? null : r;
  };
  const failed = (await step(-input.used, "consume", input.reason || `Used on ${wo.number}`)) ?? (await step(-input.scrap, "scrap", input.reason || `Scrap on ${wo.number}`));
  if (failed) return failed;
  if (left > 0 && input.remnantLocationId) {
    const r = await moveUnit(store, orgId, actor, unit._id, new ObjectId(input.remnantLocationId), `Remnant ${unit.code} from ${wo.number}`, { type: "transfer", workOrderId: wo._id, transferId: group });
    if (!r.ok) return r;
    ids.push(...r.movementIds);
  }
  return {
    ok: true,
    movementIds: ids,
    summary: `Reported usage on ${wo.number}: ${unit.code} used ${input.used}, scrap ${input.scrap}, ${left} left`,
    snapshot: { unit: unit.code, used: input.used, scrap: input.scrap, left },
  };
}

/** Output of a unit-tracked item: new pallets/rolls with labels. `unitSize` is the quantity on each; a short last unit takes the rest. */
export async function outputUnits(store: Store, orgId: ObjectId, actor: Actor, wo: WorkOrderDoc, toLocationId: ObjectId, input: OutputInput): Promise<UnitProd> {
  if (input.scrap > 0) return bad(422, "Scrap on unit-tracked output isn't supported yet. Report the good units only.");
  if (input.good < 1) return bad(422, "Report the good quantity");
  if (!input.unitSize) return bad(409, "Say how many go on each pallet or roll (unit size)");
  const full = Math.floor(input.good / input.unitSize);
  const rest = input.good - full * input.unitSize;
  const group = new ObjectId();
  const ids: ObjectId[] = [];
  const codes: string[] = [];
  for (const [count, quantity] of [[full, input.unitSize], [rest > 0 ? 1 : 0, rest]] as const) {
    if (!count) continue;
    const r = await receiveUnits(store, orgId, actor, { itemId: wo.outputItemId, locationId: toLocationId, quantity, count, lot: input.lot, reference: wo.number }, { type: "produce", workOrderId: wo._id, transferId: group });
    if (!r.ok) return r;
    ids.push(...r.movementIds);
    codes.push(...r.units.map((u) => u.code));
  }
  return { ok: true, movementIds: ids, summary: `Reported output on ${wo.number}: ${input.good} good in ${codes.length} unit(s)`, snapshot: { good: input.good, units: codes } };
}
