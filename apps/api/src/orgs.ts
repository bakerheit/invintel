import { zValidator } from "@hono/zod-validator";
import {
  joinOrganizationInputSchema,
  organizationInputSchema,
  type OrgMember,
} from "@invintel/shared";
import { Hono } from "hono";
import { ObjectId } from "mongodb";
import type { Store } from "./db.js";
import { createItemRoutes } from "./items.js";
import { createLocationRoutes } from "./locations.js";
import { ROLE_RANK, requireRole, type OrgEnv } from "./org-access.js";
import {
  createOrganization,
  findOrgByJoinCode,
  joinOrganization,
  listOrgSummaries,
  rotateJoinCode,
  summarizeOrg,
} from "./org-service.js";
import { FailureLimiter } from "./ratelimit.js";

export function createOrgRoutes(store: Store) {
  const orgs = new Hono<OrgEnv>();
  const joinLimiter = new FailureLimiter(10, 15 * 60 * 1000);

  orgs.get("/", async (c) => c.json(await listOrgSummaries(store, new ObjectId(c.get("user").id))));

  orgs.post("/", zValidator("json", organizationInputSchema), async (c) => {
    const userId = new ObjectId(c.get("user").id);
    const org = await createOrganization(store, userId, c.req.valid("json").name);
    return c.json(await summarizeOrg(store, org, "owner"), 201);
  });

  orgs.post("/join", zValidator("json", joinOrganizationInputSchema), async (c) => {
    const user = c.get("user");
    if (joinLimiter.isLocked(user.id)) {
      return c.json({ error: "Too many wrong join codes. Try again in a few minutes." }, 429);
    }
    const org = await findOrgByJoinCode(store, c.req.valid("json").joinCode);
    if (!org) {
      joinLimiter.fail(user.id);
      return c.json({ error: "That join code isn't valid" }, 400);
    }
    const joined = await joinOrganization(store, new ObjectId(user.id), org);
    return c.json(await summarizeOrg(store, org, joined.role), joined.created ? 201 : 200);
  });

  // Everything below is scoped to one organization and only visible to its members.
  const scoped = new Hono<OrgEnv>();

  scoped.use("*", async (c, next) => {
    const raw = c.req.param("orgId") ?? "";
    // Non-members get the same 404 as a missing org so ids can't be probed.
    if (!/^[0-9a-f]{24}$/i.test(raw)) return c.json({ error: "Organization not found" }, 404);
    const membership = await store.memberships.findOne({
      orgId: new ObjectId(raw),
      userId: new ObjectId(c.get("user").id),
    });
    const org = membership && (await store.orgs.findOne({ _id: membership.orgId }));
    if (!membership || !org) return c.json({ error: "Organization not found" }, 404);
    c.set("org", org);
    c.set("role", membership.role);
    await next();
  });

  scoped.get("/", async (c) => c.json(await summarizeOrg(store, c.get("org"), c.get("role"))));

  scoped.patch("/", requireRole("admin"), zValidator("json", organizationInputSchema), async (c) => {
    const org = await store.orgs.findOneAndUpdate(
      { _id: c.get("org")._id },
      { $set: { name: c.req.valid("json").name } },
      { returnDocument: "after" },
    );
    return c.json(await summarizeOrg(store, org!, c.get("role")));
  });

  scoped.post("/join-code", requireRole("admin"), async (c) => {
    const org = await rotateJoinCode(store, c.get("org")._id);
    return c.json(await summarizeOrg(store, org!, c.get("role")));
  });

  scoped.get("/members", async (c) => {
    const memberships = await store.memberships.find({ orgId: c.get("org")._id }).toArray();
    const users = await store.users.find({ _id: { $in: memberships.map((m) => m.userId) } }).toArray();
    const byId = new Map(users.map((u) => [u._id.toHexString(), u]));
    const members: OrgMember[] = memberships.flatMap((m) => {
      const u = byId.get(m.userId.toHexString());
      return u
        ? [{ userId: u._id.toHexString(), name: u.name, email: u.email, role: m.role, joinedAt: m.createdAt.toISOString() }]
        : [];
    });
    members.sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role] || a.name.localeCompare(b.name));
    return c.json(members);
  });

  scoped.route("/locations", createLocationRoutes(store));
  scoped.route("/items", createItemRoutes(store));

  orgs.route("/:orgId", scoped);
  return orgs;
}
