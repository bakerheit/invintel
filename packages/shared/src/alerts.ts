import { z } from "zod";

export const ALERT_TYPES = ["out_of_stock", "low_stock", "days_of_supply", "late_po", "count_overdue", "machine_down"] as const;
export type AlertType = (typeof ALERT_TYPES)[number];
export type AlertSeverity = "critical" | "warning";
export type AlertState = "open" | "acknowledged" | "snoozed";

export const alertSettingsSchema = z.object({
  /** Warn when an item that is being used up would run out within this many days at the last 30 days' pace. */
  daysOfSupply: z.number().int().min(1).max(90),
  /** A machine counts as a problem once it has been down this long. */
  machineDownMinutes: z.number().int().min(5).max(1440),
});
export type AlertSettings = z.infer<typeof alertSettingsSchema>;
export const DEFAULT_ALERT_SETTINGS: AlertSettings = { daysOfSupply: 7, machineDownMinutes: 60 };

export const alertKeySchema = z.object({ key: z.string().min(3).max(120) });
export const alertSnoozeSchema = z.object({ key: z.string().min(3).max(120), days: z.number().int().min(1).max(30) });

export interface Alert {
  /** Stable: `${type}:${subject id}`. The same problem keeps the same key, so an acknowledgement sticks to it. */
  key: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  detail: string;
  subject: { type: "item" | "purchase_order" | "location" | "work_center"; id: string; label: string };
  /** In-app path to deal with it. */
  link: string;
  state: AlertState;
  by: string | null;
  at: string | null;
  snoozedUntil: string | null;
}

export interface AlertsResponse {
  asOf: string;
  alerts: Alert[];
  /** Counts of alerts that are open (not acknowledged or snoozed). */
  open: { critical: number; warning: number; total: number };
}

/** What a daily email or chat digest would say. Nothing is sent: this is the preview of it. */
export interface DigestPreview {
  asOf: string;
  subject: string;
  text: string;
  sections: { title: string; lines: string[] }[];
}
