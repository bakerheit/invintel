// The full-data archive: one JSON file with everything an organization has, so it can be kept, moved or restored.

export const ARCHIVE_FORMAT = "invintel-archive";
export const ARCHIVE_VERSION = 1;

/** The collections in an archive, with the names people see. */
export const ARCHIVE_COLLECTIONS = {
  locations: "Locations",
  items: "Items",
  stock: "Stock levels",
  units: "Rolls and pallets",
  movements: "Ledger entries",
  suppliers: "Suppliers",
  purchaseOrders: "Purchase orders",
  workCenters: "Work centers",
  boms: "Recipes (BOMs)",
  workOrders: "Work orders",
  counts: "Counts",
  ncrs: "Quality holds (NCRs)",
  drills: "Recall drills",
  downtime: "Downtime log",
  importBatches: "Import history",
} as const;
export type ArchiveCollection = keyof typeof ARCHIVE_COLLECTIONS;

export interface ArchiveSummary {
  format: typeof ARCHIVE_FORMAT;
  version: number;
  exportedAt: string;
  organizationName: string;
  /** Documents per collection. */
  counts: Record<string, number>;
  /** Organization settings carried in the archive (feature switches, pick-lists, approval rules...). */
  settings: string[];
}

export interface ArchiveRestoreResult extends ArchiveSummary {
  /** True when nothing was written: this is the check. */
  dryRun: boolean;
  /** Set when the archive is fine but can't be restored here (the organization already has data). */
  blocked: string | null;
}
