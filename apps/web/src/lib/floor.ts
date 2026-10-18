import type { Item, Location } from "@invintel/shared";
import { api } from "@/lib/api";

type Resolved<T> = { ok: true; value: T } | { ok: false; error: string };

const describe = (kind: "item" | "location") => (kind === "item" ? "an item" : "a location");

/** Turn whatever the scanner read into an item, or an error worth showing to someone in gloves. */
export async function resolveItem(orgId: string, code: string): Promise<Resolved<Item>> {
  const r = await api.lookup(orgId, code);
  if (r.kind === "none") return { ok: false, error: `Nothing matches "${code}"` };
  if (r.kind !== "item") return { ok: false, error: `That's ${describe(r.kind)}. Scan an item.` };
  return { ok: true, value: r.item };
}

export async function resolveLocation(orgId: string, code: string): Promise<Resolved<Location>> {
  const r = await api.lookup(orgId, code);
  if (r.kind === "none") return { ok: false, error: `Nothing matches "${code}"` };
  if (r.kind !== "location") return { ok: false, error: `That's ${describe(r.kind)}. Scan a location.` };
  return { ok: true, value: r.location };
}
