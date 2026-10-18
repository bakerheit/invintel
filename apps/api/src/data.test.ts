import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { parseCsv } from "./csv.js";
import { connect, type Store } from "./db.js";

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

let n = 0;
async function signUp(organization: object) {
  const res = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Ada", email: `d${++n}@example.com`, password: "correct horse", organization }),
  });
  const b = await res.json();
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]!, org: b.organization };
}
const call = (cookie: string, path: string, body?: unknown) =>
  app.request(path, { method: body === undefined ? "GET" : "POST", headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });

describe("csv parser", () => {
  it("handles quotes, embedded commas and newlines, CRLF and a BOM", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi""\nthere"\r\n\r\nlast,')).toEqual([["a", "b"], ["x, y", 'say "hi"\nthere'], ["last", ""]]);
  });
});

describe("items import and export", () => {
  it("previews, imports once, never overwrites, and round-trips through export", async () => {
    const { cookie, org } = await signUp({ mode: "create", name: "Acme" });
    const base = `/api/orgs/${org.id}`;
    await call(cookie, `${base}/locations`, { name: "Dock", type: "receiving", code: "DOCK" });

    const csv = [
      "SKU,Name,Category,Reorder level,Unit cost,Barcodes,Location,Qty",
      'KRAFT-42,"Kraft liner, 42 lb",Paper,12,$480.00,0123456789012|ABC-1,DOCK,9',
      "KRAFT-42,,,,,,Main,4", // more stock for the same item at a second place
      "GLUE,Glue,Chem,5,2.5,,,",
      "BAD,Bad cost,,,abc,,,",
      "NOLOC,Nowhere,,,,,Moon,3",
      ",no sku,,,,,,",
    ].join("\n");

    const preview = await (await call(cookie, `${base}/data/items/import`, { csv, dryRun: true })).json();
    expect(preview).toMatchObject({ dryRun: true, itemsToCreate: 2, stockLines: 2, units: 13, errors: 3 });
    expect(preview.rows.filter((r: { status: string }) => r.status === "error").map((r: { message: string }) => r.message)).toEqual([
      'Unit cost "abc" isn\'t a number', 'No location called "Moon"', "Missing SKU",
    ]);
    // Nothing was written by the preview, and a real import with errors is refused whole.
    expect((await (await call(cookie, `${base}/items`)).json()).length).toBe(0);
    expect((await call(cookie, `${base}/data/items/import`, { csv, dryRun: false })).status).toBe(422);
    expect((await (await call(cookie, `${base}/items`)).json()).length).toBe(0);

    const good = csv.split("\n").slice(0, 4).join("\n");
    const done = await call(cookie, `${base}/data/items/import`, { csv: good, dryRun: false });
    expect(done.status).toBe(201);
    const items = await (await call(cookie, `${base}/items`)).json();
    const kraft = items.find((i: { sku: string }) => i.sku === "KRAFT-42");
    expect(kraft).toMatchObject({ name: "Kraft liner, 42 lb", reorderLevel: 12, unitCostCents: 48000, quantity: 13, barcodes: ["0123456789012", "ABC-1"] });

    // Importing the same file again changes nothing.
    const again = await (await call(cookie, `${base}/data/items/import`, { csv: good, dryRun: false })).json();
    expect(again).toMatchObject({ itemsToCreate: 0, units: 0, skipped: 2 });
    expect((await (await call(cookie, `${base}/items`)).json()).find((i: { sku: string }) => i.sku === "KRAFT-42").quantity).toBe(13);

    // Export has one row per item and location, in the format the importer reads.
    const exp = await call(cookie, `${base}/data/items.csv`);
    expect(exp.headers.get("content-type")).toContain("text/csv");
    const rows = parseCsv(await exp.text());
    expect(rows[0]).toEqual(["sku", "name", "category", "description", "reorder_level", "unit_cost", "barcodes", "location", "quantity", "unit", "decimals"]);
    expect(rows.slice(1).map((r) => `${r[0]}@${r[7]}=${r[8]}`).sort()).toEqual(["GLUE@=", "KRAFT-42@DOCK=9", "KRAFT-42@Main=4"]);
  });

  it("is admin-only to import, neutralizes formulas on export, and enforces membership", async () => {
    const { cookie, org } = await signUp({ mode: "create", name: "Acme" });
    const base = `/api/orgs/${org.id}`;
    await call(cookie, `${base}/items`, { sku: "F-1", name: "=HYPERLINK(\"http://x\")" });
    const text = await (await call(cookie, `${base}/data/items.csv`)).text();
    expect(text).toContain("\"'=HYPERLINK(\"\"http://x\"\")\"");

    const member = await signUp({ mode: "join", joinCode: org.joinCode });
    expect((await call(member.cookie, `${base}/data/items/import`, { csv: "sku,name\nX,Y", dryRun: true })).status).toBe(403);
    expect((await call(member.cookie, `${base}/data/items.csv`)).status).toBe(200);
    const stranger = await signUp({ mode: "create", name: "Other" });
    expect((await call(stranger.cookie, `${base}/data/items.csv`)).status).toBe(404);
    expect((await call(cookie, `${base}/data/items/import`, { csv: "name,qty\nX,1", dryRun: true })).status).toBe(400);
    // A huge body is refused before it is parsed.
    const huge = await call(cookie, `${base}/data/items/import`, { csv: `sku,name\n${"x".repeat(3 * 1024 * 1024)}`, dryRun: true });
    expect(huge.status).toBe(413);
  });
});
