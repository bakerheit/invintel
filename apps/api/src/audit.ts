import {
  AUDIT_FIELD_LABELS,
  formatAuditValue,
  type AuditAction,
  type AuditChange,
  type AuditEntityType,
  type AuditEvent,
  type AuditVerification,
} from "@invintel/shared";
import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { isDuplicateKey, type AuditEventDoc, type Store } from "./db.js";

/** The "previous hash" of the first event in every chain. */
export const GENESIS_HASH = "0".repeat(64);

/** JSON with sorted keys, so the same data always hashes the same no matter how it was built. */
export function canonicalize(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

/** Everything about an event that the hash covers (all of it except the hashes themselves). */
function payloadOf(e: Omit<AuditEventDoc, "_id" | "prevHash" | "hash">) {
  return {
    seq: e.seq,
    orgId: e.orgId.toHexString(),
    at: e.at.toISOString(),
    actor: { id: e.actor.id?.toHexString() ?? null, name: e.actor.name },
    action: e.action,
    entity: e.entity,
    summary: e.summary,
    changes: e.changes,
    snapshot: e.snapshot,
    refs: e.refs,
  };
}

export const auditActor = (user: { id: string; name: string }) => ({ id: new ObjectId(user.id), name: user.name });

export const itemEntity = (id: ObjectId, item: { name: string; sku: string }) => ({
  type: "item" as const,
  id: id.toHexString(),
  label: `${item.name} (${item.sku})`,
});

export const hashEvent = (prevHash: string, e: Omit<AuditEventDoc, "_id" | "prevHash" | "hash">) =>
  createHash("sha256").update(`${prevHash}\n${canonicalize(payloadOf(e))}`).digest("hex");

/** Round-trip through JSON so what we hash is exactly what MongoDB will hand back. */
const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export interface AuditInput {
  orgId: ObjectId;
  actor: { id: ObjectId | null; name: string };
  action: AuditAction;
  entity: { type: AuditEntityType; id: string; label: string };
  summary: string;
  changes?: AuditChange[];
  snapshot?: Record<string, unknown>;
  refs?: Record<string, unknown>;
}

const MAX_ATTEMPTS = 60;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Appends an event to the organization's chain. If two writers race for the same position, the
 * unique (orgId, seq) index lets one win and the other re-reads and tries again.
 *
 * This runs after the change it describes has been made. If it can't be written, the event is
 * logged in full for manual recovery rather than failing a request whose change already happened.
 */
export async function recordAudit(store: Store, input: AuditInput): Promise<AuditEventDoc | null> {
  const body = {
    orgId: input.orgId,
    at: new Date(),
    actor: input.actor,
    action: input.action,
    entity: input.entity,
    summary: input.summary,
    ...(input.changes?.length ? { changes: clean(input.changes) } : {}),
    ...(input.snapshot ? { snapshot: clean(input.snapshot) } : {}),
    ...(input.refs ? { refs: clean(input.refs) } : {}),
  };

  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const last = await store.audit.findOne({ orgId: input.orgId }, { sort: { seq: -1 }, projection: { seq: 1, hash: 1 } });
      const seq = (last?.seq ?? 0) + 1;
      const prevHash = last?.hash ?? GENESIS_HASH;
      const event: AuditEventDoc = {
        _id: new ObjectId(),
        ...body,
        seq,
        prevHash,
        hash: hashEvent(prevHash, { ...body, seq }),
      };
      try {
        await store.audit.insertOne(event);
        return event;
      } catch (e) {
        if (!isDuplicateKey(e)) throw e;
        await sleep(Math.random() * 8); // lost the race for this position; look again
      }
    }
    throw new Error("could not claim a position in the audit chain");
  } catch (e) {
    console.error("AUDIT WRITE FAILED. Record this event by hand:", JSON.stringify({ ...body, orgId: body.orgId.toHexString() }), e);
    return null;
  }
}

export function toAuditEvent(e: AuditEventDoc): AuditEvent {
  return {
    id: e._id.toHexString(),
    seq: e.seq,
    at: e.at.toISOString(),
    actor: { id: e.actor.id?.toHexString() ?? null, name: e.actor.name },
    action: e.action,
    entity: e.entity,
    summary: e.summary,
    ...(e.changes ? { changes: e.changes } : {}),
    ...(e.snapshot ? { snapshot: e.snapshot } : {}),
    ...(e.refs ? { refs: e.refs } : {}),
    prevHash: e.prevHash,
    hash: e.hash,
  };
}

/** Fields whose value actually differs. Only fields present in `after` are considered. */
export function diffFields(before: Record<string, unknown>, after: Record<string, unknown>): AuditChange[] {
  const changes: AuditChange[] = [];
  for (const [field, to] of Object.entries(after)) {
    if (to === undefined) continue;
    const from = before[field] ?? (Array.isArray(to) ? [] : "");
    if (canonicalize(from) !== canonicalize(to)) changes.push({ field, from, to });
  }
  return changes;
}

/** "Changed unit cost from $1.00 to $1.25; changed name from A to B". */
export const summarizeChanges = (changes: AuditChange[]) =>
  changes
    .map((c) => `changed ${AUDIT_FIELD_LABELS[c.field] ?? c.field} from ${formatAuditValue(c.field, c.from)} to ${formatAuditValue(c.field, c.to)}`)
    .join("; ")
    .replace(/^c/, "C");

/**
 * Walks the whole chain and recomputes every hash. Catches edited events and events removed from
 * the middle. It can't catch events removed from the very end, which is why the head hash is
 * shown: record it somewhere else and compare later.
 */
export async function verifyChain(store: Store, orgId: ObjectId): Promise<AuditVerification> {
  let expectedSeq = 1;
  let prevHash = GENESIS_HASH;
  let checked = 0;
  let problem: AuditVerification["problem"];
  let firstAt: Date | undefined;

  for await (const e of store.audit.find({ orgId }).sort({ seq: 1 })) {
    firstAt ??= e.at;
    if (!problem) {
      if (e.seq !== expectedSeq) {
        problem = { seq: expectedSeq, reason: `Event ${expectedSeq} is missing` };
      } else if (e.prevHash !== prevHash) {
        problem = { seq: e.seq, reason: "Doesn't link to the event before it" };
      } else if (hashEvent(prevHash, e) !== e.hash) {
        problem = { seq: e.seq, reason: "Contents don't match their hash, so it was changed after being recorded" };
      }
    }
    prevHash = e.hash;
    expectedSeq = e.seq + 1;
    checked++;
  }

  // Ledger entries made since the log began should each be mentioned by a stock event.
  let ledgerGaps = 0;
  if (firstAt) {
    const referenced = new Set<string>();
    for await (const e of store.audit.find({ orgId, "refs.movementIds": { $exists: true } }, { projection: { refs: 1 } })) {
      for (const id of (e.refs?.movementIds as string[] | undefined) ?? []) referenced.add(id);
    }
    for await (const m of store.movements.find({ orgId, createdAt: { $gte: firstAt } }, { projection: { _id: 1 } })) {
      if (!referenced.has(m._id.toHexString())) ledgerGaps++;
    }
  }

  return {
    ok: !problem,
    checked,
    headSeq: expectedSeq - 1,
    headHash: prevHash,
    ...(problem ? { problem } : {}),
    ledgerGaps,
  };
}

const csvCell = (v: unknown) => {
  const text = v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function auditCsvHeader() {
  return ["seq", "time", "actor", "action", "entity_type", "entity_id", "entity", "summary", "changes", "refs", "prev_hash", "hash"].join(",");
}

export function auditCsvRow(e: AuditEventDoc) {
  return [
    e.seq,
    e.at.toISOString(),
    e.actor.name,
    e.action,
    e.entity.type,
    e.entity.id,
    e.entity.label,
    e.summary,
    e.changes,
    e.refs,
    e.prevHash,
    e.hash,
  ]
    .map(csvCell)
    .join(",");
}
