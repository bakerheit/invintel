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
  id: string;
  createdAt: string;
  updatedAt: string;
}

export const adjustmentInputSchema = z.object({
  delta: z.number().int().refine((n) => n !== 0, "delta must not be 0"),
  reason: z.string().trim().max(200).default(""),
});
export type AdjustmentInput = z.infer<typeof adjustmentInputSchema>;

export interface StockMovement {
  id: string;
  itemId: string;
  delta: number;
  reason: string;
  createdAt: string;
}

export const registerInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  password: z.string().min(8, "Password must be at least 8 characters").max(128),
});
export type RegisterInput = z.infer<typeof registerInputSchema>;

export const loginInputSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(1).max(128),
});
export type LoginInput = z.infer<typeof loginInputSchema>;

export interface User {
  id: string;
  name: string;
  email: string;
  role: "admin" | "member";
}
