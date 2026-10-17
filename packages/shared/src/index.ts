import { z } from "zod";

export const itemInputSchema = z.object({
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).default(""),
  category: z.string().trim().max(100).default(""),
  location: z.string().trim().max(100).default(""),
  quantity: z.number().int().min(0).default(0),
  reorderLevel: z.number().int().min(0).default(0),
  unitCostCents: z.number().int().min(0).default(0),
});

export type ItemInput = z.infer<typeof itemInputSchema>;

export const itemUpdateSchema = itemInputSchema.partial();
export type ItemUpdate = z.infer<typeof itemUpdateSchema>;

export interface Item extends ItemInput {
  id: number;
  createdAt: string;
  updatedAt: string;
}

export const adjustmentInputSchema = z.object({
  delta: z.number().int().refine((n) => n !== 0, "delta must not be 0"),
  reason: z.string().trim().max(200).default(""),
});
export type AdjustmentInput = z.infer<typeof adjustmentInputSchema>;

export interface StockMovement {
  id: number;
  itemId: number;
  delta: number;
  reason: string;
  createdAt: string;
}
