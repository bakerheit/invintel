import type { Location, LocationType } from "@invintel/shared";
import { Factory, Layers, PackageCheck, Send, ShieldAlert, Truck, Warehouse, type LucideIcon } from "lucide-react";

export const LOCATION_TYPE_META: Record<LocationType, { label: string; hint: string; icon: LucideIcon; className: string }> = {
  receiving: { label: "Receiving", hint: "Where deliveries arrive", icon: Truck, className: "bg-accent text-accent-foreground" },
  storage: { label: "Storage", hint: "Shelves, racks and bins", icon: Warehouse, className: "bg-secondary text-secondary-foreground" },
  wip: { label: "Work in progress", hint: "Between production steps", icon: Layers, className: "bg-warning-soft text-warning" },
  production: { label: "Production", hint: "At a machine or line", icon: Factory, className: "bg-success-soft text-success" },
  finished: { label: "Finished goods", hint: "Ready to ship", icon: PackageCheck, className: "bg-success-soft text-success" },
  shipping: { label: "Shipping", hint: "Dock and staging for outbound", icon: Send, className: "bg-accent text-accent-foreground" },
  quarantine: { label: "Quality hold", hint: "Stock waiting for a quality decision", icon: ShieldAlert, className: "bg-destructive/10 text-destructive dark:bg-destructive/20" },
};

export interface LocationNode {
  location: Location;
  children: LocationNode[];
  depth: number;
  /** Units in this location and everything inside it. */
  totalUnits: number;
}

/** Turns the flat list into a tree. Orphans (a parent we can't see) are shown at the top. */
export function buildTree(locations: Location[]): LocationNode[] {
  const ids = new Set(locations.map((l) => l.id));
  const byParent = new Map<string | null, Location[]>();
  for (const l of locations) {
    const key = l.parentId && ids.has(l.parentId) ? l.parentId : null;
    byParent.set(key, [...(byParent.get(key) ?? []), l]);
  }
  const build = (parent: string | null, depth: number): LocationNode[] =>
    (byParent.get(parent) ?? [])
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((location) => {
        const children = build(location.id, depth + 1);
        return {
          location,
          children,
          depth,
          totalUnits: location.unitCount + children.reduce((sum, c) => sum + c.totalUnits, 0),
        };
      });
  return build(null, 0);
}

/** The location itself plus everything inside it. */
export function withDescendants(locations: Location[], id: string): string[] {
  const out = [id];
  for (let i = 0; i < out.length; i++) {
    for (const l of locations) if (l.parentId === out[i]) out.push(l.id);
  }
  return out;
}
