import { z } from "zod";

const id = z.string().regex(/^[0-9a-f]{24}$/i, "Invalid id");

export const DEFAULT_DOWNTIME_REASONS = ["Breakdown", "Changeover", "Waiting for material", "No operator", "Planned maintenance", "Quality hold", "Other"] as const;

export const downtimeStartSchema = z.object({
  workCenterId: id,
  reason: z.string().trim().min(1, "Pick a reason").max(60),
  note: z.string().trim().max(300).default(""),
});
export type DowntimeStartInput = z.input<typeof downtimeStartSchema>;

export const downtimeSettingsSchema = z.object({
  /** The short list people pick from on the floor. */
  reasons: z.array(z.string().trim().min(1).max(60)).min(1).max(20).refine((r) => new Set(r.map((x) => x.toLowerCase())).size === r.length, "Each reason once"),
  /** Hours the machines are meant to run each day: the base for availability. */
  scheduledHoursPerDay: z.number().min(1).max(24),
});
export type DowntimeSettings = z.infer<typeof downtimeSettingsSchema>;

export interface DowntimeEvent {
  id: string;
  workCenterId: string;
  workCenterName: string;
  reason: string;
  note: string;
  startedAt: string;
  endedAt: string | null;
  startedBy: string;
  endedBy: string | null;
  /** Whole minutes so far (or in total, once ended). */
  minutes: number;
}

export interface DowntimeWorkCenterRow {
  workCenterId: string;
  name: string;
  events: number;
  downMinutes: number;
  scheduledMinutes: number;
  /** (scheduled - down) / scheduled, 0 to 100. A rough "OEE-lite": availability only, no speed or quality. */
  availabilityPct: number;
  topReason: string | null;
  downNow: { eventId: string; reason: string; since: string } | null;
}

export interface DowntimeSummary {
  windowDays: number;
  from: string;
  to: string;
  scheduledHoursPerDay: number;
  rows: DowntimeWorkCenterRow[];
  /** Minutes lost by reason across all work centers, biggest first. */
  byReason: { reason: string; minutes: number; events: number }[];
  totalDownMinutes: number;
}
