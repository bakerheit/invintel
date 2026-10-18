import { zValidator } from "@hono/zod-validator";
import { DEFAULT_HOLD_REASONS, DEFAULT_SCRAP_REASONS, reasonsUpdateSchema, type Reasons } from "@invintel/shared";
import { Hono } from "hono";
import { auditActor, recordAudit } from "./audit.js";
import type { OrgDoc, Store } from "./db.js";
import { requireRole, type OrgEnv } from "./org-access.js";

export const scrapReasonsOf = (org: Pick<OrgDoc, "scrapReasons">) => org.scrapReasons ?? [...DEFAULT_SCRAP_REASONS];
export const holdReasonsOf = (org: Pick<OrgDoc, "holdReasons">) => org.holdReasons ?? [...DEFAULT_HOLD_REASONS];

/** The spelling the list uses for a reason someone typed or picked, or null if it isn't on the list. */
export const matchReason = (list: string[], reason: string) => list.find((x) => x.toLowerCase() === reason.trim().toLowerCase()) ?? null;

export function createReasonRoutes(store: Store) {
  const r = new Hono<OrgEnv>();

  r.get("/", (c) => c.json<Reasons>({ scrap: scrapReasonsOf(c.get("org")), hold: holdReasonsOf(c.get("org")) }));

  r.put("/", requireRole("admin"), zValidator("json", reasonsUpdateSchema), async (c) => {
    const org = c.get("org");
    const patch = c.req.valid("json");
    const $set: Partial<Pick<OrgDoc, "scrapReasons" | "holdReasons">> = {};
    const changes: { field: string; from: unknown; to: unknown }[] = [];
    if (patch.scrap) { $set.scrapReasons = patch.scrap; changes.push({ field: "scrapReasons", from: scrapReasonsOf(org), to: patch.scrap }); }
    if (patch.hold) { $set.holdReasons = patch.hold; changes.push({ field: "holdReasons", from: holdReasonsOf(org), to: patch.hold }); }
    await store.orgs.updateOne({ _id: org._id }, { $set });
    await recordAudit(store, {
      orgId: org._id, actor: auditActor(c.get("user")), action: "reasons.changed", entity: { type: "organization", id: org._id.toHexString(), label: org.name },
      summary: `Changed the ${[patch.scrap && "scrap", patch.hold && "quality hold"].filter(Boolean).join(" and ")} reason list`, changes,
    });
    const fresh = (await store.orgs.findOne({ _id: org._id }))!;
    return c.json<Reasons>({ scrap: scrapReasonsOf(fresh), hold: holdReasonsOf(fresh) });
  });

  return r;
}
