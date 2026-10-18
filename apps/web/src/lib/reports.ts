import type { OrgModules } from "@invintel/shared";
import { BarChart3, ClipboardCheck, GitBranch, Hourglass, PowerOff, type LucideIcon } from "lucide-react";

export interface ReportEntry {
  /** Path under /o/:orgId/reports. */
  path: string;
  title: string;
  description: string;
  icon: LucideIcon;
  /** Hidden when this part of the app is switched off in Settings > Features. */
  module?: keyof OrgModules;
}

/**
 * Every report registers here and shows up on the Reports page. To add one, add an entry, a route in main.tsx,
 * and a page under pages/reports/. Keep descriptions to one plain sentence about the question it answers.
 */
export const REPORTS: ReportEntry[] = [
  { path: "aging", title: "Stock aging", description: "What hasn't moved in months, and how much money is sitting there.", icon: Hourglass },
  { path: "counting", title: "Counting: accuracy and schedule", description: "How well counts match the system, and which places are due for a count.", icon: ClipboardCheck },
  { path: "trace", title: "Lot trace and mock recall", description: "Where a supplier lot went, or what went into a finished pallet, and how fast you can answer.", icon: GitBranch },
  { path: "downtime", title: "Downtime and availability", description: "How long each machine was down, why, and a rough availability figure.", icon: PowerOff, module: "production" },
];

export const reportsIcon: LucideIcon = BarChart3;
