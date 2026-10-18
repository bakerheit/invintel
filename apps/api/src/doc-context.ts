import { DEFAULT_COMPANY, companyProfileSchema, docTemplateSchema, resolveTemplate, type DocKind } from "@invintel/shared";
import type { ObjectId } from "mongodb";
import type { Store } from "./db.js";
import type { DocContext } from "./doc-pdf.js";
import { plainContext } from "./doc-render.js";
import { readImage } from "./image.js";
import type { PdfImage } from "./pdf.js";

// INV-17: what a document is drawn with: the organization's letterhead, the template for that kind of document, the trading partner's
// adjustments, and the logo. Bridges can't reach the database, so the app registers this loader once and the email bridge asks it.

const logos = new Map<string, PdfImage | null>(); // by hash: decoding a PNG is the expensive part, and a logo hardly ever changes

async function logoOf(store: Store, orgId: ObjectId): Promise<PdfImage | null> {
  const doc = await store.docLogos.findOne({ orgId });
  if (!doc) return null;
  if (!logos.has(doc.hash)) {
    const r = readImage(Buffer.from(doc.bytes.buffer));
    if (logos.size > 50) logos.clear();
    logos.set(doc.hash, r.ok ? r.pdf : null);
  }
  return logos.get(doc.hash) ?? null;
}

/** The drawing context for one document: saved settings, then the partner's overrides. `draft` lets the preview use values not saved yet. */
export async function loadDocContext(
  store: Store, orgId: ObjectId, kind: DocKind, partnerId?: ObjectId | null,
  draft: { company?: unknown; template?: unknown; override?: unknown } = {},
): Promise<DocContext> {
  const [org, partner, logo] = await Promise.all([
    store.orgs.findOne({ _id: orgId }, { projection: { name: 1, documentProfile: 1 } }),
    partnerId ? store.tradingPartners.findOne({ _id: partnerId, orgId }, { projection: { docTemplates: 1 } }) : null,
    logoOf(store, orgId),
  ]);
  const saved = org?.documentProfile;
  const company = companyProfileSchema.parse(draft.company ?? saved?.company ?? DEFAULT_COMPANY);
  const orgTemplate = draft.template !== undefined ? docTemplateSchema.parse(draft.template) : saved?.templates?.[kind];
  const template = resolveTemplate(kind, orgTemplate, (draft.override as object | undefined) ?? partner?.docTemplates?.[kind]);
  return { kind, company: { ...company, name: company.name.trim() || org?.name || "Your company" }, template, logo };
}

/** The name documents are issued under: the letterhead's company name, or the organization's own. */
export const issuerName = (org: { name: string; documentProfile?: { company?: { name?: string } } } | null | undefined) => org?.documentProfile?.company?.name?.trim() || org?.name || "";

type Loader = (orgId: ObjectId, partnerId: ObjectId | null, kind: DocKind) => Promise<DocContext>;
let loader: Loader | null = null;
export const registerDocContextLoader = (store: Store) => { loader = (orgId, partnerId, kind) => loadDocContext(store, orgId, kind, partnerId); };

/** For bridges: the context for a document going to this partner. With no loader registered (a bare test) it is the plain look. */
export async function docContextFor(orgId: ObjectId, partnerId: ObjectId | null, kind: DocKind, fallbackName: string): Promise<DocContext> {
  try {
    if (loader) return await loader(orgId, partnerId, kind);
  } catch { /* fall through to the plain look: a document should still go out */ }
  return plainContext(kind, fallbackName);
}
