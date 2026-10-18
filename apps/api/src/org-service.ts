import type { OrgRole, OrgSummary } from "@invintel/shared";
import { randomInt } from "node:crypto";
import { ObjectId } from "mongodb";
import { recordAudit } from "./audit.js";
import { isDuplicateKey, type OrgDoc, type Store } from "./db.js";

// No 0/O/1/I/L so codes survive being read out loud or copied by hand.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

export const generateJoinCode = () =>
  Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");

export const DEFAULT_LOCATION_NAME = "Main";

const canSeeJoinCode = (role: OrgRole) => role !== "member";

export function toOrgSummary(org: OrgDoc, role: OrgRole, memberCount: number): OrgSummary {
  return {
    id: org._id.toHexString(),
    name: org.name,
    role,
    ...(canSeeJoinCode(role) ? { joinCode: org.joinCode } : {}),
    memberCount,
    createdAt: org.createdAt.toISOString(),
  };
}

export async function summarizeOrg(store: Store, org: OrgDoc, role: OrgRole) {
  const memberCount = await store.memberships.countDocuments({ orgId: org._id });
  return toOrgSummary(org, role, memberCount);
}

export async function listOrgSummaries(store: Store, userId: ObjectId): Promise<OrgSummary[]> {
  const memberships = await store.memberships.find({ userId }).toArray();
  if (!memberships.length) return [];
  const ids = memberships.map((m) => m.orgId);
  const [orgs, counts] = await Promise.all([
    store.orgs.find({ _id: { $in: ids } }).toArray(),
    store.memberships
      .aggregate<{ _id: ObjectId; n: number }>([
        { $match: { orgId: { $in: ids } } },
        { $group: { _id: "$orgId", n: { $sum: 1 } } },
      ])
      .toArray(),
  ]);
  const roleByOrg = new Map(memberships.map((m) => [m.orgId.toHexString(), m.role]));
  const countByOrg = new Map(counts.map((c) => [c._id.toHexString(), c.n]));
  return orgs
    .map((o) =>
      toOrgSummary(o, roleByOrg.get(o._id.toHexString())!, countByOrg.get(o._id.toHexString()) ?? 0),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Creates the org, makes the user its owner, and gives it a first location to hold stock. */
export async function createOrganization(store: Store, userId: ObjectId, userName: string, name: string) {
  const now = new Date();
  const org: OrgDoc = { _id: new ObjectId(), name, joinCode: "", createdBy: userId, createdAt: now };
  for (let attempt = 0; ; attempt++) {
    org.joinCode = generateJoinCode();
    try {
      await store.orgs.insertOne(org);
      break;
    } catch (e) {
      if (!isDuplicateKey(e) || attempt >= 4) throw e;
    }
  }
  await store.memberships.insertOne({
    _id: new ObjectId(),
    orgId: org._id,
    userId,
    role: "owner",
    createdAt: now,
  });
  await store.locations.insertOne({
    _id: new ObjectId(),
    orgId: org._id,
    name: DEFAULT_LOCATION_NAME,
    description: "",
    type: "storage",
    parentId: null,
    code: "",
    createdAt: now,
    updatedAt: now,
  });
  await recordAudit(store, {
    orgId: org._id,
    actor: { id: userId, name: userName },
    action: "organization.created",
    entity: { type: "organization", id: org._id.toHexString(), label: org.name },
    summary: `Created organization ${org.name}`,
    snapshot: { name: org.name, owner: userName, defaultLocation: DEFAULT_LOCATION_NAME },
  });
  return org;
}

export const findOrgByJoinCode = (store: Store, joinCode: string) => store.orgs.findOne({ joinCode });

/** Adds the user as a member. Joining twice is harmless and keeps their existing role. */
export async function joinOrganization(store: Store, userId: ObjectId, userName: string, org: OrgDoc, via: string) {
  try {
    await store.memberships.insertOne({
      _id: new ObjectId(),
      orgId: org._id,
      userId,
      role: "member",
      createdAt: new Date(),
    });
    await recordAudit(store, {
      orgId: org._id,
      actor: { id: userId, name: userName },
      action: "member.joined",
      entity: { type: "member", id: userId.toHexString(), label: userName },
      summary: `${userName} joined as a member (${via})`,
      snapshot: { role: "member", via },
    });
    return { role: "member" as OrgRole, created: true };
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
    const existing = await store.memberships.findOne({ orgId: org._id, userId });
    return { role: existing!.role, created: false };
  }
}

export async function rotateJoinCode(store: Store, orgId: ObjectId) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await store.orgs.findOneAndUpdate(
        { _id: orgId },
        { $set: { joinCode: generateJoinCode() } },
        { returnDocument: "after" },
      );
    } catch (e) {
      if (!isDuplicateKey(e) || attempt >= 4) throw e;
    }
  }
}
