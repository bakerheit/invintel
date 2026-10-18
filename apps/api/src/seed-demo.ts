// Loads a small corrugated-plant demo into a local database so you can click around.
//   pnpm --filter @invintel/api seed:demo
// Signs in as demo@invintel.local with the password below. Local development only: refuses to run
// twice (it never touches an account that already exists) and prints nothing sensitive.
import { createApp } from "./app.js";
import { connect } from "./db.js";

// A different account can be seeded with DEMO_EMAIL and DEMO_PASSWORD in the environment (used for a shared demo, so the password in this file is never the one that is exposed).
const DEMO_EMAIL = process.env.DEMO_EMAIL ?? "demo@invintel.local";
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "invintel-demo-2026";

const store = await connect();
const app = createApp(store, { allowRegistration: true, cookieSecure: false });

if (await store.users.findOne({ email: DEMO_EMAIL })) {
  console.log(`The demo account already exists in database "${store.db.databaseName}". Nothing changed.`);
  await store.close();
  process.exit(0);
}

let cookie = "";
async function call<T = any>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const res = await app.request(path, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0]!;
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const reg = await call("/api/auth/register", {
  name: "Dana Demo",
  email: DEMO_EMAIL,
  password: DEMO_PASSWORD,
  organization: { mode: "create", name: "Demo Corrugated Co." },
});
const base = `/api/orgs/${reg.organization.id}`;

const first = (await call<{ id: string }[]>(`${base}/locations`))[0]!;
const plant = first.id; // "Main" becomes the plant
await call(`${base}/locations/${plant}`, { name: "Plant 1", type: "storage" }, "PATCH");
const loc = async (name: string, type: string, code: string, parentId: string | null = plant) =>
  (await call<{ id: string }>(`${base}/locations`, { name, type, code, parentId })).id;

const dock = await loc("Receiving dock", "receiving", "DOCK");
const rolls = await loc("Roll storage", "storage", "ROLLS");
const rackA = await loc("Rack A", "storage", "RA", rolls);
const rackB = await loc("Rack B", "storage", "RB", rolls);
const chem = await loc("Chemical room", "storage", "CHEM");
const corr = await loc("Corrugator 1", "production", "CORR1");
const conv = await loc("Converting WIP", "wip", "WIP");
const fg = await loc("Finished goods", "finished", "FG");
const ship = await loc("Shipping", "shipping", "SHIP");

const item = (sku: string, name: string, category: string, reorderLevel: number, dollars: number, barcodes: string[] = [], description = "") =>
  call<{ id: string }>(`${base}/items`, { sku, name, category, reorderLevel, unitCostCents: Math.round(dollars * 100), barcodes, description }).then((i) => i.id);

const kraft = await item("LINER-KR42", "Kraft liner 42 lb, 60 in roll", "Paper", 12, 480, [], "Single-face and double-backer liner");
const med = await item("MED-26", "Corrugating medium 26 lb, 60 in roll", "Paper", 10, 390);
const test = await item("LINER-T33", "Test liner 33 lb, 60 in roll", "Paper", 8, 420);
const starch = await item("STARCH-50", "Corn starch 50 lb bag", "Adhesive", 40, 28, ["0049000050103"]);
const inkB = await item("INK-BLK", "Flexo ink, black, 5 gal", "Ink", 6, 95);
const inkW = await item("INK-WHT", "Flexo ink, white, 5 gal", "Ink", 6, 92);
const strap = await item("STRAP-PP", "Polypropylene strapping coil", "Supplies", 20, 31.5);
const pallet = await item("PAL-4840", "Pallet 48x40", "Supplies", 100, 9);
const rsc = await item("RSC-1296", "RSC box 12x9x6 (bundle of 25)", "Finished goods", 50, 21, ["0850012345674"]);
const rsc2 = await item("RSC-181212", "RSC box 18x12x12 (bundle of 25)", "Finished goods", 40, 34);

const receive = (itemId: string, locationId: string, quantity: number, reference: string) =>
  call(`${base}/receipts`, { itemId, locationId, quantity, reference });
const move = (itemId: string, from: string, to: string, quantity: number, reason = "") =>
  call(`${base}/moves`, { itemId, fromLocationId: from, toLocationId: to, quantity, reason });

await receive(kraft, rackA, 14, "PO 4401");
await receive(med, rackA, 11, "PO 4402");
await receive(test, rackB, 5, "PO 4388");
await receive(starch, chem, 55, "PO 4410");
await receive(inkB, chem, 4, "PO 4390");
await receive(inkW, chem, 9, "PO 4390");
await receive(strap, conv, 26, "PO 4377");
await receive(pallet, ship, 140, "PO 4350");
await receive(rsc, fg, 80, "Run 2291");
await receive(rsc2, fg, 36, "Run 2292");
await receive(kraft, dock, 6, "PO 4415 (just arrived)");
await receive(med, dock, 4, "PO 4415 (just arrived)");
await move(kraft, rackA, corr, 3, "Load for order 2301");
await move(med, rackA, corr, 2, "Load for order 2301");
await move(rsc, fg, ship, 25, "Order 8812");
await call(`${base}/items/${inkB}/adjust`, { locationId: chem, delta: -1, reason: "Spilled during a pail change" });

// Production: a work center at Corrugator 1, a BOM for RSC-1296 and a released work order the floor can start.
const prod = `${base}/production`;
const wc = await call<{ id: string }>(`${prod}/work-centers`, { name: "Corrugator 1", code: "WC-CORR1", locationId: corr });
await call(`${prod}/boms`, {
  outputItemId: rsc,
  outputQuantity: 50, // the inputs below make 50 bundles
  yieldPct: 97,
  note: "Demo recipe, not a real spec",
  inputs: [
    { itemId: kraft, quantity: 2, scrapPct: 5 },
    { itemId: med, quantity: 1, scrapPct: 3 },
    { itemId: starch, quantity: 1, scrapPct: 0 },
  ],
});
const wo = await call<{ id: string }>(`${prod}/work-orders`, { outputItemId: rsc, quantity: 100, workCenterId: wc.id, dueDate: null, note: "Demo order" });
await call(`${prod}/work-orders/${wo.id}/action`, { action: "release" });

// A paper item tracked roll by roll: each roll has its own label (print them from Labels) and a remaining weight.
const rollItem = await call<{ id: string }>(`${base}/items`, { sku: "ROLL-KR60", name: "Kraft 60 in roll, tracked per roll (kg)", category: "Paper", reorderLevel: 1500, unitCostCents: 120, tracking: "unit" });
await call(`${base}/units`, { itemId: rollItem.id, locationId: rackB, quantity: 820, count: 3, lot: "MILL-7741" });
await call(`${base}/units`, { itemId: rollItem.id, locationId: dock, quantity: 640, count: 1, lot: "MILL-7802" });

// A supplier and an order that has been placed, so Purchasing has something in it.
const supplier = await call<{ id: string }>(`${base}/purchasing/suppliers`, { name: "Midwest Paper Mill", contact: "Sam Ortiz", email: "orders@midwestpaper.example", phone: "555-0142" });
const po = await call<{ id: string }>(`${base}/purchasing/orders`, {
  supplierId: supplier.id, expectedDate: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10),
  lines: [{ itemId: test, quantity: 6, unitCostCents: 42000 }, { itemId: inkB, quantity: 8, unitCostCents: 9500 }],
});
await call(`${base}/purchasing/orders/${po.id}/place`, {});

// Quality: a few bags of starch found wet, put on hold for an admin to decide.
await call(`${base}/quality/holds`, { itemId: starch, locationId: chem, quantity: 3, reason: "Damaged", note: "Bags wet from a roof leak (demo)" });

// Traceability: a labelled roll from lot MILL-0712 is used in a work order that makes labelled pallets, one of which
// goes into a second order. Try Reports > Lot trace and mock recall with lot MILL-0712.
const lblRoll = (await call<{ id: string }>(`${base}/items`, { sku: "LINER-LBL", name: "Kraft liner 42 lb (labelled rolls)", category: "Paper", tracking: "unit", unitCostCents: 48000 })).id;
const lblPallet = (await call<{ id: string }>(`${base}/items`, { sku: "PAL-RSC", name: "Pallet of RSC boxes (labelled)", category: "Finished goods", tracking: "unit" })).id;
const rollsIn = await call<{ units: { id: string; code: string }[] }>(`${base}/units`, { itemId: lblRoll, locationId: rackA, quantity: 800, count: 2, lot: "MILL-0712" });
await call(`${base}/production/boms`, { outputItemId: lblPallet, inputs: [{ itemId: lblRoll, quantity: 1 }] });
const wo2 = await call<{ id: string }>(`${prod}/work-orders`, { outputItemId: lblPallet, quantity: 100, workCenterId: wc.id });
await call(`${prod}/work-orders/${wo2.id}/action`, { action: "release" });
await call(`${prod}/work-orders/${wo2.id}/load`, { itemId: lblRoll, unitId: rollsIn.units[0]!.id });
await call(`${prod}/work-orders/${wo2.id}/consume`, { itemId: lblRoll, unitId: rollsIn.units[0]!.id, used: 780, scrap: 20 });
await call(`${prod}/work-orders/${wo2.id}/output`, { good: 100, unitSize: 50, lot: "RUN-2291", toLocationId: fg });
await call(`${prod}/work-orders/${wo2.id}/action`, { action: "complete" });
// Scrap: a finished run of RSC-1296 with scrap on material and output, each with a reason (Reports > Scrap and yield trends).
const wo3 = await call<{ id: string }>(`${prod}/work-orders`, { outputItemId: rsc, quantity: 50, workCenterId: wc.id });
await call(`${prod}/work-orders/${wo3.id}/action`, { action: "release" });
await call(`${prod}/work-orders/${wo3.id}/load`, { itemId: kraft, fromLocationId: rackA, quantity: 4 });
await call(`${prod}/work-orders/${wo3.id}/consume`, { itemId: kraft, used: 1, scrap: 1, scrapReason: "Trim" });
await call(`${prod}/work-orders/${wo3.id}/consume`, { itemId: kraft, used: 1, scrap: 1, scrapReason: "Setup" });
await call(`${prod}/work-orders/${wo3.id}/output`, { good: 44, scrap: 6, scrapReason: "Damaged", toLocationId: fg });
await call(`${prod}/work-orders/${wo3.id}/action`, { action: "complete" });

// Email exchange: Midwest Paper Mill is a trading partner reached by email (a test partner: nothing leaves this machine, mail
// goes to an outbox folder), and an invoice from them has arrived as a file for checking (Documents > Incoming invoices).
const mailPartner = await call<{ id: string }>(`${base}/b2b/partners`, { name: "Midwest Paper Mill", kind: "supplier", supplierId: supplier.id, bridge: "email", bridgeConfig: { to: "orders@midwestpaper.example" }, mode: "test" });
const poNumber = (await call<{ number: string }>(`${base}/purchasing/orders/${po.id}`)).number;
await call(`${base}/b2b/invoices/upload`, {
  partnerId: mailPartner.id, filename: "MWP-20418.json", contentType: "application/json",
  contentBase64: Buffer.from(JSON.stringify({ invoiceNumber: "MWP-20418", issueDate: new Date().toISOString().slice(0, 10), poNumber, total: "3280.00", lines: [{ description: "Test liner 33 lb, 60 in roll", quantity: "6", unitPrice: "420.00" }, { description: "Flexo ink, black, 5 gal", quantity: "8", unitPrice: "95.00" }] })).toString("base64"),
});

// EDI: Lakeshore Film & Resin takes orders as X12 (a test partner on the built-in test transport: nothing leaves this machine).
// Open its order, "Send as X12 (850)", then Documents > the sent order > "Let it answer" to play the supplier's side.
const ediSupplier = await call<{ id: string }>(`${base}/purchasing/suppliers`, { name: "Lakeshore Film & Resin", contact: "Dee Park" });
await call(`${base}/b2b/partners`, {
  name: "Lakeshore Film & Resin", kind: "supplier", supplierId: ediSupplier.id, bridge: "x12", mode: "test",
  bridgeConfig: { ourQual: "ZZ", ourId: "DEMOCORRUG", theirQual: "ZZ", theirId: "LAKESHORE", version: "004010", transport: "loopback" },
});
const ediPo = await call<{ id: string }>(`${base}/purchasing/orders`, {
  supplierId: ediSupplier.id, expectedDate: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10), note: "Dock 2, call before arrival",
  lines: [{ itemId: inkB, quantity: 10, unitCostCents: 9500 }],
});
await call(`${base}/purchasing/orders/${ediPo.id}/place`, {});

// Exchange: a second organization on the same server (a paper supplier) is connected to the demo plant, so you can play both
// sides: switch organizations in the sidebar. The plant has a placed order for the supplier waiting to be sent from the order's dialog.
const sunrise = await call<{ id: string }>("/api/orgs", { name: "Sunrise Paper Co." });
const sBase = `/api/orgs/${sunrise.id}`;
const sMain = (await call<{ id: string }[]>(`${sBase}/locations`))[0]!.id;
for (const [sku, name, qty, cost] of [["LINER-KR42", "Kraft liner 42 lb, 60 in roll", 60, 31000], ["MED-26", "Corrugating medium 26 lb, 60 in roll", 25, 26000]] as const) {
  await call(`${sBase}/items`, { sku, name, unitCostCents: cost, reorderLevel: 10, initialStock: { locationId: sMain, quantity: qty } });
}
const theirInvitation = await call<unknown>(`${sBase}/exchange/invitation`);
await call(`${base}/exchange/connect`, { invitation: theirInvitation, kind: "supplier" });
const sunriseSupplier = await call<{ id: string }>(`${base}/purchasing/suppliers`, { name: "Sunrise Paper Co.", contact: "Sol Reyes" });
const sunrisePo = await call<{ id: string }>(`${base}/purchasing/orders`, {
  supplierId: sunriseSupplier.id, expectedDate: new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10),
  lines: [{ itemId: kraft, quantity: 12, unitCostCents: 48000 }, { itemId: med, quantity: 6, unitCostCents: 39000 }],
});
await call(`${base}/purchasing/orders/${sunrisePo.id}/place`, {});
// The supplier lets the plant ask about stock and order status (off by default for every partner).
const theirPartners = await call<{ id: string }[]>(`${sBase}/exchange/partners`);
await call(`${sBase}/exchange/partners/${theirPartners[0]!.id}/permissions`, { shareStock: true, shareStockQuantities: true, shareOrderStatus: true }, "PATCH");

console.log(`Demo loaded into database "${store.db.databaseName}". Sign in as ${DEMO_EMAIL} (password is at the top of apps/api/src/seed-demo.ts).`);
await store.close();
process.exit(0);
