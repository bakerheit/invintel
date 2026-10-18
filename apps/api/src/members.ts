import { zValidator } from "@hono/zod-validator";
import { memberRoleInputSchema, objectIdSchema } from "@invintel/shared";
import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { Store } from "./db.js";
import { ROLE_RANK, type OrgEnv } from "./org-access.js";

const params = z.object({ userId: objectIdSchema });

/**
 * Who can do what to whom:
 *  - Only the owner changes roles (promote to admin, back to member).
 *  - The owner can remove anyone but themselves. An admin can remove members. Anyone can leave, except the owner.
 *  - Nobody can touch the owner. Ownership is not transferable yet.
 */
export function createMemberRoutes(store: Store) {
  const r = new Hono<OrgEnv>();

  const target = async (c: { get: (k: "org") => { _id: ObjectId } }, userId: string) =>
    store.memberships.findOne({ orgId: c.get("org")._id, userId: new ObjectId(userId) });

  r.patch("/:userId", zValidator("param", params), zValidator("json", memberRoleInputSchema), async (c) => {
    if (c.get("role") !== "owner") return c.json({ error: "Only the owner can change roles" }, 403);
    const m = await target(c, c.req.valid("param").userId);
    if (!m) return c.json({ error: "Member not found" }, 404);
    if (m.role === "owner") return c.json({ error: "The owner's role can't be changed" }, 409);
    await store.memberships.updateOne({ _id: m._id }, { $set: { role: c.req.valid("json").role } });
    return c.json({ userId: m.userId.toHexString(), role: c.req.valid("json").role });
  });

  r.delete("/:userId", zValidator("param", params), async (c) => {
    const me = c.get("user").id;
    const { userId } = c.req.valid("param");
    const m = await target(c, userId);
    if (!m) return c.json({ error: "Member not found" }, 404);
    if (m.role === "owner") return c.json({ error: "The owner can't be removed or leave" }, 409);
    const leaving = userId === me;
    // Removing someone else needs a higher rank than they have.
    if (!leaving && ROLE_RANK[c.get("role")] <= ROLE_RANK[m.role]) {
      return c.json({ error: m.role === "admin" ? "Only the owner can remove an admin" : "You need to be an admin to remove people" }, 403);
    }
    await store.memberships.deleteOne({ _id: m._id });
    return c.body(null, 204);
  });

  return r;
}
