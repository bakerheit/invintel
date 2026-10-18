import { zValidator } from "@hono/zod-validator";
import {
  DEFAULT_MODULES,
  joinOrganizationInputSchema,
  organizationInputSchema,
  orgModulesUpdateSchema,
  type OrgMember,
} from "@invintel/shared";
import { Hono } from "hono";
import { ObjectId } from "mongodb";
import type { Store } from "./db.js";
import { createActivityRoutes } from "./activity.js";
import { createAuditRoutes } from "./audit-routes.js";
import { createUnitRoutes } from "./unit-routes.js";
import { auditActor, recordAudit } from "./audit.js";
import { createFloorRoutes } from "./floor.js";
import { createItemRoutes } from "./items.js";
import { createDataRoutes } from "./data.js";
import { createLocationRoutes } from "./locations.js";
import { createMemberRoutes } from "./members.js";
import { createOverviewRoutes } from "./overview.js";
import { createProductionRoutes } from "./production.js";
import { createPurchasingRoutes } from "./purchasing.js";
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
    const org = await createOrganization(store, userId, c.get("user").name, c.req.valid("json").name);
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
    const joined = await joinOrganization(store, new ObjectId(user.id), user.name, org, "used the join code");
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
    const before = c.get("org");
    const org = await store.orgs.findOneAndUpdate(
      { _id: before._id },
      { $set: { name: c.req.valid("json").name } },
      { returnDocument: "after" },
    );
    if (org!.name !== before.name) {
      await recordAudit(store, {
        orgId: before._id,
        actor: auditActor(c.get("user")),
        action: "organization.renamed",
        entity: { type: "organization", id: before._id.toHexString(), label: org!.name },
        summary: `Renamed the organization from ${before.name} to ${org!.name}`,
        changes: [{ field: "name", from: before.name, to: org!.name }],
      });
    }
    return c.json(await summarizeOrg(store, org!, c.get("role")));
  });

  scoped.patch("/modules", requireRole("admin"), zValidator("json", orgModulesUpdateSchema), async (c) => {
    const before = c.get("org");
    const patch = c.req.valid("json");
    const org = await store.orgs.findOneAndUpdate(
      { _id: before._id },
      { $set: Object.fromEntries(Object.entries(patch).map(([k, v]) => [`modules.${k}`, v])) },
      { returnDocument: "after" },
    );
    const was = { ...DEFAULT_MODULES, ...before.modules };
    const changes = Object.entries(patch).filter(([k, v]) => was[k as keyof typeof was] !== v).map(([field, to]) => ({ field, from: was[field as keyof typeof was], to }));
    if (changes.length) {
      await recordAudit(store, {
        orgId: before._id,
        actor: auditActor(c.get("user")),
        action: "organization.modules_changed",
        entity: { type: "organization", id: before._id.toHexString(), label: org!.name },
        summary: changes.map((x) => `${x.to ? "Turned on" : "Turned off"} ${x.field}`).join(", "),
        changes,
      });
    }
    return c.json(await summarizeOrg(store, org!, c.get("role")));
  });

  scoped.post("/join-code", requireRole("admin"), async (c) => {
    const org = await rotateJoinCode(store, c.get("org")._id);
    // The codes themselves are credentials, so the log records that it happened, not what they were.
    await recordAudit(store, {
      orgId: org!._id,
      actor: auditActor(c.get("user")),
      action: "organization.join_code_rotated",
      entity: { type: "organization", id: org!._id.toHexString(), label: org!.name },
      summary: "Generated a new join code. The old one no longer works",
    });
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

  scoped.route("/data", createDataRoutes(store));
  scoped.route("/members", createMemberRoutes(store));
  scoped.route("/purchasing", createPurchasingRoutes(store));
  scoped.route("/overview", createOverviewRoutes(store));
  scoped.route("/locations", createLocationRoutes(store));
  scoped.route("/movements", createActivityRoutes(store));
  scoped.route("/audit", createAuditRoutes(store));
  scoped.route("/units", createUnitRoutes(store));
  scoped.route("/", createFloorRoutes(store));
  scoped.route("/items", createItemRoutes(store));
  scoped.route("/production", createProductionRoutes(store));

  orgs.route("/:orgId", scoped);
  return orgs;
}
