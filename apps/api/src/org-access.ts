import type { OrgRole, User } from "@invintel/shared";
import { createMiddleware } from "hono/factory";
import type { OrgDoc } from "./db.js";

export type OrgEnv = { Variables: { user: User; org: OrgDoc; role: OrgRole } };

export const ROLE_RANK: Record<OrgRole, number> = { member: 1, admin: 2, owner: 3 };

export const requireRole = (min: OrgRole) =>
  createMiddleware<OrgEnv>(async (c, next) => {
    if (ROLE_RANK[c.get("role")] < ROLE_RANK[min]) {
      return c.json({ error: "You need to be an admin of this organization to do that" }, 403);
    }
    await next();
  });
