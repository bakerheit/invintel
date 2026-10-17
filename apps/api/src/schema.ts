import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const timestamp = (name: string) =>
  text(name)
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`);

export const items = sqliteTable(
  "items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sku: text("sku").notNull().unique(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    category: text("category").notNull().default(""),
    location: text("location").notNull().default(""),
    quantity: integer("quantity").notNull().default(0),
    reorderLevel: integer("reorder_level").notNull().default(0),
    unitCostCents: integer("unit_cost_cents").notNull().default(0),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (t) => [index("items_category_idx").on(t.category)],
);

export const stockMovements = sqliteTable(
  "stock_movements",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    itemId: integer("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    delta: integer("delta").notNull(),
    reason: text("reason").notNull().default(""),
    createdAt: timestamp("created_at"),
  },
  (t) => [index("stock_movements_item_idx").on(t.itemId)],
);
