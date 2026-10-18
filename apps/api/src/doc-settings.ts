import { zValidator } from "@hono/zod-validator";
import {
  DOC_KINDS, DOC_LABELS, cleanColumns, companyProfileSchema, docPreviewSchema, documentSettingsUpdateSchema, logoUploadSchema, resolveTemplate,
  type DocKind, type DocTemplate, type DocumentSettings,
} from "@invintel/shared";
import { Binary, ObjectId } from "mongodb";
import { Hono } from "hono";
import { auditActor, recordAudit } from "./audit.js";
import type { Store } from "./db.js";
import { loadDocContext } from "./doc-context.js";
import { renderDocument, sampleDoc } from "./doc-render.js";
import { readImage } from "./image.js";
import { requireRole, type OrgEnv } from "./org-access.js";
import { createHash } from "node:crypto";

/** The routes for the letterhead, the templates, the logo and the live preview (INV-17). Admins change them; every member can read them. */
export function createDocumentRoutes(store: Store) {
  const r = new Hono<OrgEnv>();

  const settingsOf = async (orgId: ObjectId): Promise<DocumentSettings> => {
    const [org, logo] = await Promise.all([store.orgs.findOne({ _id: orgId }, { projection: { name: 1, documentProfile: 1 } }), store.docLogos.findOne({ orgId }, { projection: { width: 1, height: 1, contentType: 1, bytes: 1 } })]);
    const saved = org?.documentProfile;
    return {
      company: companyProfileSchema.parse(saved?.company ?? {}),
      orgName: org?.name ?? "",
      templates: Object.fromEntries(DOC_KINDS.map((k) => [k, resolveTemplate(k, saved?.templates?.[k])])) as Record<DocKind, DocTemplate>,
      logo: logo ? { width: logo.width, height: logo.height, contentType: logo.contentType, bytes: logo.bytes.length() } : null,
    };
  };

  r.get("/settings", async (c) => c.json(await settingsOf(c.get("org")._id)));

  r.put("/settings", requireRole("admin"), zValidator("json", documentSettingsUpdateSchema), async (c) => {
    const org = c.get("org");
    const input = c.req.valid("json");
    const before = await settingsOf(org._id);
    const company = input.company ?? before.company;
    const templates: Partial<Record<DocKind, DocTemplate>> = Object.fromEntries(DOC_KINDS.map((k) => {
      const t = input.templates?.[k] ?? before.templates[k];
      return [k, { ...t, columns: cleanColumns(k, t.columns) }];
    }));
    await store.orgs.updateOne({ _id: org._id }, { $set: { documentProfile: { company, templates } } });
    const changed = [
      ...(JSON.stringify(company) !== JSON.stringify(before.company) ? ["the letterhead"] : []),
      ...DOC_KINDS.filter((k) => JSON.stringify(templates[k]) !== JSON.stringify(before.templates[k])).map((k) => `the ${DOC_LABELS[k].toLowerCase()} template`),
    ];
    if (changed.length) {
      await recordAudit(store, {
        orgId: org._id, actor: auditActor(c.get("user")), action: "organization.documents_changed", entity: { type: "organization", id: org._id.toHexString(), label: org.name },
        summary: `Changed ${changed.join(", ")}`, changes: [{ field: "documents", from: changed.length, to: changed }],
      });
    }
    return c.json(await settingsOf(org._id));
  });

  /** The logo arrives as base64 in JSON (small, and the type is decided by what the bytes are). */
  r.post("/logo", requireRole("admin"), zValidator("json", logoUploadSchema), async (c) => {
    const org = c.get("org");
    const b64 = c.req.valid("json").contentBase64.replace(/^data:[^,]*,/, "");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return c.json({ error: "That isn't an image file." }, 400);
    const bytes = Buffer.from(b64, "base64");
    const img = readImage(bytes);
    if (!img.ok) return c.json({ error: img.error }, 400);
    await store.docLogos.updateOne(
      { orgId: org._id },
      { $set: { contentType: img.contentType, width: img.width, height: img.height, bytes: new Binary(bytes), hash: createHash("sha256").update(bytes).digest("hex"), uploadedBy: auditActor(c.get("user")), createdAt: new Date() }, $setOnInsert: { _id: new ObjectId(), orgId: org._id } },
      { upsert: true },
    );
    await recordAudit(store, { orgId: org._id, actor: auditActor(c.get("user")), action: "organization.documents_changed", entity: { type: "organization", id: org._id.toHexString(), label: org.name }, summary: `Set the logo on documents (${img.kind.toUpperCase()}, ${img.width}x${img.height})` });
    return c.json(await settingsOf(org._id));
  });

  r.delete("/logo", requireRole("admin"), async (c) => {
    const org = c.get("org");
    const gone = await store.docLogos.deleteOne({ orgId: org._id });
    if (gone.deletedCount) await recordAudit(store, { orgId: org._id, actor: auditActor(c.get("user")), action: "organization.documents_changed", entity: { type: "organization", id: org._id.toHexString(), label: org.name }, summary: "Removed the logo from documents" });
    return c.json(await settingsOf(org._id));
  });

  /** The logo itself, for the settings screen. Served as an image that can't do anything else. */
  r.get("/logo", async (c) => {
    const logo = await store.docLogos.findOne({ orgId: c.get("org")._id });
    if (!logo) return c.json({ error: "No logo" }, 404);
    return new Response(Buffer.from(logo.bytes.buffer), {
      headers: { "content-type": logo.contentType, "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; img-src 'self'", "cache-control": "private, max-age=60", "content-disposition": "inline" },
    });
  });

  /** A sample document (fictional data) drawn with the values on the screen, saved or not, so the look can be judged before it is kept. */
  r.post("/preview", requireRole("admin"), zValidator("json", docPreviewSchema), async (c) => {
    const org = c.get("org");
    const { kind, company, template, override } = c.req.valid("json");
    const ctx = await loadDocContext(store, org._id, kind, null, { company, template, override });
    const pdf = renderDocument(sampleDoc(kind, { name: ctx.company.name, taxRateBps: ctx.company.taxRateBps, paymentTermsDays: ctx.company.paymentTermsDays, taxLabel: ctx.company.taxLabel }), ctx);
    return new Response(new Uint8Array(pdf), { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${kind}-preview.pdf"`, "x-content-type-options": "nosniff", "cache-control": "no-store" } });
  });

  return r;
}
