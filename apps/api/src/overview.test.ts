import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { connect, type Store } from "./db.js";

// Needs a running MongoDB (docker compose up -d). Uses its own throwaway database.
const uri = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
let store: Store;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  store = await connect(uri, `invintel_test_${randomBytes(4).toString("hex")}`);
  app = createApp(store, { allowRegistration: true, cookieSecure: false });
});
afterAll(async () => {
  await store.db.dropDatabase();
  await store.close();
});

const json = (cookie: string, body?: unknown, method?: string): RequestInit => ({
  method: method ?? (body === undefined ? "GET" : "POST"),
  headers: { cookie, ...(body !== undefined && { "content-type": "application/json" }) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describe("overview", () => {
  it("summarizes stock, flags low and out items, and splits stock by kind of location", async () => {
    const reg = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada", email: "ada@example.com", password: "correct horse", organization: { mode: "create", name: "Acme" } }),
    });
    const cookie = reg.headers.get("set-cookie")!.split(";")[0]!;
    const { organization } = await reg.json();
    const base = `/api/orgs/${organization.id}`;
    const mk = async (path: string, body: unknown) => (await app.request(`${base}${path}`, json(cookie, body))).json();

    const main = (await (await app.request(`${base}/locations`, json(cookie))).json())[0];
    const dock = await mk("/locations", { name: "Dock", type: "receiving" });

    const roll = await mk("/items", { sku: "ROLL-1", name: "Kraft roll", unitCostCents: 1000, reorderLevel: 10, initialStock: { locationId: dock.id, quantity: 4 } });
    await mk("/items", { sku: "GLUE", name: "Glue", unitCostCents: 250, reorderLevel: 5, initialStock: { locationId: main.id, quantity: 20 } });
    await mk("/items", { sku: "TAPE", name: "Tape", reorderLevel: 3 }); // no stock at all: out
    await mk("/items", { sku: "BOX", name: "Boxes", reorderLevel: 0 }); // reorder level 0 means "don't track"

    const res = await app.request(`${base}/overview`, json(cookie));
    expect(res.status).toBe(200);
    const o = await res.json();
    expect(o).toMatchObject({ items: 4, units: 24, valueCents: 4 * 1000 + 20 * 250, outCount: 2, lowCount: 1, awaitingPutaway: 4 });
    // Out-of-stock items come before low ones.
    expect(o.attention.map((a: { sku: string; status: string }) => `${a.sku}:${a.status}`)).toEqual(["BOX:out", "TAPE:out", "ROLL-1:low"]);
    const receiving = o.byType.find((t: { type: string }) => t.type === "receiving");
    expect(receiving).toMatchObject({ locations: 1, units: 4, valueCents: 4000 });
    expect(o.byType.find((t: { type: string }) => t.type === "storage")).toMatchObject({ units: 20 });
    expect(o.movements24h).toBeGreaterThanOrEqual(2);
    expect(roll.id).toBeTruthy();
  });

  it("is members-only: a stranger gets a 404", async () => {
    const reg = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Eve", email: "eve@example.com", password: "correct horse", organization: { mode: "create", name: "Other" } }),
    });
    const cookie = reg.headers.get("set-cookie")!.split(";")[0]!;
    const res = await app.request("/api/orgs/aaaaaaaaaaaaaaaaaaaaaaaa/overview", json(cookie));
    expect(res.status).toBe(404);
  });
});
