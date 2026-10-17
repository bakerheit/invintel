import { zValidator } from "@hono/zod-validator";
import {
  adjustmentInputSchema,
  itemInputSchema,
  itemUpdateSchema,
} from "@invintel/shared";
import { desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { z } from "zod";
import type { Db } from "./db.js";
import { items, stockMovements } from "./schema.js";

const idParam = z.object({ id: z.coerce.number().int().positive() });

const isUniqueError = (e: unknown) =>
  e instanceof Error && "code" in e && e.code === "SQLITE_CONSTRAINT_UNIQUE";

export function createApp(db: Db) {
  const app = new Hono();

  app.use("*", logger());
  app.use("/api/*", cors({ origin: (o) => o ?? "*" }));

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/items", (c) => c.json(db.select().from(items).orderBy(items.name).all()));

  app.get("/api/items/:id", zValidator("param", idParam), (c) => {
    const { id } = c.req.valid("param");
    const item = db.select().from(items).where(eq(items.id, id)).get();
    return item ? c.json(item) : c.json({ error: "Item not found" }, 404);
  });

  app.post("/api/items", zValidator("json", itemInputSchema), (c) => {
    const input = c.req.valid("json");
    try {
      const item = db.transaction((tx) => {
        const created = tx.insert(items).values(input).returning().get();
        if (created.quantity !== 0) {
          tx.insert(stockMovements)
            .values({ itemId: created.id, delta: created.quantity, reason: "Initial stock" })
            .run();
        }
        return created;
      });
      return c.json(item, 201);
    } catch (e) {
      if (isUniqueError(e)) return c.json({ error: `SKU "${input.sku}" already exists` }, 409);
      throw e;
    }
  });

  app.patch(
    "/api/items/:id",
    zValidator("param", idParam),
    zValidator("json", itemUpdateSchema),
    (c) => {
      const { id } = c.req.valid("param");
      const { quantity: _ignored, ...patch } = c.req.valid("json");
      // Quantity only changes through stock adjustments so history stays accurate.
      try {
        const updated = db
          .update(items)
          .set({ ...patch, updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))` })
          .where(eq(items.id, id))
          .returning()
          .get();
        return updated ? c.json(updated) : c.json({ error: "Item not found" }, 404);
      } catch (e) {
        if (isUniqueError(e)) return c.json({ error: "SKU already exists" }, 409);
        throw e;
      }
    },
  );

  app.delete("/api/items/:id", zValidator("param", idParam), (c) => {
    const { id } = c.req.valid("param");
    const deleted = db.delete(items).where(eq(items.id, id)).returning({ id: items.id }).get();
    return deleted ? c.body(null, 204) : c.json({ error: "Item not found" }, 404);
  });

  app.get("/api/items/:id/movements", zValidator("param", idParam), (c) => {
    const { id } = c.req.valid("param");
    return c.json(
      db
        .select()
        .from(stockMovements)
        .where(eq(stockMovements.itemId, id))
        .orderBy(desc(stockMovements.id))
        .all(),
    );
  });

  app.post(
    "/api/items/:id/adjust",
    zValidator("param", idParam),
    zValidator("json", adjustmentInputSchema),
    (c) => {
      const { id } = c.req.valid("param");
      const { delta, reason } = c.req.valid("json");
      const result = db.transaction((tx) => {
        const item = tx.select().from(items).where(eq(items.id, id)).get();
        if (!item) return { status: 404 as const, error: "Item not found" };
        if (item.quantity + delta < 0) {
          return { status: 422 as const, error: `Only ${item.quantity} in stock` };
        }
        const updated = tx
          .update(items)
          .set({
            quantity: item.quantity + delta,
            updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
          })
          .where(eq(items.id, id))
          .returning()
          .get();
        tx.insert(stockMovements).values({ itemId: id, delta, reason }).run();
        return { status: 200 as const, item: updated };
      });
      if ("error" in result) return c.json({ error: result.error }, result.status);
      return c.json(result.item);
    },
  );

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "Internal server error" }, 500);
  });

  return app;
}
