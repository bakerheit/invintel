import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createDb } from "./db.js";

let app: ReturnType<typeof createApp>;

const json = (body: unknown, method = "POST") => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  app = createApp(createDb(":memory:"));
});

describe("items api", () => {
  it("creates an item, logs initial stock, and rejects duplicate SKUs", async () => {
    const res = await app.request("/api/items", json({ sku: "A-1", name: "Widget", quantity: 5 }));
    expect(res.status).toBe(201);
    const item = await res.json();
    expect(item.quantity).toBe(5);

    const moves = await (await app.request(`/api/items/${item.id}/movements`)).json();
    expect(moves).toHaveLength(1);
    expect(moves[0].delta).toBe(5);

    const dupe = await app.request("/api/items", json({ sku: "A-1", name: "Other" }));
    expect(dupe.status).toBe(409);
  });

  it("validates input", async () => {
    const res = await app.request("/api/items", json({ sku: "", name: "x" }));
    expect(res.status).toBe(400);
  });

  it("adjusts stock and refuses to go negative", async () => {
    const item = await (
      await app.request("/api/items", json({ sku: "B-1", name: "Bolt", quantity: 3 }))
    ).json();

    const ok = await app.request(`/api/items/${item.id}/adjust`, json({ delta: -2, reason: "sold" }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).quantity).toBe(1);

    const bad = await app.request(`/api/items/${item.id}/adjust`, json({ delta: -5 }));
    expect(bad.status).toBe(422);
  });

  it("ignores quantity on PATCH, updates other fields, and deletes", async () => {
    const item = await (
      await app.request("/api/items", json({ sku: "C-1", name: "Cog", quantity: 4 }))
    ).json();

    const patched = await (
      await app.request(`/api/items/${item.id}`, json({ name: "Big Cog", quantity: 99 }, "PATCH"))
    ).json();
    expect(patched.name).toBe("Big Cog");
    expect(patched.quantity).toBe(4);

    expect((await app.request(`/api/items/${item.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await app.request(`/api/items/${item.id}`)).status).toBe(404);
  });
});
