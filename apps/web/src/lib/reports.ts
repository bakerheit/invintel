import { BarChart3, ClipboardCheck, Hourglass, type LucideIcon } from "lucide-react";

export interface ReportEntry {
  /** Path under /o/:orgId/reports. */
  path: string;
  title: string;
  description: string;
  icon: LucideIcon;
}

/**
 * Every report registers here and shows up on the Reports page. To add one, add an entry, a route in main.tsx,
 * and a page under pages/reports/. Keep descriptions to one plain sentence about the question it answers.
 */
export const REPORTS: ReportEntry[] = [
  { path: "aging", title: "Stock aging", description: "What hasn't moved in months, and how much money is sitting there.", icon: Hourglass },
  { path: "counting", title: "Counting: accuracy and schedule", description: "How well counts match the system, and which places are due for a count.", icon: ClipboardCheck },
];

export const reportsIcon: LucideIcon = BarChart3;
