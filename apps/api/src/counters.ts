import type { ObjectId } from "mongodb";
import type { Store } from "./db.js";

/**
 * Next number in a per-organization sequence, e.g. nextNumber(store, orgId, "wo", "WO-") gives "WO-0001",
 * then "WO-0002". Atomic, so two simultaneous callers never get the same number. Numbers are never
 * reused, even if the document that took one is deleted. `kind` names the sequence ("wo", "po", ...).
 */
export async function nextSeq(store: Store, orgId: ObjectId, kind: string): Promise<number> {
  const row = await store.counters.findOneAndUpdate(
    { _id: `${orgId.toHexString()}:${kind}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" },
  );
  return row!.seq;
}

export async function nextNumber(store: Store, orgId: ObjectId, kind: string, prefix: string, width = 4): Promise<string> {
  return `${prefix}${String(await nextSeq(store, orgId, kind)).padStart(width, "0")}`;
}
